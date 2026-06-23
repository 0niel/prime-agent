import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Transport } from "@earendil-works/pi-ai";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { AgentCronJob, AgentHeartbeatUpdateAction } from "../../core/cron-jobs.js";
import type { SessionCwdIssue } from "../../core/session-cwd.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type {
	AgentConnectionQueueMode,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSavedSessionScope,
	AgentConnectionSavedSessionState,
	AgentConnectionScopedModel,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSessionTreeNode,
	AgentConnectionState,
} from "../agent-connection/types.js";
import type { SessionSummary } from "./daemon-session-list.js";

/**
 * Local daemon JSONL protocol.
 *
 * This is the transport used by DaemonAgentConnection today, not the final
 * remote gateway protocol. The protocol primitives below are intentionally
 * JSON-serializable so a future gateway can wrap or proxy this local transport
 * without leaking transport details back into InteractiveMode.
 */

export const DAEMON_PROTOCOL_NAME = "prime-agent.daemon";
export const DAEMON_PROTOCOL_VERSION = 1;

export type DaemonProtocolName = typeof DAEMON_PROTOCOL_NAME;
export type DaemonProtocolVersion = typeof DAEMON_PROTOCOL_VERSION;
export type DaemonCommandId = string;
export type DaemonEventId = string;
export type DaemonEventSequence = number;
export type DaemonClientId = string;
export type DaemonClientCapability = "attach_snapshot" | "event_sequence" | "extension_ui" | "slim_attach";
export type DaemonReplayStatus = "complete" | "partial" | "unavailable";

export interface DaemonProtocolInfo {
	name: DaemonProtocolName;
	version: DaemonProtocolVersion;
}

export const DAEMON_PROTOCOL_INFO: DaemonProtocolInfo = {
	name: DAEMON_PROTOCOL_NAME,
	version: DAEMON_PROTOCOL_VERSION,
};

export const DAEMON_DEFAULT_CLIENT_CAPABILITIES: readonly DaemonClientCapability[] = [
	"attach_snapshot",
	"event_sequence",
];

export interface DaemonResumeCursor {
	activeSessionId?: string;
	eventSequence: DaemonEventSequence;
}

export interface DaemonAttachClientMetadata {
	clientId?: DaemonClientId;
	capabilities?: readonly DaemonClientCapability[];
	resumeCursor?: DaemonResumeCursor;
}

export interface DaemonReplayInfo {
	status: DaemonReplayStatus;
	fromSequence?: DaemonEventSequence;
	toSequence: DaemonEventSequence;
	reason?: string;
}

export interface DaemonEventMeta {
	id: DaemonEventId;
	protocol: DaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: DaemonEventSequence;
	emittedAt: string;
	replayed?: boolean;
}

export interface DaemonCommandEnvelope<TCommand extends DaemonCommand = DaemonCommand> {
	type: "command";
	id: DaemonCommandId;
	protocol: DaemonProtocolInfo;
	clientId?: DaemonClientId;
	command: TCommand;
}

export interface DaemonEventEnvelope<TEvent extends DaemonOutbound = DaemonOutbound> {
	type: "event";
	id: DaemonEventId;
	protocol: DaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: DaemonEventSequence;
	emittedAt: string;
	event: TEvent;
}

export interface DaemonArtifactReference {
	id: string;
	sessionId: string;
	type: string;
	logicalPath: string;
	relativePath?: string;
	mimeType?: string;
	metadata?: Record<string, string | number | boolean | null>;
}

export interface DaemonSessionSnapshot {
	activeSessionId: string;
	summary: SessionSummary;
	state: AgentConnectionState;
	messages: AgentMessage[];
	sessionContext?: AgentConnectionSessionContext;
	sessionTree?: { tree: AgentConnectionSessionTreeNode[]; leafId: string | null };
	lastEventSequence: DaemonEventSequence;
	parent?: {
		activeSessionId?: string;
		sessionId?: string;
		nodeId?: string;
		childId?: string;
	};
	/** Live RLM child sessions (including grandchildren) hosted by the daemon under this session. */
	children?: AgentConnectionRlmChildAgentSnapshot[];
}

