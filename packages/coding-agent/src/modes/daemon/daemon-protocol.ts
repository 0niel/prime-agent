import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, ServiceTier, TextContent, Transport } from "@earendil-works/pi-ai";
import type {
	AgentSessionMessageDeliveryMode,
	AgentSessionMessageReceipt,
	AgentSessionMessageSafetyStatus,
} from "../../core/agent-messages.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { AgentSessionRuntimeMetadata } from "../../core/agent-session-runtime.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { CustomMessage } from "../../core/messages.js";
import type { SessionCwdIssue } from "../../core/session-cwd.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type {
	AgentConnectionAgentStatus,
	AgentConnectionHeartbeat,
	AgentConnectionQueueMode,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSavedSessionScope,
	AgentConnectionSavedSessionState,
	AgentConnectionScopedModel,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSessionTreeNode,
	AgentConnectionSideQuestionEvent,
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
export const DAEMON_PROTOCOL_VERSION = 3;
export const DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION = 2;

export type DaemonProtocolName = typeof DAEMON_PROTOCOL_NAME;
export type DaemonProtocolVersion = number;
export type DaemonCommandId = string;
export type DaemonEventId = string;
export type DaemonEventSequence = number;
export interface DaemonEventCursor {
	generation: string;
	sequence: DaemonEventSequence;
}
export type DaemonClientId = string;
export type DaemonClientCapability =
	| "attach_snapshot"
	| "event_sequence"
	| "extension_ui"
	| "slim_attach"
	| "chunked_snapshot";
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

export type DaemonResumeCursor =
	| ({ activeSessionId?: string } & DaemonEventCursor)
	| { activeSessionId?: string; eventSequence: DaemonEventSequence };

export interface DaemonAttachClientMetadata {
	clientId?: DaemonClientId;
	capabilities?: readonly DaemonClientCapability[];
	resumeCursor?: DaemonResumeCursor;
}

/**
 * Client-side env vars forwarded to the daemon so extensions can reach them
 * (e.g. HERDR_PANE_ID/HERDR_SOCKET_PATH that herdr sets per pane). The daemon
 * scopes these to the created session and merges them over process.env for
 * that session's pi.exec() subprocesses — it does not mutate the daemon's own
 * env. Carried on create only: attach must not rebind a session's identity,
 * since watchers (agents view, subagent viewers) also attach.
 */
export interface DaemonClientEnv {
	env?: Record<string, string>;
}

/**
 * The allowlist of env vars a client may forward. One shared list because it
 * is the wire contract: clients filter before sending and the daemon
 * re-filters on receipt (the socket peer is untrusted).
 */
export const DAEMON_CLIENT_ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
] as const;

