import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { deleteSessionFile } from "../../core/session-file-actions.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../../core/session-manager.js";

export const DAEMON_CATALOG_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_CATALOG";

interface SessionInfoWire extends Omit<SessionInfo, "created" | "modified"> {
	created: string;
	modified: string;
}

type CatalogRequest =
	| { type: "request"; id: string; command: "list"; cwd?: string; sessionDir?: string }
	| { type: "request"; id: string; command: "family"; sessionDir?: string }
	| { type: "request"; id: string; command: "resolve"; selector: string; cwd: string; sessionDir?: string }
	| { type: "request"; id: string; command: "siblings"; sessionPath: string; sessionDir?: string }
	| { type: "request"; id: string; command: "rename"; sessionPath: string; name: string }
	| { type: "request"; id: string; command: "delete"; sessionPath: string }
	| { type: "request"; id: string; command: "archive"; sessionPath: string; sessionId: string }
	| {
			type: "request";
			id: string;
			command: "mark_interrupted";
			sessionPath: string;
			activeSessionId: string;
			operations: string[];
	  }
	| { type: "request"; id: string; command: "shutdown" };

type CatalogOutbound =
	| { type: "ready" }
	| { type: "progress"; id: string; loaded: number; total: number }
	| { type: "session"; id: string; session: SessionInfoWire }
	| { type: "response"; id: string; success: true; data?: unknown }
	| { type: "response"; id: string; success: false; error: string };

interface CatalogListCallbacks {
	onProgress?: (loaded: number, total: number) => void;
	onSession?: (session: SessionInfo) => void;
}

function serializeSessionInfo(session: SessionInfo): SessionInfoWire {
	return {
		...session,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
	};
}

function deserializeSessionInfo(session: SessionInfoWire): SessionInfo {
	return {
		...session,
		created: new Date(session.created),
		modified: new Date(session.modified),
	};
}

interface SavedRlmSubagentRegistryEntry {
	type?: unknown;
	childId?: unknown;
	sessionFile?: unknown;
	status?: unknown;
}

const MAX_RLM_REGISTRY_BYTES = 1024 * 1024;
const MAX_RLM_REGISTRY_RECORDS = 10_000;
const MAX_RLM_FAMILY_EDGES = 10_000;
const MAX_RLM_FAMILY_NODES = 10_000;
const MAX_RLM_FAMILY_DEPTH = 64;

interface ManagedRoots {
	session: { lexical: string; canonical: string };
	artifacts: { lexical: string; canonical: string } | undefined;
}

interface TrustedSession extends SessionInfo {
	/** The header claim is intentionally separate from SessionInfo's legacy fallback. */
	persistedDepth: number;
	persistedParentPath?: string;
}

function rlmSubagentRegistryPath(parent: SessionInfo, roots: ManagedRoots): string {
	const parentDir = dirname(parent.path);
	const artifactDir = parentDir === roots.session.lexical ? roots.artifacts?.lexical : join(parentDir, "session-artifacts");
	if (!artifactDir) throw invalidFamilyTopology("managed artifact directory is absent");
	return join(artifactDir, parent.id, "rlm-subagents.jsonl");
}

function isWithin(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function invalidFamilyTopology(reason: string): Error {
	return new Error(`Invalid RLM artifact family topology: ${reason}`);
}

async function managedRoots(sessionDir: string | undefined): Promise<ManagedRoots> {
	const sessionLexical = resolve(sessionDir ?? "");
	let sessionCanonical: string;
	try {
		sessionCanonical = await realpath(sessionLexical);
	} catch (error) {
		throw invalidFamilyTopology(`managed session directory is unavailable: ${String(error)}`);
	}
	const artifactLexical = join(dirname(sessionLexical), "session-artifacts");
	let artifacts: ManagedRoots["artifacts"];
	try {
		const artifactCanonical = await realpath(artifactLexical);
		artifacts = { lexical: artifactLexical, canonical: artifactCanonical };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw invalidFamilyTopology(`managed artifact directory is unreadable: ${String(error)}`);
		}
	}
	return { session: { lexical: sessionLexical, canonical: sessionCanonical }, artifacts };
}

/**
 * Resolve a persisted path only beneath a selected daemon session root. The
 * lexical/realpath pair rejects aliases and every link component below the
 * authority-owned root before the final O_NOFOLLOW open.
 */