export interface DaemonAttachResult {
	protocol: DaemonProtocolInfo;
	activeSessionId: string;
	/** Omitted for clients with the "slim_attach" capability; use snapshot.summary. */
	state?: SessionSummary;
	/** Omitted for clients with the "slim_attach" capability; use snapshot.messages. */
	messages?: AgentMessage[];
	snapshot: DaemonSessionSnapshot;
	replay: DaemonReplayInfo;
	lastEventSequence: DaemonEventSequence;
	client: {
		id: DaemonClientId;
		capabilities: DaemonClientCapability[];
	};
}

export type DaemonCommand =
	| { id?: string; type: "list"; all?: boolean; cwd?: string; sessionDir?: string }
	| { id?: string; type: "list_saved_sessions"; activeSessionId: string; scope: AgentConnectionSavedSessionScope }
	| {
			id?: string;
			type: "create";
			sessionPath?: string;
			continueRecent?: boolean;
			name?: string;
			config?: AgentSessionRuntimeConfig;
	  }
	| ({
			id?: string;
			type: "attach";
			activeSessionId: string;
			supportsExtensionUi?: boolean;
	  } & DaemonAttachClientMetadata)
	| { id?: string; type: "detach"; activeSessionId?: string }
	| { id?: string; type: "kill"; activeSessionId: string }
	| { id?: string; type: "rename"; activeSessionId: string; name: string }
	| {
			id?: string;
			type: "prompt";
			activeSessionId: string;
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer"; activeSessionId: string; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; activeSessionId: string; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort"; activeSessionId: string }
	| {
			id?: string;
			type: "execute_bash";
			activeSessionId: string;
			command: string;
			excludeFromContext?: boolean;
	  }
	| { id?: string; type: "abort_bash"; activeSessionId: string }
	| { id?: string; type: "cancel_rlm_child"; activeSessionId: string; childId: string }
	| { id?: string; type: "wait_for_idle"; activeSessionId: string }
	| { id?: string; type: "get_state"; activeSessionId: string }
	| { id?: string; type: "get_connection_state"; activeSessionId: string }
	| { id?: string; type: "get_messages"; activeSessionId: string }
	| { id?: string; type: "get_session_stats"; activeSessionId: string }
	| { id?: string; type: "get_context_tree"; activeSessionId: string }
	| { id?: string; type: "get_commands"; activeSessionId: string }
	| { id?: string; type: "get_resource_snapshot"; activeSessionId: string }
	| { id?: string; type: "get_available_models"; activeSessionId: string }
	| { id?: string; type: "get_queue"; activeSessionId: string }
	| { id?: string; type: "clear_queue"; activeSessionId: string }
	| { id?: string; type: "cron_list"; activeSessionId?: string; includeInactive?: boolean }
	| { id?: string; type: "cron_add"; activeSessionId: string; schedule: string; prompt: string }
	| { id?: string; type: "cron_cancel"; jobId: string }
	| { id?: string; type: "heartbeat_get"; activeSessionId: string }
	| { id?: string; type: "heartbeat_set"; activeSessionId: string; schedule: string; prompt: string }
	| { id?: string; type: "heartbeat_update"; activeSessionId: string; action: AgentHeartbeatUpdateAction }
	| { id?: string; type: "set_model"; activeSessionId: string; provider: string; modelId: string }
	| { id?: string; type: "cycle_model"; activeSessionId: string; direction?: "forward" | "backward" }
	| { id?: string; type: "set_scoped_models"; activeSessionId: string; scopedModels: AgentConnectionScopedModel[] }
	| { id?: string; type: "set_thinking_level"; activeSessionId: string; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level"; activeSessionId: string }
	| { id?: string; type: "set_transport"; activeSessionId: string; transport: Transport }
	| { id?: string; type: "set_steering_mode"; activeSessionId: string; mode: AgentConnectionQueueMode }
	| { id?: string; type: "set_follow_up_mode"; activeSessionId: string; mode: AgentConnectionQueueMode }
	| { id?: string; type: "set_auto_compaction"; activeSessionId: string; enabled: boolean }
	| { id?: string; type: "compact"; activeSessionId: string; customInstructions?: string }
	| { id?: string; type: "refine"; activeSessionId: string; instructions?: string; rollbackId?: string }
	| { id?: string; type: "abort_compaction"; activeSessionId: string }
	| { id?: string; type: "abort_branch_summary"; activeSessionId: string }
	| { id?: string; type: "abort_retry"; activeSessionId: string }
	| { id?: string; type: "reload"; activeSessionId: string }
	| { id?: string; type: "new_session"; activeSessionId: string; parentSession?: string }
	| { id?: string; type: "switch_session"; activeSessionId: string; sessionPath: string; cwdOverride?: string }
	| { id?: string; type: "fork"; activeSessionId: string; entryId: string; position?: "before" | "at" }
	| {
			id?: string;
			type: "navigate_tree";
			activeSessionId: string;
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  }
	| { id?: string; type: "import_jsonl"; activeSessionId: string; inputPath: string; cwdOverride?: string }
	| { id?: string; type: "export_html"; activeSessionId: string; outputPath?: string }
	| { id?: string; type: "export_jsonl"; activeSessionId: string; outputPath?: string }
	| { id?: string; type: "set_session_name"; activeSessionId: string; name: string }
	| { id?: string; type: "rename_saved_session"; activeSessionId: string; sessionPath: string; name: string }
	| { id?: string; type: "delete_saved_session"; activeSessionId?: string; sessionPath: string }
	| { id?: string; type: "get_session_context"; activeSessionId: string }
	| { id?: string; type: "get_session_tree"; activeSessionId: string }
	| { id?: string; type: "get_user_messages_for_forking"; activeSessionId: string }
	| { id?: string; type: "get_last_assistant_text"; activeSessionId: string }
	| { id?: string; type: "get_system_prompt"; activeSessionId: string }
	| { id?: string; type: "get_tool_definition"; activeSessionId: string; name: string }
	| { id?: string; type: "set_session_entry_label"; activeSessionId: string; entryId: string; label?: string }
	| {
			id?: string;
			type: "extension_ui_response";
			activeSessionId: string;
			requestId: string;
			response: DaemonExtensionUIResponse;
	  }
	| { id?: string; type: "shutdown" };

type DaemonCommandName = DaemonCommand["type"];

export type DaemonResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			errorInfo?: DaemonErrorInfo;
	  };

