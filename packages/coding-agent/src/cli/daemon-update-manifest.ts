import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDaemonUpdateRestartManifestPath, getLegacyDaemonUpdateRestartManifestPath } from "../config.js";
import type { DaemonUpdateRestartManifest, DaemonUpdateRestartSession } from "../modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";

export type DaemonUpdateRestartRecoveryKind = "restart" | "retry";

export interface PreparedDaemonUpdateRestartManifest extends DaemonUpdateRestartManifest {
	retryOnly?: true;
}

function normalizedSocketPath(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : resolve(path);
}

function normalizedFilePath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sessionKey(sessionFile: string): string {
	return normalizedFilePath(sessionFile);
}

export function getDaemonUpdateRestartManifestCandidates(socketPath: string, agentDir: string): string[] {
	const candidates = [getDaemonUpdateRestartManifestPath(socketPath, agentDir)];
	if (normalizedSocketPath(socketPath) === normalizedSocketPath(defaultDaemonSocketPath())) {
		candidates.push(getLegacyDaemonUpdateRestartManifestPath(agentDir));
	}
	return candidates;
}

export function getPendingDaemonUpdateRestartRecoveryKind(
	socketPath: string,
	agentDir: string,
): DaemonUpdateRestartRecoveryKind | undefined {
	let retryPending = false;
	for (const path of getDaemonUpdateRestartManifestCandidates(socketPath, agentDir)) {
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as { sessions?: unknown; retryOnly?: unknown };
			if (Array.isArray(value.sessions) && value.sessions.length > 0) {
				if (value.retryOnly !== true) {
					return "restart";
				}
				retryPending = true;
			}
		} catch {
			// Full validation and diagnostics happen in the recovery coordinator.
		}
	}
	return retryPending ? "retry" : undefined;
}

export function hasPendingDaemonUpdateRestartManifest(socketPath: string, agentDir: string): boolean {
	return getPendingDaemonUpdateRestartRecoveryKind(socketPath, agentDir) !== undefined;
}

export function writePreparedDaemonUpdateRestartManifest(
	socketPath: string,
	agentDir: string,
	manifest: PreparedDaemonUpdateRestartManifest,
): void {
	const path = getDaemonUpdateRestartManifestPath(socketPath, agentDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
		for (const candidate of getDaemonUpdateRestartManifestCandidates(socketPath, agentDir)) {
			if (candidate !== path) {
				rmSync(candidate, { force: true });
			}
		}
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

export function clearPreparedDaemonUpdateRestartManifest(socketPath: string, agentDir: string): void {
	for (const path of getDaemonUpdateRestartManifestCandidates(socketPath, agentDir)) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best effort only. A later recovery can safely reconcile duplicates by session file.
		}
	}
}

function resolveActiveSessionAlias(activeSessionId: string, aliases: ReadonlyMap<string, string>): string {
	let current = activeSessionId;
	const visited = new Set<string>();
	while (!visited.has(current)) {
		visited.add(current);
		const next = aliases.get(current);
		if (!next) {
			break;
		}
		current = next;
	}
	return current;
}

function remapParentActiveSessionId(
	session: DaemonUpdateRestartSession,
	aliases: ReadonlyMap<string, string>,
): DaemonUpdateRestartSession {
	const runtimeMetadata = session.runtimeMetadata;
	const parentActiveSessionId = runtimeMetadata?.parentActiveSessionId;
	if (!parentActiveSessionId) {
		return session;
	}
	const remappedParentActiveSessionId = resolveActiveSessionAlias(parentActiveSessionId, aliases);
	if (remappedParentActiveSessionId === parentActiveSessionId) {
		return session;
	}
	return {
		...session,
		runtimeMetadata: {
			...runtimeMetadata,
			parentActiveSessionId: remappedParentActiveSessionId,
		},
	};
}

function orderParentSessionsFirst(sessions: readonly DaemonUpdateRestartSession[]): DaemonUpdateRestartSession[] {
	const byActiveSessionId = new Map(sessions.map((session) => [session.activeSessionId, session]));
	const ordered: DaemonUpdateRestartSession[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (session: DaemonUpdateRestartSession) => {
		if (visited.has(session.activeSessionId)) {
			return;
		}
		if (visiting.has(session.activeSessionId)) {
			return;
		}
		visiting.add(session.activeSessionId);
		const parentActiveSessionId = session.runtimeMetadata?.parentActiveSessionId;
		const parent = parentActiveSessionId ? byActiveSessionId.get(parentActiveSessionId) : undefined;
		if (parent) {
			visit(parent);
		}
		visiting.delete(session.activeSessionId);
		visited.add(session.activeSessionId);
		ordered.push(session);
	};
	for (const session of sessions) {
		visit(session);
	}
	return ordered;
}

export function mergeDaemonUpdateRestartManifests(
	pending: DaemonUpdateRestartManifest,
	current: DaemonUpdateRestartManifest,
): DaemonUpdateRestartManifest {
	const currentBySessionFile = new Map(current.sessions.map((session) => [sessionKey(session.sessionFile), session]));
	const consumedCurrentSessionFiles = new Set<string>();
	const aliases = new Map<string, string>();
	const merged = pending.sessions.map((pendingSession) => {
		const key = sessionKey(pendingSession.sessionFile);
		const currentSession = currentBySessionFile.get(key);
		if (!currentSession) {
			return pendingSession;
		}
		consumedCurrentSessionFiles.add(key);
		if (pendingSession.activeSessionId !== currentSession.activeSessionId) {
			aliases.set(pendingSession.activeSessionId, currentSession.activeSessionId);
		}
		return currentSession;
	});
	for (const currentSession of current.sessions) {
		if (!consumedCurrentSessionFiles.has(sessionKey(currentSession.sessionFile))) {
			merged.push(currentSession);
		}
	}
	return {
		createdAt: current.createdAt,
		sessions: orderParentSessionsFirst(merged.map((session) => remapParentActiveSessionId(session, aliases))),
	};
}

export function manifestForFailedDaemonUpdateRestores(
	manifest: DaemonUpdateRestartManifest,
	failedSessionFiles: readonly string[],
): PreparedDaemonUpdateRestartManifest | undefined {
	const failed = new Set(failedSessionFiles.map(sessionKey));
	const retained = new Set(failed);
	const byActiveSessionId = new Map(manifest.sessions.map((session) => [session.activeSessionId, session]));
	for (const failedSession of manifest.sessions.filter((session) => retained.has(sessionKey(session.sessionFile)))) {
		let parentActiveSessionId = failedSession.runtimeMetadata?.parentActiveSessionId;
		const visited = new Set<string>();
		while (parentActiveSessionId && !visited.has(parentActiveSessionId)) {
			visited.add(parentActiveSessionId);
			const parent = byActiveSessionId.get(parentActiveSessionId);
			if (!parent) {
				break;
			}
			retained.add(sessionKey(parent.sessionFile));
			parentActiveSessionId = parent.runtimeMetadata?.parentActiveSessionId;
		}
	}
	const sessions = manifest.sessions
		.filter((session) => retained.has(sessionKey(session.sessionFile)))
		.map((session) => {
			if (failed.has(sessionKey(session.sessionFile))) {
				return session;
			}
			return {
				...session,
				queue: { steering: [], followUp: [], nextTurn: [] },
				shouldResume: false,
				wasStreaming: false,
				wasCompacting: false,
				wasBashRunning: false,
				hadRunningRlmChildren: false,
				wasRetrying: false,
				hadAcceptedPromptInFlight: false,
			};
		});
	return sessions.length > 0 ? { createdAt: manifest.createdAt, sessions, retryOnly: true } : undefined;
}