async function trustedManagedPath(rawPath: string, roots: ManagedRoots): Promise<string> {
	if (!isAbsolute(rawPath) || rawPath !== resolve(rawPath)) {
		throw invalidFamilyTopology("session path is not canonical");
	}
	const root = [roots.session, roots.artifacts].find((candidate) => candidate && isWithin(candidate.lexical, rawPath));
	if (!root) throw invalidFamilyTopology("session path escapes managed roots");
	const suffix = relative(root.lexical, rawPath);
	let current = root.lexical;
	for (const component of suffix ? suffix.split(/[/\\]+/) : []) {
		current = join(current, component);
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(current);
		} catch (error) {
			throw invalidFamilyTopology(`session path is unreadable: ${String(error)}`);
		}
		if (stats.isSymbolicLink()) throw invalidFamilyTopology("session path contains a symbolic link");
	}
	let canonical: string;
	try {
		canonical = await realpath(rawPath);
	} catch (error) {
		throw invalidFamilyTopology(`session path is unreadable: ${String(error)}`);
	}
	if (canonical !== join(root.canonical, suffix)) {
		throw invalidFamilyTopology("session path is an alias or crosses a symbolic link");
	}
	return rawPath;
}

async function readNoFollow(path: string, maxBytes: number): Promise<string> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = await handle.stat();
		if (!stats.isFile()) throw invalidFamilyTopology("artifact is not a regular file");
		if (stats.size > maxBytes) throw invalidFamilyTopology("artifact exceeds byte limit");
		return await handle.readFile({ encoding: "utf8" });
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Invalid RLM artifact family topology:")) throw error;
		throw invalidFamilyTopology(`artifact is unreadable: ${String(error)}`);
	} finally {
		await handle?.close();
	}
}

async function readTrustedSession(path: string, roots: ManagedRoots): Promise<TrustedSession> {
	const trustedPath = await trustedManagedPath(path, roots);
	const headerLine = (await readNoFollow(trustedPath, 256 * 1024)).split(/\r?\n/, 1)[0];
	let header: { type?: unknown; id?: unknown; parentSession?: unknown; rlmDepth?: unknown };
	try {
		header = JSON.parse(headerLine ?? "") as typeof header;
	} catch {
		throw invalidFamilyTopology("session header is malformed");
	}
	const hasParent = header.parentSession !== undefined;
	const hasDepth = Number.isSafeInteger(header.rlmDepth) && (header.rlmDepth as number) >= 0;
	if (
		header.type !== "session" ||
		typeof header.id !== "string" ||
		header.id === "" ||
		(hasParent && typeof header.parentSession !== "string") ||
		(hasParent && header.parentSession === "") ||
		(hasParent && !hasDepth) ||
		(!hasParent && header.rlmDepth !== undefined && !hasDepth)
	) {
		throw invalidFamilyTopology("session header lacks trustworthy topology claims");
	}
	// SessionManager headers predating the explicit depth field may be roots.
	// Their root claim is exactly zero only because the persisted header has no
	// parent claim; never derive it from SessionInfo's legacy depth fallback.
	const persistedDepth = hasDepth ? (header.rlmDepth as number) : 0;
	const info = await readSessionInfo(trustedPath);
	if (!info || info.id !== header.id) throw invalidFamilyTopology("session metadata does not match its header");
	return {
		...info,
		path: trustedPath,
		rlmDepth: persistedDepth,
		persistedDepth,
		...(hasParent ? { persistedParentPath: header.parentSession as string } : {}),
	};
}

async function readLatestRegistry(path: string, roots: ManagedRoots): Promise<SavedRlmSubagentRegistryEntry[] | undefined> {
	try {
		await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw invalidFamilyTopology(`registry is unreadable: ${String(error)}`);
	}
	// Registry paths are constructed from a trusted parent, but the artifact
	// subtree is attacker-writable; verify each component before opening it.
	await trustedManagedPath(path, roots);
	const contents = await readNoFollow(path, MAX_RLM_REGISTRY_BYTES);
	const latest = new Map<string, SavedRlmSubagentRegistryEntry>();
	let records = 0;
	for (const line of contents.split(/\r?\n/)) {
		if (!line.trim()) continue;
		if (++records > MAX_RLM_REGISTRY_RECORDS) throw invalidFamilyTopology("registry record limit exhausted");
		let entry: SavedRlmSubagentRegistryEntry;
		try {
			entry = JSON.parse(line) as SavedRlmSubagentRegistryEntry;
		} catch {
			throw invalidFamilyTopology("registry contains malformed JSON");
		}
		if (
			entry.type !== "rlm_subagent" ||
			typeof entry.childId !== "string" ||
			entry.childId === "" ||
			typeof entry.sessionFile !== "string" ||
			entry.sessionFile === "" ||
			(entry.status !== "running" && entry.status !== "completed" && entry.status !== "deleted")
		) {
			throw invalidFamilyTopology("registry contains an invalid edge");
		}
		latest.set(entry.childId, entry);
	}
	return [...latest.values()];
}