export type DaemonErrorInfo =
	| { code: "missing_session_cwd"; issue: SessionCwdIssue }
	| { code: "session_import_file_not_found"; filePath: string };

export type DaemonSessionClosedReason = "killed" | "shutdown" | "completed" | "replaced";

export type DaemonExtensionUIResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export function isDaemonDialogExtensionUiRequest(method: string): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

/**
 * True when a daemon rejected a command it does not know, i.e. the daemon
 * process was started from a build that predates the command.
 */
export function isUnknownDaemonCommandError(error: unknown, command: DaemonCommand["type"]): boolean {
	return error instanceof Error && error.message.includes(`Unknown daemon command: ${command}`);
}

export interface DaemonRequestProgress {
	id?: string;
	type: "session_list_progress";
	command: "list_saved_sessions";
	activeSessionId: string;
	loaded: number;
	total: number;
}

export interface DaemonSavedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: AgentConnectionSavedSessionState;
	parentSessionPath?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type DaemonDeleteSavedSessionResult = DeleteSessionFileResult;

export type DaemonResourceSnapshot = AgentConnectionResourceSnapshot;

export type DaemonCronJob = AgentCronJob;

export type DaemonOutbound =
	| DaemonResponse
	| DaemonRequestProgress
	| {
			type: "daemon_hello";
			socketPath: string;
			protocol: DaemonProtocolInfo;
			/** App version of the daemon process, used to detect stale daemons after self-update. */
			appVersion?: string;
			clientId: DaemonClientId;
			serverCapabilities: readonly DaemonClientCapability[];
	  }
	| { type: "session_event"; activeSessionId: string; event: AgentConnectionSessionEvent; meta?: DaemonEventMeta }
	| { type: "session_status"; activeSessionId: string; recap?: string; meta?: DaemonEventMeta }
	| {
			type: "session_replaced";
			activeSessionId: string;
			state: AgentConnectionState;
			messages: AgentMessage[];
			meta?: DaemonEventMeta;
	  }
	| {
			type: "session_attached";
			activeSessionId: string;
			state: SessionSummary;
			messages: AgentMessage[];
			snapshot?: DaemonSessionSnapshot;
			replay?: DaemonReplayInfo;
			lastEventSequence?: DaemonEventSequence;
	  }
	| { type: "session_detached"; activeSessionId: string }
	| { type: "session_closed"; activeSessionId: string; reason: DaemonSessionClosedReason; meta?: DaemonEventMeta }
	| {
			type: "extension_ui_request";
			activeSessionId: string;
			id: string;
			method: string;
			payload: Record<string, unknown>;
			meta?: DaemonEventMeta;
	  }
	| {
			type: "extension_error";
			activeSessionId: string;
			extensionPath: string;
			event: string;
			error: string;
			meta?: DaemonEventMeta;
	  };

