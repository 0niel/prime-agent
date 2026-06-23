import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type ImageContent, type Transport } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type { AgentCronJob, AgentHeartbeatUpdateAction } from "../../core/cron-jobs.js";
import { emptyGoalState } from "../../core/goals.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { SessionManager } from "../../core/session-manager.js";
import type { SessionStats } from "../../core/session-stats.js";
import { emptyUsage } from "../../core/usage.js";
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
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
	AgentConnectionSwitchSessionOptions,
	AgentConnectionToolDefinition,
	AgentConnectionUserMessage,
} from "./types.js";

/** Local data used to render the chat before a session exists. */
export interface DeferredAgentConnectionSeed {
	cwd: string;
	sessionDir?: string;
	model?: AgentConnectionModel;
	thinkingLevel: ThinkingLevel;
	scopedModels: AgentConnectionScopedModel[];
	availableModels: () => AgentConnectionModel[];
	steeringMode: AgentConnectionQueueMode;
	followUpMode: AgentConnectionQueueMode;
	autoCompactionEnabled: boolean;
}

function emptyResourceSnapshot(): AgentConnectionResourceSnapshot {
	return {
		contextFiles: [],
		skills: [],
		prompts: [],
		extensions: [],
		themes: [],
		diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
	};
}

/**
 * Opens the chat instantly by serving local catalog data, and only creates the
 * real daemon session on the first action (a prompt, model change, etc.). Until
 * then nothing is created, so pressing left to the agents view — or quitting —
 * costs nothing. On creation it pipes the real connection's events through and
 * emits one session_replaced so the UI rebinds to the live catalog.
 */