/** Collect the allowlisted env vars from the client process for the create command. */
export function collectDaemonClientEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	for (const key of DAEMON_CLIENT_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

export interface DaemonReplayInfo {
	status: DaemonReplayStatus;
	fromSequence?: DaemonEventSequence;
	toSequence: DaemonEventSequence;
	fromCursor?: DaemonEventCursor;
	toCursor?: DaemonEventCursor;
	reason?: string;
}

export interface DaemonEventMeta {
	id: DaemonEventId;
	protocol: DaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: DaemonEventSequence;
	cursor?: DaemonEventCursor;
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

export type DaemonCommandWire = DaemonCommand | DaemonCommandEnvelope;

export interface DaemonEventEnvelope<TEvent extends DaemonOutbound = DaemonOutbound> {
	type: "event";
	id: DaemonEventId;
	protocol: DaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: DaemonEventSequence;
	cursor?: DaemonEventCursor;
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
	lastEventCursor?: DaemonEventCursor;
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
	lastEventCursor?: DaemonEventCursor;
	snapshotStream?: {
		id: string;
		messageCount: number;
		targetChunkBytes: number;
	};
	client: {
		id: DaemonClientId;
		capabilities: DaemonClientCapability[];
	};
}

export interface DaemonUpdateRestartQueuedMessage {
	message: string;
	content?: (TextContent | ImageContent)[];
	images?: ImageContent[];
	queueKey?: string;
	agentMessageId?: string;
	customMessage?: CustomMessage;
	prefixMessages?: CustomMessage[];
}

export interface DaemonUpdateRestartAcceptedPrompt extends DaemonUpdateRestartQueuedMessage {
	nextTurn: CustomMessage[];
}

export interface DaemonUpdateRestartQueue {
	steering: DaemonUpdateRestartQueuedMessage[];
	followUp: DaemonUpdateRestartQueuedMessage[];
	nextTurn: CustomMessage[];
	acceptedPrompt?: DaemonUpdateRestartAcceptedPrompt;
}

export interface DaemonUpdateRestartSession {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	config: AgentSessionRuntimeConfig;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
	clientEnv?: Record<string, string>;
	queue: DaemonUpdateRestartQueue;
	shouldResume: boolean;
	wasStreaming: boolean;
	wasCompacting: boolean;
	wasBashRunning: boolean;
	hadRunningRlmChildren: boolean;
	wasRetrying: boolean;
	hadAcceptedPromptInFlight: boolean;
}

export interface DaemonUpdateRestartManifest {
	createdAt: string;
	sessions: DaemonUpdateRestartSession[];
}

export type DaemonSavedSessionListCommand =
	| { id?: string; type: "list_saved_sessions"; activeSessionId: string; scope: AgentConnectionSavedSessionScope }
	| {
			id?: string;
			type: "list_saved_sessions";
			cwd: string;
			sessionDir?: string;
			scope: AgentConnectionSavedSessionScope;
	  };

export type DaemonCommand =
	| { id?: string; type: "list"; all?: boolean; cwd?: string; sessionDir?: string }
	| DaemonSavedSessionListCommand
	| ({
			id?: string;
			type: "create";
			sessionPath?: string;
			continueRecent?: boolean;
			name?: string;
			config?: AgentSessionRuntimeConfig;
			runtimeMetadata?: AgentSessionRuntimeMetadata;
	  } & DaemonClientEnv)
	// Attach env is adopt-if-absent only: it fills identity for env-less
	// sessions (e.g. cron-created) but never rebinds one, since watchers
	// (agents view, subagent viewers) also attach.
	| ({
			id?: string;
			type: "attach";
			activeSessionId: string;
			supportsExtensionUi?: boolean;
	  } & DaemonAttachClientMetadata &
			DaemonClientEnv)
	| { id?: string; type: "detach"; activeSessionId?: string }
	| { id?: string; type: "kill"; activeSessionId: string }
	| { id?: string; type: "rename"; activeSessionId: string; name: string }
	| {
			id?: string;
			type: "prompt";
			activeSessionId: string;
			message: string;
			content?: (TextContent | ImageContent)[];
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			expandPromptTemplates?: boolean;
			agentMessageId?: string;
			customMessage?: CustomMessage;
	  }
	| {
			id?: string;
			type: "steer";
			activeSessionId: string;
			message: string;
			content?: (TextContent | ImageContent)[];
			images?: ImageContent[];
			queueKey?: string;
			expandPromptTemplates?: boolean;
			agentMessageId?: string;
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
	  }
	| {
			id?: string;
			type: "follow_up";
			activeSessionId: string;
			message: string;
			content?: (TextContent | ImageContent)[];
			images?: ImageContent[];
			queueKey?: string;
			expandPromptTemplates?: boolean;
			agentMessageId?: string;
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
	  }
	| { id?: string; type: "restore_next_turn"; activeSessionId: string; messages: CustomMessage[] }
	| { id?: string; type: "resume_queue"; activeSessionId: string }
	| {
			id?: string;
			type: "send_message";
			targetActiveSessionId: string;
			message: string;
			fromActiveSessionId?: string;
			deliveryMode?: AgentSessionMessageDeliveryMode;
	  }
	| { id?: string; type: "agent_messages_status" }
	| { id?: string; type: "agent_messages_pause" }
	| { id?: string; type: "agent_messages_resume" }
	| { id?: string; type: "agent_messages_clear"; activeSessionId: string }
	| { id?: string; type: "abort"; activeSessionId: string }
	| {
			id?: string;
			type: "start_side_question";
			activeSessionId: string;
			sideQuestionId: string;
			question: string;
	  }
	| { id?: string; type: "abort_side_question"; activeSessionId: string; sideQuestionId: string }
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
	| { id?: string; type: "abort_and_clear_queue"; activeSessionId: string }
	| { id?: string; type: "cron_list"; activeSessionId?: string; includeInactive?: boolean }
	| { id?: string; type: "heartbeats_list" }
	| {
			id?: string;
			type: "heartbeat_manage";
			activeSessionId: string;
			jobId: string;
			action: AgentHeartbeatManagementAction;
	  }
	| { id?: string; type: "cron_add"; activeSessionId: string; schedule: string; prompt: string }
	| { id?: string; type: "cron_cancel"; jobId: string }
	| { id?: string; type: "heartbeat_get"; activeSessionId: string }
	| {
			id?: string;
			type: "heartbeat_set";
			activeSessionId: string;
			schedule: string;
			prompt: string;
			deliveryMode?: AgentHeartbeatDeliveryMode;
	  }
	| { id?: string; type: "heartbeat_update"; activeSessionId: string; action: AgentHeartbeatUpdateAction }
	| { id?: string; type: "set_model"; activeSessionId: string; provider: string; modelId: string }
	| { id?: string; type: "cycle_model"; activeSessionId: string; direction?: "forward" | "backward" }
	| { id?: string; type: "set_scoped_models"; activeSessionId: string; scopedModels: AgentConnectionScopedModel[] }
	| { id?: string; type: "set_thinking_level"; activeSessionId: string; level: ThinkingLevel }
	| { id?: string; type: "set_service_tier"; activeSessionId: string; serviceTier: ServiceTier }
	| { id?: string; type: "cycle_thinking_level"; activeSessionId: string }
	| { id?: string; type: "set_transport"; activeSessionId: string; transport: Transport }
	| { id?: string; type: "set_steering_mode"; activeSessionId: string; mode: AgentConnectionQueueMode }
	| { id?: string; type: "set_follow_up_mode"; activeSessionId: string; mode: AgentConnectionQueueMode }
	| { id?: string; type: "set_auto_compaction"; activeSessionId: string; enabled: boolean }
	| { id?: string; type: "compact"; activeSessionId: string; customInstructions?: string }
	| {
			id?: string;
			type: "refine";
			activeSessionId: string;
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
	  }
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
	| { id?: string; type: "rename_saved_session"; activeSessionId?: string; sessionPath: string; name: string }
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
	| { id?: string; type: "ack_result"; commandId: string }
	| { id?: string; type: "prepare_update_restart" }
	| { id?: string; type: "retry_worker"; activeSessionId: string }
	| { id?: string; type: "restart" }
	| { id?: string; type: "shutdown"; force?: boolean };

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
	| { code: "session_import_file_not_found"; filePath: string }
	| { code: "session_already_active"; sessionPath: string; activeSessionId?: string }
	| { code: "command_result_uncertain"; clientId: DaemonClientId; commandId: DaemonCommandId };

export type DaemonSessionClosedReason = "killed" | "shutdown" | "completed" | "replaced" | "update";
export type DaemonClosingReason = "shutdown" | "update";

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

export type DaemonRequestProgress =
	| {
			id?: string;
			type: "session_list_progress";
			command: "list_saved_sessions";
			activeSessionId?: string;
			loaded: number;
			total: number;
	  }
	| {
			id?: string;
			type: "session_list_item";
			command: "list_saved_sessions";
			activeSessionId?: string;
			session: DaemonSavedSessionInfo;
	  };

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
	agentStatus?: AgentConnectionAgentStatus;
}

export type DaemonDeleteSavedSessionResult = DeleteSessionFileResult;

export type DaemonResourceSnapshot = AgentConnectionResourceSnapshot;

export type DaemonCronJob = AgentCronJob;
export type DaemonHeartbeat = AgentConnectionHeartbeat;
export type DaemonAgentSessionMessageReceipt = AgentSessionMessageReceipt;
export type DaemonAgentSessionMessageSafetyStatus = AgentSessionMessageSafetyStatus;

export type DaemonOutbound =
	| DaemonResponse
	| DaemonRequestProgress
	| {
			type: "daemon_hello";
			socketPath: string;
			protocol: DaemonProtocolInfo;
			/** App version of the daemon process, used to detect stale daemons after self-update. */
			appVersion?: string;
			/** Changes whenever the public supervisor process is replaced. */
			supervisorGeneration?: string;
			/** Diagnostic process identity for attributing supervisor replacement. */
			supervisorPid?: number;
			/** Durable owner marker for validating update handoff fences. */
			supervisorOwnerToken?: string;
			/** Process start identity captured when the durable owner was published. */
			supervisorProcessStartId?: string;
			/** Normalized socket identity stored in the durable owner record. */
			supervisorSocketPath?: string;
			clientId: DaemonClientId;
			serverCapabilities: readonly DaemonClientCapability[];
	  }
	| { type: "daemon_closing"; reason: DaemonClosingReason }
	| { type: "heartbeats_changed" }
	| { type: "session_event"; activeSessionId: string; event: AgentConnectionSessionEvent; meta?: DaemonEventMeta }
	| { type: "side_question_event"; activeSessionId: string; event: AgentConnectionSideQuestionEvent }
	| { type: "session_status"; activeSessionId: string; recap?: string; meta?: DaemonEventMeta }
	| {
			type: "session_replaced";
			activeSessionId: string;
			state: AgentConnectionState;
			messages: AgentMessage[];
			snapshotFollows?: boolean;
			meta?: DaemonEventMeta;
	  }
	| {
			type: "session_resynced";
			activeSessionId: string;
			snapshot: DaemonSessionSnapshot;
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
	| {
			type: "session_snapshot_begin";
			activeSessionId: string;
			snapshotId: string;
			snapshot: Omit<DaemonSessionSnapshot, "messages">;
			messageCount: number;
			targetChunkBytes: number;
			purpose?: "attach" | "replacement" | "resync";
	  }
	| {
			type: "session_snapshot_chunk";
			activeSessionId: string;
			snapshotId: string;
			index: number;
			messages: AgentMessage[];
	  }
	| {
			type: "session_snapshot_end";
			activeSessionId: string;
			snapshotId: string;
			chunkCount: number;
			lastEventSequence: DaemonEventSequence;
			lastEventCursor?: DaemonEventCursor;
	  }
	| {
			type: "session_snapshot_failed";
			activeSessionId: string;
			snapshotId: string;
			error: string;
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
	protocolVersion: DaemonProtocolVersion = DAEMON_PROTOCOL_VERSION,
): DaemonCommandEnvelope<TCommand> {
	return {
		type: "command",
		id,
		protocol: { name: DAEMON_PROTOCOL_NAME, version: protocolVersion },
		...(clientId ? { clientId } : {}),
		command,
	};
}

export function isDaemonCommandEnvelope(value: unknown): value is DaemonCommandEnvelope {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as {
		type?: unknown;
		id?: unknown;
		protocol?: { name?: unknown; version?: unknown };
		clientId?: unknown;
		command?: unknown;
	};
	return (
		candidate.type === "command" &&
		typeof candidate.id === "string" &&
		candidate.protocol?.name === DAEMON_PROTOCOL_NAME &&
		typeof candidate.protocol.version === "number" &&
		candidate.protocol.version >= DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION &&
		candidate.protocol.version <= DAEMON_PROTOCOL_VERSION &&
		(candidate.clientId === undefined || typeof candidate.clientId === "string") &&
		typeof candidate.command === "object" &&
		candidate.command !== null
	);
}

const READ_ONLY_DAEMON_COMMANDS: ReadonlySet<DaemonCommand["type"]> = new Set([
	"ack_result",
	"list",
	"list_saved_sessions",
	"attach",
	"agent_messages_status",
	"wait_for_idle",
	"get_state",
	"get_connection_state",
	"get_messages",
	"get_session_stats",
	"get_context_tree",
	"get_commands",
	"get_resource_snapshot",
	"get_available_models",
	"get_queue",
	"cron_list",
	"heartbeats_list",
	"heartbeat_get",
	"get_session_context",
	"get_session_tree",
	"get_user_messages_for_forking",
	"get_last_assistant_text",
	"get_system_prompt",
	"get_tool_definition",
]);

export function isDaemonMutatingCommand(command: Pick<DaemonCommand, "type">): boolean {
	return !READ_ONLY_DAEMON_COMMANDS.has(command.type);
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
		...(meta.cursor ? { cursor: meta.cursor } : {}),
		emittedAt: meta.emittedAt,
		event,
	};
}

export function createDaemonEventMeta(
	activeSessionId: string,
	sequence: DaemonEventSequence,
	emittedAt = new Date().toISOString(),
	generation = activeSessionId,
): DaemonEventMeta {
	return {
		id: `${activeSessionId}:${sequence}`,
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		sequence,
		cursor: { generation, sequence },
		emittedAt,
	};
}

export function createDaemonReplayInfo(
	resumeCursor: DaemonResumeCursor | undefined,
	lastEventSequence: DaemonEventSequence,
	generation = "legacy",
): DaemonReplayInfo {
	const toCursor = { generation, sequence: lastEventSequence };
	if (!resumeCursor) {
		return {
			status: "complete",
			toSequence: lastEventSequence,
			toCursor,
		};
	}
	const resumeSequence = "sequence" in resumeCursor ? resumeCursor.sequence : resumeCursor.eventSequence;
	const fromCursor =
		"generation" in resumeCursor
			? { generation: resumeCursor.generation, sequence: resumeCursor.sequence }
			: undefined;
	if (fromCursor && fromCursor.generation !== generation) {
		return {
			status: "unavailable",
			fromSequence: resumeSequence,
			toSequence: lastEventSequence,
			fromCursor,
			toCursor,
			reason: "event_generation_changed",
		};
	}

	if (resumeSequence > lastEventSequence) {
		return {
			status: "unavailable",
			fromSequence: resumeSequence,
			toSequence: lastEventSequence,
			...(fromCursor ? { fromCursor } : {}),
			toCursor,
			reason: "resume_cursor_ahead_of_session",
		};
	}

	if (resumeSequence === lastEventSequence) {
		return {
			status: "complete",
			fromSequence: resumeSequence,
			toSequence: lastEventSequence,
			...(fromCursor ? { fromCursor } : {}),
			toCursor,
		};
	}

	return {
		status: "unavailable",
		fromSequence: resumeSequence,
		toSequence: lastEventSequence,
		...(fromCursor ? { fromCursor } : {}),
		toCursor,
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
