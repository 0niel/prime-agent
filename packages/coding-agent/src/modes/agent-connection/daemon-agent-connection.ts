import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Transport } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type { SessionStats } from "../../core/session-stats.js";
import type { DaemonClient } from "../daemon/daemon-client.js";
import { deserializeDaemonError } from "../daemon/daemon-errors.js";
import type {
	DaemonAttachResult,
	DaemonCommand,
	DaemonDeleteSavedSessionResult,
	DaemonOutbound,
	DaemonSavedSessionInfo,
} from "../daemon/daemon-protocol.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import type {
	AgentConnection,
	AgentConnectionBeforeSessionInvalidateListener,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionExtensionUiResponse,
	AgentConnectionForkOptions,
	AgentConnectionModel,
	AgentConnectionModelCycleResult,
	AgentConnectionNavigateTreeOptions,
	AgentConnectionNavigateTreeResult,
	AgentConnectionNewSessionOptions,
	AgentConnectionPromptOptions,
	AgentConnectionQueueMode,
	AgentConnectionQueueState,
	AgentConnectionResourceSnapshot,
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionScopedModel,
	AgentConnectionSessionContext,
	AgentConnectionSessionListProgress,
	AgentConnectionSessionTreeNode,
	AgentConnectionSlashCommand,
	AgentConnectionState,
	AgentConnectionSwitchSessionOptions,
	AgentConnectionToolDefinition,
	AgentConnectionUserMessage,
} from "./types.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;

export interface DaemonAgentConnectionOptions {
	closeClientOnDispose?: boolean;
}

/**
 * AgentConnection adapter for the local daemon JSONL socket transport.
 *
 * InteractiveMode depends only on AgentConnection; local socket ownership and
 * daemon command details stay inside this adapter.
 */
