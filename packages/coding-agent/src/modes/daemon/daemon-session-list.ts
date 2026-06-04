import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.js";
import type { SessionInfo } from "../../core/session-manager.js";
import type { AgentConnectionSavedSessionStateStatus } from "../agent-connection/types.js";
import type { ActiveSessionState } from "./active-session-state.js";

export type SessionStatus = "user" | "idle" | "tool" | "model" | AgentConnectionSavedSessionStateStatus;

// Lightweight daemon session shape used by list, create, rename, attach, and state responses.
export interface SessionSummary {
	id: string;
	status: SessionStatus;
	runtimeKind?: "top-level" | "subagent";
	activeSessionId?: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	attachedClients: number;
	messageCount: number;
	pendingMessageCount: number;
	streamingMessage?: AgentMessage;
	created?: string;
	modified?: string;
	firstMessage?: string;
	parentActiveSessionId?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	rlmChildId?: string;
	rlmParentNodeId?: string;
	modelFallbackMessage?: string;
	diagnostics?: AgentSessionRuntimeDiagnostic[];
}

export function buildSessionList(
	activeSessions: readonly ActiveSessionState[],
	savedSessions: readonly SessionInfo[],
): SessionSummary[] {
	const activeBySessionFile = new Map<string, ActiveSessionState>();

	for (const activeSession of activeSessions) {
		const sessionFile = activeSession.runtime.session.sessionFile;
		if (sessionFile) {
			activeBySessionFile.set(resolve(sessionFile), activeSession);
		}
	}

	const entries: SessionSummary[] = [];
	const seenActiveSessionIds = new Set<string>();
	for (const savedSession of savedSessions) {
		const sessionFile = resolve(savedSession.path);
		const activeSession = activeBySessionFile.get(sessionFile);
		if (activeSession) {
			entries.push(summaryForActiveSession(activeSession, savedSession));
			seenActiveSessionIds.add(activeSession.activeSessionId);
			continue;
		}
		entries.push(summaryForInactiveSession(savedSession));
	}

	for (const activeSession of activeSessions) {
		if (!seenActiveSessionIds.has(activeSession.activeSessionId)) {
			entries.push(summaryForActiveSession(activeSession));
		}
	}
	return entries;
}

export function summaryForActiveSession(activeSession: ActiveSessionState, savedSession?: SessionInfo): SessionSummary {
	const session = activeSession.runtime.session;
	const metadata = activeSession.runtime.metadata ?? { kind: "top-level" as const };
	let modified = savedSession?.modified.toISOString();
	if (!modified && session.sessionFile) {
		try {
			modified = statSync(session.sessionFile).mtime.toISOString();
		} catch {
			// Leave age blank when the active session has not flushed a jsonl yet.
		}
	}

	return {
		id: activeSession.activeSessionId,
		status: activeStatusForSession(activeSession),
		runtimeKind: metadata.kind,
		activeSessionId: activeSession.activeSessionId,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.sessionManager.getCwd(),
		model: session.model as Model<Api> | undefined,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		attachedClients: activeSession.clients.size,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		streamingMessage: session.state.streamingMessage,
		created: savedSession?.created.toISOString(),
		modified,
		firstMessage: savedSession?.firstMessage,
		parentActiveSessionId: metadata.parentActiveSessionId,
		parentSessionId: metadata.parentSessionId,
		parentSessionPath: savedSession?.parentSessionPath ?? metadata.parentSessionFile,
		rlmChildId: metadata.rlmChildId,
		rlmParentNodeId: metadata.rlmParentNodeId,
		modelFallbackMessage: activeSession.runtime.modelFallbackMessage,
		diagnostics: [...activeSession.runtime.diagnostics],
	};
}

export function summaryForInactiveSession(session: SessionInfo): SessionSummary {
	return {
		id: session.id,
		status: session.state?.status ?? "sleep",
		sessionId: session.id,
		sessionFile: session.path,
		sessionName: session.name,
		cwd: session.cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: session.messageCount,
		pendingMessageCount: 0,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		firstMessage: session.firstMessage,
		parentSessionPath: session.parentSessionPath,
	};
}

function activeStatusForSession(activeSession: ActiveSessionState): SessionStatus {
	const session = activeSession.runtime.session;
	if (session.isStreaming) {
		return session.state.pendingToolCalls.size > 0 ? "tool" : "model";
	}
	return activeSession.clients.size > 0 ? "user" : "idle";
}