/**
 * Produces an all-or-nothing durable topology. Missing registries are simply
 * absent; every other malformed, unreadable, cyclic, aliased, or exhausted
 * edge rejects the entire authorization snapshot instead of returning a
 * partial tree that could authorize a message.
 */
export async function listCatalogFamilySessions(sessionDir?: string): Promise<SessionInfo[]> {
	const roots = await SessionManager.listAll(undefined, sessionDir);
	const authority = await managedRoots(sessionDir);
	const sessions = new Map<string, SessionInfo>();
	for (const root of roots) {
		const trusted = await readTrustedSession(root.path, authority);
		sessions.set(trusted.path, trusted);
	}
	let edges = 0;
	const visited = new Set<string>();
	const visit = async (parent: TrustedSession, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
		if (depth > MAX_RLM_FAMILY_DEPTH) throw invalidFamilyTopology("family depth limit exhausted");
		const parentPath = parent.path;
		if (ancestors.has(parentPath)) throw invalidFamilyTopology("family contains a cycle");
		if (visited.has(parentPath)) return;
		visited.add(parentPath);
		const registryPath = rlmSubagentRegistryPath(parent, authority);
		const entries = await readLatestRegistry(registryPath, authority);
		if (!entries) return;
		const childAncestors = new Set(ancestors);
		childAncestors.add(parentPath);
		for (const entry of entries) {
			if (entry.status === "deleted") continue;
			if (++edges > MAX_RLM_FAMILY_EDGES) throw invalidFamilyTopology("family edge limit exhausted");
			const childPath = await trustedManagedPath(entry.sessionFile as string, authority);
			if (childAncestors.has(childPath)) throw invalidFamilyTopology("family contains a cycle");
			const child = await readTrustedSession(childPath, authority);
			if (child.id !== entry.childId) throw invalidFamilyTopology("registry child id does not match session id");
			if (child.persistedParentPath === undefined) throw invalidFamilyTopology("child lacks a persisted parent path");
			const claimedParentPath = await trustedManagedPath(
				resolve(dirname(child.path), child.persistedParentPath),
				authority,
			);
			if (claimedParentPath !== parentPath) throw invalidFamilyTopology("child parent path does not match traversed parent");
			if (child.persistedDepth !== parent.persistedDepth + 1) {
				throw invalidFamilyTopology("child depth does not equal parent depth plus one");
			}
			if (!sessions.has(child.path) && sessions.size >= MAX_RLM_FAMILY_NODES) {
				throw invalidFamilyTopology("family node limit exhausted");
			}
			sessions.set(child.path, child);
			await visit(child, depth + 1, childAncestors);
		}
	};
	for (const root of [...sessions.values()] as TrustedSession[]) await visit(root, 0, new Set());
	return [...sessions.values()];
}

export async function listSavedSessionSiblings(sessionPath: string, sessionDir?: string): Promise<SessionInfo[]> {
	const family = await listCatalogFamilySessions(sessionDir);
	const targetPath = resolve(sessionPath);
	const target = family.find((session) => session.path === targetPath);
	if (!target) throw new Error(`Session not found: ${sessionPath}`);
	if (!target.parentSessionPath) return [target];
	const parentPath = resolve(dirname(target.path), target.parentSessionPath);
	return family.filter(
		(session) =>
			session.parentSessionPath !== undefined &&
			resolve(dirname(session.path), session.parentSessionPath) === parentPath,
	);
}

/** @internal Exported to pin catalog selector semantics without spawning a catalog process. */
export function resolveCatalogSessionMatch(
	sessions: readonly SessionInfo[],
	selector: string,
): SessionInfo | undefined {
	// Deliberate broadening for create/resume as well as a2a wake: exact names
	// participate alongside id prefixes. Therefore a name that collides with an
	// id prefix is now ambiguous instead of the id-prefix match winning.
	const matches = sessions.filter((session) => session.id.startsWith(selector) || session.name === selector);
	if (matches.length > 1) {
		throw new Error(`Ambiguous session selector "${selector}"`);
	}
	return matches[0];
}

function isCatalogOutbound(value: unknown): value is CatalogOutbound {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown };
	return (
		candidate.type === "ready" ||
		((candidate.type === "progress" || candidate.type === "session" || candidate.type === "response") &&
			typeof candidate.id === "string")
	);
}

