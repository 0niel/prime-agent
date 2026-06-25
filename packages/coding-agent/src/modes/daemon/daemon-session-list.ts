import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compactRlmText } from "../../core/agent-session.js";
import type { AgentSessionRuntimeMetadata } from "../../core/agent-session-runtime.js";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.js";
import type { AgentTaskState, SessionInfo } from "../../core/session-manager.js";
import type {
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionRlmChildAgentTranscriptLine,
	AgentConnectionSavedSessionStateStatus,
} from "../agent-connection/types.js";
import type { ActiveSessionState } from "./active-session-state.js";

export type SessionStatus = "user" | "idle" | "tool" | "model" | AgentConnectionSavedSessionStateStatus;

// Upper bound on the spawn-code source carried in a session summary. Generous
// enough for real spawn cells while keeping the daemon wire payload bounded.
const SPAWN_CODE_MAX_CHARS = 4000;

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
	isBashRunning?: boolean;
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
	/** Source of the IPython cell that spawned this subagent, for display. */
	spawnCode?: string;
	modelFallbackMessage?: string;
	diagnostics?: AgentSessionRuntimeDiagnostic[];
	/** One-line background summary of what the agent is doing or just did. */
	summary?: string;
	/** Completion verdict for an idle session; absent while working or unjudged. */
	taskState?: AgentTaskState;
}

/**
 * Pick the model fallback message to show when attaching to a daemon session.
 *
 * The daemon's summary is authoritative. The attaching process's own startup
 * snapshot only applies when the summary reports no model: a UI process may
 * compute "no models available" merely because it cannot see credentials the
 * daemon resolves fine (e.g. an env var set only for the daemon).
 */
export function resolveAttachModelFallbackMessage(
	summary: SessionSummary,
	startupModelFallbackMessage: string | undefined,
): string | undefined {
	if (summary.modelFallbackMessage) {
		return summary.modelFallbackMessage;
	}
	return summary.model ? undefined : startupModelFallbackMessage;
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
		isBashRunning: session.isBashRunning,
		attachedClients: activeSession.clients.size,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		streamingMessage: session.state.streamingMessage,
		created: savedSession?.created.toISOString(),
		modified,
		// Subagent sessions live in artifact dirs that the saved-session scan
		// never sees; their spawn prompt is the most identifying title we have.
		// A freshly created top-level session has neither yet — its jsonl is not
		// scanned until it flushes — so derive from the live first user message to
		// avoid titling the chat with its session ID until the file lands.
		firstMessage:
			savedSession?.firstMessage ??
			(metadata.prompt ? compactRlmText(metadata.prompt, 120) : undefined) ??
			firstUserMessageText(session),
		parentActiveSessionId: metadata.parentActiveSessionId,
		parentSessionId: metadata.parentSessionId,
		parentSessionPath: savedSession?.parentSessionPath ?? metadata.parentSessionFile,
		rlmChildId: metadata.rlmChildId,
		rlmParentNodeId: metadata.rlmParentNodeId,
		// Cap the cell source so the summary stays small on the daemon wire; the
		// agents view truncates further for display.
		spawnCode: metadata.spawnCode ? metadata.spawnCode.slice(0, SPAWN_CODE_MAX_CHARS) : undefined,
		modelFallbackMessage: activeSession.runtime.modelFallbackMessage,
		diagnostics: [...activeSession.runtime.diagnostics],
		// Keep the last recap visible across turns so the view never blanks, but
		// gate the verdict on currency: a stale "completed" must not show on a turn
		// that is active again.
		summary: activeSession.summaryState?.summary,
		...(isSummaryCurrent(activeSession) ? { taskState: activeSession.summaryState?.taskState } : {}),
	};
}

