import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent, Transport, Usage } from "@earendil-works/pi-ai";
import type { AuthSourceToken } from "../../core/auth-storage.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type { AgentCronJob, AgentHeartbeatUpdateAction } from "../../core/cron-jobs.js";
import type { ReplayBuiltInToolName } from "../../core/extensions/index.js";
import type { GoalState } from "../../core/goals.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type { SessionStats } from "../../core/session-stats.js";

/**
 * Client-side interaction boundary consumed by InteractiveMode.
 *
 * This is not the final hosted/gateway wire protocol. Local and future remote
 * adapters may implement this interface, but network transports should translate
 * at their edge to versioned DTOs with their own framing, sequencing, replay,
 * and command lifecycle semantics.
 *
 * Keep runtime ownership details out of this contract. InteractiveMode must not
 * receive AgentSessionRuntime, AgentSession, SessionManager, daemon socket
 * clients, in-process event emitters, or executable callbacks through
 * AgentConnection. Local-only compatibility hooks belong in adapter/service
 * layers such as InteractiveModeLocalSessionHost.
 *
 * Transitional note: AgentEvent and AgentMessage are still reused below so this
 * PR can move the TUI behind a boundary without rewriting the transcript
 * renderer and stream event model. Replace those aliases with stable
 * connection-owned/network DTOs before treating this surface as a remote wire
 * contract.
 */
export type AgentConnectionQueueMode = "all" | "one-at-a-time";
export type AgentConnectionModel = Model<Api>;
export type AgentConnectionSavedSessionScope = "current" | "all";

export type AgentConnectionSavedSessionStateStatus = "active" | "archived" | "crash";

export type AgentConnectionSourceScope = "user" | "project" | "temporary";
export type AgentConnectionSourceOrigin = "package" | "top-level";

export interface AgentConnectionSourceInfo {
	path: string;
	source: string;
	scope: AgentConnectionSourceScope;
	origin: AgentConnectionSourceOrigin;
	baseDir?: string;
}

export interface AgentConnectionResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string;
	winnerPath: string;
	loserPath: string;
	winnerSource?: string;
	loserSource?: string;
}

export interface AgentConnectionResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: AgentConnectionResourceCollision;
}

export interface AgentConnectionSavedSessionState {
	status: AgentConnectionSavedSessionStateStatus;
}

/**
 * Saved-session registry row for the current local TUI migration.
 *
 * Existing fields intentionally preserve local behavior, including filesystem
 * paths and Date objects. Do not add new TUI features that require these local
 * shapes through AgentConnection. Hosted/gateway work should introduce opaque
 * session/artifact identifiers and string timestamp DTOs before exposing this
 * data across a network.
 */
export interface AgentConnectionSavedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: AgentConnectionSavedSessionState;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type AgentConnectionSessionListProgress = (loaded: number, total: number) => void;

export interface AgentConnectionSessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface AgentConnectionSessionMessageEntry extends AgentConnectionSessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface AgentConnectionThinkingLevelChangeEntry extends AgentConnectionSessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface AgentConnectionModelChangeEntry extends AgentConnectionSessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface AgentConnectionCompactionEntry extends AgentConnectionSessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
	fromHook?: boolean;
}

export interface AgentConnectionBranchSummaryEntry extends AgentConnectionSessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: unknown;
	fromHook?: boolean;
}