export class DaemonAgentConnection implements AgentConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private readonly unsubscribeDaemonMessages: () => void;
	private readonly unsubscribeDaemonClose: () => void;
	private readonly clientId = `daemon-agent-connection:${randomUUID()}`;
	private lastEventSequence: number | undefined;

	constructor(
		private readonly client: DaemonClient,
		private activeSessionId: string,
		private readonly options: DaemonAgentConnectionOptions = {},
	) {
		this.unsubscribeDaemonMessages = this.client.onMessage((message) => {
			void this.handleDaemonMessage(message);
		});
		this.unsubscribeDaemonClose = this.client.onClose((error) => {
			void this.emit({ type: "closed", error: error.message });
		});
	}

	static async attach(
		client: DaemonClient,
		activeSessionId: string,
		options?: DaemonAgentConnectionOptions,
	): Promise<DaemonAgentConnection> {
		const connection = new DaemonAgentConnection(client, activeSessionId, options);
		try {
			await connection.attach();
			return connection;
		} catch (error) {
			await connection.dispose();
			throw error;
		}
	}

	async attach(): Promise<void> {
		const result = await this.requestData<SessionSummary | DaemonAttachResult>({
			type: "attach",
			activeSessionId: this.activeSessionId,
			supportsExtensionUi: true,
			clientId: this.clientId,
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui"],
			resumeCursor:
				this.lastEventSequence === undefined
					? undefined
					: {
							activeSessionId: this.activeSessionId,
							eventSequence: this.lastEventSequence,
						},
		});
		this.activeSessionId = getAttachActiveSessionId(result);
		this.lastEventSequence = maxEventSequence(this.lastEventSequence, getAttachLastEventSequence(result));
	}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onBeforeSessionInvalidate(_listener: AgentConnectionBeforeSessionInvalidateListener): () => void {
		return () => {};
	}

	async getState(): Promise<AgentConnectionState> {
		return this.requestData<AgentConnectionState>({
			type: "get_connection_state",
			activeSessionId: this.activeSessionId,
		});
	}

	async getMessages(): Promise<AgentMessage[]> {
		const data = await this.requestData<{ messages: AgentMessage[] }>({
			type: "get_messages",
			activeSessionId: this.activeSessionId,
		});
		return data.messages;
	}

	async getCommands(): Promise<AgentConnectionSlashCommand[]> {
		const data = await this.requestData<{ commands: AgentConnectionSlashCommand[] }>({
			type: "get_commands",
			activeSessionId: this.activeSessionId,
		});
		return data.commands;
	}

	async getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot> {
		return this.requestData<AgentConnectionResourceSnapshot>({
			type: "get_resource_snapshot",
			activeSessionId: this.activeSessionId,
		});
	}

	async getAvailableModels(): Promise<AgentConnectionModel[]> {
		const data = await this.requestData<{ models: AgentConnectionModel[] }>({
			type: "get_available_models",
			activeSessionId: this.activeSessionId,
		});
		return data.models;
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.requestData<SessionStats>({
			type: "get_session_stats",
			activeSessionId: this.activeSessionId,
		});
	}

	async getSessionContext(): Promise<AgentConnectionSessionContext> {
		const data = await this.requestData<{ context: AgentConnectionSessionContext }>({
			type: "get_session_context",
			activeSessionId: this.activeSessionId,
		});
		return data.context;
	}

	async getSessionTree(): Promise<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }> {
		return this.requestData<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }>({
			type: "get_session_tree",
			activeSessionId: this.activeSessionId,
		});
	}

	async listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		onProgress?: AgentConnectionSessionListProgress,
	): Promise<AgentConnectionSavedSessionInfo[]> {
		const response = await this.client.request(
			{
				type: "list_saved_sessions",
				activeSessionId: this.activeSessionId,
				scope,
			},
			30000,
			{
				onProgress: (progress) => {
					onProgress?.(progress.loaded, progress.total);
				},
			},
		);
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		const data = response.data as { sessions: DaemonSavedSessionInfo[] };
		return data.sessions.map(deserializeSavedSessionInfo);
	}

	async getQueue(): Promise<AgentConnectionQueueState> {
		return this.requestData<AgentConnectionQueueState>({
			type: "get_queue",
			activeSessionId: this.activeSessionId,
		});
	}

	async clearQueue(): Promise<AgentConnectionQueueState> {
		return this.requestData<AgentConnectionQueueState>({
			type: "clear_queue",
			activeSessionId: this.activeSessionId,
		});
	}

	async getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]> {
		const data = await this.requestData<{ messages: AgentConnectionUserMessage[] }>({
			type: "get_user_messages_for_forking",
			activeSessionId: this.activeSessionId,
		});
		return data.messages;
	}

	async getLastAssistantText(): Promise<string | undefined> {
		const data = await this.requestData<{ text?: string | null }>({
			type: "get_last_assistant_text",
			activeSessionId: this.activeSessionId,
		});
		return data.text ?? undefined;
	}

	async getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined> {
		const data = await this.requestData<{ toolDefinition?: AgentConnectionToolDefinition }>({
			type: "get_tool_definition",
			activeSessionId: this.activeSessionId,
			name,
		});
		return data.toolDefinition;
	}

	async setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void> {
		await this.requestOk({
			type: "set_session_entry_label",
			activeSessionId: this.activeSessionId,
			entryId,
			label,
		});
	}

	async respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void> {
		await this.requestOk({
			type: "extension_ui_response",
			activeSessionId: this.activeSessionId,
			requestId,
			response,
		});
	}

	async prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await this.requestOk({
			type: "prompt",
			activeSessionId: this.activeSessionId,
			message,
			images: options?.images,
			streamingBehavior: options?.streamingBehavior,
		});
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.requestOk({ type: "steer", activeSessionId: this.activeSessionId, message, images });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.requestOk({ type: "follow_up", activeSessionId: this.activeSessionId, message, images });
	}

	async abort(): Promise<void> {
		await this.requestOk({ type: "abort", activeSessionId: this.activeSessionId });
	}

	async waitForIdle(): Promise<void> {
		await this.requestOk({ type: "wait_for_idle", activeSessionId: this.activeSessionId });
	}

	async setModel(provider: string, modelId: string): Promise<AgentConnectionModel> {
		return this.requestData<AgentConnectionModel>({
			type: "set_model",
			activeSessionId: this.activeSessionId,
			provider,
			modelId,
		});
	}

	async cycleModel(direction?: "forward" | "backward"): Promise<AgentConnectionModelCycleResult | undefined> {
		const result = await this.requestData<AgentConnectionModelCycleResult | null>({
			type: "cycle_model",
			activeSessionId: this.activeSessionId,
			direction,
		});
		return result ?? undefined;
	}

	async setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void> {
		await this.requestOk({
			type: "set_scoped_models",
			activeSessionId: this.activeSessionId,
			scopedModels,
		});
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.requestOk({ type: "set_thinking_level", activeSessionId: this.activeSessionId, level });
	}

	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		const result = await this.requestData<{ level: ThinkingLevel } | null>({
			type: "cycle_thinking_level",
			activeSessionId: this.activeSessionId,
		});
		return result?.level;
	}

	async setTransport(transport: Transport): Promise<void> {
		await this.requestOk({ type: "set_transport", activeSessionId: this.activeSessionId, transport });
	}

	async setSteeringMode(mode: AgentConnectionQueueMode): Promise<void> {
		await this.requestOk({ type: "set_steering_mode", activeSessionId: this.activeSessionId, mode });
	}

	async setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void> {
		await this.requestOk({ type: "set_follow_up_mode", activeSessionId: this.activeSessionId, mode });
	}

	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		await this.requestOk({ type: "set_auto_compaction", activeSessionId: this.activeSessionId, enabled });
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this.requestData<CompactionResult>({
			type: "compact",
			activeSessionId: this.activeSessionId,
			customInstructions,
		});
	}

	async abortCompaction(): Promise<void> {
		await this.requestOk({ type: "abort_compaction", activeSessionId: this.activeSessionId });
	}

	async abortBranchSummary(): Promise<void> {
		await this.requestOk({ type: "abort_branch_summary", activeSessionId: this.activeSessionId });
	}

	async abortRetry(): Promise<void> {
		await this.requestOk({ type: "abort_retry", activeSessionId: this.activeSessionId });
	}

	async reload(): Promise<void> {
		await this.requestOk({ type: "reload", activeSessionId: this.activeSessionId });
	}

	async newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }> {
		return this.requestData<{ cancelled: boolean }>({
			type: "new_session",
			activeSessionId: this.activeSessionId,
			parentSession: options?.parentSession,
		});
	}

	async switchSession(
		sessionPath: string,
		options?: AgentConnectionSwitchSessionOptions,
	): Promise<{ cancelled: boolean }> {
		return this.requestData<{ cancelled: boolean }>({
			type: "switch_session",
			activeSessionId: this.activeSessionId,
			sessionPath,
			cwdOverride: options?.cwdOverride,
		});
	}

	async fork(
		entryId: string,
		options?: AgentConnectionForkOptions,
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.requestData<{ cancelled: boolean; selectedText?: string }>({
			type: "fork",
			activeSessionId: this.activeSessionId,
			entryId,
			position: options?.position,
		});
	}

	async navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult> {
		return this.requestData<AgentConnectionNavigateTreeResult>({
			type: "navigate_tree",
			activeSessionId: this.activeSessionId,
			targetId,
			summarize: options?.summarize,
			customInstructions: options?.customInstructions,
			replaceInstructions: options?.replaceInstructions,
			label: options?.label,
		});
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.requestData<{ cancelled: boolean }>({
			type: "import_jsonl",
			activeSessionId: this.activeSessionId,
			inputPath,
			cwdOverride,
		});
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const data = await this.requestData<{ path: string }>({
			type: "export_html",
			activeSessionId: this.activeSessionId,
			outputPath,
		});
		return data.path;
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		const data = await this.requestData<{ path: string }>({
			type: "export_jsonl",
			activeSessionId: this.activeSessionId,
			outputPath,
		});
		return data.path;
	}

	async setSessionName(name: string): Promise<void> {
		await this.requestOk({ type: "set_session_name", activeSessionId: this.activeSessionId, name });
	}

	async renameSavedSession(sessionPath: string, name: string): Promise<void> {
		await this.requestOk({
			type: "rename_saved_session",
			activeSessionId: this.activeSessionId,
			sessionPath,
			name,
		});
	}

	async deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult> {
		return this.requestData<DaemonDeleteSavedSessionResult>({
			type: "delete_saved_session",
			activeSessionId: this.activeSessionId,
			sessionPath,
		});
	}

	async dispose(): Promise<void> {
		this.unsubscribeDaemonMessages();
		this.unsubscribeDaemonClose();
		await this.requestOk({ type: "detach", activeSessionId: this.activeSessionId }).catch(() => undefined);
		if (this.options.closeClientOnDispose) {
			this.client.close();
		}
	}

	private async requestOk(command: DaemonCommandBody): Promise<void> {
		await this.requestData<unknown>(command);
	}

	private async requestData<T>(command: DaemonCommandBody): Promise<T> {
		const response = await this.client.request(command);
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		return response.data as T;
	}

	private async handleDaemonMessage(message: DaemonOutbound): Promise<void> {
		if (!this.isMessageForActiveSession(message)) {
			return;
		}
		this.observeDaemonEventSequence(message);

		if (message.type === "session_event") {
			await this.emit({ type: "session_event", event: message.event });
			return;
		}
		if (message.type === "session_replaced") {
			await this.emit({ type: "session_replaced", state: message.state, messages: message.messages });
			return;
		}
		if (message.type === "extension_ui_request") {
			await this.emit({
				type: "extension_ui_request",
				request: {
					id: message.id,
					method: message.method,
					payload: message.payload,
				},
			});
			return;
		}
		if (message.type === "session_closed") {
			await this.emit({ type: "closed", error: message.reason });
		}
	}

	private isMessageForActiveSession(message: DaemonOutbound): boolean {
		if (!("activeSessionId" in message)) {
			return false;
		}
		return message.activeSessionId === this.activeSessionId;
	}

	private observeDaemonEventSequence(message: DaemonOutbound): void {
		if (!("meta" in message) || message.meta?.sequence === undefined) {
			return;
		}
		this.lastEventSequence =
			this.lastEventSequence === undefined
				? message.meta.sequence
				: Math.max(this.lastEventSequence, message.meta.sequence);
	}

	private async emit(event: AgentConnectionEvent): Promise<void> {
		for (const listener of [...this.listeners]) {
			await listener(event);
		}
	}
}

function getAttachActiveSessionId(result: SessionSummary | DaemonAttachResult): string {
	if ("snapshot" in result) {
		return result.activeSessionId;
	}
	return result.activeSessionId ?? result.id;
}

function getAttachLastEventSequence(result: SessionSummary | DaemonAttachResult): number | undefined {
	if ("lastEventSequence" in result) {
		return result.lastEventSequence;
	}
	return undefined;
}

function maxEventSequence(current: number | undefined, observed: number | undefined): number | undefined {
	if (current === undefined) {
		return observed;
	}
	if (observed === undefined) {
		return current;
	}
	return Math.max(current, observed);
}

function deserializeSavedSessionInfo(session: DaemonSavedSessionInfo): AgentConnectionSavedSessionInfo {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		state: session.state,
		parentSessionPath: session.parentSessionPath,
		created: new Date(session.created),
		modified: new Date(session.modified),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
	};
}