export function isSummaryCurrent(activeSession: ActiveSessionState): boolean {
	const status = activeSession.summaryState;
	return status !== undefined && status.basedOnMessageCount === activeSession.runtime.session.messages.length;
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

/**
 * Build snapshots for all RLM child sessions hosted by the daemon under the
 * given session, including grandchildren. Mirrors the shape of live
 * rlm_child_update events so attach clients can seed their subagent state
 * from daemon memory instead of replaying the event stream.
 */
export function buildRlmChildSnapshots(
	rootActiveSessionId: string,
	activeSessions: readonly ActiveSessionState[],
): AgentConnectionRlmChildAgentSnapshot[] {
	const childrenByParent = new Map<string, ActiveSessionState[]>();
	for (const candidate of activeSessions) {
		const metadata = candidate.runtime.metadata;
		if (metadata.kind !== "subagent" || !metadata.parentActiveSessionId) {
			continue;
		}
		const siblings = childrenByParent.get(metadata.parentActiveSessionId) ?? [];
		siblings.push(candidate);
		childrenByParent.set(metadata.parentActiveSessionId, siblings);
	}

	const snapshots: AgentConnectionRlmChildAgentSnapshot[] = [];
	const visit = (parent: ActiveSessionState | undefined, parentActiveSessionId: string): void => {
		const parentNodeId = parent?.runtime.metadata.rlmChildId;
		for (const child of childrenByParent.get(parentActiveSessionId) ?? []) {
			snapshots.push(rlmChildSnapshotForActiveSession(child, child.runtime.metadata, parentNodeId, parent));
			// A child passes its own node id to its children as their parent id.
			visit(child, child.activeSessionId);
		}
	};
	const root = activeSessions.find((candidate) => candidate.activeSessionId === rootActiveSessionId);
	visit(root, rootActiveSessionId);
	return snapshots;
}

function rlmChildSnapshotForActiveSession(
	activeSession: ActiveSessionState,
	metadata: AgentSessionRuntimeMetadata,
	parentNodeId: string | undefined,
	parent: ActiveSessionState | undefined,
): AgentConnectionRlmChildAgentSnapshot {
	const session = activeSession.runtime.session;
	const transcript: AgentConnectionRlmChildAgentTranscriptLine[] = [];
	let answerPreview: string | undefined;
	for (const message of session.messages) {
		if (message.role !== "user" && message.role !== "assistant") {
			continue;
		}
		const text = compactRlmText(readMessageText(message.content));
		if (!text) {
			continue;
		}
		transcript.push({ role: message.role, text });
		if (message.role === "assistant") {
			answerPreview = text;
		}
	}
	// The parent session's run tracker is the source of truth for child status;
	// a daemon-hosted child whose agent is momentarily idle is still part of an
	// active run. The streaming heuristic only covers parents the daemon does
	// not host (e.g. children attributed to a session created by an older build).
	const runStatus = metadata.rlmChildId
		? parent?.runtime.session.getRlmChildRunStatus(metadata.rlmChildId)
		: undefined;
	return {
		id: metadata.rlmChildId ?? activeSession.activeSessionId,
		parentId: parentNodeId,
		label: compactRlmText(metadata.prompt ?? "", 80) || "child agent",
		status: runStatus ?? (session.isStreaming || session.pendingMessageCount > 0 ? "running" : "done"),
		answerPreview,
		sessionDir: metadata.sessionDir ?? session.sessionManager.getSessionDir(),
		transcript,
	};
}

function firstUserMessageText(session: ActiveSessionState["runtime"]["session"]): string | undefined {
	for (const message of session.messages) {
		if (message.role !== "user") {
			continue;
		}
		const text = compactRlmText(readMessageText(message.content), 120).trim();
		if (text) {
			return text;
		}
	}
	return undefined;
}

function readMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function activeStatusForSession(activeSession: ActiveSessionState): SessionStatus {
	const session = activeSession.runtime.session;
	if (session.isStreaming) {
		return session.state.pendingToolCalls.size > 0 ? "tool" : "model";
	}
	return activeSession.clients.size > 0 ? "user" : "idle";
}
