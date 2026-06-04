import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Transport } from "@earendil-works/pi-ai";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { SessionCwdIssue } from "../../core/session-cwd.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type {
	AgentConnectionQueueMode,
	AgentConnectionResourceSnapshot,
	AgentConnectionSavedSessionScope,
	AgentConnectionSavedSessionState,
	AgentConnectionScopedModel,
	AgentConnectionSessionEvent,
	AgentConnectionState,
} from "../agent-connection/types.js";
import type { SessionSummary } from "./daemon-session-list.js";

/**
 * Local daemon JSONL protocol.
 *
 * This is the transport used by DaemonAgentConnection today, not the final
 * remote gateway protocol. Gateway work should add its own versioned envelopes,
 * sequencing/replay, command lifecycle, artifact handles, and auth/control-plane
 * concerns without leaking those details back into InteractiveMode.
 */
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
	| { id?: string; type: "attach"; activeSessionId: string; supportsExtensionUi?: boolean }
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
	| { id?: string; type: "wait_for_idle"; activeSessionId: string }
	| { id?: string; type: "get_state"; activeSessionId: string }
	| { id?: string; type: "get_connection_state"; activeSessionId: string }
	| { id?: string; type: "get_messages"; activeSessionId: string }
	| { id?: string; type: "get_session_stats"; activeSessionId: string }
	| { id?: string; type: "get_commands"; activeSessionId: string }
	| { id?: string; type: "get_resource_snapshot"; activeSessionId: string }
	| { id?: string; type: "get_available_models"; activeSessionId: string }
	| { id?: string; type: "get_queue"; activeSessionId: string }
	| { id?: string; type: "clear_queue"; activeSessionId: string }
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
	| { id?: string; type: "delete_saved_session"; activeSessionId: string; sessionPath: string }
	| { id?: string; type: "get_session_context"; activeSessionId: string }
	| { id?: string; type: "get_session_tree"; activeSessionId: string }
	| { id?: string; type: "get_user_messages_for_forking"; activeSessionId: string }
	| { id?: string; type: "get_last_assistant_text"; activeSessionId: string }
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

export type DaemonOutbound =
	| DaemonResponse
	| DaemonRequestProgress
	| { type: "daemon_hello"; socketPath: string }
	| { type: "session_event"; activeSessionId: string; event: AgentConnectionSessionEvent }
	| { type: "session_replaced"; activeSessionId: string; state: AgentConnectionState; messages: AgentMessage[] }
	| { type: "session_attached"; activeSessionId: string; state: SessionSummary; messages: AgentMessage[] }
	| { type: "session_detached"; activeSessionId: string }
	| { type: "session_closed"; activeSessionId: string; reason: DaemonSessionClosedReason }
	| {
			type: "extension_ui_request";
			activeSessionId: string;
			id: string;
			method: string;
			payload: Record<string, unknown>;
	  }
	| { type: "extension_error"; activeSessionId: string; extensionPath: string; event: string; error: string };

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