export interface AgentConnectionCustomEntry extends AgentConnectionSessionEntryBase {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface AgentConnectionChildUsageAttributionEntry extends AgentConnectionSessionEntryBase {
	type: "child_usage_attributed";
	targetId: string;
	childUsage: Usage;
	aggregateUsage: Usage;
}

export interface AgentConnectionCustomMessageEntry extends AgentConnectionSessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

export interface AgentConnectionLabelEntry extends AgentConnectionSessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface AgentConnectionSessionInfoEntry extends AgentConnectionSessionEntryBase {
	type: "session_info";
	name?: string;
}

export interface AgentConnectionSessionStateEntry extends AgentConnectionSessionEntryBase {
	type: "session_state";
	state: AgentConnectionSavedSessionState;
}

export interface AgentConnectionAgentStatusEntry extends AgentConnectionSessionEntryBase {
	type: "agent_status";
	status: {
		summary: string;
		taskState?: "needs_input" | "completed";
		basedOnMessageCount: number;
	};
}

export interface AgentConnectionGitStateEntry extends AgentConnectionSessionEntryBase {
	type: "git_state";
	git: {
		repoUrl?: string;
		commit?: string;
		branch?: string;
	};
}

export type AgentConnectionSessionEntry =
	| AgentConnectionSessionMessageEntry
	| AgentConnectionThinkingLevelChangeEntry
	| AgentConnectionModelChangeEntry
	| AgentConnectionCompactionEntry
	| AgentConnectionBranchSummaryEntry
	| AgentConnectionCustomEntry
	| AgentConnectionChildUsageAttributionEntry
	| AgentConnectionCustomMessageEntry
	| AgentConnectionLabelEntry
	| AgentConnectionSessionInfoEntry
	| AgentConnectionSessionStateEntry
	| AgentConnectionAgentStatusEntry
	| AgentConnectionGitStateEntry;

export interface AgentConnectionSessionTreeNode {
	entry: AgentConnectionSessionEntry;
	children: AgentConnectionSessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

export interface AgentConnectionSessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export type AgentConnectionReplayStatus = "complete" | "partial" | "unavailable";

export interface AgentConnectionReplayInfo {
	status: AgentConnectionReplayStatus;
	fromSequence?: number;
	toSequence: number;
	reason?: string;
}

export interface AgentConnectionParentMetadata {
	activeSessionId?: string;
	sessionId?: string;
	nodeId?: string;
	childId?: string;
}

export interface AgentConnectionSnapshot {
	state: AgentConnectionState;
	messages: AgentMessage[];
	sessionContext?: AgentConnectionSessionContext;
	sessionTree?: { tree: AgentConnectionSessionTreeNode[]; leafId: string | null };
	parent?: AgentConnectionParentMetadata;
	/** Live RLM child agents (including grandchildren) known to the host at snapshot time. */
	children?: AgentConnectionRlmChildAgentSnapshot[];
	lastEventSequence?: number;
	replay?: AgentConnectionReplayInfo;
}

export interface AgentConnectionScopedModel {
	model: AgentConnectionModel;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentConnectionModelCycleResult {
	model: AgentConnectionModel;
	thinkingLevel: ThinkingLevel;
	isScoped: boolean;
}

export interface AgentConnectionState {
	activeSessionId?: string;
	cwd: string;
	model?: AgentConnectionModel;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning: boolean;
	retryAttempt: number;
	steeringMode: AgentConnectionQueueMode;
	followUpMode: AgentConnectionQueueMode;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	sessionDir?: string;
	leafId: string | null;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	compactionCount: number;
	goal: GoalState;
	scopedModels: AgentConnectionScopedModel[];
	activeToolNames: string[];
	contextUsage: SessionStats["contextUsage"];
	/** One-line recap of the agent's recent work, shown above the prompt. */
	recap?: string;
}

export interface AgentConnectionSlashCommand {
	name: string;
	registeredName?: string;
	description?: string;
	argumentHint?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: AgentConnectionSourceInfo;
}

export type AgentConnectionArtifactType = "context_file" | "extension" | "prompt" | "skill" | "theme";

export interface AgentConnectionArtifactReference {
	id: string;
	sessionId: string;
	type: AgentConnectionArtifactType;
	logicalPath: string;
	relativePath?: string;
	mimeType?: string;
}

export interface AgentConnectionResourceContextFile {
	path: string;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceSkill {
	name: string;
	description?: string;
	filePath: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourcePrompt {
	name: string;
	description?: string;
	argumentHint?: string;
	filePath: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceExtension {
	path: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceTheme {
	name?: string;
	sourcePath?: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceDiagnostics {
	skills: AgentConnectionResourceDiagnostic[];
	prompts: AgentConnectionResourceDiagnostic[];
	extensions: AgentConnectionResourceDiagnostic[];
	themes: AgentConnectionResourceDiagnostic[];
}

export interface AgentConnectionResourceSnapshot {
	contextFiles: AgentConnectionResourceContextFile[];
	skills: AgentConnectionResourceSkill[];
	prompts: AgentConnectionResourcePrompt[];
	extensions: AgentConnectionResourceExtension[];
	themes: AgentConnectionResourceTheme[];
	diagnostics: AgentConnectionResourceDiagnostics;
}

export interface AgentConnectionToolDefinition {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	renderShell?: "default" | "self";
	replayBuiltInToolName?: ReplayBuiltInToolName;
}

export interface AgentConnectionPromptOptions {
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
}

export interface AgentConnectionExecuteBashOptions {
	excludeFromContext?: boolean;
}

export interface AgentConnectionNewSessionOptions {
	parentSession?: string;
}

export interface AgentConnectionForkOptions {
	position?: "before" | "at";
}

export interface AgentConnectionSwitchSessionOptions {
	cwdOverride?: string;
}

export interface AgentConnectionNavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface AgentConnectionNavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
}

export interface AgentConnectionUserMessage {
	entryId: string;
	text: string;
}

export interface AgentConnectionQueueState {
	steering: string[];
	followUp: string[];
}

export type AgentConnectionExtensionUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface AgentConnectionExtensionUiRequest {
	id: string;
	method: string;
	payload: Record<string, unknown>;
}

export type AgentConnectionRlmChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface AgentConnectionRlmChildAgentActivity {
	kind: "waiting" | "writing" | "executing";
	toolName?: string;
}

export interface AgentConnectionRlmChildAgentSnapshot {
	id: string;
	parentId?: string;
	/** The child's own daemon active-session id, for attaching to it directly. */
	activeSessionId?: string;
	label: string;
	status: AgentConnectionRlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	/** Number of tool executions the subagent has started so far. */
	toolUseCount?: number;
	/** Context size (tokens) of the subagent's latest turn. */
	tokenCount?: number;
	/** Latest recap of what the subagent is doing. */
	recap?: string;
	sessionDir: string;
	activity?: AgentConnectionRlmChildAgentActivity;
	/** Failure reason when status is "error". */
	error?: string;
}

export type AgentConnectionSessionEvent =
	| AgentEvent
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| {
			type: "compaction_start";
			reason: "manual" | "threshold" | "overflow" | "requested";
			customInstructions?: string;
	  }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow" | "requested";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** "warning" for benign skips (nothing to compact), "error" for real failures */
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "auth_stale"; provider: string; sourceTokens?: readonly AuthSourceToken[] }
	| { type: "rlm_child_update"; child: AgentConnectionRlmChildAgentSnapshot }
	| { type: "recap_update"; recap: string | undefined }
	| { type: "goal_update"; goal: GoalState }
	| { type: "bash_start"; command: string; excludeFromContext: boolean }
	| { type: "bash_output"; chunk: string }
	| {
			type: "bash_end";
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			fullOutputPath?: string;
			/** Set when execution failed before producing a result (e.g. spawn failure) */
			errorMessage?: string;
	  };

export type AgentConnectionEvent =
	| { type: "session_event"; event: AgentConnectionSessionEvent }
	| { type: "session_replaced"; state: AgentConnectionState; messages: AgentMessage[] }
	| { type: "session_status"; recap?: string }
	| { type: "extension_ui_request"; request: AgentConnectionExtensionUiRequest }
	| { type: "closed"; error?: string };

export type AgentConnectionEventListener = (event: AgentConnectionEvent) => void | Promise<void>;
export type AgentConnectionBeforeSessionInvalidateListener = () => void;

export interface AgentConnection {
	subscribe(listener: AgentConnectionEventListener): () => void;
	onBeforeSessionInvalidate(listener: AgentConnectionBeforeSessionInvalidateListener): () => void;

	getState(): Promise<AgentConnectionState>;
	getInitialSnapshot(): Promise<AgentConnectionSnapshot>;
	getMessages(): Promise<AgentMessage[]>;
	getCommands(): Promise<AgentConnectionSlashCommand[]>;
	getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot>;
	getAvailableModels(): Promise<AgentConnectionModel[]>;
	getSessionStats(): Promise<SessionStats>;
	getContextTree(): Promise<ContextTreeNode>;
	getSessionContext(): Promise<AgentConnectionSessionContext>;
	getSessionTree(): Promise<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }>;
	listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		onProgress?: AgentConnectionSessionListProgress,
	): Promise<AgentConnectionSavedSessionInfo[]>;
	getQueue(): Promise<AgentConnectionQueueState>;
	clearQueue(): Promise<AgentConnectionQueueState>;
	listCronJobs(options?: { includeInactive?: boolean }): Promise<AgentCronJob[]>;
	addCronJob(schedule: string, prompt: string): Promise<AgentCronJob>;
	cancelCronJob(jobId: string): Promise<AgentCronJob>;
	getHeartbeat(): Promise<AgentCronJob | undefined>;
	setHeartbeat(schedule: string, instruction: string): Promise<AgentCronJob>;
	updateHeartbeat(action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined>;
	getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]>;
	getLastAssistantText(): Promise<string | undefined>;
	/** The system prompt currently in effect for the model (with any per-turn extension changes). */
	getSystemPrompt(): Promise<string>;
	getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined>;
	setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void>;
	respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void>;

	prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void>;
	steer(message: string, images?: ImageContent[]): Promise<void>;
	followUp(message: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	cancelRlmChild(childId: string): Promise<boolean>;
	waitForIdle(): Promise<void>;

	/**
	 * Run a user-initiated bash command (! / !! prefix). Resolution timing is
	 * adapter-specific; rendering must be driven by the bash_start/bash_output/
	 * bash_end session events, which reach every attached client.
	 */
	executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void>;
	abortBash(): Promise<void>;

	setModel(provider: string, modelId: string): Promise<AgentConnectionModel>;
	cycleModel(direction?: "forward" | "backward"): Promise<AgentConnectionModelCycleResult | undefined>;
	setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	cycleThinkingLevel(): Promise<ThinkingLevel | undefined>;
	setTransport(transport: Transport): Promise<void>;
	setSteeringMode(mode: AgentConnectionQueueMode): Promise<void>;
	setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void>;
	setAutoCompactionEnabled(enabled: boolean): Promise<void>;

	compact(customInstructions?: string): Promise<CompactionResult>;
	refine(options?: { instructions?: string; rollbackId?: string; global?: boolean }): Promise<RefinementResult>;
	abortCompaction(): Promise<void>;
	abortBranchSummary(): Promise<void>;
	abortRetry(): Promise<void>;

	reload(): Promise<void>;
	newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string, options?: AgentConnectionSwitchSessionOptions): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: AgentConnectionForkOptions): Promise<{ cancelled: boolean; selectedText?: string }>;
	navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	exportToHtml(outputPath?: string): Promise<string>;
	exportToJsonl(outputPath?: string): Promise<string>;
	setSessionName(name: string): Promise<void>;
	renameSavedSession(sessionPath: string, name: string): Promise<void>;
	deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult>;

	/** Read-only watcher on another live session (a subagent); undefined if the transport can't reach it. */
	watchSession(activeSessionId: string): Promise<AgentConnectionSessionWatcher | undefined>;

	dispose(): Promise<void>;
}

export interface AgentConnectionSessionWatcher {
	getMessages(): Promise<AgentMessage[]>;
	subscribe(listener: AgentConnectionEventListener): () => void;
	getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined>;
	close(): Promise<void>;
}
