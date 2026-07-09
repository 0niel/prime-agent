import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Transport } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type { AgentCronJob, AgentHeartbeatUpdateAction } from "../../core/cron-jobs.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type { SessionStats } from "../../core/session-stats.js";
import type { DaemonClient } from "../daemon/daemon-client.js";
import { deserializeDaemonError } from "../daemon/daemon-errors.js";
import {
	collectDaemonClientEnv,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonDeleteSavedSessionResult,
	type DaemonOutbound,
	type DaemonReplayInfo,
	type DaemonSavedSessionInfo,
	type DaemonSessionSnapshot,
	isUnknownDaemonCommandError,
} from "../daemon/daemon-protocol.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import type {
	AgentConnection,
	AgentConnectionBeforeSessionInvalidateListener,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionExecuteBashOptions,
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
	AgentConnectionSessionWatcher,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
	AgentConnectionSwitchSessionOptions,
	AgentConnectionToolDefinition,
	AgentConnectionUserMessage,
} from "./types.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;

export const DAEMON_REFINE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export interface DaemonAgentConnectionOptions {
	closeClientOnDispose?: boolean;
	/**
	 * Send this client's allowlisted env (herdr pane identity) with attach so
	 * an env-less session (e.g. cron-created) adopts it. Set only by the
	 * primary interactive connection — the daemon adopts-if-absent, never
	 * rebinds, so watchers must not send env at all.
	 */
	sendClientEnv?: boolean;
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
	private latestSnapshot: AgentConnectionSnapshot | undefined;
	private latestSnapshotIsFresh = false;

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
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach"],
			env: this.options.sendClientEnv ? collectDaemonClientEnv() : undefined,
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
		if ("snapshot" in result) {
			this.latestSnapshot = mapDaemonAttachSnapshot(result);
			if (this.lastEventSequence !== undefined) {
				this.latestSnapshot.lastEventSequence = this.lastEventSequence;
			}
			this.latestSnapshotIsFresh = true;
		} else {
			this.latestSnapshot = undefined;
			this.latestSnapshotIsFresh = false;
		}
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
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot.state;
		}
		return this.requestData<AgentConnectionState>({
			type: "get_connection_state",
			activeSessionId: this.activeSessionId,
		});
	}

	async getInitialSnapshot(): Promise<AgentConnectionSnapshot> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot;
		}
		// The session tree is intentionally not fetched here: it is large on long
		// sessions and only needed when the user opens the tree/branch selector.
		// getSessionTree() fetches it lazily via get_session_tree on first use.
		const [state, messagesData, sessionContextData] = await Promise.all([
			this.requestData<AgentConnectionState>({
				type: "get_connection_state",
				activeSessionId: this.activeSessionId,
			}),
			this.requestData<{ messages: AgentMessage[] }>({
				type: "get_messages",
				activeSessionId: this.activeSessionId,
			}),
			this.requestData<{ context: AgentConnectionSessionContext }>({
				type: "get_session_context",
				activeSessionId: this.activeSessionId,
			}),
		]);
		// Children only travel in the attach snapshot; a session event arriving
		// before the first read marks the cache stale, but the attach-time child
		// roster is still the best seed available (live rlm_child_update events
		// overwrite each entry anyway).
		const children = this.latestSnapshot?.children;
		this.latestSnapshot = {
			state,
			messages: messagesData.messages,
			sessionContext: sessionContextData.context,
			...(children ? { children } : {}),
		};
		if (this.lastEventSequence !== undefined) {
			this.latestSnapshot.lastEventSequence = this.lastEventSequence;
		}
		this.latestSnapshotIsFresh = true;
		return this.latestSnapshot;
	}

	async getMessages(): Promise<AgentMessage[]> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot.messages;
		}
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

	async getContextTree(): Promise<ContextTreeNode> {
		return this.requestData<ContextTreeNode>({
			type: "get_context_tree",
			activeSessionId: this.activeSessionId,
		});
	}

	async getSessionContext(): Promise<AgentConnectionSessionContext> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionContext) {
			return this.latestSnapshot.sessionContext;
		}
		const data = await this.requestData<{ context: AgentConnectionSessionContext }>({
			type: "get_session_context",
			activeSessionId: this.activeSessionId,
		});
		return data.context;
	}

	async getSessionTree(): Promise<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionTree) {
			return this.latestSnapshot.sessionTree;
		}
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

	async abortAndClearQueue(): Promise<AgentConnectionQueueState> {
		try {
			return await this.requestData<AgentConnectionQueueState>({
				type: "abort_and_clear_queue",
				activeSessionId: this.activeSessionId,
			});
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "abort_and_clear_queue")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async listCronJobs(options: { includeInactive?: boolean } = {}): Promise<AgentCronJob[]> {
		const data = await this.requestData<{ jobs: AgentCronJob[] }>({
			type: "cron_list",
			activeSessionId: this.activeSessionId,
			includeInactive: options.includeInactive,
		});
		return data.jobs;
	}

	async addCronJob(schedule: string, prompt: string): Promise<AgentCronJob> {
		const data = await this.requestData<{ job: AgentCronJob }>({
			type: "cron_add",
			activeSessionId: this.activeSessionId,
			schedule,
			prompt,
		});
		return data.job;
	}

	async cancelCronJob(jobId: string): Promise<AgentCronJob> {
		const data = await this.requestData<{ job: AgentCronJob }>({ type: "cron_cancel", jobId });
		return data.job;
	}

	async getHeartbeat(): Promise<AgentCronJob | undefined> {
		const data = await this.requestData<{ heartbeat?: AgentCronJob | null }>({
			type: "heartbeat_get",
			activeSessionId: this.activeSessionId,
		});
		return data.heartbeat ?? undefined;
	}

	async setHeartbeat(schedule: string, instruction: string): Promise<AgentCronJob> {
		const data = await this.requestData<{ heartbeat: AgentCronJob }>({
			type: "heartbeat_set",
			activeSessionId: this.activeSessionId,
			schedule,
			prompt: instruction,
		});
		return data.heartbeat;
	}

	async updateHeartbeat(action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined> {
		const data = await this.requestData<{ heartbeat?: AgentCronJob | null }>({
			type: "heartbeat_update",
			activeSessionId: this.activeSessionId,
			action,
		});
		return data.heartbeat ?? undefined;
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

	async getSystemPrompt(): Promise<string> {
		const data = await this.requestData<{ systemPrompt: string }>({
			type: "get_system_prompt",
			activeSessionId: this.activeSessionId,
		});
		return data.systemPrompt;
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

	async cancelRlmChild(childId: string): Promise<boolean> {
		try {
			const result = await this.requestData<{ cancelled: boolean }>({
				type: "cancel_rlm_child",
				activeSessionId: this.activeSessionId,
				childId,
			});
			return result.cancelled;
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "cancel_rlm_child")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async waitForIdle(): Promise<void> {
		await this.requestOk({ type: "wait_for_idle", activeSessionId: this.activeSessionId });
	}

	async executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void> {
		try {
			await this.requestOk({
				type: "execute_bash",
				activeSessionId: this.activeSessionId,
				command,
				excludeFromContext: options?.excludeFromContext,
			});
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "execute_bash")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async abortBash(): Promise<void> {
		try {
			await this.requestOk({ type: "abort_bash", activeSessionId: this.activeSessionId });
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "abort_bash")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
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

	async refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
	): Promise<RefinementResult> {
		const command: {
			type: "refine";
			activeSessionId: string;
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		} = {
			type: "refine",
			activeSessionId: this.activeSessionId,
			instructions: options.instructions,
			rollbackId: options.rollbackId,
		};
		if (options.global !== undefined) {
			command.global = options.global;
		}
		return this.requestData<RefinementResult>(command, DAEMON_REFINE_REQUEST_TIMEOUT_MS);
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

	async watchSession(activeSessionId: string): Promise<AgentConnectionSessionWatcher | undefined> {
		// A second connection on the shared client; each one filters to its own session id.
		// attach() rejects for an unknown/exited session — treat that as unreachable.
		let connection: DaemonAgentConnection;
		try {
			connection = await DaemonAgentConnection.attach(this.client, activeSessionId, { closeClientOnDispose: false });
		} catch {
			return undefined;
		}
		return {
			getMessages: () => connection.getMessages(),
			subscribe: (listener) => connection.subscribe(listener),
			getToolDefinition: (name) => connection.getToolDefinition(name),
			close: () => connection.dispose(),
		};
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

	private async requestData<T>(command: DaemonCommandBody, timeoutMs?: number): Promise<T> {
		const response = await this.client.request(command, timeoutMs);
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		if (invalidatesCachedSnapshot(command.type)) {
			this.latestSnapshotIsFresh = false;
		}
		return response.data as T;
	}

	private async handleDaemonMessage(message: DaemonOutbound): Promise<void> {
		if (!this.isMessageForActiveSession(message)) {
			return;
		}
		if (this.isStaleSequencedMessage(message)) {
			return;
		}
		this.observeDaemonEventSequence(message);

		if (message.type === "session_event") {
			this.latestSnapshotIsFresh = false;
			await this.emit({ type: "session_event", event: message.event });
			return;
		}
		if (message.type === "session_status") {
			// Keep a cached snapshot's recap current so a later re-attach seeds it.
			if (this.latestSnapshot) {
				this.latestSnapshot = {
					...this.latestSnapshot,
					state: { ...this.latestSnapshot.state, recap: message.recap },
				};
			}
			await this.emit({ type: "session_status", recap: message.recap });
			return;
		}
		if (message.type === "session_replaced") {
			const latestSnapshot: AgentConnectionSnapshot = {
				state: message.state,
				messages: message.messages,
			};
			if (this.lastEventSequence !== undefined) {
				latestSnapshot.lastEventSequence = this.lastEventSequence;
			}
			this.latestSnapshot = latestSnapshot;
			this.latestSnapshotIsFresh = true;
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

	private isStaleSequencedMessage(message: DaemonOutbound): boolean {
		const sequence = getDaemonMessageSequence(message);
		return sequence !== undefined && this.lastEventSequence !== undefined && sequence <= this.lastEventSequence;
	}

	private observeDaemonEventSequence(message: DaemonOutbound): void {
		const sequence = getDaemonMessageSequence(message);
		if (sequence === undefined) {
			return;
		}
		this.lastEventSequence =
			this.lastEventSequence === undefined ? sequence : Math.max(this.lastEventSequence, sequence);
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

function mapDaemonAttachSnapshot(result: DaemonAttachResult): AgentConnectionSnapshot {
	return mapDaemonSessionSnapshot(result.snapshot, result.replay);
}

function mapDaemonSessionSnapshot(snapshot: DaemonSessionSnapshot, replay?: DaemonReplayInfo): AgentConnectionSnapshot {
	const connectionSnapshot: AgentConnectionSnapshot = {
		state: snapshot.state,
		messages: snapshot.messages,
		lastEventSequence: snapshot.lastEventSequence,
	};
	if (snapshot.sessionContext) {
		connectionSnapshot.sessionContext = snapshot.sessionContext;
	}
	if (snapshot.sessionTree) {
		connectionSnapshot.sessionTree = snapshot.sessionTree;
	}
	if (snapshot.parent) {
		connectionSnapshot.parent = snapshot.parent;
	}
	if (snapshot.children) {
		connectionSnapshot.children = snapshot.children;
	}
	if (replay) {
		connectionSnapshot.replay = replay;
	}
	return connectionSnapshot;
}

function getDaemonMessageSequence(message: DaemonOutbound): number | undefined {
	if (!("meta" in message)) {
		return undefined;
	}
	return message.meta?.sequence;
}

function invalidatesCachedSnapshot(commandType: DaemonCommandBody["type"]): boolean {
	switch (commandType) {
		case "attach":
		case "detach":
		case "list":
		case "list_saved_sessions":
		case "wait_for_idle":
		case "get_state":
		case "get_connection_state":
		case "get_messages":
		case "get_session_stats":
		case "get_commands":
		case "get_resource_snapshot":
		case "get_available_models":
		case "get_queue":
		case "cron_list":
		case "get_session_context":
		case "get_session_tree":
		case "get_user_messages_for_forking":
		case "get_last_assistant_text":
		case "get_system_prompt":
		case "get_tool_definition":
		case "export_html":
		case "export_jsonl":
			return false;
		default:
			return true;
	}
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