function isCatalogRequest(value: unknown): value is CatalogRequest {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown; command?: unknown };
	return (
		candidate.type === "request" &&
		typeof candidate.id === "string" &&
		(candidate.command === "list" ||
			candidate.command === "family" ||
			candidate.command === "resolve" ||
			candidate.command === "siblings" ||
			candidate.command === "rename" ||
			candidate.command === "delete" ||
			candidate.command === "archive" ||
			candidate.command === "mark_interrupted" ||
			candidate.command === "shutdown")
	);
}

function sendCatalogMessage(message: CatalogOutbound): void {
	if (process.send) {
		process.send(message);
	}
}

export function isDaemonCatalogProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_CATALOG_ROLE_ENV] === "1";
}

export async function runDaemonCatalogProcess(): Promise<never> {
	process.on("disconnect", () => process.exit(0));
	process.on("message", (value: unknown) => {
		if (!isCatalogRequest(value)) {
			return;
		}
		void handleCatalogRequest(value);
	});
	sendCatalogMessage({ type: "ready" });
	return new Promise(() => {});
}

async function handleCatalogRequest(request: CatalogRequest): Promise<void> {
	try {
		switch (request.command) {
			case "list": {
				const callbacks = {
					onProgress: (loaded: number, total: number) =>
						sendCatalogMessage({ type: "progress", id: request.id, loaded, total }),
					onSession: (session: SessionInfo) =>
						sendCatalogMessage({ type: "session", id: request.id, session: serializeSessionInfo(session) }),
				};
				const sessions = request.cwd
					? await SessionManager.list(request.cwd, request.sessionDir, callbacks)
					: await SessionManager.listAll(callbacks, request.sessionDir);
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: sessions.map(serializeSessionInfo) },
				});
				return;
			}
			case "family": {
				const sessions = await listCatalogFamilySessions(request.sessionDir);
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: sessions.map(serializeSessionInfo) },
				});
				return;
			}
			case "resolve": {
				const localMatch = resolveCatalogSessionMatch(
					await SessionManager.list(request.cwd, request.sessionDir),
					request.selector,
				);
				if (localMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: localMatch.path },
					});
					return;
				}
				const globalMatch = resolveCatalogSessionMatch(
					await SessionManager.listAll(undefined, request.sessionDir),
					request.selector,
				);
				if (globalMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: globalMatch.path },
					});
					return;
				}
				throw new Error(`No session found matching '${request.selector}'`);
			}
			case "siblings":
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: (await listSavedSessionSiblings(request.sessionPath, request.sessionDir)).map(serializeSessionInfo) },
				});
				return;
			case "rename":
				SessionManager.open(request.sessionPath).appendSessionInfo(request.name.trim());
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			case "delete":
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: await deleteSessionFile(request.sessionPath),
				});
				return;
			case "archive": {
				const session = await readSessionInfo(request.sessionPath);
				if (!session || session.id !== request.sessionId) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { archived: false },
					});
					return;
				}
				if (session.state?.status !== "archived") {
					SessionManager.open(request.sessionPath).appendSessionState({ status: "archived" });
				}
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { archived: true },
				});
				return;
			}
			case "mark_interrupted":
				SessionManager.open(request.sessionPath).appendCustomMessageEntry(
					"prime-agent.worker_recovery",
					"<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>",
					false,
					{
						activeSessionId: request.activeSessionId,
						operations: request.operations,
					},
				);
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			case "shutdown":
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				setImmediate(() => process.exit(0));
				return;
		}
	} catch (error) {
		sendCatalogMessage({
			type: "response",
			id: request.id,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export class DaemonCatalogClient {
	private child?: ChildProcess;
	private starting?: Promise<void>;
	private readonly pending = new Map<
		string,
		{
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			callbacks?: CatalogListCallbacks;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(private readonly onDiagnostic: (message: string) => void) {}

	async start(): Promise<void> {
		if (this.child?.connected) {
			return;
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = this.spawnCatalog().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async list(cwd?: string, sessionDir?: string, callbacks?: CatalogListCallbacks): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>(
			{ type: "request", id: randomUUID(), command: "list", cwd, sessionDir },
			callbacks,
		);
		return data.sessions.map(deserializeSessionInfo);
	}

	async family(sessionDir?: string): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>({
			type: "request",
			id: randomUUID(),
			command: "family",
			sessionDir,
		});
		return data.sessions.map(deserializeSessionInfo);
	}

	async siblings(sessionPath: string, sessionDir?: string): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>({
			type: "request",
			id: randomUUID(),
			command: "siblings",
			sessionPath,
			sessionDir,
		});
		return data.sessions.map(deserializeSessionInfo);
	}

	async rename(sessionPath: string, name: string): Promise<void> {
		await this.request({ type: "request", id: randomUUID(), command: "rename", sessionPath, name });
	}

	async resolve(selector: string, cwd: string, sessionDir?: string): Promise<string> {
		const data = await this.request<{ sessionPath: string }>({
			type: "request",
			id: randomUUID(),
			command: "resolve",
			selector,
			cwd,
			sessionDir,
		});
		return data.sessionPath;
	}

	delete(sessionPath: string): Promise<DeleteSessionFileResult> {
		return this.request({ type: "request", id: randomUUID(), command: "delete", sessionPath });
	}

	async archive(sessionPath: string, sessionId: string): Promise<boolean> {
		const data = await this.request<{ archived: boolean }>({
			type: "request",
			id: randomUUID(),
			command: "archive",
			sessionPath,
			sessionId,
		});
		return data.archived;
	}

	async markInterrupted(sessionPath: string, activeSessionId: string, operations: string[]): Promise<void> {
		await this.request({
			type: "request",
			id: randomUUID(),
			command: "mark_interrupted",
			sessionPath,
			activeSessionId,
			operations,
		});
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}
		await this.request({ type: "request", id: randomUUID(), command: "shutdown" }).catch(() => undefined);
		child.disconnect();
		this.child = undefined;
	}

	private async spawnCatalog(): Promise<void> {
		const launch = createCliSubprocessLaunchSpec(["--version"]);
		const child = spawn(launch.command, launch.args, {
			cwd: process.cwd(),
			env: createCliSubprocessEnv({ ...process.env, [DAEMON_CATALOG_ROLE_ENV]: "1" }),
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		this.child = child;
		child.on("message", (value: unknown) => this.handleMessage(value));
		child.on("error", (error) => this.handleClose(child, error));
		child.on("exit", (code, signal) =>
			this.handleClose(child, new Error(`Daemon catalog exited (${signal ?? code ?? "unknown"})`)),
		);
		await new Promise<void>((resolveReady, rejectReady) => {
			const timeout = setTimeout(() => {
				cleanup();
				const error = new Error("Timed out starting daemon catalog");
				this.handleClose(child, error);
				if (child.connected) {
					child.disconnect();
				}
				child.kill("SIGKILL");
				rejectReady(error);
			}, 5000);
			const cleanup = () => {
				clearTimeout(timeout);
				child.off("message", onMessage);
				child.off("error", onError);
			};
			const onMessage = (value: unknown) => {
				if (isCatalogOutbound(value) && value.type === "ready") {
					cleanup();
					resolveReady();
				}
			};
			const onError = (error: Error) => {
				cleanup();
				rejectReady(error);
			};
			child.on("message", onMessage);
			child.once("error", onError);
		});
	}

	private async request<T = void>(request: CatalogRequest, callbacks?: CatalogListCallbacks): Promise<T> {
		await this.start();
		const child = this.child;
		if (!child?.connected) {
			throw new Error("Daemon catalog is not connected");
		}
		return new Promise<T>((resolveRequest, rejectRequest) => {
			const timeout = setTimeout(
				() => {
					if (!this.pending.delete(request.id)) {
						return;
					}
					child.kill("SIGKILL");
					rejectRequest(new Error(`Timed out waiting for daemon catalog ${request.command}`));
				},
				5 * 60 * 1000,
			);
			this.pending.set(request.id, {
				resolve: (data) => resolveRequest(data as T),
				reject: rejectRequest,
				callbacks,
				timeout,
			});
			child.send(request, (error) => {
				if (!error) {
					return;
				}
				const pending = this.pending.get(request.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pending.delete(request.id);
				}
				rejectRequest(error);
			});
		});
	}

	private handleMessage(value: unknown): void {
		if (!isCatalogOutbound(value) || value.type === "ready") {
			return;
		}
		const pending = this.pending.get(value.id);
		if (!pending) {
			return;
		}
		if (value.type === "progress") {
			pending.callbacks?.onProgress?.(value.loaded, value.total);
			return;
		}
		if (value.type === "session") {
			pending.callbacks?.onSession?.(deserializeSessionInfo(value.session));
			return;
		}
		this.pending.delete(value.id);
		clearTimeout(pending.timeout);
		if (value.success) {
			pending.resolve(value.data);
		} else {
			pending.reject(new Error(value.error));
		}
	}

	private handleClose(child: ChildProcess, error: Error): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		this.onDiagnostic(error.message);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}
