import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Transport } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type { AgentCronJob, AgentHeartbeatDeliveryMode, AgentHeartbeatUpdateAction } from "../../core/cron-jobs.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import { type DeleteSessionFileResult, deleteSessionFile } from "../../core/session-file-actions.js";
import { SessionManager } from "../../core/session-manager.js";
import type { SessionStats } from "../../core/session-stats.js";
import { type SideQuestionRun, startSideQuestion } from "../../core/side-question.js";
import {
	createAgentConnectionCommands,
	createAgentConnectionResourceSnapshot,
	createAgentConnectionSnapshot,
	createAgentConnectionState,
} from "./snapshot.js";
import { createAgentConnectionToolDefinition } from "./tool-definition.js";
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
	AgentConnectionSessionListCallbacks,
	AgentConnectionSessionTreeNode,
	AgentConnectionSessionWatcher,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
	AgentConnectionSwitchSessionOptions,
	AgentConnectionToolDefinition,
	AgentConnectionUserMessage,
} from "./types.js";

export class InProcessAgentConnection implements AgentConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private readonly beforeSessionInvalidateListeners = new Set<AgentConnectionBeforeSessionInvalidateListener>();
	private readonly sideQuestionRuns = new Map<string, SideQuestionRun>();
	private unsubscribeSessionEvents: (() => void) | undefined;

	constructor(private readonly runtimeHost: AgentSessionRuntime) {
		this.bindCurrentSessionEvents();
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.abortAllSideQuestions();
			for (const listener of [...this.beforeSessionInvalidateListeners]) {
				listener();
			}
		});
		this.runtimeHost.setRebindSession(async () => {
			this.bindCurrentSessionEvents();
			await this.emit({
				type: "session_replaced",
				state: createAgentConnectionState(this.runtimeHost),
				messages: this.runtimeHost.session.messages,
			});
		});
	}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onBeforeSessionInvalidate(listener: AgentConnectionBeforeSessionInvalidateListener): () => void {
		this.beforeSessionInvalidateListeners.add(listener);
		return () => {
			this.beforeSessionInvalidateListeners.delete(listener);
		};
	}

	async getState(): Promise<AgentConnectionState> {
		return createAgentConnectionState(this.runtimeHost);
	}

	async getInitialSnapshot(): Promise<AgentConnectionSnapshot> {
		return createAgentConnectionSnapshot(this.runtimeHost);
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.session.messages;
	}

	async getCommands(): Promise<AgentConnectionSlashCommand[]> {
		return createAgentConnectionCommands(this.session);
	}

	async getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot> {
		return createAgentConnectionResourceSnapshot(this.session);
	}

	async getAvailableModels(): Promise<AgentConnectionModel[]> {
		this.session.modelRegistry.refresh();
		return this.session.modelRegistry.getAvailable();
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.session.getSessionStats();
	}

	async getContextTree(): Promise<ContextTreeNode> {
		return this.session.getContextTree();
	}

	async getSessionContext(): Promise<AgentConnectionSessionContext> {
		return this.session.buildSessionContext();
	}

	async getSessionTree(): Promise<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }> {
		return {
			tree: this.session.sessionManager.getTree(),
			leafId: this.session.sessionManager.getLeafId(),
		};
	}

	async listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		callbacks?: AgentConnectionSessionListCallbacks,
	): Promise<AgentConnectionSavedSessionInfo[]> {
		if (scope === "current") {
			return SessionManager.list(
				this.session.sessionManager.getCwd(),
				this.session.sessionManager.getSessionDir(),
				callbacks,
			);
		}
		return SessionManager.listAll(callbacks, this.session.sessionManager.getSessionDir());
	}

	async getQueue(): Promise<AgentConnectionQueueState> {
		return {
			steering: [...this.session.getSteeringMessagePreviews()],
			followUp: [...this.session.getFollowUpMessagePreviews()],
		};
	}

	async clearQueue(): Promise<AgentConnectionQueueState> {
		return this.session.clearQueue();
	}

	async abortAndClearQueue(): Promise<AgentConnectionQueueState> {
		const queue = this.session.clearQueue();
		this.session.requestAbort();
		return queue;
	}

	async listCronJobs(_options: { includeInactive?: boolean } = {}): Promise<AgentCronJob[]> {
		return [];
	}

	async addCronJob(_schedule: string, _prompt: string): Promise<AgentCronJob> {
		throw new Error("Cron jobs require daemon mode");
	}

	async cancelCronJob(_jobId: string): Promise<AgentCronJob> {
		throw new Error("Cron jobs require daemon mode");
	}

	async getHeartbeat(): Promise<AgentCronJob | undefined> {
		return undefined;
	}

	async setHeartbeat(
		_schedule: string,
		_instruction: string,
		_deliveryMode?: AgentHeartbeatDeliveryMode,
	): Promise<AgentCronJob> {
		throw new Error("Heartbeats require daemon mode");
	}

	async updateHeartbeat(_action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined> {
		throw new Error("Heartbeats require daemon mode");
	}

	async getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]> {
		return this.session.getUserMessagesForForking();
	}

	async getLastAssistantText(): Promise<string | undefined> {
		return this.session.getLastAssistantText();
	}

	async getSystemPrompt(): Promise<string> {
		return this.session.systemPrompt;
	}

	async getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined> {
		return createAgentConnectionToolDefinition(this.session.getToolDefinition(name));
	}

	async setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void> {
		this.session.sessionManager.appendLabelChange(entryId, label);
	}

	async respondToExtensionUiRequest(_requestId: string, _response: AgentConnectionExtensionUiResponse): Promise<void> {
		// In-process extension UI requests are handled directly by InteractiveMode.
	}

	async prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await this.session.prompt(message, {
			images: options?.images,
			streamingBehavior: options?.streamingBehavior,
		});
	}

	async startSideQuestion(id: string, question: string): Promise<void> {
		if (this.sideQuestionRuns.has(id)) {
			throw new Error(`Side question already exists: ${id}`);
		}
		const run = startSideQuestion(this.session.agent, id, question, (event) =>
			this.emit({ type: "side_question_event", event }),
		);
		this.sideQuestionRuns.set(id, run);
		const removeRun = () => {
			this.sideQuestionRuns.delete(id);
		};
		void run.done.then(removeRun, removeRun);
	}

	async abortSideQuestion(id: string): Promise<boolean> {
		const run = this.sideQuestionRuns.get(id);
		if (!run) {
			return false;
		}
		run.abort();
		return true;
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.session.steer(message, images);
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.session.followUp(message, images);
	}

	async abort(): Promise<void> {
		this.session.requestAbort();
	}

	async cancelRlmChild(childId: string): Promise<boolean> {
		return this.session.cancelRlmChildRun(childId);
	}

	async waitForIdle(): Promise<void> {
		await this.session.agent.waitForIdle();
	}

	async executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void> {
		await this.session.runUserBash(command, options);
	}

	async abortBash(): Promise<void> {
		this.session.abortBash();
	}

	async setModel(provider: string, modelId: string): Promise<AgentConnectionModel> {
		this.session.modelRegistry.refresh();
		const model = this.session.modelRegistry.getAvailable().find((candidate) => {
			return candidate.provider === provider && candidate.id === modelId;
		});
		if (!model) {
			throw new Error(`Model not found: ${provider}/${modelId}`);
		}
		await this.session.setModel(model);
		return model;
	}

	async cycleModel(
		direction: "forward" | "backward" = "forward",
	): Promise<AgentConnectionModelCycleResult | undefined> {
		return this.session.cycleModel(direction);
	}

	async setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void> {
		this.session.setScopedModels(scopedModels);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.session.setThinkingLevel(level);
	}

	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		return this.session.cycleThinkingLevel();
	}

	async setTransport(transport: Transport): Promise<void> {
		this.session.settingsManager.setTransport(transport);
		this.session.agent.transport = transport;
	}

	async setSteeringMode(mode: AgentConnectionQueueMode): Promise<void> {
		this.session.setSteeringMode(mode);
	}

	async setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void> {
		this.session.setFollowUpMode(mode);
	}

	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		this.session.setAutoCompactionEnabled(enabled);
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this.session.compact(customInstructions);
	}

	async refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
	): Promise<RefinementResult> {
		return this.session.refine(options);
	}

	async abortCompaction(): Promise<void> {
		this.session.abortCompaction();
	}

	async abortBranchSummary(): Promise<void> {
		this.session.abortBranchSummary();
	}

	async abortRetry(): Promise<void> {
		this.session.abortRetry();
	}

	async reload(): Promise<void> {
		await this.session.reload();
	}

	async newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }> {
		return this.runtimeHost.newSession(options);
	}

	async switchSession(
		sessionPath: string,
		options?: AgentConnectionSwitchSessionOptions,
	): Promise<{ cancelled: boolean }> {
		return this.runtimeHost.switchSession(sessionPath, options);
	}

	async fork(
		entryId: string,
		options?: AgentConnectionForkOptions,
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.runtimeHost.fork(entryId, options);
	}

	async navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult> {
		return this.session.navigateTree(targetId, options);
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.runtimeHost.importFromJsonl(inputPath, cwdOverride);
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return this.session.exportToHtml(outputPath);
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		return this.session.exportToJsonl(outputPath);
	}

	async setSessionName(name: string): Promise<void> {
		const trimmedName = name.trim();
		if (!trimmedName) {
			throw new Error("Session name cannot be empty");
		}
		this.session.setSessionName(trimmedName);
	}

	async renameSavedSession(sessionPath: string, name: string): Promise<void> {
		const trimmedName = name.trim();
		if (!trimmedName) {
			throw new Error("Session name cannot be empty");
		}
		const currentSessionFile = this.session.sessionFile;
		if (currentSessionFile && resolve(currentSessionFile) === resolve(sessionPath)) {
			this.session.setSessionName(trimmedName);
			return;
		}
		SessionManager.open(sessionPath).appendSessionInfo(trimmedName);
	}

	async deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult> {
		return deleteSessionFile(sessionPath);
	}

	async watchSession(childId: string): Promise<AgentConnectionSessionWatcher | undefined> {
		const child = this.session.getRlmChildSession(childId);
		if (!child) {
			return undefined;
		}
		const unsubscribes = new Set<() => void>();
		return {
			getMessages: async () => child.messages,
			subscribe: (listener) => {
				const unsubscribe = child.subscribe((event) => void listener({ type: "session_event", event }));
				unsubscribes.add(unsubscribe);
				return () => {
					unsubscribes.delete(unsubscribe);
					unsubscribe();
				};
			},
			getToolDefinition: async (name) => createAgentConnectionToolDefinition(child.getToolDefinition(name)),
			close: async () => {
				for (const unsubscribe of unsubscribes) {
					unsubscribe();
				}
				unsubscribes.clear();
			},
		};
	}

	async dispose(): Promise<void> {
		this.abortAllSideQuestions();
		this.unsubscribeSessionEvents?.();
		this.unsubscribeSessionEvents = undefined;
		this.runtimeHost.setBeforeSessionInvalidate(undefined);
		this.runtimeHost.setRebindSession(undefined);
		await this.runtimeHost.dispose();
	}

	private get session() {
		return this.runtimeHost.session;
	}

	private bindCurrentSessionEvents(): void {
		this.unsubscribeSessionEvents?.();
		this.unsubscribeSessionEvents = this.session.subscribe((event) => {
			void this.emit({ type: "session_event", event });
		});
	}

	private abortAllSideQuestions(): void {
		for (const run of this.sideQuestionRuns.values()) {
			run.abort();
		}
		this.sideQuestionRuns.clear();
	}

	private async emit(event: AgentConnectionEvent): Promise<void> {
		for (const listener of [...this.listeners]) {
			await listener(event);
		}
	}
}
