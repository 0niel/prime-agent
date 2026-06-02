import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.js";
import type { SessionSummary } from "./daemon-session-list.js";

export interface DaemonModeOptions {
	socketPath?: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
	createRuntime: CreateAgentSessionRuntimeFactory;
}

export type DaemonCommand =
	| { id?: string; type: "list"; all?: boolean; cwd?: string; sessionDir?: string }
	| {
			id?: string;
			type: "create";
			sessionPath?: string;
			continueRecent?: boolean;
			name?: string;
			config?: AgentSessionRuntimeConfig;
	  }
	| { id?: string; type: "attach"; activeSessionId: string }
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
	| { id?: string; type: "get_state"; activeSessionId: string }
	| { id?: string; type: "get_messages"; activeSessionId: string }
	| { id?: string; type: "get_session_stats"; activeSessionId: string }
	| { id?: string; type: "get_commands"; activeSessionId: string }
	| { id?: string; type: "shutdown" };

type DaemonCommandName = DaemonCommand["type"];

export type DaemonResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export type DaemonOutbound =
	| DaemonResponse
	| { type: "daemon_hello"; socketPath: string }
	| { type: "session_event"; activeSessionId: string; event: AgentSessionEvent }
	| { type: "session_attached"; activeSessionId: string; state: SessionSummary; messages: AgentMessage[] }
	| { type: "session_detached"; activeSessionId: string }
	| { type: "session_closed"; activeSessionId: string; reason: "killed" | "shutdown" }
	| {
			type: "extension_ui_request";
			activeSessionId: string;
			method: string;
			payload: Record<string, unknown>;
	  }
	| { type: "extension_error"; activeSessionId: string; extensionPath: string; event: string; error: string };

export function success(id: string | undefined, command: DaemonCommandName, data?: unknown): DaemonResponse {
	return data === undefined
		? { id, type: "response", command, success: true }
		: { id, type: "response", command, success: true, data };
}

export function failure(id: string | undefined, command: string, error: unknown): DaemonResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: error instanceof Error ? error.message : String(error),
	};
}