export function createDaemonCommandEnvelope<TCommand extends DaemonCommand>(
	command: TCommand,
	id: DaemonCommandId,
	clientId?: DaemonClientId,
): DaemonCommandEnvelope<TCommand> {
	return {
		type: "command",
		id,
		protocol: DAEMON_PROTOCOL_INFO,
		...(clientId ? { clientId } : {}),
		command,
	};
}

export function createDaemonEventEnvelope<TEvent extends DaemonOutbound>(
	event: TEvent,
	meta: DaemonEventMeta,
): DaemonEventEnvelope<TEvent> {
	return {
		type: "event",
		id: meta.id,
		protocol: meta.protocol,
		...(meta.activeSessionId ? { activeSessionId: meta.activeSessionId } : {}),
		...(meta.sequence !== undefined ? { sequence: meta.sequence } : {}),
		emittedAt: meta.emittedAt,
		event,
	};
}

export function createDaemonEventMeta(
	activeSessionId: string,
	sequence: DaemonEventSequence,
	emittedAt = new Date().toISOString(),
): DaemonEventMeta {
	return {
		id: `${activeSessionId}:${sequence}`,
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		sequence,
		emittedAt,
	};
}

export function createDaemonReplayInfo(
	resumeCursor: DaemonResumeCursor | undefined,
	lastEventSequence: DaemonEventSequence,
): DaemonReplayInfo {
	if (!resumeCursor) {
		return {
			status: "complete",
			toSequence: lastEventSequence,
		};
	}

	if (resumeCursor.eventSequence > lastEventSequence) {
		return {
			status: "unavailable",
			fromSequence: resumeCursor.eventSequence,
			toSequence: lastEventSequence,
			reason: "resume_cursor_ahead_of_session",
		};
	}

	if (resumeCursor.eventSequence === lastEventSequence) {
		return {
			status: "complete",
			fromSequence: resumeCursor.eventSequence,
			toSequence: lastEventSequence,
		};
	}

	return {
		status: "unavailable",
		fromSequence: resumeCursor.eventSequence,
		toSequence: lastEventSequence,
		reason: "event_replay_not_available",
	};
}

export function success(id: string | undefined, command: DaemonCommandName, data?: unknown): DaemonResponse {
	return data === undefined
		? { id, type: "response", command, success: true }
		: { id, type: "response", command, success: true, data };
}

export function failure(
	id: string | undefined,
	command: string,
	error: unknown,
	errorInfo?: DaemonErrorInfo,
): DaemonResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: error instanceof Error ? error.message : String(error),
		...(errorInfo ? { errorInfo } : {}),
	};
}