export class DeferredAgentConnection implements AgentConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private readonly beforeInvalidateListeners = new Set<AgentConnectionBeforeSessionInvalidateListener>();
	private readonly beforeInvalidateRealUnsubs = new Map<AgentConnectionBeforeSessionInvalidateListener, () => void>();
	private real: AgentConnection | undefined;
	private realUnsub: (() => void) | undefined;
	private promotion: Promise<AgentConnection> | undefined;
	private promotedActiveSessionId: string | undefined;
	private disposed = false;

	constructor(
		// Creates the real session and returns its connection plus the daemon
		// activeSessionId, so the id is known even if a later setup step fails.
		private readonly factory: () => Promise<{ connection: AgentConnection; activeSessionId: string }>,
		private readonly seed: DeferredAgentConnectionSeed,
		// Called with a promoted session id so the caller can drop it if it was
		// created but never used (e.g. cycled the model then left, or setup failed).
		private readonly discardEmptySession?: (activeSessionId: string) => Promise<void>,
	) {}

	/** True once the real session has been created. */
	get created(): boolean {
		return this.real !== undefined;
	}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onBeforeSessionInvalidate(listener: AgentConnectionBeforeSessionInvalidateListener): () => void {
		if (this.real) {
			return this.real.onBeforeSessionInvalidate(listener);
		}
		this.beforeInvalidateListeners.add(listener);
		// Unsubscribe must work whether called before or after promotion forwards
		// the listener to the real connection.
		return () => {
			this.beforeInvalidateListeners.delete(listener);
			this.beforeInvalidateRealUnsubs.get(listener)?.();
			this.beforeInvalidateRealUnsubs.delete(listener);
		};
	}

	private emit(event: AgentConnectionEvent): void {
		for (const listener of [...this.listeners]) {
			void listener(event);
		}
	}

	private async emitAndWait(event: AgentConnectionEvent): Promise<void> {
		await Promise.allSettled([...this.listeners].map((listener) => Promise.resolve().then(() => listener(event))));
	}

	private ensure(): Promise<AgentConnection> {
		if (this.real) {
			return Promise.resolve(this.real);
		}
		if (!this.promotion) {
			// Drop a failed attempt so a later action can retry instead of replaying
			// the same rejection forever.
			this.promotion = this.promote().catch((error) => {
				this.promotion = undefined;
				throw error;
			});
		}
		return this.promotion;
	}

	private async promote(): Promise<AgentConnection> {
		const { connection: real, activeSessionId } = await this.factory();
		// dispose() may have run, or a setup step may throw. In any of those cases
		// tear down the client AND drop the daemon session the factory just created,
		// so a failed/cancelled promotion never commits half-state or orphans an
		// empty agent (and retries can't pile more up).
		try {
			if (this.disposed) {
				throw new Error("Deferred connection disposed before promotion completed");
			}
			const [state, messages] = await Promise.all([real.getState(), real.getMessages()]);
			if (this.disposed) {
				throw new Error("Deferred connection disposed before promotion completed");
			}
			this.real = real;
			this.promotedActiveSessionId = activeSessionId;
			this.realUnsub = real.subscribe((event) => this.emit(event));
			// Clear the buffer only after wiring succeeds, so a throw here keeps the
			// listeners for a retry.
			for (const listener of this.beforeInvalidateListeners) {
				this.beforeInvalidateRealUnsubs.set(listener, real.onBeforeSessionInvalidate(listener));
			}
			this.beforeInvalidateListeners.clear();
			// Wait for the UI to rebind to the (empty) real session before the caller's
			// action runs, so the action's own events aren't double-rendered against a
			// concurrent full re-render.
			await this.emitAndWait({ type: "session_replaced", state, messages });
			return real;
		} catch (error) {
			await real.dispose().catch(() => undefined);
			await this.discardEmptySession?.(activeSessionId).catch(() => undefined);
			// Roll back a partial commit so ensure() retries instead of short-circuiting
			// to this disposed connection.
			if (this.real === real) {
				this.realUnsub = undefined;
				this.real = undefined;
				this.promotedActiveSessionId = undefined;
			}
			throw error;
		}
	}

	private defaultState(): AgentConnectionState {
		return {
			cwd: this.seed.cwd,
			model: this.seed.model,
			thinkingLevel: this.seed.thinkingLevel,
			availableThinkingLevels: this.seed.model
				? (getSupportedThinkingLevels(this.seed.model) as ThinkingLevel[])
				: [],
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			steeringMode: this.seed.steeringMode,
			followUpMode: this.seed.followUpMode,
			sessionId: "",
			sessionDir: this.seed.sessionDir,
			leafId: null,
			autoCompactionEnabled: this.seed.autoCompactionEnabled,
			messageCount: 0,
			pendingMessageCount: 0,
			compactionCount: 0,
			goal: emptyGoalState(),
			scopedModels: this.seed.scopedModels,
			activeToolNames: [],
			contextUsage: undefined,
		};
	}

	async getState(): Promise<AgentConnectionState> {
		return this.real ? this.real.getState() : this.defaultState();
	}

	async getInitialSnapshot(): Promise<AgentConnectionSnapshot> {
		if (this.real) {
			return this.real.getInitialSnapshot();
		}
		return { state: this.defaultState(), messages: [], sessionTree: { tree: [], leafId: null } };
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.real ? this.real.getMessages() : [];
	}

	// Extension/skill commands and resources are session-scoped, so they stay
	// empty until promotion; builtin slash commands work meanwhile, and the
	// session_replaced on first action repopulates the catalog.
	async getCommands(): Promise<AgentConnectionSlashCommand[]> {
		return this.real ? this.real.getCommands() : [];
	}

	async getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot> {
		return this.real ? this.real.getResourceSnapshot() : emptyResourceSnapshot();
	}

	async getAvailableModels(): Promise<AgentConnectionModel[]> {
		return this.real ? this.real.getAvailableModels() : this.seed.availableModels();
	}

	async getSessionStats(): Promise<SessionStats> {
		if (this.real) {
			return this.real.getSessionStats();
		}
		return {
			sessionFile: undefined,
			sessionId: "",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		};
	}

	async getContextTree(): Promise<ContextTreeNode> {
		if (this.real) {
			return this.real.getContextTree();
		}
		return {
			id: "root",
			label: "",
			status: "active",
			ownUsage: emptyUsage(),
			totalUsage: emptyUsage(),
			children: [],
		};
	}

	async getSessionContext(): Promise<AgentConnectionSessionContext> {
		if (this.real) {
			return this.real.getSessionContext();
		}
		return {
			messages: [],
			thinkingLevel: this.seed.thinkingLevel,
			model: this.seed.model ? { provider: this.seed.model.provider, modelId: this.seed.model.id } : null,
		};
	}

	async getSessionTree(): Promise<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }> {
		return this.real ? this.real.getSessionTree() : { tree: [], leafId: null };
	}

	async listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		onProgress?: AgentConnectionSessionListProgress,
	): Promise<AgentConnectionSavedSessionInfo[]> {
		if (this.real) {
			return this.real.listSavedSessions(scope, onProgress);
		}
		// Saved sessions live on disk, so the resume picker works without a session.
		return scope === "current"
			? SessionManager.list(this.seed.cwd, this.seed.sessionDir, onProgress)
			: SessionManager.listAll(onProgress, this.seed.sessionDir);
	}

	async getQueue(): Promise<AgentConnectionQueueState> {
		return this.real ? this.real.getQueue() : { steering: [], followUp: [] };
	}

	async clearQueue(): Promise<AgentConnectionQueueState> {
		return this.real ? this.real.clearQueue() : { steering: [], followUp: [] };
	}

	async listCronJobs(options?: { includeInactive?: boolean }): Promise<AgentCronJob[]> {
		return this.real ? this.real.listCronJobs(options) : [];
	}

	async getHeartbeat(): Promise<AgentCronJob | undefined> {
		return this.real ? this.real.getHeartbeat() : undefined;
	}

	async getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]> {
		return this.real ? this.real.getUserMessagesForForking() : [];
	}

	async getLastAssistantText(): Promise<string | undefined> {
		return this.real ? this.real.getLastAssistantText() : undefined;
	}

	async getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined> {
		return this.real ? this.real.getToolDefinition(name) : undefined;
	}

	async setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void> {
		return (await this.ensure()).setSessionEntryLabel(entryId, label);
	}

	async respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void> {
		if (this.real) {
			await this.real.respondToExtensionUiRequest(requestId, response);
		}
	}

	async prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		return (await this.ensure()).prompt(message, options);
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		return (await this.ensure()).steer(message, images);
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		return (await this.ensure()).followUp(message, images);
	}

	async abort(): Promise<void> {
		if (this.real) {
			await this.real.abort();
		}
	}

	async cancelRlmChild(childId: string): Promise<boolean> {
		return this.real ? this.real.cancelRlmChild(childId) : false;
	}

	async waitForIdle(): Promise<void> {
		if (this.real) {
			await this.real.waitForIdle();
		}
	}

	async executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void> {
		return (await this.ensure()).executeBash(command, options);
	}

	async abortBash(): Promise<void> {
		if (this.real) {
			await this.real.abortBash();
		}
	}

	async setModel(provider: string, modelId: string): Promise<AgentConnectionModel> {
		return (await this.ensure()).setModel(provider, modelId);
	}

	async cycleModel(direction?: "forward" | "backward"): Promise<AgentConnectionModelCycleResult | undefined> {
		return (await this.ensure()).cycleModel(direction);
	}

	async setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void> {
		return (await this.ensure()).setScopedModels(scopedModels);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return (await this.ensure()).setThinkingLevel(level);
	}

	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		return (await this.ensure()).cycleThinkingLevel();
	}

	async setTransport(transport: Transport): Promise<void> {
		return (await this.ensure()).setTransport(transport);
	}

	async setSteeringMode(mode: AgentConnectionQueueMode): Promise<void> {
		return (await this.ensure()).setSteeringMode(mode);
	}

	async setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void> {
		return (await this.ensure()).setFollowUpMode(mode);
	}

	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		return (await this.ensure()).setAutoCompactionEnabled(enabled);
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return (await this.ensure()).compact(customInstructions);
	}

	async refine(options?: { instructions?: string; rollbackId?: string }): Promise<RefinementResult> {
		return (await this.ensure()).refine(options);
	}

	async abortCompaction(): Promise<void> {
		if (this.real) {
			await this.real.abortCompaction();
		}
	}

	async abortBranchSummary(): Promise<void> {
		if (this.real) {
			await this.real.abortBranchSummary();
		}
	}

	async abortRetry(): Promise<void> {
		if (this.real) {
			await this.real.abortRetry();
		}
	}

	async reload(): Promise<void> {
		return (await this.ensure()).reload();
	}

	async newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }> {
		return (await this.ensure()).newSession(options);
	}

	async switchSession(
		sessionPath: string,
		options?: AgentConnectionSwitchSessionOptions,
	): Promise<{ cancelled: boolean }> {
		return (await this.ensure()).switchSession(sessionPath, options);
	}

	async fork(
		entryId: string,
		options?: AgentConnectionForkOptions,
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return (await this.ensure()).fork(entryId, options);
	}

	async navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult> {
		return (await this.ensure()).navigateTree(targetId, options);
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return (await this.ensure()).importFromJsonl(inputPath, cwdOverride);
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return (await this.ensure()).exportToHtml(outputPath);
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		return (await this.ensure()).exportToJsonl(outputPath);
	}

	async setSessionName(name: string): Promise<void> {
		return (await this.ensure()).setSessionName(name);
	}

	async renameSavedSession(sessionPath: string, name: string): Promise<void> {
		return (await this.ensure()).renameSavedSession(sessionPath, name);
	}

	async deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult> {
		return (await this.ensure()).deleteSavedSession(sessionPath);
	}

	async addCronJob(schedule: string, prompt: string): Promise<AgentCronJob> {
		return (await this.ensure()).addCronJob(schedule, prompt);
	}

	async cancelCronJob(jobId: string): Promise<AgentCronJob> {
		return (await this.ensure()).cancelCronJob(jobId);
	}

	async setHeartbeat(schedule: string, instruction: string): Promise<AgentCronJob> {
		return (await this.ensure()).setHeartbeat(schedule, instruction);
	}

	async updateHeartbeat(action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined> {
		return (await this.ensure()).updateHeartbeat(action);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		// Wait out an in-flight promotion so a session created during teardown is
		// not left attached with no client.
		if (this.promotion) {
			await this.promotion.catch(() => undefined);
		}
		this.realUnsub?.();
		this.realUnsub = undefined;
		if (this.real) {
			await this.real.dispose();
			this.real = undefined;
			// A promoted-but-never-messaged session (e.g. only a model cycle) would
			// otherwise linger in the daemon; let the caller drop it if abandoned.
			if (this.promotedActiveSessionId && this.discardEmptySession) {
				await this.discardEmptySession(this.promotedActiveSessionId).catch(() => undefined);
			}
		}
	}
}
