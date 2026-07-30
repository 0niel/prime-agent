/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type GetContinuationMessagesContext,
	type ShouldStopAfterTurnContext,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	ServiceTier,
	TextContent,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	resetApiProviders,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import { theme } from "../modes/interactive/theme/theme.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { sleep } from "../utils/sleep.js";
import {
	AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL,
	AGENT_MESSAGE_SKILL_NAME,
	type AgentSessionMessage,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageController,
	type AgentSessionMessageListResult,
	type AgentSessionMessageReceipt,
	assertDirectAgentMessageTarget,
	createAgentMessageHostHandlers,
	isAgentSessionMessage,
	normalizeAgentSessionMessage,
	normalizeAgentSessionMessageDeliveryMode,
	parseAgentSessionMessagePromptId,
} from "./agent-messages.js";
import {
	AGENT_OBSERVE_SKILL_NAME,
	type AgentObserveAgentSnapshot,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesResult,
	createAgentObserveHostHandlers,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
	ORCHESTRATION_HEARTBEAT_SKILL_NAME,
} from "./agent-observe.js";
import { flushAgentTraceUpload } from "./agent-traces.js";
import {
	addLoginGuidanceToAuthError,
	formatAuthenticationFailedMessage,
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	isLikelyAuthenticationError,
} from "./auth-guidance.js";
import type { AuthSourceToken } from "./auth-storage.js";
import {
	type AgentAutonomousConfig,
	type AgentAutonomousStatus,
	type AutonomousRuntimeState,
	addAutonomousContinuation,
	addAutonomousUsage,
	autonomousStatus,
	createAutonomousRuntimeState,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
} from "./autonomous.js";
import { type BashResult, executeBashWithOperations } from "./bash-executor.js";
import {
	COMPACT_SKILL_NAME,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.js";
import {
	type ContextTreeNode,
	type ContextWindowResolver,
	computeOwnAndTotalUsage,
	loadContextTreeChildFromDisk,
	loadContextTreeChildrenFromDisk,
} from "./context-tree.js";
import type { AgentCronJob, AgentRlmHeartbeatController, AgentRlmHeartbeatStatusUpdate } from "./cron-jobs.js";
import { normalizeHeartbeatDeliveryMode } from "./cron-jobs.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.js";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.js";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import {
	createGoalContextMessage,
	emptyGoalState,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTEXT_PREVIEW_LABEL,
	GOAL_SKILL_NAME,
	GOAL_STATE_CUSTOM_TYPE,
	type GoalHostResponse,
	type GoalState,
	type GoalStatus,
	goalHostResponse,
	goalTokenDeltaForUsage,
	isPersistedGoalState,
	normalizeGoalState,
	validateGoalBudget,
	validateGoalObjective,
} from "./goals.js";
import type { HostRequestHandlers, KernelSentAgentMessage } from "./kernel/index.js";
import { type RestoreResult, snapshotPathIn } from "./kernel/state-snapshot.js";
import type { McpManager } from "./mcp/mcp-manager.js";
import {
	type BashExecutionMessage,
	type CompactionOutcome,
	type CompactionOutcomeReason,
	type CustomMessage,
	createCompactionOutcomeMessage,
	createHeartbeatPromptMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	isSessionSlashCommandMessage,
} from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { throwIfPromptAdmissionCancelled, waitForPromptAdmission } from "./prompt-admission.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import {
	type AutoRefineReason,
	type AutoRefineReview,
	appendGlobalRefinement,
	applyRefinementProposal,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	getRefinementHistory,
	type HarnessState,
	inferRefinementResultScope,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	planRefinement,
	REFINE_SKILL_NAME,
	type RefinementPlan,
	type RefinementResult,
	reviewAutoRefine,
	saveHarnessState,
} from "./refinement/index.js";
import { resolveConfigValue } from "./resolve-config-value.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createDefaultRlmSubagentSessionName,
	createRlmDeleteSubagentHostHandler,
	createRlmFindModelsHostHandler,
	createRlmListSubagentsHostHandler,
	createRlmRunHostHandler,
	findRlmModelMatches,
	normalizeRequestedRlmSubagentModel,
	normalizeRequestedRlmSubagentSessionName,
	type RlmDeleteSubagentResult,
	type RlmFindModelsResult,
	type RlmInternalRunResult,
	type RlmListSubagentsResult,
	type RlmRunResult,
	type RlmSubagentRegistryEntry,
	type RlmSubagentReleaseStatus,
	type RlmSubagentRuntime,
	type RlmUsage,
	type SubagentRuntimeHost,
} from "./rlm-runtime.js";
import type { BranchSummaryEntry, CompactionEntry, SessionContext, SessionMessageEntry } from "./session-manager.js";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	type SessionHeader,
	SessionManager,
} from "./session-manager.js";
import type { SessionStats } from "./session-stats.js";
import type { SettingsManager } from "./settings-manager.js";
import { getPythonSkillRuntimeInfo, type Skill } from "./skills.js";
import {
	parseRefineCommandOptions,
	parseSessionSlashCommand,
	parseSlashCommand,
	type SessionSlashCommand,
	type SlashCommandInfo,
} from "./slash-commands.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.js";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { IpythonKernelProvisioner } from "./tools/ipython.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import { addAssistantUsage, emptyUsage } from "./usage.js";
import { SERPER_CREDENTIAL_ID, SERPER_ENV_VAR, WEBSEARCH_SKILL_NAME } from "./websearch-credential.js";

export type { GoalState, GoalStatus } from "./goals.js";
export type { SessionStats } from "./session-stats.js";
export { type ParsedSkillBlock, parseSkillBlock } from "./skill-blocks.js";

export type RlmChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface RlmChildAgentActivity {
	kind: "waiting" | "writing" | "executing";
	toolName?: string;
}

export interface RlmChildAgentSnapshot {
	id: string;
	parentId?: string;
	activeSessionId?: string;
	/** Stable daemon-visible session name for addressing/displaying the child. */
	sessionName?: string;
	/** Exact provider/model selector used by the child. */
	model?: string;
	label: string;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	/** Number of tool executions the subagent has started so far. */
	toolUseCount?: number;
	/** Context size (tokens) of the subagent's latest turn. */
	tokenCount?: number;
	/** Latest recap of what the subagent is doing, from the summarizer. */
	recap?: string;
	sessionDir: string;
	activity?: RlmChildAgentActivity;
	/** Failure reason when status is "error". */
	error?: string;
}

export type CompactionReason = "manual" | "threshold" | "overflow" | "requested";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "ipython_sent_agent_message"; toolCallId: string; message: KernelSentAgentMessage }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: CompactionReason; customInstructions?: string }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "service_tier_changed"; serviceTier: ServiceTier }
	| {
			type: "compaction_end";
			reason: CompactionReason;
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
	| { type: "rlm_child_update"; child: RlmChildAgentSnapshot }
	| { type: "recap_update"; recap: string | undefined }
	| { type: "goal_update"; goal: GoalState }
	| { type: "bash_start"; command: string; excludeFromContext: boolean; transient?: boolean; runId?: string }
	| { type: "bash_output"; chunk: string }
	| {
			type: "bash_end";
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			fullOutputPath?: string;
			/** Set when execution failed before producing a result (e.g. spawn failure) */
			errorMessage?: string;
			/** Set for transient (side-conversation) runs so other attached clients suppress them. */
			transient?: boolean;
			/** Echo of the caller-supplied run id, so clients correlate runs by identity. */
			runId?: string;
	  }
	| { type: "refine_complete"; result: RefinementResult }
	| { type: "refine_failed"; error: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/** Payload of the bash_end event for a user-initiated bash command */
type UserBashEndDetails = {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	errorMessage?: string;
};

/** Thrown when compaction is skipped for a benign reason (surfaced as a warning, not an error) */
export class CompactionSkippedError extends Error {}

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	serviceTierPreference?: ServiceTier;
	cwd: string;
	/** Config dir backing credentials (auth.json); exported to the kernel for skills. */
	agentDir?: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [ipython] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/**
	 * Whether the built-in long-running goals feature is available: the bundled
	 * goal skill in the IPython kernel, its goal.* host handlers, and /goal.
	 * Default: true.
	 */
	includeGoals?: boolean;
	/** Daemon-backed agent-to-agent messaging bridge. Omitted for local-only sessions. */
	agentMessageController?: AgentSessionMessageController;
	/** Daemon-backed read-only active-session observation bridge. Omitted for local-only sessions. */
	agentObserveController?: AgentObserveController;
	/**
	 * Whether the bundled compact skill and its compact.* host handlers are
	 * available to the model. Default: the compaction.agentCallable setting.
	 */
	includeCompactSkill?: boolean;
	/**
	 * Optional host-side controller for the bundled rlm-heartbeat Python skill.
	 * When omitted, rlm_heartbeat.* host requests are unavailable.
	 */
	rlmHeartbeatController?: AgentRlmHeartbeatController;
	/**
	 * Optional MCP integration manager. When present, its mcp.* host requests
	 * (refresh, begin_login) are exposed to the kernel.
	 */
	mcpManager?: McpManager;
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Current RLM recursion depth. Root sessions default to RLM_DEPTH or 0. */
	rlmDepth?: number;
	/** Maximum RLM recursion depth. Defaults to RLM_MAX_DEPTH or 1. */
	rlmMaxDepth?: number;
	/** Directory exposed to the kernel as RLM_SESSION_DIR. */
	rlmSessionDir?: string;
	/** Node id for this session when it is itself an RLM child. */
	rlmParentNodeId?: string;
	/** Host responsible for creating RLM subagent runtimes. */
	subagentRuntimeHost?: SubagentRuntimeHost;
	/** Host-side autonomous continuation policy. */
	autonomous?: AgentAutonomousConfig;
	/**
	 * Boot the IPython kernel in the background as soon as the session is created,
	 * so the first ipython tool call doesn't pay the kernel cold start.
	 *
	 * Only applies to main agents (rlmDepth 0); subagent kernels stay lazy. Default: false.
	 */
	prewarmIpythonKernel?: boolean;
	/** Test/extension hook for automatic refine review decisions. Defaults to the model-backed review gate. */
	autoRefineReviewer?: AutoRefineReviewer;
	/**
	 * When true, auto-refine runs synchronously between turns at the
	 * shouldStopAfterTurn boundary instead of in the background after
	 * agent_end. Used for print/headless autonomous runs so refinement
	 * never overlaps the primary model request. Default: false.
	 */
	serializedRefine?: boolean;
	/**
	 * Initial goal to seed at session creation. Only applied when rlmDepth
	 * is 0 and no persisted thread_goal_state entry exists in the branch.
	 */
	initialGoal?: { objective: string; tokenBudget?: number };
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface AutoRefineReviewRequest {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

/**
 * Discriminated result from a serialized-mode background planning pass.
 * - "plan": review approved and planning succeeded; carry the exact plan,
 *   options, and abort controller so the boundary can apply directly
 *   without a second planning request.
 * - "skip": reviewer declined; no refine needed.
 * - "failure": review or planning threw; boundary should not retry.
 */
export type SerializedBackgroundPlanResult =
	| {
			status: "plan";
			plan: RefinementPlan;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			abort: AbortController;
			branchVersion: number;
	  }
	| { status: "skip" }
	| { status: "invalidated"; branchVersion: number }
	| {
			status: "failure";
			/** True when the background plan was for an explicit refine.run (skipReview). */
			explicit: boolean;
			/** Original options for the failed plan, to allow re-queue on explicit failure. */
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			branchVersion: number;
	  };

export type AutoRefineReviewer = (request: AutoRefineReviewRequest, signal?: AbortSignal) => Promise<AutoRefineReview>;

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Coalesce follow-up queueing so only one pending follow-up exists for this key. */
	followUpQueueKey?: string;
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean, queued?: boolean) => void;
	/** Queue instead of starting immediately when the session is idle but already has queued work. */
	queueIfBusy?: boolean;
	/** Start queued work when no agent turn is currently running. */
	resumeIfIdle?: boolean;
	/** Host-generated prompt that must bypass extension/slash/template input interception. */
	internalPrompt?: boolean;
	/** Prevent host-driven prompts from causing autonomous continuation injection. */
	suppressAutonomousContinuation?: boolean;
	/** Skip extension input handlers for replaying already-accepted input. */
	skipInputHandlers?: boolean;
	/** Cancel this prompt while it is waiting for direct-turn admission. */
	signal?: AbortSignal;
	/** Internal host hook fired at the direct-turn ownership commit point. */
	admissionCommitted?: () => void;
	agentMessageId?: string;
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
}

interface InternalPromptOptions extends PromptOptions {
	skipPrePromptWork?: boolean;
	returnAfterAccepted?: boolean;
	agentMessageId?: string;
}

type QueuedAgentMessage = UserMessage | CustomMessage;
type SessionInputSchedule = "steer" | "followUp";

interface PreparedPromptInput {
	kind: "prompt";
	text: string;
	images?: ImageContent[];
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
	previewLabel?: string;
	queueKey?: string;
	agentMessageId?: string;
	prefixMessages: CustomMessage[];
	suppressAutonomousContinuation?: boolean;
	autoPump: boolean;
	preparation?: PreparedPromptPreparation;
	message: QueuedAgentMessage;
}

interface PreparedPromptPreparation {
	result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>;
	/** Base system prompt captured at emitBeforeAgentStart, for stale-base refresh at handoff. */
	basePromptSnapshot: string;
}

class DeferredSessionInputError extends Error {}

/** Wrap a preflight callback so only the first report wins. */
function oncePreflight(
	preflightResult: ((success: boolean, queued?: boolean) => void) | undefined,
): (success: boolean, queued?: boolean) => void {
	let settled = false;
	return (success, queued = false) => {
		if (!settled) {
			settled = true;
			preflightResult?.(success, queued);
		}
	};
}

interface PreparedCommandInput {
	kind: "command";
	text: string;
	command: SessionSlashCommand;
	images?: ImageContent[];
	queueKey?: undefined;
	agentMessageId?: string;
	message?: undefined;
}

type QueuedSessionInput = PreparedPromptInput | PreparedCommandInput;

export interface QueuedAgentInputSnapshot {
	text: string;
	content?: (TextContent | ImageContent)[];
	images?: ImageContent[];
	queueKey?: string;
	agentMessageId?: string;
	customMessage?: CustomMessage;
	prefixMessages?: CustomMessage[];
}

export interface AcceptedAgentInputSnapshot extends QueuedAgentInputSnapshot {
	nextTurn: CustomMessage[];
}

function cloneCustomMessage(message: CustomMessage): CustomMessage {
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

function createQueuedAgentInputSnapshotFromUserMessage(
	text: string,
	message: QueuedAgentMessage,
): QueuedAgentInputSnapshot {
	if (message.role === "custom") {
		return { text, customMessage: cloneCustomMessage(message) };
	}
	const messageContent = message.content;
	if (!Array.isArray(messageContent)) {
		return { text };
	}
	const content = messageContent.map((block) => ({ ...block }));
	const images = content.filter((block): block is ImageContent => block.type === "image");
	return { text, content, ...(images.length > 0 ? { images } : {}) };
}

function createQueuedAgentInputSnapshot(message: QueuedSessionInput): QueuedAgentInputSnapshot {
	if (message.kind === "command") {
		return {
			text: message.text,
			...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
			...(message.agentMessageId ? { agentMessageId: message.agentMessageId } : {}),
			customMessage: createSessionSlashCommandMessage(message.command),
		};
	}
	const legacySnapshot = createQueuedAgentInputSnapshotFromUserMessage(message.text, message.message);
	return {
		...legacySnapshot,
		text: message.text,
		...(message.content ? { content: message.content.map((block) => ({ ...block })) } : {}),
		...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
		...(message.customMessage ? { customMessage: cloneCustomMessage(message.customMessage) } : {}),
		...(message.prefixMessages.length > 0
			? { prefixMessages: message.prefixMessages.map((prefix) => cloneCustomMessage(prefix)) }
			: {}),
		...(message.agentMessageId ? { agentMessageId: message.agentMessageId } : {}),
		...(message.queueKey ? { queueKey: message.queueKey } : {}),
	};
}

function queuedMessagePreview(message: { text: string; previewLabel?: string }): string {
	return message.previewLabel ? `${message.previewLabel}: ${message.text}` : message.text;
}

function normalizeMessageContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images?: ImageContent[];
} {
	if (typeof content === "string") return { text: content };
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part): part is ImageContent => part.type === "image");
	return { text, ...(images.length > 0 ? { images } : {}) };
}

function queuedAgentMessagePreview(message: QueuedSessionInput): string {
	if (message.kind === "command") {
		return message.text;
	}
	if (message.customMessage && isAgentSessionMessage(message.customMessage)) {
		return `${AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL}: ${message.customMessage.details.message}`;
	}
	return queuedMessagePreview(message);
}

const IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY = "ipython_sent_agent_message";

interface PersistedIpythonSentAgentMessage {
	toolCallId: string;
	message: KernelSentAgentMessage;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedIpythonSentAgentMessage(value: unknown): PersistedIpythonSentAgentMessage | undefined {
	if (!isObjectRecord(value) || typeof value.toolCallId !== "string" || !isObjectRecord(value.message)) {
		return undefined;
	}
	const { id, message, deliveryStatus, target } = value.message;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		!isObjectRecord(target) ||
		typeof target.activeSessionId !== "string" ||
		typeof target.sessionId !== "string"
	) {
		return undefined;
	}
	return {
		toolCallId: value.toolCallId,
		message: {
			id,
			message,
			deliveryStatus,
			target: {
				activeSessionId: target.activeSessionId,
				sessionId: target.sessionId,
				...(typeof target.sessionName === "string" ? { sessionName: target.sessionName } : {}),
			},
		},
	};
}

function appendSentAgentMessageToToolResult(
	message: AgentMessage,
	toolCallId: string,
	sentMessage: KernelSentAgentMessage,
): boolean {
	if (message.role !== "toolResult" || message.toolName !== "ipython" || message.toolCallId !== toolCallId) {
		return false;
	}
	const details = isObjectRecord(message.details) ? message.details : {};
	const current = Array.isArray(details.sentAgentMessages) ? details.sentAgentMessages : [];
	if (current.some((entry) => isObjectRecord(entry) && entry.id === sentMessage.id)) {
		return true;
	}
	message.details = { ...details, sentAgentMessages: [...current, sentMessage] };
	return true;
}

function injectedMessagePreviewLabel(message: CustomMessage): string | undefined {
	switch (message.customType) {
		case HEARTBEAT_PROMPT_CUSTOM_TYPE:
			return HEARTBEAT_PROMPT_PREVIEW_LABEL;
		case GOAL_CONTEXT_CUSTOM_TYPE:
			return GOAL_CONTEXT_PREVIEW_LABEL;
		default:
			return undefined;
	}
}

interface AcceptedAgentMessagePrompt {
	text: string;
	agentMessageId: string;
	message: QueuedAgentMessage;
	messages: Set<AgentMessage>;
	/** Pending nextTurn messages drained into this prompt; restored to the queue if the prompt is cleared. */
	pendingNextTurnMessages: CustomMessage[];
	deliveredPendingNextTurnMessages: Set<CustomMessage>;
	accepted: Promise<void>;
	resolveAccepted: () => void;
	rejectAccepted: (error: Error) => void;
	turnStarted: boolean;
	cleared: boolean;
}

function undeliveredPendingNextTurnMessages(accepted: AcceptedAgentMessagePrompt): CustomMessage[] {
	return accepted.pendingNextTurnMessages.filter((message) => !accepted.deliveredPendingNextTurnMessages.has(message));
}

interface AgentMessageDeferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

/**
 * Per-agent-message settlement record: `delivery` settles when the prompt reaches agent state,
 * `completion` when its turn (or command) finishes. Settled deferreds are removed immediately.
 */
interface AgentMessageOutcome {
	delivery?: AgentMessageDeferred;
	completion?: AgentMessageDeferred;
}

function createAgentMessageDeferred(): AgentMessageDeferred {
	const deferred = {} as AgentMessageDeferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	deferred.promise.catch(() => undefined);
	return deferred;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

interface ModelSelectOptions {
	waitForExtensions?: boolean;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

type GoalSlashCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "start"; objective: string; tokenBudget?: number };

type AutonomousSlashCommand = { kind: "status" } | { kind: "on" } | { kind: "off" };

type AutonomousRuntimeSnapshot = Pick<
	AutonomousRuntimeState,
	"continuationsUsed" | "gateAttempts" | "lastGateFailure" | "lastGateFailureSnapshot"
>;

interface RlmChildRun {
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	status: RlmChildAgentStatus;
	result?: RlmRunResult;
	error?: string;
	releaseError?: unknown;
	task?: Promise<RlmInternalRunResult>;
	abort: () => void;
	/** Child session, once its runtime exists. Used to cancel nested child runs. */
	session?: AgentSession;
	/** Re-emits the run's rlm_child_update snapshot with its current status. */
	emitUpdate?: () => void;
	/** Idempotent child-event forwarder cleanup, once the child runtime exists. */
	unsubscribe?: () => void;
	/** Rejects the public rlm.run promise when deletion detaches stuck underlying work. */
	rejectTask?: (error: Error) => void;
	/** Snapshot retained until an in-flight runtime creation is released after early deletion. */
	detachedDeletion?: RlmSubagentRegistryEntry;
}

interface RlmSubagentModelSelection {
	model: Model<Api>;
	warning?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Cap on the post-compaction kernel namespace probe so a wedged kernel can't stall recovery. */
const KERNEL_STATE_LISTING_TIMEOUT_MS = 5000;

function noopRlmChildAbort(): void {}

function isRlmChildRunCancelled(run: RlmChildRun): boolean {
	return run.status === "cancelled";
}

function autoRefineInstructions(reason: AutoRefineReason, review: AutoRefineReview): string {
	const detail = review.instructions
		? `
Reviewer instructions: ${review.instructions}`
		: "";
	return `Automatic refine review triggered by ${reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: ${review.rationale}${detail}`;
}

function parseDepth(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return parsed;
}

function parseGoalBudgetValue(value: string): number {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	const budget = validateGoalBudget(Number(value));
	if (budget === undefined) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	return budget;
}

function emptyRlmUsage(): RlmUsage {
	return { prompt_tokens: 0, completion_tokens: 0 };
}

function addUsage(total: RlmUsage, usage: Usage): void {
	total.prompt_tokens += usage.input + usage.cacheRead + usage.cacheWrite;
	total.completion_tokens += usage.output;
}

export function compactRlmText(text: string, maxLength = 160): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

// Child-agent label: collapse to one line but keep the full prompt — the TUI
// truncates to the visible width and elides shared prefixes, so capping here
// would only hide the divergence between near-identical sibling prompts.
export function rlmChildLabel(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim() || "child agent";
}

function readAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function waitForPromiseOrAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	abortMessage: string,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error(abortMessage));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(new Error(abortMessage));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before observing the awaited work.
		if (signal.aborted) return onAbort();
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function attributeChildUsage(parentUsage: Usage, childUsage: Usage): void {
	const parentContextTokens =
		parentUsage.totalTokens ||
		parentUsage.input + parentUsage.output + parentUsage.cacheRead + parentUsage.cacheWrite;
	// Recursive children are launched from an assistant tool call, so the parent assistant
	// message carries their billable usage for session-level cost totals.
	addAssistantUsage(parentUsage, childUsage);
	// Child work affects session-level billable totals, not the parent's model-facing context size.
	parentUsage.totalTokens = parentContextTokens;
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private _serviceTierPreference: ServiceTier;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _agentEventQueue: Promise<void> = Promise.resolve();

	/** Session-owned typed queues. Items are never fed into Agent.steer/followUp. */
	private _steeringMessages: QueuedSessionInput[] = [];
	private _followUpMessages: QueuedSessionInput[] = [];
	private _sessionInputPump: Promise<void> = Promise.resolve();
	private _sessionInputPumpRequested = false;
	private _sessionInputPumpEpoch = 0;
	private _sessionInputArrivalEpoch = 0;
	private _sessionInputPumpSuspended = false;
	private readonly _queuedWorkPauses = new Set<symbol>();
	private readonly _queuedWorkAdmissionWaiters = new Set<() => void>();
	private _turnAdmissionTail: Promise<void> = Promise.resolve();
	private _turnAdmissionOwner: symbol | undefined;
	private readonly _turnAdmissionContext = new AsyncLocalStorage<symbol>();
	private _pumpingSessionInput = false;
	private _activeSessionInput:
		| {
				kind: "prompt";
				lane: SessionInputSchedule;
				items: PreparedPromptInput[];
				phase: "preparing" | "handedOff";
				cancelled?: boolean;
		  }
		| { kind: "command"; lane: SessionInputSchedule; item: PreparedCommandInput; phase: "executing" }
		| undefined;
	private readonly _sessionInputCheckpointWaiters = new Set<() => void>();
	/** Direct prompts between admission and agent handoff; restart checkpoints wait for zero. */
	private _directPromptSectionCount = 0;
	/** One-shot waiters resolved when a dispatched message reaches message_start. */
	private _directDispatchObservers = new Set<{ message: AgentMessage; resolve: () => void }>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	private _goalState: GoalState = emptyGoalState();
	private _goalAccountingStartedAt: number | undefined = undefined;
	private _goalAccountedAssistantMessages = new WeakSet<AssistantMessage>();
	private _goalAbortInProgress = false;
	private _autonomousState: AutonomousRuntimeState;
	private _autonomousContinuationSuppressionDepth = 0;
	private _autonomousContinuationSuppressedMessages = new WeakSet<AgentMessage>();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _compactionOperation: Promise<void> | undefined = undefined;
	/** One recovery attempt per overflow; "reported" dedups the failure notice. */
	private _overflowRecovery: "idle" | "attempted" | "reported" = "idle";
	private _continueAfterThresholdCompaction = false;
	private _pendingRequestedCompaction: { customInstructions?: string } | undefined;
	private _pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;
	private _branchSummaryOperation: Promise<void> | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _retryAuthFailureSources: AuthSourceToken[] = [];
	private _acceptedPromptCompletions = new Set<Promise<void>>();
	private _acceptedAgentMessagePrompt: AcceptedAgentMessagePrompt | undefined = undefined;
	private _agentMessageOutcomes = new Map<string, AgentMessageOutcome>();
	private _lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	/** Outcome disclosures whose session-file append failed; retained for context rebuilds. */
	private readonly _unpersistedCompactionOutcomes: CustomMessage[] = [];

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _userBashRunning = false;
	private _userBashAbortRequested = false;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _execEnvProvider?: () => Record<string, string | undefined> | undefined;
	private _turnIndex = 0;
	private _modelSelectEmitQueue: Promise<void> = Promise.resolve();
	private _modelSelectEmitQueueIdle = true;
	private _modelSelectEmitContext = new AsyncLocalStorage<boolean>();

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir?: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _includeGoals: boolean;
	private _includeCompactSkill: boolean;
	private _rlmHeartbeatController?: AgentRlmHeartbeatController;
	private _agentMessageController?: AgentSessionMessageController;
	private _agentObserveController?: AgentObserveController;
	private _mcpManager?: McpManager;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _disposed = false;
	private readonly _disposeCallbacks = new Set<() => void>();
	// Set at the start of async teardown so a child finishing mid-disposeAsync doesn't
	// re-populate the retained map after it's been cleared.
	private _disposing = false;
	private _disposeAsyncPromise?: Promise<void>;
	private _ipythonKernelProvisioner?: IpythonKernelProvisioner;
	/** Artifact dir backing the current provisioner's kernel snapshot, if any. */
	private _ipythonKernelSnapshotDir?: string;
	/** True once the runtime has been built once; later builds are in-process rebuilds (/reload). */
	private _ipythonRuntimeBuilt = false;
	private readonly _prewarmIpythonKernel: boolean;
	private _rlmDepth: number;
	private _rlmMaxDepth: number;
	private _rlmSessionDir?: string;
	private _rlmParentNodeId?: string;
	private _subagentRuntimeHost?: SubagentRuntimeHost;
	private _activeRlmChildRuns = new Map<string, RlmChildRun>();
	private _pendingRlmSubagentSessionNames = new Set<string>();
	// Inline mode keeps finished child sessions so the inspector can still read them;
	// the daemon does the same by leaving the child session resident in its registry.
	private _retainedRlmChildSessions = new Map<string, AgentSession>();
	private _deletedRlmChildIds = new Set<string>();
	private _retryableRlmSubagentDeletions = new Map<string, RlmSubagentRegistryEntry>();
	private _deletingRlmChildren = new Map<
		string,
		{ subagent: RlmSubagentRegistryEntry; promise: Promise<RlmDeleteSubagentResult> }
	>();
	// Kept alive for retained children so nested updates (e.g. a grandchild cancel)
	// still forward to root; torn down when the retained child is disposed.
	private _retainedRlmChildUnsubscribes = new Map<string, () => void>();
	/** Latest recap for this session, written by the daemon summarizer; read by a parent to label its child snapshots. */
	private _currentRecap?: string;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _assistantTurnsSinceAutoRefine = 0;
	private _lastAutoRefineReviewAt = 0;
	private _autoRefineInProgress = false;
	private readonly _autoRefineOperations = new Set<Promise<void>>();
	private readonly _scheduledAutoRefineTimers = new Set<ReturnType<typeof setTimeout>>();
	private _compactAutoRefinePending = false;
	private _turnIntervalAutoRefinePending = false;
	private _postCompactionContinuationScheduled = false;
	private _postCompactionContinuationTimer: ReturnType<typeof setTimeout> | undefined;
	private _postCompactionContinuationMessages: AgentMessage[] = [];
	private _scheduledPostCompactionContinuationMessages: AgentMessage[] = [];
	private _queuedAutonomousThresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private _queuedAutonomousContinuationSnapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private _pendingThresholdCompactionAutonomousMessages: AgentMessage[] = [];
	private _pendingAutoRefineReview: { reason: AutoRefineReason; review: AutoRefineReview } | undefined;
	private _autoRefineBranchVersion = 0;
	private _autoRefineReviewAbort?: AbortController;
	private _refineAbortController?: AbortController;
	private readonly _autoRefineReviewer?: AutoRefineReviewer;
	/** When true, auto-refine runs synchronously between turns (serialized mode). */
	private readonly _serializedRefine: boolean;
	/** Settles (never rejects) after a planned refine waits for idle and finishes applying. */
	private _refineInFlight?: Promise<void>;
	/** Settles when the background planning LLM pass completes. Planning does not block turn entry points. */
	private _refinePlanInFlight?: Promise<void>;
	/**
	 * Settles when a serialized-mode background planning pass completes.
	 * Planning starts at assistant message_end (overlapping tool execution)
	 * and is awaited at shouldStopAfterTurn before applying.
	 */
	private _serializedPlanInFlight?: Promise<SerializedBackgroundPlanResult | undefined>;
	private _serializedPlanClaim?: Promise<void>;
	private _serializedExplicitRefineOptions?: { instructions?: string; global?: boolean };

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._serviceTierPreference = config.serviceTierPreference ?? config.agent.state.serviceTier;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = config.agentDir;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._includeGoals = config.includeGoals ?? true;
		this._includeCompactSkill = config.includeCompactSkill ?? this.settingsManager.getCompactionAgentCallable();
		this._rlmHeartbeatController = config.rlmHeartbeatController;
		this._agentMessageController = config.agentMessageController;
		this._agentObserveController = config.agentObserveController;
		this._mcpManager = config.mcpManager;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._rlmDepth = config.rlmDepth ?? parseDepth(process.env.RLM_DEPTH, 0, "RLM_DEPTH");
		this._rlmMaxDepth = config.rlmMaxDepth ?? parseDepth(process.env.RLM_MAX_DEPTH, 1, "RLM_MAX_DEPTH");
		this._prewarmIpythonKernel = (config.prewarmIpythonKernel ?? false) && this._rlmDepth === 0;
		this._autoRefineReviewer = config.autoRefineReviewer;
		this._serializedRefine = config.serializedRefine ?? false;
		this._rlmSessionDir = config.rlmSessionDir;
		this._rlmParentNodeId = config.rlmParentNodeId;
		this._subagentRuntimeHost = config.subagentRuntimeHost;
		this._autonomousState = createAutonomousRuntimeState(config.autonomous, { cwd: this._cwd });
		this._goalState = this._loadPersistedGoalState();
		// Seed initial goal from CLI --goal flag, but only for top-level sessions
		// and only when the branch contains only bootstrap entry types (model_change,
		// thinking_level_change, service_tier_change) and no persisted
		// thread_goal_state. This prevents reseeding after clear/complete/error
		// or restart/rehydration of a session that already has messages or a goal.
		if (this._rlmDepth === 0 && config.initialGoal && this._isBranchSeedable()) {
			this._goalState = this._startGoal(config.initialGoal.objective, config.initialGoal.tokenBudget);
		}
		this._restoreLateIpythonSentAgentMessages();
		if (this._goalState.status === "active") {
			this._goalAccountingStartedAt = Date.now();
		}

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentTurnHook();
		this._installAgentContinuationHook();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/**
	 * Set the RLM heartbeat controller after construction. Used by
	 * print/headless mode to attach an in-process heartbeat scheduler
	 * when the session is created outside the daemon.
	 */
	setRlmHeartbeatController(controller: AgentRlmHeartbeatController): void {
		if (this._rlmHeartbeatController === controller) {
			return;
		}
		this._rlmHeartbeatController = controller;
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			includeAllExtensionTools: true,
		});
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	setSubagentRuntimeHost(host?: SubagentRuntimeHost): void {
		this._subagentRuntimeHost = host;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(formatAuthenticationFailedMessage(model.provider));
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			await this._agentEventQueue;

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	private _installAgentContinuationHook(): void {
		this.agent.getContinuationMessages = (context, signal) => this._getContinuationMessages(context, signal);
	}

	private _installAgentTurnHook(): void {
		this.agent.shouldStopBeforeTurn = () => this._shouldStopBeforeTurn();
		this.agent.shouldStopAfterTurn = (context) => this._shouldStopAfterTurn(context);
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			try {
				l(event);
			} catch {
				// A failing observer must not prevent other subscribers from
				// receiving lifecycle and persistence events.
			}
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: this._pendingSessionInputs("steer").map(queuedAgentMessagePreview),
			followUp: this._pendingSessionInputs("followUp").map(queuedAgentMessagePreview),
		});
	}

	private _restoreLateIpythonSentAgentMessages(): void {
		this._lateIpythonSentAgentMessages.clear();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY) {
				continue;
			}
			const persisted = parsePersistedIpythonSentAgentMessage(entry.data);
			if (persisted) {
				this._rememberLateIpythonSentAgentMessage(persisted.toolCallId, persisted.message);
			}
		}
	}

	private _rememberLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): boolean {
		const messages = this._lateIpythonSentAgentMessages.get(toolCallId) ?? [];
		const isNew = !messages.some((entry) => entry.id === message.id);
		if (isNew) {
			messages.push(message);
			this._lateIpythonSentAgentMessages.set(toolCallId, messages);
		}
		for (let index = this.agent.state.messages.length - 1; index >= 0; index -= 1) {
			if (appendSentAgentMessageToToolResult(this.agent.state.messages[index], toolCallId, message)) {
				break;
			}
		}
		return isNew;
	}

	private _applyLateIpythonSentAgentMessages(message: AgentMessage): void {
		if (message.role !== "toolResult" || message.toolName !== "ipython") {
			return;
		}
		for (const sentMessage of this._lateIpythonSentAgentMessages.get(message.toolCallId) ?? []) {
			appendSentAgentMessageToToolResult(message, message.toolCallId, sentMessage);
		}
	}

	private _recordLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): void {
		const record = () => {
			if (this._disposed || !this._rememberLateIpythonSentAgentMessage(toolCallId, message)) {
				return;
			}
			this.sessionManager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, { toolCallId, message });
			this._emit({ type: "ipython_sent_agent_message", toolCallId, message });
		};
		this._agentEventQueue = this._agentEventQueue.then(record, record);
		this._agentEventQueue.catch(() => {});
	}

	private _emitGoalUpdate(): void {
		this._emit({ type: "goal_update", goal: this.goalState });
	}

	private _loadPersistedGoalState(): GoalState {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === GOAL_STATE_CUSTOM_TYPE &&
				isPersistedGoalState(entry.data)
			) {
				return normalizeGoalState(entry.data);
			}
		}
		return emptyGoalState();
	}

	/**
	 * Whether the session branch is seedable for an initial goal. Returns true
	 * only when the branch contains exclusively bootstrap entry types
	 * (model_change, thinking_level_change, service_tier_change) and no
	 * thread_goal_state custom entry. Any message, custom entry, or persisted
	 * goal (including cleared/complete/error) means the session has been used
	 * and should not be reseeded.
	 */
	private _isBranchSeedable(): boolean {
		const branch = this.sessionManager.getBranch();
		for (const entry of branch) {
			switch (entry.type) {
				case "model_change":
				case "thinking_level_change":
				case "service_tier_change":
					continue;
				case "custom":
					if (entry.customType === GOAL_STATE_CUSTOM_TYPE) {
						return false;
					}
					return false;
				default:
					return false;
			}
		}
		return true;
	}

	private _reloadGoalStateFromBranch(): void {
		this._goalState = this._loadPersistedGoalState();
		this._goalAccountingStartedAt = this._goalState.status === "active" ? Date.now() : undefined;
		this._emitGoalUpdate();
	}

	private _persistGoalState(goal: GoalState): void {
		this.sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal);
		// Force flush so the goal state is durable on disk immediately,
		// even before the first assistant response. This ensures idempotent
		// restart/rehydration can detect the persisted goal.
		this.sessionManager.flushNow();
	}

	private _setGoalState(next: GoalState, options: { persist?: boolean } = {}): void {
		const normalized = normalizeGoalState({
			...next,
			updatedAt: Date.now(),
		});
		this._goalState = normalized;
		if (normalized.status === "active") {
			this._goalAccountingStartedAt ??= Date.now();
		} else {
			this._goalAccountingStartedAt = undefined;
		}
		if (options.persist !== false) {
			this._persistGoalState(normalized);
		}
		this._emitGoalUpdate();
	}

	private _goalWithCurrentWallClock(now = Date.now()): GoalState {
		if (this._goalState.status !== "active" || !this._goalAccountingStartedAt) {
			return this._goalState;
		}
		const elapsedSeconds = Math.floor((now - this._goalAccountingStartedAt) / 1000);
		if (elapsedSeconds <= 0) {
			return this._goalState;
		}
		return {
			...this._goalState,
			timeUsedSeconds: this._goalState.timeUsedSeconds + elapsedSeconds,
		};
	}

	private _goalWithAccountedWallClock(): GoalState {
		const now = Date.now();
		const goal = this._goalWithCurrentWallClock(now);
		if (goal !== this._goalState) {
			this._goalAccountingStartedAt = now;
		}
		return goal;
	}

	private _clearQueuedGoalContexts(): void {
		this.agent.removeQueuedMessages(
			(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_CUSTOM_TYPE,
		);
		const isGoalContext = (input: QueuedSessionInput) =>
			input.kind === "prompt" && input.customMessage?.customType === GOAL_CONTEXT_CUSTOM_TYPE;
		this._removeActivePreparingPrompts(isGoalContext);
		this._steeringMessages = this._steeringMessages.filter((input) => !isGoalContext(input));
		this._followUpMessages = this._followUpMessages.filter((input) => !isGoalContext(input));
		this._emitQueueUpdate();
	}

	private _startGoal(objectiveText: string, tokenBudget: number | undefined): GoalState {
		const objective = validateGoalObjective(objectiveText);
		const budget = validateGoalBudget(tokenBudget);
		const now = Date.now();
		const goal: GoalState = {
			active: true,
			status: "active",
			goalId: randomUUID(),
			objective,
			tokenBudget: budget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			createdAt: now,
			updatedAt: now,
		};
		this._goalAccountingStartedAt = now;
		this._setGoalState(goal);
		return this._goalState;
	}

	private _clearGoal(): void {
		this._clearQueuedGoalContexts();
		this._setGoalState(emptyGoalState());
	}

	private _pauseGoal(reason = "Paused by user"): void {
		this._clearQueuedGoalContexts();
		if (this._goalState.status !== "active") {
			this._emitGoalUpdate();
			return;
		}
		const goal = this._goalWithAccountedWallClock();
		this._setGoalState({
			...goal,
			active: false,
			status: "paused",
			lastReason: reason,
			lastError: undefined,
		});
	}

	private async _resumeGoal(): Promise<void> {
		if (!this._goalState.objective) {
			this._emitGoalUpdate();
			return;
		}
		if (this._goalState.status !== "paused" && this._goalState.status !== "budget_limited") {
			this._emitGoalUpdate();
			return;
		}
		const exhausted =
			this._goalState.tokenBudget !== undefined && this._goalState.tokensUsed >= this._goalState.tokenBudget;
		const nextStatus: GoalStatus = exhausted ? "budget_limited" : "active";
		this._setGoalState({
			...this._goalState,
			active: nextStatus === "active",
			status: nextStatus,
			lastReason: exhausted ? "Goal token budget already reached" : undefined,
			lastError: undefined,
		});
		if (nextStatus === "active") {
			await this._runOrQueueGoalContext("continuation");
		}
	}

	private _finishGoalWithError(errorMessage: string): void {
		if (!this._goalState.objective || this._goalState.status !== "active") {
			return;
		}
		const goal = this._goalWithAccountedWallClock();
		this._setGoalState({
			...goal,
			active: false,
			status: "error",
			lastReason: errorMessage,
			lastError: errorMessage,
		});
	}

	private _finishGoalForTerminalAssistantMessage(message: AssistantMessage): void {
		if (this._goalState.status !== "active") {
			return;
		}

		if (message.stopReason === "aborted") {
			this._goalAbortInProgress = false;
			return;
		}

		if (message.stopReason === "error") {
			if (this._goalAbortInProgress) {
				this._goalAbortInProgress = false;
				return;
			}
			this._finishGoalWithError(message.errorMessage || "Assistant response failed");
		}
	}

	private _stopGoalContinuationForTerminalMessage(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			return false;
		}
		try {
			this._finishGoalForTerminalAssistantMessage(message);
		} catch {
			// Goal hooks must not reject; listener failures should not crash the agent loop.
		}
		return true;
	}

	private _parseGoalSlashCommand(text: string): GoalSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "goal") return undefined;

		const rest = command.args;
		const normalized = rest.toLowerCase();
		if (!rest || normalized === "status") {
			return { kind: "status" };
		}
		if (normalized === "clear" || normalized === "stop") {
			return { kind: "clear" };
		}
		if (normalized === "pause") {
			return { kind: "pause" };
		}
		if (normalized === "resume") {
			return { kind: "resume" };
		}

		let tokenBudget: number | undefined;
		let objective = rest;
		const firstToken = rest.split(/\s+/, 1)[0] ?? "";
		if (
			firstToken === "--budget" ||
			firstToken === "--token-budget" ||
			firstToken.startsWith("--budget=") ||
			firstToken.startsWith("--token-budget=")
		) {
			let valueText: string;
			if (firstToken === "--budget" || firstToken === "--token-budget") {
				const withoutFlag = rest.slice(firstToken.length).trimStart();
				const nextSpace = withoutFlag.search(/\s/);
				if (nextSpace < 0) {
					throw new Error("Usage: /goal [--budget <tokens>] <objective>");
				}
				valueText = withoutFlag.slice(0, nextSpace);
				objective = withoutFlag.slice(nextSpace + 1).trim();
			} else {
				const separator = firstToken.indexOf("=");
				valueText = firstToken.slice(separator + 1);
				objective = rest.slice(firstToken.length).trim();
			}
			tokenBudget = parseGoalBudgetValue(valueText);
		}

		return { kind: "start", objective: validateGoalObjective(objective), tokenBudget };
	}

	private _parseAutonomousSlashCommand(text: string): AutonomousSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "autonomous") return undefined;
		const rest = command.args.toLowerCase();
		if (!rest || rest === "status") {
			return { kind: "status" };
		}
		if (rest === "on" || rest === "enable" || rest === "enabled") {
			return { kind: "on" };
		}
		if (rest === "off" || rest === "disable" || rest === "disabled") {
			return { kind: "off" };
		}
		throw new Error("Usage: /autonomous [on|off|status]");
	}

	private _formatAutonomousStatus(): string {
		const status = this.getAutonomousStatus();
		const state = status.enabled ? "on" : "off";
		return `Autonomous mode: ${state}. Continuations: ${status.continuationsUsed}/${status.limits.maxContinuations}. Turns: ${status.turnsUsed}/${status.limits.maxTurns}. Tokens: ${status.tokensUsed}/${status.limits.maxTokens}.`;
	}

	private _emitAutonomousStatus(): void {
		const message = {
			role: "custom" as const,
			customType: "autonomous_status",
			content: this._formatAutonomousStatus(),
			display: true,
			details: this.getAutonomousStatus(),
			timestamp: Date.now(),
		} satisfies CustomMessage<AgentAutonomousStatus>;
		this.agent.state.messages.push(message);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private async _handleAutonomousSlashCommand(text: string): Promise<boolean> {
		const command = this._parseAutonomousSlashCommand(text);
		if (!command) {
			return false;
		}
		if (command.kind === "on") {
			setAutonomousEnabled(this._autonomousState, true, { cwd: this._cwd });
		} else if (command.kind === "off") {
			setAutonomousEnabled(this._autonomousState, false);
			this._clearQueuedAutonomousContinuations();
		}
		this._emitAutonomousStatus();
		return true;
	}

	/** Append custom messages returned by before_agent_start extension handlers. */
	private _appendBeforeAgentStartMessages(
		messages: AgentMessage[],
		result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>,
	): void {
		if (!result?.messages) return;
		for (const message of result.messages) {
			messages.push({
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				timestamp: Date.now(),
			});
		}
	}

	private async _validateCanStartAgentRun(): Promise<void> {
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}
		if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
			const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
			if (isOAuth) {
				throw new Error(formatAuthenticationFailedMessage(this.model.provider));
			}
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}
	}

	/**
	 * Goals are pursued through the IPython goal skill, so the only tool the
	 * model needs is ipython. Force-activate it (including into a live
	 * continuation context) so the model can always reach `goal.complete()`.
	 */
	private _ensureGoalRuntimeActive(context?: AgentContext): void {
		if (!this._includeGoals) {
			throw new Error("Goals are disabled. Enable goals before using /goal.");
		}
		const ipythonTool = this._toolRegistry.get("ipython");
		if (!ipythonTool) {
			throw new Error("Goals require the ipython tool, which is not available in this session.");
		}
		const activeToolNames = new Set(this.getActiveToolNames());
		if (!activeToolNames.has("ipython")) {
			activeToolNames.add("ipython");
			this.setActiveToolsByName([...activeToolNames]);
		}
		if (context) {
			const contextTools = [...(context.tools ?? [])];
			if (!contextTools.some((tool) => tool.name === "ipython")) {
				contextTools.push(ipythonTool);
				context.tools = contextTools;
			}
		}
	}

	private async _runOrQueueGoalContext(
		kind: "continuation" | "budget_limit" | "objective_updated",
		images?: ImageContent[],
	): Promise<void> {
		if (!this._goalState.objective) {
			return;
		}
		this._ensureGoalRuntimeActive();
		const message = createGoalContextMessage(this._goalState, kind, images);
		if (this._pumpingSessionInput) {
			const normalized = normalizeMessageContent(message.content);
			if (kind === "budget_limit") {
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				});
			} else {
				const input = this._createPreparedPromptInput(normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				});
				this._followUpMessages.unshift(input);
				this._sessionInputArrivalEpoch++;
				this._emitQueueUpdate();
			}
			return;
		}
		if (this.isStreaming) {
			if (kind === "budget_limit") this.agent.steer(message);
			else this.agent.followUp(message);
			return;
		}

		await this._validateCanStartAgentRun();
		// Wait immediately before the handoff so a refine starting during the
		// awaits above cannot disconnect event handling under this turn.
		await this._waitForRefineIdle();
		await this.agent.prompt([message]);
		await this.waitForRetry();
	}

	private async _handleGoalSlashCommand(text: string, images: ImageContent[] | undefined): Promise<boolean> {
		const command = this._parseGoalSlashCommand(text);
		if (!command) {
			return false;
		}

		if (command.kind === "status") {
			this._emitGoalUpdate();
			return true;
		}

		if (command.kind === "clear") {
			this._clearGoal();
			return true;
		}

		if (command.kind === "pause") {
			this._pauseGoal();
			return true;
		}

		if (command.kind === "resume") {
			await this._resumeGoal();
			return true;
		}

		const previousWasActive = this._goalState.status === "active";
		if (!this.isStreaming) {
			await this._validateCanStartAgentRun();
		}
		this._ensureGoalRuntimeActive();
		this._clearQueuedGoalContexts();
		this._startGoal(command.objective, command.tokenBudget);
		await this._runOrQueueGoalContext(previousWasActive ? "objective_updated" : "continuation", images);
		return true;
	}

	private _accountGoalUsageForAssistantMessage(message: AssistantMessage): boolean {
		if (!this._goalState.objective) {
			return false;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (this._goalAccountedAssistantMessages.has(message)) {
			return false;
		}
		// Usage is attributed at the assistant message's message_end, which fires
		// before that turn's ipython cell runs. goal.complete() only arrives later
		// over the kernel host bridge, so the completing turn is always accounted
		// while the goal is still active. Only count turns spent pursuing the goal;
		// post-completion turns (e.g. a closing summary) must not be attributed.
		if (this._goalState.status !== "active") {
			return false;
		}
		this._goalAccountedAssistantMessages.add(message);
		const tokenDelta = goalTokenDeltaForUsage(message.usage);
		const goal = this._goalWithAccountedWallClock();
		const nextGoal: GoalState = {
			...goal,
			tokensUsed: goal.tokensUsed + tokenDelta,
		};
		const budgetReached = nextGoal.tokenBudget !== undefined && nextGoal.tokensUsed >= nextGoal.tokenBudget;
		if (!budgetReached) {
			this._setGoalState(nextGoal);
			return false;
		}
		this._setGoalState({
			...nextGoal,
			active: false,
			status: "budget_limited",
			lastReason: `Reached ${nextGoal.tokenBudget} token goal budget`,
			lastError: undefined,
		});
		return true;
	}

	private get _steeringStopPending(): boolean {
		const activeSteeringHandoff =
			this._activeSessionInput?.kind === "prompt" &&
			this._activeSessionInput.lane === "steer" &&
			this._activeSessionInput.phase === "preparing" &&
			!this._activeSessionInput.cancelled &&
			this._activeSessionInput.items.length > 0;
		return this._steeringMessages.length > 0 || activeSteeringHandoff;
	}

	private _shouldStopBeforeTurn(): boolean {
		return this._steeringStopPending;
	}

	private async _shouldStopAfterTurn(context: ShouldStopAfterTurnContext): Promise<boolean> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return true;
		}
		try {
			if (this._accountGoalUsageForAssistantMessage(context.message)) {
				const message = createGoalContextMessage(this._goalState, "budget_limit");
				const normalized = normalizeMessageContent(message.content);
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				});
			}
		} catch {
			// Goal accounting must not interrupt the core agent loop.
		}
		// Serialized refine checkpoint: in print/headless mode, run refinement
		// planning+apply synchronously here — the quiescent boundary between
		// turns — so it never overlaps the primary model request.
		// This MUST run BEFORE threshold compaction to prevent the
		// compaction model call from overlapping an in-flight refine
		// plan/apply that was started at message_end.
		if (this._serializedRefine) {
			// Ensure the preceding message_end processing (counter increment,
			// background plan kickoff) has completed before the checkpoint.
			await this._agentEventQueue;
			await this._runSerializedRefineCheckpoint();
		}
		if (await this._shouldStopForThresholdCompaction(context)) {
			return true;
		}
		// Steering stops continuation only after mandatory serialized checkpoints.
		// Returning true here still prevents the agent loop from starting another turn.
		return this._steeringStopPending;
	}

	private async _shouldStopForThresholdCompaction(context: ShouldStopAfterTurnContext): Promise<boolean> {
		this._continueAfterThresholdCompaction = false;
		if (this._pendingRequestedCompaction === undefined && !(await this._thresholdCompactionNeeded(context))) {
			return false;
		}

		const lastMessage = this.agent.state.messages[this.agent.state.messages.length - 1];
		this._continueAfterThresholdCompaction = lastMessage !== undefined && lastMessage.role !== "assistant";
		return true;
	}

	/**
	 * Serialized-mode auto-refine checkpoint called from _shouldStopAfterTurn.
	 * Runs the review, planning, and application phases inline between turns
	 * at the quiescent shouldStopAfterTurn boundary. This path NEVER calls
	 * _maybeAutoRefine, _runApprovedRefine, public refine(), agent.abort(),
	 * or agent.waitForIdle — all of which would deadlock or defer because
	 * the agent loop still owns activeRun at this point. Instead it calls
	 * _reviewAutoRefine, _planRefine, and _applyRefine directly with proper
	 * in-flight guards and counter resets.
	 */
	private async _runSerializedRefineCheckpoint(): Promise<void> {
		if (this._disposed || this._disposing) {
			return;
		}

		// 1. Await any background plan that was started at message_end
		//    (either for a pending refine.run or for interval-triggered
		//    auto-refine). This must be checked BEFORE the pending and
		//    interval checks because background planning may have consumed
		//    the pending request at message_end.
		const branchVersion = this._autoRefineBranchVersion;
		const bgConsumption = await this._consumeSerializedBackgroundPlan(async (bgResult) => {
			if (this._disposed || this._disposing) {
				return true;
			}

			if (bgResult?.status === "plan") {
				// Fix 4: Validate branchVersion before applying the plan.
				if (bgResult.branchVersion !== this._autoRefineBranchVersion) {
					if (!this._pendingRequestedRefine) {
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
						return true;
					}
				} else {
					// Apply the EXACT background plan directly via _applyRefine
					// (no second _planRefine call).
					try {
						await this._applySerializedPlan(bgResult);
					} catch (error) {
						this._emitRefineFailed(error);
					}
					this._lastAutoRefineReviewAt = Date.now();
					this._assistantTurnsSinceAutoRefine = 0;
					if (!this._pendingRequestedRefine) {
						return true;
					}
				}
			}

			if (bgResult?.status === "skip") {
				// Reviewer declined during background planning.
				// Reset exactly once. Never retry the interval review; only fall through for a separate pending refine.run.
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "failure") {
				// Fix 3: Background review or planning failed. Stamp cooldown
				// without a synchronous retry (the discriminated contract says no duplicate boundary
				// model call). A separately queued refine.run may still be serviced below.
				if (branchVersion === this._autoRefineBranchVersion) {
					this._lastAutoRefineReviewAt = Date.now();
				}
				// Re-queue an explicit refine.run whose background plan failed,
				// but only when branchVersion is still current and no newer
				// pending request has arrived since the background plan consumed
				// the original one. A newer request retains priority; interval
				// failures keep existing no-retry cooldown semantics.
				if (
					bgResult.explicit &&
					bgResult.branchVersion === this._autoRefineBranchVersion &&
					!this._pendingRequestedRefine
				) {
					this._pendingRequestedRefine = bgResult.options;
				}
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "invalidated" && !this._pendingRequestedRefine) {
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				return true;
			}

			await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
			return true;
		});
		if (this._disposed || this._disposing || bgConsumption !== "none") {
			return;
		}
		await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
	}

	private async _runSerializedRefineCheckpointAfterBackground(branchVersion: number): Promise<void> {
		// No background result, or a refine.run arrived while the background result was
		// in flight. Fall through so an explicit pending request is serviced at this boundary.

		// 2. Agent-callable refine.run requests that were NOT consumed by
		//    background planning (e.g. interval not reached at message_end,
		//    or cooldown was active). Service them synchronously.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending);
			} catch (error) {
				this._emitRefineFailed(error);
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			return;
		}

		// 3. Post-compaction auto-refine. Serialized sessions defer the
		// compaction trigger to this boundary instead of entering the interactive
		// path, which waits for agent idle and can never run inside a tool loop.
		if (!this._autoRefineAllowedForSession()) {
			this._compactAutoRefinePending = false;
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._compactAutoRefinePending = false;
			return;
		}
		if (this._compactAutoRefinePending) {
			if (!settings.compact) {
				this._compactAutoRefinePending = false;
			} else {
				const nowMs = Date.now();
				const underCooldown =
					this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
				if (underCooldown) {
					// Preserve the compact trigger for a later boundary, matching the
					// interactive path's pending behavior while the cooldown is active.
					return;
				}
				this._compactAutoRefinePending = false;
				await this._runSerializedAutoRefineReview("compact", branchVersion);
				return;
			}
		}

		// 4. Interval-triggered auto-refine (no background plan was started).
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		await this._runSerializedAutoRefineReview("turn_interval", branchVersion);
	}

	/** Run automatic review and, when approved, refinement at a serialized turn boundary. */
	private async _runSerializedAutoRefineReview(
		reason: "compact" | "turn_interval",
		branchVersion: number,
	): Promise<void> {
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		this._autoRefineInProgress = true;
		try {
			const review = await this._reviewAutoRefine(
				{ reason, turnsSinceLastReview: this._assistantTurnsSinceAutoRefine },
				reviewAbort.signal,
			);
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				return;
			}
			await this._runSerializedRefine({
				instructions: autoRefineInstructions(reason, review),
			});
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		} catch (error) {
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
				this._emitRefineFailed(error);
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
		}
	}

	/**
	 * Claim and process the serialized background plan if one is in flight.
	 * A concurrent caller waits for the claim holder's full processing callback
	 * instead of resuming as soon as planning settles.
	 */
	private async _consumeSerializedBackgroundPlan(
		consume: (result: SerializedBackgroundPlanResult | undefined) => Promise<boolean>,
	): Promise<"none" | "waited" | "continue" | "stop"> {
		if (this._serializedPlanClaim) {
			await this._serializedPlanClaim.catch(() => undefined);
			return "waited";
		}
		const planInFlight = this._serializedPlanInFlight;
		if (!planInFlight) {
			return "none";
		}

		let releaseClaim: () => void = () => {};
		const claim = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		this._serializedPlanClaim = claim;
		try {
			const result = await planInFlight.catch(() => undefined);
			if (this._serializedPlanInFlight === planInFlight) {
				this._serializedPlanInFlight = undefined;
				this._serializedExplicitRefineOptions = undefined;
			}
			return (await consume(result)) ? "stop" : "continue";
		} finally {
			releaseClaim();
			if (this._serializedPlanClaim === claim) {
				this._serializedPlanClaim = undefined;
			}
		}
	}

	/**
	 * Apply an exact background plan directly via _applyRefine without
	 * calling _planRefine again. Sets _refineInFlight for safety.
	 */
	private async _applySerializedPlan(
		bgResult: Extract<SerializedBackgroundPlanResult, { status: "plan" }>,
	): Promise<void> {
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._applyRefine(bgResult.plan, bgResult.options, bgResult.abort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._scheduleSessionInputPump();
		}
	}

	/**
	 * Start background refinement planning at assistant message_end, while
	 * tools are still executing. The plan (if any) is awaited at the
	 * shouldStopAfterTurn boundary before applying. Planning overlaps tool
	 * execution only — never another model request.
	 */
	private _maybeStartSerializedBackgroundPlan(): void {
		if (!this._serializedRefine || this._disposed || this._disposing) {
			return;
		}
		// Don't start if a plan is already in flight.
		if (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			return;
		}

		// Bug 4 fix: Also start background planning for a pending agent-callable
		// refine.run request, so its plan is ready at the shouldStopAfterTurn
		// boundary. The pending request is consumed (cleared) here so the
		// boundary doesn't re-plan it. Explicit refine.run skips the review gate.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			this._serializedExplicitRefineOptions = pending;
			const refineAbort = new AbortController();
			this._refineAbortController = refineAbort;
			const branchVersion = this._autoRefineBranchVersion;
			this._serializedPlanInFlight = this._runBackgroundPlan(pending, refineAbort, branchVersion, true);
			return;
		}

		// Interval-triggered auto-refine background planning.
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;
		const branchVersion = this._autoRefineBranchVersion;
		// Pass empty options — _runBackgroundPlan derives instructions from
		// the review result for interval-triggered auto-refine.
		this._serializedPlanInFlight = this._runBackgroundPlan({}, refineAbort, branchVersion);
	}

	/**
	 * Shared background planning coroutine. Runs review + planRefine and
	 * returns a discriminated result so the boundary can distinguish
	 * reviewer-declined ("skip") from failure ("failure") from a ready
	 * plan ("plan") and apply that exact plan without re-planning.
	 */
	private async _runBackgroundPlan(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
		branchVersion: number,
		skipReview = false,
	): Promise<SerializedBackgroundPlanResult | undefined> {
		try {
			let planOptions = options;
			if (!skipReview) {
				// Interval-triggered: run the review gate first, then derive
				// instructions from the review result (not prepopulated).
				const review = await this._reviewAutoRefine(
					{ reason: "turn_interval", turnsSinceLastReview: this._assistantTurnsSinceAutoRefine },
					refineAbort.signal,
				);
				if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
					return { status: "invalidated", branchVersion };
				}
				if (!review.shouldRefine) {
					return { status: "skip" };
				}
				planOptions = { instructions: autoRefineInstructions("turn_interval", review) };
			}
			// For explicit refine.run (skipReview=true), plan directly with
			// the user-provided options — no auto-review gate.
			const plan = await this._planRefine(planOptions, refineAbort.signal);
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
			}
			return { status: "plan", plan, options: planOptions, abort: refineAbort, branchVersion };
		} catch {
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
			}
			return {
				status: "failure",
				explicit: skipReview,
				options,
				branchVersion,
			};
		} finally {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
		}
	}

	/**
	 * Direct serialized plan+apply. Calls _planRefine and _applyRefine with
	 * proper in-flight guards but NEVER agent.waitForIdle or agent.abort.
	 * The caller (shouldStopAfterTurn) is already at the quiescent boundary,
	 * so the agent is between turns and _applyRefine's disconnect/reconnect
	 * is safe.
	 */
	private async _runSerializedRefine(options: {
		instructions?: string;
		rollbackId?: string;
		global?: boolean;
	}): Promise<void> {
		if (this._disposed || this._disposing) {
			return;
		}
		// Guard: serialize against concurrent _runSerializedRefine calls.
		// _serializedPlanInFlight covers background planning; _refineInFlight
		// covers the apply phase. Both must be settled before starting a new
		// plan+apply cycle.
		while (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			if (this._serializedPlanInFlight) {
				await this._consumeSerializedBackgroundPlan(async () => false);
			} else if (this._refineInFlight) {
				await this._refineInFlight;
			} else {
				await this._refinePlanInFlight;
			}
		}
		if (this._disposed || this._disposing) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		const planRun = this._planRefine(options, refineAbort.signal);
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (error) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			throw error;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		if (this._disposed || refineAbort.signal.aborted) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			return;
		}

		// Do NOT call agent.waitForIdle() — we are at the quiescent boundary
		// already (shouldStopAfterTurn). _applyRefine handles disconnect/reconnect internally.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._applyRefine(plan, options, refineAbort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._scheduleSessionInputPump();
		}
	}

	private async _thresholdCompactionNeeded(context: ShouldStopAfterTurnContext): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		const contextWindow = this.model?.contextWindow ?? 0;
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		if (compactionTimestamp !== undefined && context.message.timestamp <= compactionTimestamp) {
			return false;
		}

		const contextTokens = this._getThresholdContextTokens(context.message, compactionTimestamp);
		if (contextTokens === undefined || !shouldCompact(contextTokens, contextWindow, settings)) {
			return false;
		}

		if (await this._queueAutonomousContinuationForThresholdCompaction(context.message)) {
			this._continueAfterThresholdCompaction = true;
		}
		return true;
	}

	private _snapshotAutonomousRuntimeState(): AutonomousRuntimeSnapshot {
		return {
			continuationsUsed: this._autonomousState.continuationsUsed,
			gateAttempts: { ...this._autonomousState.gateAttempts },
			lastGateFailure: this._autonomousState.lastGateFailure
				? { ...this._autonomousState.lastGateFailure }
				: undefined,
			lastGateFailureSnapshot: this._autonomousState.lastGateFailureSnapshot
				? { ...this._autonomousState.lastGateFailureSnapshot }
				: undefined,
		};
	}

	private _restoreAutonomousRuntimeSnapshot(snapshot: AutonomousRuntimeSnapshot): void {
		this._autonomousState.continuationsUsed = snapshot.continuationsUsed;
		this._autonomousState.gateAttempts = { ...snapshot.gateAttempts };
		this._autonomousState.lastGateFailure = snapshot.lastGateFailure ? { ...snapshot.lastGateFailure } : undefined;
		this._autonomousState.lastGateFailureSnapshot = snapshot.lastGateFailureSnapshot
			? { ...snapshot.lastGateFailureSnapshot }
			: undefined;
	}

	private async _queueAutonomousContinuationForThresholdCompaction(
		message: AssistantMessage,
	): Promise<AgentMessage | undefined> {
		const queuedMessage = this._queuedAutonomousThresholdContinuations.get(message);
		if (queuedMessage && this._postCompactionContinuationMessages.includes(queuedMessage)) {
			return queuedMessage;
		}
		const snapshot = this._snapshotAutonomousRuntimeState();
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, message, {
			cwd: this._cwd,
			signal: this.agent.signal,
		});
		if (!autonomousMessage) {
			return undefined;
		}
		if (this._sessionInputArrivalEpoch !== arrivalEpoch) {
			this._restoreAutonomousRuntimeSnapshot(snapshot);
			return undefined;
		}
		this._queuedAutonomousThresholdContinuations.set(message, autonomousMessage);
		this._queuedAutonomousContinuationSnapshots.set(autonomousMessage, snapshot);
		this._postCompactionContinuationMessages.push(autonomousMessage);
		this._pendingThresholdCompactionAutonomousMessages.push(autonomousMessage);
		const text =
			typeof autonomousMessage.content === "string"
				? autonomousMessage.content
				: autonomousMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		this._enqueueSessionInput(
			this._createPreparedPromptInput(text, undefined, { message: autonomousMessage }),
			"followUp",
		);
		return autonomousMessage;
	}

	private _clearQueuedAutonomousContinuations(
		options: { restoreAutonomousState?: boolean; messages?: AgentMessage[] } = {},
	): void {
		const requestedMessages = options.messages ?? [...this._postCompactionContinuationMessages];
		const requestedMessageSet = new Set(requestedMessages);
		const queuedMessages = this._postCompactionContinuationMessages.filter((message) =>
			requestedMessageSet.has(message),
		);
		if (queuedMessages.length === 0) {
			return;
		}
		const queuedMessageSet = new Set(queuedMessages);
		this._postCompactionContinuationMessages = this._postCompactionContinuationMessages.filter(
			(message) => !queuedMessageSet.has(message),
		);
		this.agent.removeQueuedMessages((message) => queuedMessageSet.has(message));
		const isQueuedContinuation = (input: QueuedSessionInput) =>
			input.kind === "prompt" && queuedMessageSet.has(input.message);
		this._steeringMessages = this._steeringMessages.filter((input) => !isQueuedContinuation(input));
		this._followUpMessages = this._followUpMessages.filter((input) => !isQueuedContinuation(input));
		this._emitQueueUpdate();
		if (options.restoreAutonomousState) {
			for (const queuedMessage of queuedMessages) {
				const snapshot = this._queuedAutonomousContinuationSnapshots.get(queuedMessage);
				if (snapshot) {
					this._restoreAutonomousRuntimeSnapshot(snapshot);
					break;
				}
			}
		}
		for (const queuedMessage of queuedMessages) {
			this._queuedAutonomousContinuationSnapshots.delete(queuedMessage);
		}
		this._pendingThresholdCompactionAutonomousMessages = this._pendingThresholdCompactionAutonomousMessages.filter(
			(message) => !queuedMessageSet.has(message),
		);
		if (options.messages === undefined) {
			this._continueAfterThresholdCompaction = false;
		}
		if (!this.agent.hasQueuedMessages() && this.pendingMessageCount === 0) {
			this._cancelPostCompactionContinue();
		}
	}

	private _clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
		shouldContinueAfterThreshold: boolean,
		queuedMessages: AgentMessage[],
	): void {
		if (shouldContinueAfterThreshold) {
			this._clearQueuedAutonomousContinuations({ restoreAutonomousState: true, messages: queuedMessages });
		}
	}

	/**
	 * Handle a goal.* request from the IPython kernel host bridge (the bundled
	 * goal skill). All goal state stays host-side; the kernel only sees the
	 * serialized snake_case response.
	 */
	handleGoalHostRequest(type: string, payload: Record<string, unknown> = {}): GoalHostResponse {
		if (!this._includeGoals) {
			throw new Error("goals are disabled in this session");
		}
		switch (type) {
			case "goal.get":
				return goalHostResponse(this.goalState, false);
			case "goal.create": {
				if (typeof payload.objective !== "string") {
					throw new Error("goal.create objective must be a string");
				}
				if (payload.token_budget !== undefined && typeof payload.token_budget !== "number") {
					throw new Error("goal.create token_budget must be an integer when provided");
				}
				return goalHostResponse(this._createGoalFromHost(payload.objective, payload.token_budget), false);
			}
			case "goal.complete":
				return goalHostResponse(this._completeGoalFromHost(), true);
			default:
				throw new Error(`unknown goal request type "${type}"`);
		}
	}

	/**
	 * Handle a compact.* request from the kernel host bridge. Compaction would
	 * abort the run executing the requesting cell, so compact.run only schedules
	 * it; _checkCompaction consumes the request at the turn boundary.
	 */
	handleCompactHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		if (!this._includeCompactSkill) {
			throw new Error("the compact skill is disabled in this session");
		}
		switch (type) {
			case "compact.status": {
				const usage = this.getContextUsage();
				return {
					tokens: usage?.tokens ?? null,
					context_window: usage?.contextWindow ?? null,
					percent: usage?.percent ?? null,
					scheduled: this._pendingRequestedCompaction !== undefined,
				};
			}
			case "compact.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("compact.run instructions must be a string when provided");
				}
				// "status" is reserved by the host-request reply protocol; don't use it as a key.
				if (!this.isStreaming) {
					return {
						scheduled: false,
						reason: "no active turn; compaction can only be requested while a turn is running",
					};
				}
				const preparation = prepareCompaction(
					this.sessionManager.getBranch(),
					this.settingsManager.getCompactionSettings(),
				);
				if (!preparation) {
					const lastEntry = this.sessionManager.getBranch().at(-1);
					return {
						scheduled: false,
						reason: lastEntry?.type === "compaction" ? "already compacted" : "session is too short to compact",
					};
				}
				this._pendingRequestedCompaction = { customInstructions: instructions };
				return {
					scheduled: true,
					note: "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown compact request type "${type}"`);
		}
	}

	/**
	 * Handle a refine.* request from the kernel host bridge. Like compact,
	 * refinement waits for the current turn to become idle before applying
	 * changes, so refine.run only schedules it; _consumePendingRequestedRefine
	 * fires it at the turn boundary. This prevents a deadlock that would occur
	 * if refine() awaited agent idle from within the active tool call.
	 */
	handleRefineHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		switch (type) {
			case "refine.status": {
				return {
					pending: this._pendingRequestedRefine !== undefined,
					in_flight:
						this._refineInFlight !== undefined ||
						this._refinePlanInFlight !== undefined ||
						this._serializedPlanInFlight !== undefined,
				};
			}
			case "refine.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("refine.run instructions must be a string when provided");
				}
				const globalFlag = payload.global;
				if (globalFlag !== undefined && typeof globalFlag !== "boolean") {
					throw new Error("refine.run global must be a boolean when provided");
				}
				if (!this.isStreaming) {
					return {
						scheduled: false,
						reason: "no active turn; refine can only be requested while a turn is running",
					};
				}
				const previous = this._pendingRequestedRefine ?? this._serializedExplicitRefineOptions;
				this._pendingRequestedRefine = {
					instructions: instructions ?? previous?.instructions,
					global: globalFlag ?? previous?.global,
				};
				// In serialized mode, kick off background planning immediately
				// (the primary response ended at message_end, tools are active).
				// This lets planning overlap tool execution rather than waiting
				// for the shouldStopAfterTurn boundary.
				if (this._serializedRefine) {
					if (this._serializedPlanInFlight) {
						this._autoRefineBranchVersion++;
						if (this._refineAbortController) {
							this._refineAbortController.abort();
						} else {
							this._serializedPlanInFlight = Promise.resolve({
								status: "invalidated",
								branchVersion: this._autoRefineBranchVersion,
							});
						}
					} else {
						this._maybeStartSerializedBackgroundPlan();
					}
				}
				return {
					scheduled: true,
					note: "Refinement runs when the current turn ends; the harness rebuilds the system prompt and resumes you automatically. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown refine request type "${type}"`);
		}
	}

	/**
	 * Handle an rlm_heartbeat.* request from the bundled rlm-heartbeat skill.
	 * These heartbeats are internal to this active session and never read or
	 * mutate the user-level /heartbeat.
	 */
	handleRlmHeartbeatHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		const controller = this._rlmHeartbeatController;
		if (!controller) {
			throw new Error("RLM heartbeat skill is not available in this session");
		}
		switch (type) {
			case "rlm_heartbeat.list": {
				const includeInactive = payload.include_inactive === true || payload.includeInactive === true;
				return {
					heartbeats: controller
						.listRlmHeartbeats({ includeInactive })
						.map((heartbeat) => rlmHeartbeatHostResponse(heartbeat)),
				};
			}
			case "rlm_heartbeat.create": {
				if (typeof payload.instruction !== "string") {
					throw new Error("rlm_heartbeat.create instruction must be a string");
				}
				if (payload.interval !== undefined && typeof payload.interval !== "string") {
					throw new Error("rlm_heartbeat.create interval must be a string when provided");
				}
				if (payload.label !== undefined && typeof payload.label !== "string") {
					throw new Error("rlm_heartbeat.create label must be a string when provided");
				}
				const deliveryMode = normalizeHeartbeatDeliveryMode(payload.delivery_mode ?? payload.deliveryMode);
				return {
					heartbeat: rlmHeartbeatHostResponse(
						controller.createRlmHeartbeat({
							instruction: payload.instruction,
							interval: payload.interval,
							label: payload.label,
							deliveryMode,
						}),
					),
				};
			}
			case "rlm_heartbeat.update": {
				if (typeof payload.id !== "string") {
					throw new Error("rlm_heartbeat.update id must be a string");
				}
				if (payload.instruction !== undefined && typeof payload.instruction !== "string") {
					throw new Error("rlm_heartbeat.update instruction must be a string when provided");
				}
				if (payload.interval !== undefined && typeof payload.interval !== "string") {
					throw new Error("rlm_heartbeat.update interval must be a string when provided");
				}
				if (payload.label !== undefined && typeof payload.label !== "string") {
					throw new Error("rlm_heartbeat.update label must be a string when provided");
				}
				if (payload.status !== undefined && !isRlmHeartbeatStatusUpdate(payload.status)) {
					throw new Error('rlm_heartbeat.update status must be "pause" or "resume" when provided');
				}
				const rawDeliveryMode = payload.delivery_mode ?? payload.deliveryMode;
				const deliveryMode = normalizeHeartbeatDeliveryMode(rawDeliveryMode);
				if (
					payload.instruction === undefined &&
					payload.interval === undefined &&
					payload.label === undefined &&
					payload.status === undefined &&
					rawDeliveryMode === undefined
				) {
					throw new Error("rlm_heartbeat.update requires at least one field to update");
				}
				const heartbeat = controller.updateRlmHeartbeat({
					id: payload.id,
					instruction: payload.instruction,
					interval: payload.interval,
					label: payload.label,
					status: payload.status,
					deliveryMode,
				});
				return { heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null };
			}
			case "rlm_heartbeat.delete": {
				if (typeof payload.id !== "string") {
					throw new Error("rlm_heartbeat.delete id must be a string");
				}
				const heartbeat = controller.deleteRlmHeartbeat(payload.id);
				return { heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null };
			}
			default:
				throw new Error(`unknown RLM heartbeat request type "${type}"`);
		}
	}

	handleAgentMessageHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	): AgentSessionMessageListResult | Promise<AgentSessionMessageReceipt> {
		if (!this._agentMessageController) {
			throw new Error("agent messaging is not available in this session");
		}
		switch (type) {
			case "agent_message.list":
				return this._agentMessageController.listAgents();
			case "agent_message.send": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_message.send target must be a string");
				}
				if (typeof payload.message !== "string") {
					throw new Error("agent_message.send message must be a string");
				}
				const deliveryMode = normalizeAgentSessionMessageDeliveryMode(payload.mode);
				return this._agentMessageController.sendAgentMessage({
					target: assertDirectAgentMessageTarget(payload.target),
					message: normalizeAgentSessionMessage(payload.message),
					...(deliveryMode ? { deliveryMode } : {}),
				});
			}
			default:
				throw new Error(`unknown agent message request type "${type}"`);
		}
	}

	handleAgentObserveHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	): AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult {
		const controller = this._agentObserveController;
		if (!controller) {
			throw new Error("agent observation is not available in this session");
		}
		switch (type) {
			case "agent_observe.list":
				return controller.listAgents();
			case "agent_observe.get": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_observe.get target must be a string");
				}
				return controller.getAgent(payload.target);
			}
			case "agent_observe.recent": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_observe.recent target must be a string");
				}
				return controller.recentMessages({
					target: payload.target,
					limit: normalizeObserveLimit(payload.limit as number | undefined),
					maxChars: normalizeObserveMaxChars((payload.max_chars ?? payload.maxChars) as number | undefined),
				});
			}
			default:
				throw new Error(`unknown agent observe request type "${type}"`);
		}
	}

	private _createGoalFromHost(objective: string, tokenBudget: number | undefined): GoalState {
		switch (this._goalState.status) {
			case "active":
				throw new Error(
					"cannot create a new goal because this thread already has an active goal; run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear",
				);
			case "paused":
				throw new Error(
					"cannot create a new goal because a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			case "budget_limited":
				throw new Error(
					"cannot create a new goal because a budget-limited goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			default:
				// idle, or a terminal record (complete / error): nothing pending, start fresh.
				return this._startGoal(objective, tokenBudget);
		}
	}

	private _completeGoalFromHost(): GoalState {
		if (!this._goalState.objective || this._goalState.status === "idle") {
			throw new Error("cannot complete goal because this thread has no goal");
		}
		const goal = this._goalWithAccountedWallClock();
		// A turn can cross the budget and complete the goal at once: accounting
		// runs at message_end, before the completing ipython cell executes, so a
		// budget-limit context may already be steered. It is stale now — drop it.
		this._clearQueuedGoalContexts();
		this._setGoalState({
			...goal,
			active: false,
			status: "complete",
			lastReason: "Goal achieved",
			lastError: undefined,
		});
		return this._goalState;
	}

	private async _getGoalContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return [];
		}
		if (signal?.aborted || this._goalState.status !== "active" || !this._goalState.objective) {
			return [];
		}
		try {
			this._ensureGoalRuntimeActive(context.context);
			const nextGoal = {
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			};
			this._setGoalState(nextGoal);
			return [createGoalContextMessage(this._goalState, "continuation")];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this._finishGoalWithError(message);
			} catch {
				// The continuation hook must not reject; listener failures should not crash the agent loop.
			}
			return [];
		}
	}

	private async _getContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this.pendingMessageCount > 0) {
			return [];
		}
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const goalSnapshot = this._goalState;
		const goalAccountingStartedAt = this._goalAccountingStartedAt;
		const goalMessages = await this._getGoalContinuationMessages(context, signal);
		if (goalMessages.length > 0 || signal?.aborted) {
			if (goalMessages.length > 0 && this._sessionInputArrivalEpoch !== arrivalEpoch) {
				this._setGoalState(goalSnapshot);
				this._goalAccountingStartedAt = goalAccountingStartedAt;
				return [];
			}
			return goalMessages;
		}
		if (
			this._autonomousContinuationSuppressionDepth > 0 ||
			context.newMessages.some((message) => this._autonomousContinuationSuppressedMessages.has(message))
		) {
			return [];
		}
		const autonomousSnapshot = this._snapshotAutonomousRuntimeState();
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, context.message, {
			cwd: this._cwd,
			signal,
		});
		if (autonomousMessage && this._sessionInputArrivalEpoch !== arrivalEpoch) {
			this._restoreAutonomousRuntimeSnapshot(autonomousSnapshot);
			return [];
		}
		return autonomousMessage ? [autonomousMessage] : [];
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	private _agentMessageOutcome(agentMessageId: string): AgentMessageOutcome {
		let outcome = this._agentMessageOutcomes.get(agentMessageId);
		if (!outcome) {
			outcome = {};
			this._agentMessageOutcomes.set(agentMessageId, outcome);
		}
		return outcome;
	}

	/**
	 * Register a delivery waiter before submitting the prompt. Delivery outcomes are not retained
	 * for late lookup, so callers that register after admission may wait for a future use of the id.
	 */
	waitForAgentMessagePromptDelivery(agentMessageId: string): Promise<void> {
		const outcome = this._agentMessageOutcome(agentMessageId);
		outcome.delivery ??= createAgentMessageDeferred();
		return outcome.delivery.promise;
	}

	/** Resolve (no error) or reject an existing leg of an agent message outcome. */
	private _settleAgentMessage(
		agentMessageId: string | undefined,
		leg: "delivery" | "completion",
		error?: Error,
	): void {
		if (agentMessageId === undefined) return;
		const outcome = this._agentMessageOutcomes.get(agentMessageId);
		if (!outcome) return;
		const deferred = outcome[leg];
		if (!deferred) return;
		outcome[leg] = undefined;
		if (!outcome.delivery && !outcome.completion) {
			this._agentMessageOutcomes.delete(agentMessageId);
		}
		if (error) deferred.reject(error);
		else deferred.resolve();
	}

	/** Reject both currently registered legs of an agent message outcome. */
	private _rejectAgentMessage(agentMessageId: string | undefined, error: Error): void {
		if (agentMessageId === undefined) return;
		this._settleAgentMessage(agentMessageId, "delivery", error);
		this._settleAgentMessage(agentMessageId, "completion", error);
	}

	private _rejectQueuedAgentMessageDeliveries(deliveryError: Error, completionError = deliveryError): void {
		for (const message of [...this._steeringMessages, ...this._followUpMessages]) {
			this._settleAgentMessage(message.agentMessageId, "delivery", deliveryError);
			this._settleAgentMessage(message.agentMessageId, "completion", completionError);
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent): void => {
		// Create retry promise synchronously before queueing async processing.
		// Agent.emit() calls this handler synchronously, and prompt() calls waitForRetry()
		// as soon as agent.prompt() resolves. If _retryPromise is created only inside
		// _processAgentEvent, slow earlier queued events can delay agent_end processing
		// and waitForRetry() can miss the in-flight retry.
		this._createRetryPromiseForAgentEnd(event);
		const acceptedPrompt = this._acceptedAgentMessagePrompt;
		if (event.type === "message_start") {
			if (acceptedPrompt?.message === event.message && !acceptedPrompt.cleared) {
				acceptedPrompt.turnStarted = true;
				this._settleAgentMessage(acceptedPrompt.agentMessageId, "delivery");
				acceptedPrompt.resolveAccepted();
			}
			const activeInput =
				this._activeSessionInput?.kind === "prompt"
					? this._activeSessionInput.items.find((input) => input.message === event.message)
					: undefined;
			this._settleAgentMessage(activeInput?.agentMessageId, "delivery");
			for (const observer of this._directDispatchObservers) {
				if (observer.message === event.message) {
					this._directDispatchObservers.delete(observer);
					observer.resolve();
				}
			}
		}
		this._agentEventQueue = this._agentEventQueue.then(
			() => this._processAgentEvent(event),
			() => this._processAgentEvent(event),
		);

		// Keep queue alive if an event handler fails
		this._agentEventQueue.catch(() => {});
	};

	private _createRetryPromiseForAgentEnd(event: AgentEvent): void {
		if (event.type !== "agent_end" || this._retryPromise) {
			return;
		}

		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return;
		}

		const lastAssistant = this._findLastAssistantInMessages(event.messages);
		const concreteAuthFailure = lastAssistant ? this._isConcreteProviderAuthFailure(lastAssistant) : false;
		if (!lastAssistant || (!this._isRetryableError(lastAssistant) && !concreteAuthFailure)) {
			return;
		}
		if (concreteAuthFailure) {
			this._captureRetryAuthFailureSource(lastAssistant);
		}

		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	private _findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private _addLoginGuidanceToAuthError(event: AgentEvent): void {
		const message =
			event.type === "message_end" && event.message.role === "assistant"
				? (event.message as AssistantMessage)
				: event.type === "agent_end"
					? this._findLastAssistantInMessages(event.messages)
					: undefined;
		if (!message || message.stopReason !== "error" || !message.errorMessage) {
			return;
		}
		if (!isLikelyAuthenticationError(message.errorMessage)) {
			return;
		}
		message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
	}

	private async _processAgentEvent(event: AgentEvent): Promise<void> {
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
			this._applyLateIpythonSentAgentMessages(event.message);
		}
		const acceptedPrompt = this._acceptedAgentMessagePrompt;
		if (acceptedPrompt && (event.type === "message_start" || event.type === "message_end")) {
			if (event.message === acceptedPrompt.message) {
				if (event.type === "message_start") {
					acceptedPrompt.turnStarted = true;
				}
				acceptedPrompt.messages.add(event.message);
			} else if (acceptedPrompt.turnStarted) {
				acceptedPrompt.messages.add(event.message);
			}
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				acceptedPrompt.pendingNextTurnMessages.includes(event.message)
			) {
				acceptedPrompt.deliveredPendingNextTurnMessages.add(event.message);
			}
			if (acceptedPrompt.cleared && acceptedPrompt.messages.has(event.message)) {
				// Membership filter, not a positional slice: newer prompts or compaction may
				// have rewritten state.messages since the clear.
				this.agent.state.messages = this.agent.state.messages.filter(
					(message) => !acceptedPrompt.messages.has(message),
				);
				return;
			}
		}
		const clearedPromptEnded = event.type === "agent_end" ? this._acceptedAgentMessagePrompt : undefined;
		const clearedAcceptedPromptEnded = clearedPromptEnded?.cleared === true;
		if (clearedAcceptedPromptEnded) {
			// Membership filter, not a positional slice: this runs asynchronously after the
			// clear, and a newer prompt or compaction may have rewritten state.messages.
			this.agent.state.messages = this.agent.state.messages.filter(
				(message) => !clearedPromptEnded.messages.has(message),
			);
			(this.agent.state as { errorMessage?: string }).errorMessage = undefined;
			if (!clearedPromptEnded.turnStarted) {
				clearedPromptEnded.rejectAccepted(new Error("Accepted agent message was cleared before delivery."));
			}
			this._lastAssistantMessage = undefined;
			this._acceptedAgentMessagePrompt = undefined;
			this._resolveRetry();
		}

		if (event.type === "message_start" && this._isPromptTurnStartMessage(event.message)) {
			this._overflowRecovery = "idle";
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);
		if (
			(event.type === "message_start" || event.type === "message_end") &&
			this._acceptedAgentMessagePrompt?.cleared &&
			this._acceptedAgentMessagePrompt.messages.has(event.message)
		) {
			this.agent.state.messages = this.agent.state.messages.filter(
				(message) => !this._acceptedAgentMessagePrompt?.messages.has(message),
			);
			return;
		}

		this._addLoginGuidanceToAuthError(event);

		// Notify all listeners
		this._emit(event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					addAutonomousUsage(this._autonomousState, assistantMsg.usage);
				}
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
					this._assistantTurnsSinceAutoRefine++;
					// In serialized mode, kick off background refinement planning
					// immediately after the primary stream finishes, while tools
					// are still executing. The plan is awaited at shouldStopAfterTurn
					// before applying, so planning overlaps tools only — never another
					// model request.
					this._maybeStartSerializedBackgroundPlan();
				}
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecovery = "idle";
				}
				if (this._isConcreteProviderAuthFailure(assistantMsg)) {
					this._captureRetryAuthFailureSource(assistantMsg);
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
					this._retryAuthFailureSources = [];
				}
				if (this._accountGoalUsageForAssistantMessage(assistantMsg)) {
					const message = createGoalContextMessage(this._goalState, "budget_limit");
					const normalized = normalizeMessageContent(message.content);
					await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
						message,
						resumeIfIdle: true,
					});
				}
			}
		}

		if (clearedAcceptedPromptEnded) {
			return;
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			const msg =
				this._lastAssistantMessage ??
				(this._retryPromise ? this._findLastAssistantInMessages(event.messages) : undefined);
			this._lastAssistantMessage = undefined;
			if (!msg) {
				this._resolveRetry();
				return;
			}

			// Check for retryable errors first (overloaded, rate limit, server errors)
			const concreteAuthFailure = this._isConcreteProviderAuthFailure(msg);
			const retryConcreteAuthFailure =
				concreteAuthFailure && !this._isStructuredPermanentProviderRetryExhausted(msg);
			if (this._isRetryableError(msg) || retryConcreteAuthFailure) {
				if (retryConcreteAuthFailure) {
					this._captureRetryAuthFailureSource(msg);
				}
				const didRetry = await this._handleRetryableError(msg, {
					markAuthStaleOnFailure: retryConcreteAuthFailure,
					authSourceTokens: retryConcreteAuthFailure ? this._retryAuthFailureSources : undefined,
				});
				if (didRetry) return; // Retry was initiated, don't proceed to compaction
			}

			const compactionWillRetry = await this._checkCompaction(msg);
			if (compactionWillRetry && this._retryAttempt > 0) {
				return;
			}
			this._finishActiveRetryWithFailure(msg);
			this._resolveRetry();
			if (!compactionWillRetry) {
				this._finishGoalForTerminalAssistantMessage(msg);
				// In serialized mode, agent-callable refine.run is serviced
				// at the shouldStopAfterTurn boundary, not here at agent_end.
				if (!this._serializedRefine) {
					const consumedRequestedRefine = this._consumePendingRequestedRefine();
					if (!consumedRequestedRefine) {
						this._scheduleAutoRefineAfterAgentEnd();
					}
				}
			}
		}
	}

	private _isPromptTurnStartMessage(message: AgentMessage): boolean {
		return (
			message.role === "user" ||
			isAgentSessionMessage(message) ||
			(message.role === "custom" && message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE)
		);
	}

	/** Resolve the pending retry promise */
	private _resolveRetry(): void {
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
			this._scheduleSessionInputPump();
		}
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _processAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			this.sessionManager.recordGitStateIfChanged();
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			// Also capture at end of turn so commits made during the run (e.g. via a bash tool) land.
			this.sessionManager.recordGitStateIfChanged();
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				this._replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	/**
	 * Async teardown for graceful quit/switch: await the IPython kernel's dispose
	 * (which flushes a final namespace snapshot) before the synchronous dispose, so
	 * the latest state reaches disk instead of racing process exit.
	 */
	async disposeAsync(): Promise<void> {
		if (this._disposed) {
			return;
		}
		// Concurrent callers await the same in-flight teardown so none resolves before
		// the kernel snapshot flush finishes.
		if (this._disposeAsyncPromise) {
			return this._disposeAsyncPromise;
		}
		this._disposeAsyncPromise = (async () => {
			// Drain before marking _disposing so a refine triggered at the final
			// agent_end completes instead of being aborted by dispose().
			await this._drainPendingRefinementForDisposal();
			if (this._disposed) {
				return;
			}
			this._disposing = true;
			this._wakeQueuedWorkAdmissionWaiters();
			await this._disposeAsyncOnce();
		})();
		return this._disposeAsyncPromise;
	}

	/**
	 * Await any in-flight refinement (planning or application) and run a
	 * pending auto-refine that was scheduled but not yet started. Called
	 * from disposeAsync before _disposing is set so refinement completes
	 * before disposal.
	 */
	private async _drainPendingRefinementForDisposal(): Promise<void> {
		for (const timer of this._scheduledAutoRefineTimers) {
			clearTimeout(timer);
		}
		this._scheduledAutoRefineTimers.clear();
		await Promise.allSettled([...this._autoRefineOperations]);
		for (const timer of this._scheduledAutoRefineTimers) {
			clearTimeout(timer);
		}
		this._scheduledAutoRefineTimers.clear();
		// Wait for in-flight refinement (including serialized background plan) to settle.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else if (this._serializedPlanInFlight) {
				// Fix 5: Await the background plan and apply a ready "plan"
				// result before teardown so the refinement is persisted.
				// Do NOT discard a ready plan.
				await this._consumeSerializedBackgroundPlan(async (bgResult) => {
					if (bgResult?.status === "plan" && bgResult.branchVersion === this._autoRefineBranchVersion) {
						try {
							await this._applySerializedPlan(bgResult);
						} catch (error) {
							this._emitRefineFailed(error);
						}
						// Stamp cooldown and reset counter so the interval
						// check below does not trigger a duplicate refine.
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
					}
					// Preserve a consumed explicit request when its background plan failed,
					// matching the turn-boundary recovery path. The pending drain below
					// retries it once before disposal.
					if (
						bgResult?.status === "failure" &&
						bgResult.explicit &&
						bgResult.branchVersion === this._autoRefineBranchVersion &&
						!this._pendingRequestedRefine
					) {
						this._pendingRequestedRefine = bgResult.options;
					}
					// For "skip" or "failure", stamp cooldown and reset counter
					// so the interval check below does not trigger a duplicate
					// terminal retry.
					if (
						bgResult?.status === "skip" ||
						bgResult?.status === "failure" ||
						bgResult?.status === "invalidated"
					) {
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
					}
					return false;
				});
			} else {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		// Drain an agent-callable refine.run request that was scheduled but
		// not yet consumed. Use the direct serialized path (no waitForIdle)
		// since the agent may still own activeRun at the final agent_end.
		if (this._pendingRequestedRefine) {
			const pending = this._pendingRequestedRefine;
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending);
			} catch {
				// Best-effort drain; refinement errors must not block disposal.
			}
			// Stamp cooldown and reset counter so the interval check below
			// does not trigger a duplicate refine after the explicit drain.
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		}
		// A serialized compaction can finish without another model turn. Drain its
		// pending review here so disposal does not silently lose the trigger.
		if (this._serializedRefine && this._compactAutoRefinePending && this._autoRefineAllowedForSession()) {
			const compactSettings = this.settingsManager.getAutoRefineSettings();
			if (!compactSettings.enabled || !compactSettings.compact) {
				this._compactAutoRefinePending = false;
			} else {
				const nowMs = Date.now();
				const underCooldown =
					this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < compactSettings.cooldownMs;
				this._compactAutoRefinePending = false;
				if (!underCooldown) {
					try {
						await this._runSerializedAutoRefineReview("compact", this._autoRefineBranchVersion);
					} catch {
						// Best-effort drain; refinement errors must not block disposal.
					}
					return;
				}
			}
		}

		// If auto-refine is due but has not started yet, run it now so the
		// refinement is persisted before disposal. Use the direct serialized
		// path in serialized mode, or _maybeAutoRefine in interactive mode
		// (where the agent is idle at this point).
		if (this._disposed || !this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		if (this._serializedRefine) {
			await this._runSerializedRefineCheckpoint();
		} else {
			await this._maybeAutoRefine("turn_interval");
		}
	}

	private async _disposeAsyncOnce(): Promise<void> {
		// Flush kernels/traces for both still-running and retained children; the sync
		// dispose() below only tears them down synchronously.
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.session) {
				await run.session.disposeAsync().catch(() => undefined);
			}
		}
		for (const unsubscribe of this._retainedRlmChildUnsubscribes.values()) {
			unsubscribe();
		}
		this._retainedRlmChildUnsubscribes.clear();
		for (const session of this._retainedRlmChildSessions.values()) {
			await session.disposeAsync().catch(() => undefined);
		}
		this._retainedRlmChildSessions.clear();
		this._deletedRlmChildIds.clear();
		this._retryableRlmSubagentDeletions.clear();
		try {
			await this._ipythonKernelProvisioner?.dispose();
		} catch {
			// a failed kernel startup already cleaned up after itself
		}
		this.dispose();
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._wakeQueuedWorkAdmissionWaiters();
		try {
			// Invalidate scheduled timers and abort any in-flight review so a late
			// resolution cannot write harness state or re-subscribe handlers.
			this._autoRefineReviewAbort?.abort();
			this._refineAbortController?.abort();
			for (const timer of this._scheduledAutoRefineTimers) {
				clearTimeout(timer);
			}
			this._scheduledAutoRefineTimers.clear();
			this._serializedPlanInFlight = undefined;
			this._serializedExplicitRefineOptions = undefined;
			this._pendingRequestedRefine = undefined;
			this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
			this._autoRefineBranchVersion++;
			this._cancelActiveRlmChildRuns("Parent session disposed");
			for (const unsubscribe of this._retainedRlmChildUnsubscribes.values()) {
				unsubscribe();
			}
			this._retainedRlmChildUnsubscribes.clear();
			for (const session of this._retainedRlmChildSessions.values()) {
				session.dispose();
			}
			this._retainedRlmChildSessions.clear();
			this._deletedRlmChildIds.clear();
			this._retryableRlmSubagentDeletions.clear();
			this._pendingNextTurnMessages = [];
			const deliveryError = new Error("Session disposed before prompt delivery.");
			const completionError = new Error("Session disposed before prompt completion.");
			this._rejectQueuedAgentMessageDeliveries(deliveryError, completionError);
			for (const [agentMessageId, outcome] of this._agentMessageOutcomes) {
				if (outcome.delivery) this._settleAgentMessage(agentMessageId, "delivery", deliveryError);
				if (outcome.completion) this._settleAgentMessage(agentMessageId, "completion", completionError);
			}
			this._steeringMessages = [];
			this._followUpMessages = [];
			this.agent.clearAllQueues();
			this._extensionRunner.invalidate(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
			);
			this._disconnectFromAgent();
			this._eventListeners = [];
			cleanupSessionResources(this.sessionId);
		} finally {
			for (const callback of this._disposeCallbacks) {
				try {
					callback();
				} catch {
					// Disposal remains best-effort; one owner must not block the rest.
				}
			}
			this._disposeCallbacks.clear();
		}
	}

	registerDisposeCallback(callback: () => void): void {
		if (this._disposed) {
			callback();
			return;
		}
		this._disposeCallbacks.add(callback);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get serviceTier(): ServiceTier {
		return this.agent.state.serviceTier;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const seenToolNames = new Set<string>();
		for (const name of toolNames) {
			if (seenToolNames.has(name)) {
				continue;
			}
			const tool = this._toolRegistry.get(name);
			if (tool) {
				seenToolNames.add(name);
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildSessionContext(): SessionContext {
		const context = this.sessionManager.buildSessionContext();
		for (const message of context.messages) {
			this._applyLateIpythonSentAgentMessages(message);
		}
		this._mergeUnpersistedCompactionOutcomes(context.messages);
		return context;
	}

	/**
	 * Merge disclosures whose session-file append failed into a rebuilt message
	 * list at their timestamp position, where they appeared live.
	 */
	private _mergeUnpersistedCompactionOutcomes(messages: AgentMessage[]): void {
		for (const outcome of this._unpersistedCompactionOutcomes) {
			let insertAt = messages.length;
			while (insertAt > 0 && messages[insertAt - 1]!.timestamp > outcome.timestamp) {
				insertAt -= 1;
			}
			messages.splice(insertAt, 0, outcome);
		}
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get goalState(): GoalState {
		return { ...this._goalWithCurrentWallClock() };
	}

	getAutonomousStatus(): AgentAutonomousStatus {
		return autonomousStatus(this._autonomousState);
	}

	recordHostAutonomousContinuation(): void {
		addAutonomousContinuation(this._autonomousState);
	}

	async refreshAutonomousGates(): Promise<void> {
		await refreshAutonomousQualityGates(this._autonomousState, { cwd: this._cwd });
	}

	private async _runWithAutonomousContinuationSuppressed<T>(fn: () => Promise<T>): Promise<T> {
		this._autonomousContinuationSuppressionDepth++;
		try {
			return await fn();
		} finally {
			this._autonomousContinuationSuppressionDepth--;
		}
	}

	private _markAutonomousContinuationSuppressed(message: AgentMessage): void {
		this._autonomousContinuationSuppressedMessages.add(message);
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._modelVisibleSkills();
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			messagesPath: this.sessionManager.getSessionFile(),
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			allowRecursion: this._rlmDepth < this._rlmMaxDepth,
			harnessState: this._loadMergedHarnessState(),
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private _refreshExtensionSystemPrompt(extensionPrompt: string, baseSnapshot: string): string {
		if (this._baseSystemPrompt === baseSnapshot) {
			return extensionPrompt;
		}
		if (!extensionPrompt.includes(baseSnapshot)) {
			return extensionPrompt;
		}
		return extensionPrompt.replace(baseSnapshot, () => this._baseSystemPrompt);
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		return this._prompt(text, options);
	}

	/** Resolve once the session has accepted ownership, before queued or active execution completes. */
	async promptUntilAccepted(text: string, options?: PromptOptions): Promise<void> {
		return this._prompt(text, { ...options, returnAfterAccepted: true });
	}

	async promptAndWait(text: string, options?: PromptOptions): Promise<void> {
		const agentMessageId = options?.agentMessageId ?? `prompt-wait:${randomUUID()}`;
		if (this._agentMessageOutcomes.get(agentMessageId)?.completion) {
			throw new Error(`Prompt completion id is already in use: ${agentMessageId}`);
		}
		const outcome = this._agentMessageOutcome(agentMessageId);
		outcome.completion = createAgentMessageDeferred();
		const completion = outcome.completion.promise;
		try {
			await this.promptUntilAccepted(text, { ...options, agentMessageId });
			await completion;
		} catch (error) {
			this._settleAgentMessage(agentMessageId, "completion", this._asError(error));
			throw error;
		}
	}

	async acceptAgentMessagePrompt(text: string, options?: PromptOptions): Promise<void> {
		const customMessage =
			options?.customMessage && isAgentSessionMessage(options.customMessage) ? options.customMessage : undefined;
		return this._prompt(text, {
			...options,
			expandPromptTemplates: false,
			skipInputHandlers: true,
			skipPrePromptWork: true,
			returnAfterAccepted: true,
			agentMessageId: options?.agentMessageId ?? customMessage?.details.id ?? parseAgentSessionMessagePromptId(text),
			customMessage,
		});
	}

	async queueAgentMessagePrompt(
		text: string,
		streamingBehavior: "steer" | "followUp",
		customMessage?: AgentSessionMessage,
	): Promise<boolean> {
		const agentMessageId = customMessage?.details.id ?? parseAgentSessionMessagePromptId(text);
		if (streamingBehavior === "steer") {
			await this._queuePreparedPrompt("steer", text, undefined, { agentMessageId, message: customMessage });
			return true;
		}
		return this._queuePreparedPrompt("followUp", text, undefined, { agentMessageId, message: customMessage });
	}

	async promptHeartbeat(job: AgentCronJob, options?: PromptOptions): Promise<void> {
		const message = createHeartbeatPromptMessage(job);
		await this._promptInjectedMessage(job.prompt, message, {
			...options,
			followUpQueueKey: options?.followUpQueueKey ?? `heartbeat:${job.id}`,
			resumeIfIdle: true,
		});
	}

	private _observeDirectDispatch(message: AgentMessage): {
		observed: Promise<true>;
		wasObserved(): boolean;
		stop(): void;
	} {
		let fired = false;
		let observer!: { message: AgentMessage; resolve: () => void };
		const observed = new Promise<true>((resolve) => {
			observer = {
				message,
				resolve: () => {
					fired = true;
					resolve(true);
				},
			};
		});
		this._directDispatchObservers.add(observer);
		return {
			observed,
			wasObserved: () => fired,
			stop: () => this._directDispatchObservers.delete(observer),
		};
	}

	private async _promptInjectedMessage(
		text: string,
		message: CustomMessage,
		options?: InternalPromptOptions,
	): Promise<void> {
		if (!this.isStreaming && options?.resumeIfIdle) this._sessionInputPumpSuspended = false;
		const admission = await this._acquireDirectTurnAdmission({
			allowStreaming: true,
			allowPendingQueue: options?.queueIfBusy === true,
			signal: options?.signal,
		});
		try {
			// Ownership commits before destructive preflight, but cancellation and the
			// commit callback are covered by release if either throws.
			throwIfPromptAdmissionCancelled(options?.signal);
			options?.admissionCommitted?.();
			await this._turnAdmissionContext.run(admission.owner, () =>
				this._promptInjectedMessageUnserialized(text, message, options, admission.release),
			);
		} finally {
			admission.release();
			this._scheduleSessionInputPump();
		}
	}

	private async _promptInjectedMessageUnserialized(
		text: string,
		message: CustomMessage,
		options: InternalPromptOptions | undefined,
		releaseAdmission: () => void,
	): Promise<void> {
		const endDirectPromptSection = this._enterDirectPromptSection();
		const reportInput = oncePreflight(options?.preflightResult);
		const reportPreflight: typeof reportInput = (success, queued) => {
			endDirectPromptSection();
			reportInput(success, queued);
		};

		let messages: AgentMessage[] | undefined;
		let drainedNextTurnMessages: CustomMessage[] = [];
		const previewLabel = injectedMessagePreviewLabel(message);
		let extensionResult: Awaited<ReturnType<typeof this._extensionRunner.emitBeforeAgentStart>> | undefined;
		let basePromptSnapshot: string | undefined;
		try {
			const shouldQueueForStreaming = this.isStreaming;
			const shouldQueueForPendingWork = options?.queueIfBusy === true && this._isBusyForSessionInput("preflight");
			if (shouldQueueForStreaming || shouldQueueForPendingWork) {
				if (!options?.streamingBehavior) {
					const stateDescription = shouldQueueForStreaming
						? "Agent is already processing"
						: "Agent has queued work";
					throw new Error(
						`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
					);
				}
				await this._queueWithPendingNextTurnMessages(text, options.streamingBehavior, reportPreflight, {
					message,
					queueKey: options.followUpQueueKey,
					previewLabel,
					suppressAutonomousContinuation: options.suppressAutonomousContinuation,
					resumeIfIdle: options.resumeIfIdle,
				});

				return;
			}

			await this._waitForRefineIdle();
			this._flushPendingBashMessages();
			await this._validateCanStartAgentRun();

			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false, false);
			}

			const pendingModelSelectEmit = this._pendingModelSelectEmit();
			if (pendingModelSelectEmit) {
				await pendingModelSelectEmit;
			}

			drainedNextTurnMessages = this._pendingNextTurnMessages;
			this._pendingNextTurnMessages = [];
			messages = [...drainedNextTurnMessages, message];

			basePromptSnapshot = this._baseSystemPrompt;
			extensionResult = await this._extensionRunner.emitBeforeAgentStart(
				text,
				undefined,
				basePromptSnapshot,
				this._baseSystemPromptOptions,
			);
			this._appendBeforeAgentStartMessages(messages, extensionResult);
			this.agent.state.systemPrompt =
				extensionResult?.systemPrompt !== undefined
					? this._refreshExtensionSystemPrompt(extensionResult.systemPrompt, basePromptSnapshot)
					: this._baseSystemPrompt;
		} catch (error) {
			reportPreflight(false);
			throw error;
		}

		if (!messages) {
			endDirectPromptSection();
			return;
		}

		if (this._refineInFlight) {
			await this._waitForRefineIdle();
			if (extensionResult?.systemPrompt !== undefined && basePromptSnapshot !== undefined) {
				this.agent.state.systemPrompt = this._refreshExtensionSystemPrompt(
					extensionResult.systemPrompt,
					basePromptSnapshot,
				);
			} else {
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		}
		const shouldQueueAtHandoff = options?.queueIfBusy === true && this._isBusyForSessionInput("handoff");
		if (shouldQueueAtHandoff) {
			this._pendingNextTurnMessages.unshift(...drainedNextTurnMessages.map((pending) => ({ ...pending })));
			if (!options?.streamingBehavior) {
				reportPreflight(false);
				throw new Error(
					"Agent became busy before prompt delivery. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			try {
				await this._queueWithPendingNextTurnMessages(text, options.streamingBehavior, reportPreflight, {
					message,
					queueKey: options.followUpQueueKey,
					previewLabel,
					suppressAutonomousContinuation: options.suppressAutonomousContinuation,
					resumeIfIdle: options.resumeIfIdle,
				});
			} catch (error) {
				// A failed enqueue must still settle the preflight outcome, or the
				// direct-prompt section would fence checkpoints forever.
				reportPreflight(false);
				throw error;
			}

			return;
		}

		if (options?.suppressAutonomousContinuation) this._markAutonomousContinuationSuppressed(message);
		// Register the observer before dispatch so a synchronously-emitted
		// message_start cannot be missed.
		const dispatchObserver = this._observeDirectDispatch(message);
		const promptPromise = options?.suppressAutonomousContinuation
			? this._runWithAutonomousContinuationSuppressed(() => this.agent.prompt(messages))
			: this.agent.prompt(messages);
		releaseAdmission();
		// Settle the preflight outcome at the handoff, not after the whole turn: the
		// direct-prompt section must keep fencing update-restart checkpoints until
		// message_start proves the input reached the run's event stream, and a
		// rejected dispatch must still release the section. A resolved prompt alone
		// is not proof: Agent.prompt() converts lifecycle failures into a synthetic
		// error turn without the message ever reaching agent state.
		const dispatched = await Promise.race([
			promptPromise.then(
				() => dispatchObserver.wasObserved() || this.agent.state.messages.includes(message),
				() => false,
			),
			dispatchObserver.observed,
		]);
		dispatchObserver.stop();
		reportPreflight(dispatched);
		try {
			await promptPromise;
		} catch (error) {
			this._pendingNextTurnMessages.unshift(...drainedNextTurnMessages.map((pending) => ({ ...pending })));
			throw error;
		}
		await this.waitForRetry();
	}

	private async _prompt(text: string, options?: InternalPromptOptions): Promise<void> {
		if (!this.isStreaming) this._sessionInputPumpSuspended = false;
		const admission = !this.isStreaming
			? await this._acquireDirectTurnAdmission({
					allowPendingQueue: options?.queueIfBusy === true,
					signal: options?.signal,
				})
			: undefined;
		// The streaming path skips admission, so this is its cancellation commit point.
		if (!admission) throwIfPromptAdmissionCancelled(options?.signal);
		const releaseAdmission = admission?.release ?? (() => {});
		try {
			// Streaming prompts skip direct-turn admission but still transfer ownership
			// before any queue/interception work begins. Keep this before destructive
			// preflight while ensuring a directly acquired admission is always released.
			throwIfPromptAdmissionCancelled(options?.signal);
			options?.admissionCommitted?.();
			if (admission) {
				await this._turnAdmissionContext.run(admission.owner, () =>
					this._promptUnserialized(text, options, releaseAdmission),
				);
			} else {
				await this._promptUnserialized(text, options, releaseAdmission);
			}
		} finally {
			releaseAdmission();
		}
		if (admission) {
			this._scheduleSessionInputPump();
			// promptUntilAccepted resolves at ownership commit, before queued work runs.
			if (!options?.returnAfterAccepted) await this._sessionInputPump;
		}
	}

	private async _promptUnserialized(
		text: string,
		options: InternalPromptOptions | undefined,
		releaseAdmission: () => void,
	): Promise<void> {
		const isInternalPrompt = options?.internalPrompt === true;
		const expandPromptTemplates = isInternalPrompt ? false : (options?.expandPromptTemplates ?? true);
		const endDirectPromptSection = this._enterDirectPromptSection();
		const reportInput = oncePreflight(options?.preflightResult);
		const reportPreflight: typeof reportInput = (success, queued) => {
			endDirectPromptSection();
			reportInput(success, queued);
		};
		let messages: AgentMessage[] | undefined;
		let primaryPromptMessage: QueuedAgentMessage | undefined;
		let acceptedAgentMessagePrompt: AcceptedAgentMessagePrompt | undefined;
		let drainedNextTurnMessages: CustomMessage[] = [];
		let expandedText = text;
		let currentImages = options?.images;
		let extensionResult: Awaited<ReturnType<typeof this._extensionRunner.emitBeforeAgentStart>> | undefined;
		let basePromptSnapshot: string | undefined;

		try {
			let currentText = text;
			const shouldHandleBuiltInSlashCommands = !isInternalPrompt && !options?.skipPrePromptWork;
			const sessionCommand = shouldHandleBuiltInSlashCommands ? parseSessionSlashCommand(currentText) : undefined;
			if (sessionCommand) {
				const wasBusy =
					this.isStreaming ||
					this.isCompacting ||
					this.isRetrying ||
					this.isBashRunning ||
					this.hasAcceptedPromptInFlight ||
					this._sessionInputPumpSuspended ||
					this._queuedWorkPauses.size > 0 ||
					this._activeSessionInput !== undefined ||
					this.pendingMessageCount > 0;
				const schedule = options?.streamingBehavior ?? (this.isStreaming ? "steer" : "followUp");
				const queued = this._enqueueSessionInput(
					{
						kind: "command",
						text: currentText,
						command: sessionCommand,
						images: currentImages,
						agentMessageId: options?.agentMessageId,
					},
					schedule,
				);
				reportPreflight(queued, queued);
				releaseAdmission();
				if (!wasBusy && !options?.returnAfterAccepted) await this._sessionInputPump;
				return;
			}

			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && currentText.startsWith("/")) {
				const commandCompletion = this._executeExtensionCommand(currentText);
				if (commandCompletion) {
					reportPreflight(true);
					void commandCompletion.then(
						() => this._settleAgentMessage(options?.agentMessageId, "completion"),
						(error) => this._settleAgentMessage(options?.agentMessageId, "completion", error),
					);
					void commandCompletion.catch(() => undefined);
					if (!options?.returnAfterAccepted) await commandCompletion.catch(() => undefined);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion).
			// Agent-to-agent and internal host prompts bypass input handlers so
			// extensions cannot rewrite or swallow direct delivery.
			if (!isInternalPrompt && !options?.skipInputHandlers && this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
				);
				if (inputResult.action === "handled") {
					reportPreflight(true);
					this._settleAgentMessage(options?.agentMessageId, "completion");
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, or a caller explicitly asked to respect existing queued work,
			// enqueue according to the requested behavior.
			const shouldQueueForStreaming = this.isStreaming;
			const shouldQueueForPendingWork = options?.queueIfBusy === true && this._isBusyForSessionInput("preflight");
			if (shouldQueueForStreaming || shouldQueueForPendingWork) {
				if (!options?.streamingBehavior) {
					const stateDescription = shouldQueueForStreaming
						? "Agent is already processing"
						: "Agent has queued work";
					throw new Error(
						`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
					);
				}
				await this._queueWithPendingNextTurnMessages(expandedText, options.streamingBehavior, reportPreflight, {
					images: currentImages,
					queueKey: options.followUpQueueKey,
					agentMessageId: options.agentMessageId,
					suppressAutonomousContinuation: options.suppressAutonomousContinuation,
					message: options.customMessage,
					resumeIfIdle: options.resumeIfIdle,
				});

				return;
			}

			if (!options?.returnAfterAccepted) {
				await this._waitForRefineIdle();
			}

			// Flush any pending bash messages before the new prompt, including accepted agent messages.
			this._flushPendingBashMessages();
			await this._validateCanStartAgentRun();

			const pendingModelSelectEmit = this._pendingModelSelectEmit();
			if (pendingModelSelectEmit) {
				await pendingModelSelectEmit;
			}
			const buildUserContent = (): (TextContent | ImageContent)[] => {
				const userContent: (TextContent | ImageContent)[] = options?.content
					? options.content.map((block) => ({ ...block }))
					: [{ type: "text", text: expandedText }];
				if (!options?.content && currentImages) {
					userContent.push(...currentImages);
				}
				return userContent;
			};
			if (options?.skipPrePromptWork) {
				this.agent.state.systemPrompt = this._baseSystemPrompt;
				messages = [];
				drainedNextTurnMessages = this._pendingNextTurnMessages;
				for (const msg of drainedNextTurnMessages) {
					messages.push(msg);
				}
				this._pendingNextTurnMessages = [];
				primaryPromptMessage = options.customMessage
					? cloneCustomMessage(options.customMessage)
					: {
							role: "user",
							content: buildUserContent(),
							timestamp: Date.now(),
						};
				messages.push(primaryPromptMessage);
				if (options.agentMessageId !== undefined && options.returnAfterAccepted) {
					let resolveAccepted = () => {};
					let rejectAccepted = (_error: Error) => {};
					const accepted = new Promise<void>((resolve, reject) => {
						resolveAccepted = resolve;
						rejectAccepted = reject;
					});
					acceptedAgentMessagePrompt = {
						text: expandedText,
						agentMessageId: options.agentMessageId,
						message: primaryPromptMessage,
						messages: new Set<AgentMessage>([...drainedNextTurnMessages, primaryPromptMessage]),
						pendingNextTurnMessages: drainedNextTurnMessages,
						deliveredPendingNextTurnMessages: new Set(),
						accepted,
						resolveAccepted,
						rejectAccepted,
						turnStarted: false,
						cleared: false,
					};
				}
			} else {
				// Check if we need to compact before sending (catches aborted responses)
				const lastAssistant = this._findLastAssistantMessage();
				if (lastAssistant) {
					await this._checkCompaction(lastAssistant, false, false);
				}

				// Build messages array (custom message if any, then user message)
				messages = [];

				// Inject any pending "nextTurn" messages as context before the user message.
				drainedNextTurnMessages = this._pendingNextTurnMessages;
				for (const msg of drainedNextTurnMessages) {
					messages.push(msg);
				}
				this._pendingNextTurnMessages = [];

				primaryPromptMessage = options?.customMessage
					? cloneCustomMessage(options.customMessage)
					: {
							role: "user",
							content: buildUserContent(),
							timestamp: Date.now(),
						};
				messages.push(primaryPromptMessage);

				// Emit before_agent_start extension event
				basePromptSnapshot = this._baseSystemPrompt;
				extensionResult = await this._extensionRunner.emitBeforeAgentStart(
					expandedText,
					currentImages,
					basePromptSnapshot,
					this._baseSystemPromptOptions,
				);
				// Add all custom messages from extensions
				this._appendBeforeAgentStartMessages(messages, extensionResult);
				// Apply extension-modified system prompt, or reset to base
				this.agent.state.systemPrompt = extensionResult?.systemPrompt
					? this._refreshExtensionSystemPrompt(extensionResult.systemPrompt, basePromptSnapshot)
					: this._baseSystemPrompt;
			}
		} catch (error) {
			reportPreflight(false);
			throw error;
		}

		if (!messages) {
			endDirectPromptSection();
			return;
		}

		if (acceptedAgentMessagePrompt) {
			this._acceptedAgentMessagePrompt = acceptedAgentMessagePrompt;
		}
		// Re-check adjacent to the handoff: extension before_agent_start handlers
		// above may have suspended this turn long enough for a refine to start.
		if (this._refineInFlight) {
			await this._waitForRefineIdle();
			if (extensionResult?.systemPrompt && basePromptSnapshot !== undefined) {
				this.agent.state.systemPrompt = this._refreshExtensionSystemPrompt(
					extensionResult.systemPrompt,
					basePromptSnapshot,
				);
			} else {
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		}
		if (acceptedAgentMessagePrompt?.cleared) {
			reportPreflight(false);
			throw new Error("Accepted agent message was cleared before delivery.");
		}
		const shouldQueueAtHandoff =
			options?.queueIfBusy === true && this._isBusyForSessionInput("handoff", acceptedAgentMessagePrompt);
		if (shouldQueueAtHandoff) {
			if (acceptedAgentMessagePrompt && this._acceptedAgentMessagePrompt === acceptedAgentMessagePrompt) {
				this._acceptedAgentMessagePrompt = undefined;
			}
			this._pendingNextTurnMessages.unshift(...drainedNextTurnMessages.map((message) => ({ ...message })));
			if (!options?.streamingBehavior) {
				reportPreflight(false);
				throw new Error(
					"Agent became busy before prompt delivery. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			try {
				await this._queueWithPendingNextTurnMessages(expandedText, options.streamingBehavior, reportPreflight, {
					images: currentImages,
					queueKey: options.followUpQueueKey,
					agentMessageId: options.agentMessageId,
					suppressAutonomousContinuation: options.suppressAutonomousContinuation,
					message: options.customMessage,
					resumeIfIdle: options.resumeIfIdle,
				});
			} catch (error) {
				// A failed enqueue must still settle the preflight outcome, or the
				// direct-prompt section would fence checkpoints forever.
				reportPreflight(false);
				throw error;
			}

			return;
		}
		if (options?.suppressAutonomousContinuation) {
			for (const message of messages) {
				this._markAutonomousContinuationSuppressed(message);
			}
		}
		if (!primaryPromptMessage) {
			reportPreflight(false);
			throw new Error("Direct prompt is missing its primary message");
		}
		const dispatchObserver = acceptedAgentMessagePrompt
			? undefined
			: this._observeDirectDispatch(primaryPromptMessage);
		const promptPromise = options?.suppressAutonomousContinuation
			? this._runWithAutonomousContinuationSuppressed(() => this.agent.prompt(messages))
			: this.agent.prompt(messages);
		releaseAdmission();
		const promptAccepted = Symbol("promptAccepted");
		const acceptance = acceptedAgentMessagePrompt
			? acceptedAgentMessagePrompt.accepted.then(
					() => promptAccepted,
					(error: unknown) => error,
				)
			: dispatchObserver!.observed.then(() => promptAccepted);
		const firstOutcome = await Promise.race([
			promptPromise.then(
				() => undefined,
				(error: unknown) => error,
			),
			acceptance,
		]);
		dispatchObserver?.stop();
		if (firstOutcome !== undefined && firstOutcome !== promptAccepted) {
			// A cleared prompt stays set until the aborted run's agent_end cleanup nulls it;
			// nulling here would let the run's late events re-persist cleared messages.
			if (
				this._acceptedAgentMessagePrompt === acceptedAgentMessagePrompt &&
				!this._acceptedAgentMessagePrompt?.cleared
			) {
				this._acceptedAgentMessagePrompt = undefined;
			}
			if (acceptedAgentMessagePrompt && !acceptedAgentMessagePrompt.cleared) {
				// The prompt was never accepted, so next-turn context drained for it
				// was not consumed by the model and must remain available to retry.
				this._pendingNextTurnMessages.unshift(
					...undeliveredPendingNextTurnMessages(acceptedAgentMessagePrompt).map((message) => ({
						...message,
					})),
				);
			}
			reportPreflight(false);
			throw firstOutcome;
		}
		reportPreflight(true);
		const promptCompletion = promptPromise.then(async () => {
			await this.waitForRetry();
		});
		if (options?.agentMessageId) {
			void promptCompletion.then(
				() => this._settleAgentMessage(options.agentMessageId, "completion"),
				(error) => this._settleAgentMessage(options.agentMessageId, "completion", this._asError(error)),
			);
		}
		void promptCompletion
			.finally(() => {
				if (
					this._acceptedAgentMessagePrompt === acceptedAgentMessagePrompt &&
					!this._acceptedAgentMessagePrompt?.cleared
				) {
					this._acceptedAgentMessagePrompt = undefined;
				}
				this._scheduleSessionInputPump();
			})
			.catch(() => undefined);
		if (options?.returnAfterAccepted) {
			this._acceptedPromptCompletions.add(promptCompletion);
			void promptCompletion
				.finally(() => this._acceptedPromptCompletions.delete(promptCompletion))
				.catch(() => undefined);
			return;
		}
		await promptCompletion;
	}

	private _executeExtensionCommand(text: string): Promise<void> | undefined {
		const parsed = parseSlashCommand(text);
		if (!parsed) return undefined;
		const commandName = parsed.name;
		const args = parsed.args;

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return undefined;
		const context = this._extensionRunner.createCommandContext();
		return Promise.resolve()
			.then(() => command.handler(args, context))

			.catch((error: unknown) => {
				const commandError = error instanceof Error ? error : new Error(String(error));
				this._extensionRunner.emitError({
					extensionPath: `command:${commandName}`,
					event: "command",
					error: commandError.message,
				});
				throw commandError;
			});
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const parsed = parseSlashCommand(text);
		if (!parsed?.name.startsWith("skill:")) return text;
		const skillName = parsed.name.slice("skill:".length);
		const args = parsed.args;

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options: { queueKey?: string; agentMessageId?: string; resumeIfIdle?: boolean } = {},
	): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queuePreparedPrompt("steer", expandedText, images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options: { queueKey?: string; agentMessageId?: string; resumeIfIdle?: boolean } = {},
	): Promise<boolean> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		return this._queuePreparedPrompt("followUp", expandedText, images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	private _restoreSessionCommand(
		text: string,
		customMessage: CustomMessage | undefined,
		images: ImageContent[] | undefined,
		schedule: SessionInputSchedule,
		agentMessageId: string | undefined,
	): boolean | undefined {
		if (!isSessionSlashCommandMessage(customMessage) || text !== customMessage.details.command.text) {
			return undefined;
		}
		return this._enqueueSessionInput(
			{
				kind: "command",
				text,
				command: customMessage.details.command,
				images,
				agentMessageId,
			},
			schedule,
			{ restore: true },
		);
	}

	async restoreSteeringMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<void> {
		if (
			this._restoreSessionCommand(text, options.customMessage, images, "steer", options.agentMessageId) !== undefined
		)
			return;

		await this._queuePreparedPrompt("steer", text, images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			message: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	async restoreFollowUpMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<boolean> {
		const restoredCommand = this._restoreSessionCommand(
			text,
			options.customMessage,
			images,
			"followUp",
			options.agentMessageId,
		);
		if (restoredCommand !== undefined) return restoredCommand;

		return this._queuePreparedPrompt("followUp", text, images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			message: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	private _buildPromptContent(text: string, images?: ImageContent[]): (TextContent | ImageContent)[] {
		const content: (TextContent | ImageContent)[] = [];
		content.push({ type: "text", text });
		if (images) {
			content.push(...images);
		}
		return content;
	}

	/** Queue via the requested lane, restoring drained next-turn context on failure, and report preflight. */
	private async _queueWithPendingNextTurnMessages(
		text: string,
		streamingBehavior: "steer" | "followUp",
		reportPreflight: (success: boolean, queued?: boolean) => void,
		options: {
			images?: ImageContent[];
			queueKey?: string;
			agentMessageId?: string;
			message?: QueuedAgentMessage;
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<void> {
		const pendingNextTurnMessages = this._pendingNextTurnMessages;
		this._pendingNextTurnMessages = [];
		// Preflight callbacks run outside the try: a throwing callback must not roll
		// back queue state for an input that was in fact enqueued (its prefixMessages
		// would be delivered twice).
		let queued: boolean;
		try {
			queued = await this._queuePreparedPrompt(streamingBehavior, text, options.images, {
				queueKey: options.queueKey,
				agentMessageId: options.agentMessageId,
				message: options.message,
				prefixMessages: pendingNextTurnMessages,
				previewLabel: options.previewLabel,
				suppressAutonomousContinuation: options.suppressAutonomousContinuation,
				resumeIfIdle: options.resumeIfIdle,
			});
			if (!queued) {
				this._pendingNextTurnMessages.unshift(...pendingNextTurnMessages);
			}
		} catch (error) {
			this._pendingNextTurnMessages.unshift(...pendingNextTurnMessages);
			throw error;
		}
		reportPreflight(queued, queued);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private _createPreparedPromptInput(
		text: string,
		images: ImageContent[] | undefined,
		options: {
			agentMessageId?: string;
			queueKey?: string;
			content?: (TextContent | ImageContent)[];
			message?: QueuedAgentMessage;
			prefixMessages?: CustomMessage[];
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
		},
	): PreparedPromptInput {
		const content = options.content ?? this._buildPromptContent(text, images);
		const message =
			options.message ??
			({
				role: "user",
				content: content.map((block) => ({ ...block })),
				timestamp: Date.now(),
			} satisfies UserMessage);
		return {
			kind: "prompt",
			text,
			images: images?.map((image) => ({ ...image })),
			content: content.map((block) => ({ ...block })),
			customMessage: options.message?.role === "custom" ? cloneCustomMessage(options.message) : undefined,
			previewLabel: options.previewLabel,
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			prefixMessages: options.prefixMessages?.map((message) => cloneCustomMessage(message)) ?? [],
			suppressAutonomousContinuation: options.suppressAutonomousContinuation,
			autoPump: options.resumeIfIdle === true,
			message,
		};
	}

	private _enqueueSessionInput(
		input: QueuedSessionInput,
		schedule: SessionInputSchedule,
		options: { restore?: boolean } = {},
	): boolean {
		const queue = schedule === "steer" ? this._steeringMessages : this._followUpMessages;
		const coalescedOwner =
			schedule === "followUp" && input.kind === "prompt" && input.queueKey
				? (queue.find((item) => item.queueKey === input.queueKey) ??
					this._activePendingPromptWithQueueKey(input.queueKey))
				: undefined;
		if (coalescedOwner) {
			if (input.agentMessageId !== coalescedOwner.agentMessageId) {
				this._rejectAgentMessage(
					input.agentMessageId,
					new Error("Prompt was not queued because an equivalent follow-up is already pending."),
				);
			}
			return false;
		}
		queue.push(input);
		this._sessionInputArrivalEpoch++;
		this._emitQueueUpdate();
		if (
			!options.restore &&
			((schedule === "steer" && this.isStreaming) || input.kind === "command" || input.autoPump)
		) {
			if (input.kind === "prompt" && input.autoPump) this._sessionInputPumpSuspended = false;
			this._scheduleSessionInputPump();
		}
		return true;
	}

	/** Queue a prepared prompt on one lane; steering always queues, follow-up may coalesce by queue key. */
	private async _queuePreparedPrompt(
		schedule: SessionInputSchedule,
		text: string,
		images?: ImageContent[],
		options: {
			agentMessageId?: string;
			queueKey?: string;
			content?: (TextContent | ImageContent)[];
			message?: QueuedAgentMessage;
			prefixMessages?: CustomMessage[];
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<boolean> {
		const input = this._createPreparedPromptInput(text, images, options);
		if (options.suppressAutonomousContinuation) {
			this._markAutonomousContinuationSuppressed(input.message);
		}
		return this._enqueueSessionInput(input, schedule);
	}

	private _scheduleSessionInputPump(): void {
		if (this._sessionInputPumpSuspended || this._queuedWorkPauses.size > 0) return;
		if (this._disposed || this._disposing || this._sessionInputPumpRequested || this.pendingMessageCount === 0) {
			return;
		}
		this._sessionInputPumpRequested = true;
		const epoch = this._sessionInputPumpEpoch;
		const pump = async () => {
			this._sessionInputPumpRequested = false;
			await this._pumpSessionInputs(epoch);
		};
		this._sessionInputPump = this._sessionInputPump.then(pump, pump);
		this._sessionInputPump.catch(() => {});
	}

	private async _pumpSessionInputs(epoch: number): Promise<void> {
		this._pumpingSessionInput = true;
		let blocked = false;
		try {
			while (!this._disposed && !this._disposing && this.pendingMessageCount > 0) {
				const admission = await this._acquireTurnAdmission();
				try {
					await this.agent.waitForIdle();
					if (epoch !== this._sessionInputPumpEpoch) return;
					await this._agentEventQueue;
					await this._waitForRefineIdle();
					if (this._isSessionInputHandoffDeferred(epoch)) {
						blocked = true;
						return;
					}

					const queue = this._steeringMessages.length > 0 ? this._steeringMessages : this._followUpMessages;
					const mode = queue === this._steeringMessages ? this.steeringMode : this.followUpMode;
					const first = queue[0];
					if (!first) continue;
					const lane: SessionInputSchedule = queue === this._steeringMessages ? "steer" : "followUp";
					if (first.kind === "command") {
						queue.shift();
						this._activeSessionInput = { kind: "command", lane, item: first, phase: "executing" };
						this._notifySessionInputCheckpointChange();
						this._emitQueueUpdate();
						try {
							await this._executeQueuedSessionCommand(first);
							this._settleAgentMessage(first.agentMessageId, "completion");
						} catch (error) {
							this._rejectAgentMessage(first.agentMessageId, this._asError(error));
						} finally {
							this._activeSessionInput = undefined;
							this._notifySessionInputCheckpointChange();
							this._emitQueueUpdate();
						}
						continue;
					}

					const prompts: PreparedPromptInput[] = [];
					while (queue[0]?.kind === "prompt" && (mode === "all" || prompts.length === 0)) {
						prompts.push(queue.shift() as PreparedPromptInput);
					}
					if (epoch !== this._sessionInputPumpEpoch) {
						queue.unshift(...prompts);
						return;
					}
					this._activeSessionInput = {
						kind: "prompt",
						lane,
						items: prompts,
						phase: "preparing",
					};
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
					try {
						await this._startPreparedPromptItems(prompts, epoch, admission.release);
						for (const prompt of prompts) {
							this._settleAgentMessage(prompt.agentMessageId, "completion");
						}
					} catch (error) {
						const delivered = new Set(this.agent.state.messages);
						const undelivered: PreparedPromptInput[] = [];
						for (const prompt of prompts) {
							prompt.prefixMessages = prompt.prefixMessages.filter((message) => !delivered.has(message));
							if (!delivered.has(prompt.message)) undelivered.push(prompt);
						}
						if (this._isDeferredSessionInputError(error, epoch)) {
							if (!this._activeSessionInput?.cancelled && undelivered.length > 0) {
								queue.unshift(...undelivered);
								// Clear ownership before emitting so the requeued items are not
								// double-counted as both owned and queued.
								this._activeSessionInput = undefined;
								this._emitQueueUpdate();
							}
							blocked = true;
							return;
						}
						const terminalError = this._asError(error);
						for (const prompt of undelivered) {
							this._settleAgentMessage(prompt.agentMessageId, "delivery", terminalError);
						}
						for (const prompt of prompts) {
							this._settleAgentMessage(prompt.agentMessageId, "completion", terminalError);
						}
						this._surfaceSessionInputError(error);
					} finally {
						this._activeSessionInput = undefined;
						this._notifySessionInputCheckpointChange();
					}
				} finally {
					admission.release();
				}
			}
		} finally {
			this._pumpingSessionInput = false;
			if (!blocked && epoch === this._sessionInputPumpEpoch && this.pendingMessageCount > 0) {
				this._scheduleSessionInputPump();
			}
		}
	}

	/**
	 * Single busy truth table for turn-admission decision points:
	 * "preflight" is queueIfBusy backpressure before pre-prompt work (streaming checked separately),
	 * "handoff" re-checks adjacent to the agent.prompt() handoff (includes streaming),
	 * "pump" is session-input pump deferral (adds lifecycle and pause state).
	 */
	private _isBusyForSessionInput(
		point: "preflight" | "handoff" | "pump",
		ignoreAcceptedPrompt?: AcceptedAgentMessagePrompt,
	): boolean {
		const busy =
			this.isCompacting ||
			this.isRetrying ||
			this.isBashRunning ||
			this._acceptedPromptCompletions.size > 0 ||
			(this._acceptedAgentMessagePrompt !== undefined && this._acceptedAgentMessagePrompt !== ignoreAcceptedPrompt);
		if (point === "pump") {
			return (
				busy ||
				this._disposed ||
				this._disposing ||
				this._sessionInputPumpSuspended ||
				this._queuedWorkPauses.size > 0 ||
				this._branchSummaryOperation !== undefined
			);
		}
		return busy || this.pendingMessageCount > 0 || (point === "handoff" && this.isStreaming);
	}

	private _isSessionInputHandoffDeferred(epoch: number): boolean {
		return epoch !== this._sessionInputPumpEpoch || this._isBusyForSessionInput("pump");
	}

	private _asError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private _isDeferredSessionInputError(error: unknown, epoch: number): boolean {
		if (error instanceof DeferredSessionInputError) return true;
		if (epoch !== this._sessionInputPumpEpoch) return true;
		if (this._isBusyForSessionInput("pump")) {
			// Requeue, but surface the error: this was not a deliberate deferral.
			this._surfaceSessionInputError(error);
			return true;
		}
		return false;
	}

	private _surfaceSessionInputError(error: unknown): void {
		const normalized = this._asError(error);
		try {
			this._extensionRunner.emitError({
				extensionPath: "<session-input>",
				event: "session_input",
				error: normalized.message,
				stack: normalized.stack,
			});
		} catch {
			// Best-effort: a throwing error listener must not break the pump's requeue path.
		}
	}

	private async _startPreparedPromptItems(
		prompts: PreparedPromptInput[],
		epoch: number,
		releaseAdmission: () => void,
	): Promise<void> {
		await this._validateCanStartAgentRun();
		if (this._isSessionInputHandoffDeferred(epoch)) {
			throw new DeferredSessionInputError("Session input paused before preflight");
		}
		this._flushPendingBashMessages();
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) await this._checkCompaction(lastAssistant, false, false);
		const pendingModelSelectEmit = this._pendingModelSelectEmit();
		if (pendingModelSelectEmit) await pendingModelSelectEmit;

		while (!prompts.every((prompt) => prompt.preparation !== undefined)) {
			if (this._isSessionInputHandoffDeferred(epoch)) {
				throw new DeferredSessionInputError("Session input paused before preparation");
			}
			const preparationPrompt = prompts.at(-1);
			if (!preparationPrompt) return;
			const basePromptSnapshot = this._baseSystemPrompt;
			const result = await this._extensionRunner.emitBeforeAgentStart(
				preparationPrompt.text,
				preparationPrompt.images,
				basePromptSnapshot,
				this._baseSystemPromptOptions,
			);
			if (prompts.at(-1) !== preparationPrompt) continue;
			const preparation = { result, basePromptSnapshot };
			for (const prompt of prompts) prompt.preparation = preparation;
		}
		if (this._isSessionInputHandoffDeferred(epoch)) {
			throw new DeferredSessionInputError("Session input paused before handoff");
		}
		if (prompts.length === 0) return;

		// Re-check adjacent to the handoff: background refine planning may have
		// completed and entered _applyRefine during the awaits above,
		// disconnecting event handling. Wait for it to finish so the new
		// turn's events are not lost.
		await this._waitForRefineIdle();
		if (this._isSessionInputHandoffDeferred(epoch)) {
			throw new DeferredSessionInputError("Session input paused before handoff");
		}
		// Assemble the handoff snapshot only after the last await: a clear that runs
		// during the waits above must still be able to remove prompts from
		// active.items before they are captured for agent.prompt().
		if (prompts.length === 0) return;
		const messages: AgentMessage[] = [];
		const nextTurnMessages = this._pendingNextTurnMessages;
		this._pendingNextTurnMessages = [];
		messages.push(...nextTurnMessages);
		for (const prompt of prompts) {
			messages.push(...prompt.prefixMessages, prompt.message);
			if (prompt.suppressAutonomousContinuation) this._markAutonomousContinuationSuppressed(prompt.message);
		}
		const preparation = prompts[0]?.preparation;
		const result = preparation?.result;
		this._appendBeforeAgentStartMessages(messages, result);
		// The base prompt may have changed (e.g. refine) since preparation; splice the
		// current base into an extension-modified prompt exactly like the direct path.
		this.agent.state.systemPrompt =
			result?.systemPrompt !== undefined && preparation !== undefined
				? this._refreshExtensionSystemPrompt(result.systemPrompt, preparation.basePromptSnapshot)
				: this._baseSystemPrompt;
		try {
			if (this.isStreaming) {
				// agent.prompt() would reject with its already-processing error; defer instead.
				throw new DeferredSessionInputError("Agent became active before session input handoff");
			}
			if (this._activeSessionInput?.kind === "prompt") {
				this._activeSessionInput.phase = "handedOff";
				this._notifySessionInputCheckpointChange();
				this._emitQueueUpdate();
			}
			// The phase flipped to handedOff before dispatch; hold a checkpoint section
			// until dispatch so a restart snapshot cannot miss the accepted messages.
			const endHandoffSection = this._enterDirectPromptSection();
			const dispatchObserver = this._observeDirectDispatch(prompts[prompts.length - 1]!.message);
			const settleHandoffSection = () => {
				dispatchObserver.stop();
				endHandoffSection();
			};
			const promptPromise = this.agent.prompt(messages);
			releaseAdmission();
			void Promise.race([promptPromise.catch(() => undefined), dispatchObserver.observed]).then(
				settleHandoffSection,
				settleHandoffSection,
			);
			await promptPromise;
			await this.waitForRetry();
			await this._agentEventQueue;
			this._forgetConsumedPostCompactionContinuations(prompts.map((prompt) => prompt.message));
		} catch (error) {
			const delivered = new Set(this.agent.state.messages);
			this._pendingNextTurnMessages.unshift(...nextTurnMessages.filter((message) => !delivered.has(message)));
			throw error;
		}
	}

	private async _executeQueuedSessionCommand(input: PreparedCommandInput): Promise<void> {
		this._appendDurableSessionCommandMessage(input.text, input.command, false);
		this._settleAgentMessage(input.agentMessageId, "delivery");
		try {
			let resultText: string | undefined;
			switch (input.command.name) {
				case "compact":
					await this.compact(input.command.args || undefined, { skipAbort: true });
					break;
				case "refine": {
					const options = parseRefineCommandOptions(input.command.args);
					const result = await this.refine(options, { skipAbort: true });
					const applied = result.appliedEdits.filter((edit) => edit.applied).length;
					resultText = `Refined continual harness state: ${applied} edit${applied === 1 ? "" : "s"} applied.`;
					break;
				}
				case "goal":
					await this._handleGoalSlashCommand(input.text, input.images);
					resultText = this._goalState.objective
						? `Goal ${this._goalState.status}: ${this._goalState.objective}`
						: "No active goal.";
					break;
				case "autonomous":
					await this._handleAutonomousSlashCommand(input.text);
					break;
			}
			if (resultText) this._appendDurableSessionCommandMessage(resultText, input.command, true, false);
		} catch (error) {
			// A skipped compaction is benign and already surfaced by compaction_end.
			if (error instanceof CompactionSkippedError) return;
			const commandError = error instanceof Error ? error : new Error(String(error));
			try {
				this._appendDurableSessionCommandMessage(
					`Command failed: ${commandError.message}`,
					input.command,
					true,
					true,
				);
			} catch {
				// Surfacing the command failure matters more than persisting its row.
			}
			throw commandError;
		}
	}

	private _appendDurableSessionCommandMessage(
		content: string,
		command: SessionSlashCommand,
		isResult: boolean,
		isError = false,
	): void {
		const message: CustomMessage = isResult
			? createSessionSlashCommandResultMessage(content, {
					command,
					success: !isError,
					severity: isError ? "error" : "info",
					...(isError ? { error: content.replace(/^Command failed:\s*/, "") } : {}),
				})
			: createSessionSlashCommandMessage(command);
		// Persist before touching live state so a failed write cannot leave an
		// unsaved leaf that the next entry would silently parent onto.
		this.sessionManager.appendCustomMessageEntryWithRollback(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const commandName = parseSlashCommand(text)?.name ?? "";
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			const normalized = normalizeMessageContent(message.content);
			if (options?.deliverAs === "followUp") {
				await this._queuePreparedPrompt("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			} else {
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			}
		} else if (options?.triggerTurn) {
			const admission = await this._acquireDirectTurnAdmission();
			// Hold a checkpoint section from admission until the turn dispatches so
			// an update-restart snapshot cannot miss the admitted custom turn.
			const endDirectPromptSection = this._enterDirectPromptSection();
			const dispatchObserver = this._observeDirectDispatch(appMessage);
			const settleSection = () => {
				dispatchObserver.stop();
				endDirectPromptSection();
			};
			try {
				if (this.isStreaming) await this.agent.waitForIdle();
				await this._waitForRefineIdle();
				const promptPromise = this.agent.prompt(appMessage);
				admission.release();
				void Promise.race([promptPromise.catch(() => undefined), dispatchObserver.observed]).then(
					settleSection,
					settleSection,
				);
				await promptPromise;
			} finally {
				settleSection();
				admission.release();
				this._scheduleSessionInputPump();
			}
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this._prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
			resumeIfIdle: true,
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const active =
			this._activeSessionInput?.kind === "prompt" &&
			this._activeSessionInput.phase === "preparing" &&
			!this._activeSessionInput.cancelled
				? this._activeSessionInput
				: undefined;
		if (active) {
			active.cancelled = true;
			this._sessionInputPumpEpoch++;
			const error = new Error("Queued prompt was cleared before delivery.");
			for (const input of active.items) {
				this._settleAgentMessage(input.agentMessageId, "delivery", error);
				this._settleAgentMessage(input.agentMessageId, "completion", error);
			}
		}
		const activeTexts = active?.items.map((message) => message.text) ?? [];
		const steering = [
			...(active?.lane === "steer" ? activeTexts : []),
			...this._steeringMessages.map((message) => message.text),
		];
		const followUp = [
			...(active?.lane === "followUp" ? activeTexts : []),
			...this._followUpMessages.map((message) => message.text),
		];
		this._rejectQueuedAgentMessageDeliveries(new Error("Queued agent message was cleared before delivery."));
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	private _invalidateQueuedPromptPreparation(): void {
		for (const queue of [this._steeringMessages, this._followUpMessages]) {
			for (const input of queue) {
				if (input.kind === "prompt") input.preparation = undefined;
			}
		}
	}

	private _removeActivePreparingPrompts(predicate: (message: PreparedPromptInput) => boolean): {
		steering: PreparedPromptInput[];
		followUp: PreparedPromptInput[];
	} {
		const active = this._activeSessionInput;
		if (active?.kind !== "prompt" || active.phase !== "preparing") return { steering: [], followUp: [] };
		const removed = active.items.filter(predicate);
		if (removed.length === 0) return { steering: [], followUp: [] };
		const previousAnchor = active.items.at(-1);
		const removedSet = new Set(removed);
		active.items.splice(0, active.items.length, ...active.items.filter((message) => !removedSet.has(message)));
		if (active.items.at(-1) !== previousAnchor) {
			for (const message of active.items) message.preparation = undefined;
		}
		return active.lane === "steer" ? { steering: removed, followUp: [] } : { steering: [], followUp: removed };
	}

	clearQueuedUserMessagesMatching(predicate: (text: string) => boolean): { steering: string[]; followUp: string[] } {
		const steering = this._steeringMessages.filter(
			(message): message is PreparedPromptInput =>
				message.kind === "prompt" && message.agentMessageId !== undefined && predicate(message.text),
		);
		const followUp = this._followUpMessages.filter(
			(message): message is PreparedPromptInput =>
				message.kind === "prompt" && message.agentMessageId !== undefined && predicate(message.text),
		);
		const active = this._removeActivePreparingPrompts(
			(message) => message.agentMessageId !== undefined && predicate(message.text),
		);
		steering.push(...active.steering);
		followUp.push(...active.followUp);
		const accepted = this._acceptedAgentMessagePrompt;
		const acceptedMatches =
			accepted !== undefined && !accepted.turnStarted && !accepted.cleared && predicate(accepted.text);
		if (steering.length === 0 && followUp.length === 0 && !acceptedMatches) return { steering: [], followUp: [] };
		const steeringSet = new Set(steering);
		const followUpSet = new Set(followUp);
		this._steeringMessages = this._steeringMessages.filter(
			(message) => !steeringSet.has(message as PreparedPromptInput),
		);
		this._followUpMessages = this._followUpMessages.filter(
			(message) => !followUpSet.has(message as PreparedPromptInput),
		);
		for (const message of [...steering, ...followUp]) {
			this._rejectAgentMessage(
				message.agentMessageId,
				new Error("Queued agent message was cleared before delivery."),
			);
		}
		const removedSteering = steering.map((message) => message.text);
		const removedFollowUp = followUp.map((message) => message.text);
		if (acceptedMatches) {
			accepted.cleared = true;
			this.agent.state.messages = this.agent.state.messages.filter((message) => !accepted.messages.has(message));
			this._pendingNextTurnMessages.unshift(
				...undeliveredPendingNextTurnMessages(accepted).map((message) => ({ ...message })),
			);
			const error = new Error("Accepted agent message was cleared before delivery.");
			this._rejectAgentMessage(accepted.agentMessageId, error);
			accepted.rejectAccepted(error);
			this.agent.abort();
			removedFollowUp.push(accepted.text);
		}
		this._emitQueueUpdate();
		return { steering: removedSteering, followUp: removedFollowUp };
	}

	/**
	 * Items the pump moved out of the typed queues but has not yet delivered:
	 * prompts still preparing and commands still executing. Once a prompt hands
	 * off it reaches the transcript, so it stops counting as pending.
	 */
	private _undeliveredActiveSessionInputs(lane: SessionInputSchedule): readonly QueuedSessionInput[] {
		const active = this._activeSessionInput;
		if (!active || active.lane !== lane) return [];
		if (active.kind === "command") return [active.item];
		return active.phase === "preparing" && !active.cancelled ? active.items : [];
	}

	private _pendingSessionInputs(lane: SessionInputSchedule): readonly QueuedSessionInput[] {
		const queue = lane === "steer" ? this._steeringMessages : this._followUpMessages;
		const owned = this._undeliveredActiveSessionInputs(lane);
		return owned.length === 0 ? queue : [...owned, ...queue];
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._pendingSessionInputs("steer").length + this._pendingSessionInputs("followUp").length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._pendingSessionInputs("steer").map((message) => message.text);
	}

	getSteeringMessagePreviews(): readonly string[] {
		return this._pendingSessionInputs("steer").map(queuedAgentMessagePreview);
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._pendingSessionInputs("followUp").map((message) => message.text);
	}

	getFollowUpMessagePreviews(): readonly string[] {
		return this._pendingSessionInputs("followUp").map(queuedAgentMessagePreview);
	}

	getSteeringQueueSnapshots(): readonly QueuedAgentInputSnapshot[] {
		return this._pendingSessionInputs("steer").map((message) => createQueuedAgentInputSnapshot(message));
	}

	getFollowUpQueueSnapshots(): readonly QueuedAgentInputSnapshot[] {
		return this._pendingSessionInputs("followUp").map((message) => createQueuedAgentInputSnapshot(message));
	}

	private _notifySessionInputCheckpointChange(): void {
		for (const resolve of this._sessionInputCheckpointWaiters) resolve();
		this._sessionInputCheckpointWaiters.clear();
	}

	/**
	 * Marks a direct prompt as being between admission and its preflight outcome
	 * (queued, handed off to the agent, or failed). Restart checkpoints wait for
	 * these sections so an accepted input cannot fall between the queue snapshot
	 * and the transcript flush.
	 */
	private _enterDirectPromptSection(): () => void {
		this._directPromptSectionCount++;
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this._directPromptSectionCount--;
			this._notifySessionInputCheckpointChange();
		};
	}

	async waitForSessionInputCheckpoint(signal?: AbortSignal): Promise<void> {
		// An executing command was already shifted off the queue; the snapshot
		// must wait for it or it vanishes from durable queued input.
		while (
			(this._activeSessionInput?.kind === "prompt" && this._activeSessionInput.phase === "preparing") ||
			this._activeSessionInput?.kind === "command" ||
			this._directPromptSectionCount > 0
		) {
			if (signal?.aborted) throw new Error("Update restart preparation cancelled");
			await new Promise<void>((resolve, reject) => {
				const onChange = () => {
					cleanup();
					resolve();
				};
				const onAbort = () => {
					cleanup();
					reject(new Error("Update restart preparation cancelled"));
				};
				const cleanup = () => {
					this._sessionInputCheckpointWaiters.delete(onChange);
					signal?.removeEventListener("abort", onAbort);
				};
				this._sessionInputCheckpointWaiters.add(onChange);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		if (signal?.aborted) throw new Error("Update restart preparation cancelled");
		// Handed-off inputs reach the transcript through the event queue; drain the
		// current snapshot so the flush below persists them before the snapshot is taken.
		await waitForPromiseOrAbort(this._agentEventQueue, signal, "Update restart preparation cancelled");
		if (signal?.aborted) throw new Error("Update restart preparation cancelled");
		this.sessionManager.flushNow();
	}

	acquireQueuedWorkPause(): { release(): void } {
		const token = Symbol("queued-work-pause");
		this._queuedWorkPauses.add(token);
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this._queuedWorkPauses.delete(token);
				if (this._queuedWorkPauses.size === 0) this._wakeQueuedWorkAdmissionWaiters();
				this._scheduleSessionInputPump();
			},
		};
	}

	private _wakeQueuedWorkAdmissionWaiters(): void {
		for (const resolve of this._queuedWorkAdmissionWaiters) resolve();
		this._queuedWorkAdmissionWaiters.clear();
	}

	private _assertDirectTurnAdmissionAvailable(): void {
		if (this._disposed || this._disposing) {
			throw new Error("Cannot start a direct turn because the session is disposing or disposed.");
		}
		if (this.pendingMessageCount > 0 && this._sessionInputPumpSuspended) {
			throw new Error("Cannot start a direct turn while queued session input is suspended.");
		}
	}

	private async _acquireTurnAdmission(signal?: AbortSignal): Promise<{ owner: symbol; release(): void }> {
		const inheritedOwner = this._turnAdmissionContext.getStore();
		if (inheritedOwner !== undefined && inheritedOwner === this._turnAdmissionOwner) {
			return { owner: inheritedOwner, release: () => {} };
		}
		const previous = this._turnAdmissionTail;
		let resolve = () => {};
		this._turnAdmissionTail = new Promise<void>((release) => {
			resolve = release;
		});
		try {
			await waitForPromptAdmission(previous, signal);
		} catch (error) {
			// Keep this cancelled waiter in the FIFO chain until its predecessor
			// releases; resolving immediately would let a later caller bypass the
			// current admission owner.
			void previous.then(resolve, resolve);
			throw error;
		}
		const owner = Symbol("turn-admission");
		this._turnAdmissionOwner = owner;
		let released = false;
		return {
			owner,
			release: () => {
				if (released) return;
				released = true;
				if (this._turnAdmissionOwner === owner) this._turnAdmissionOwner = undefined;
				resolve();
			},
		};
	}

	private async _acquireDirectTurnAdmission(
		options: { allowStreaming?: boolean; allowPendingQueue?: boolean; signal?: AbortSignal } = {},
	): Promise<{ owner: symbol; release(): void }> {
		while (true) {
			this._assertDirectTurnAdmissionAvailable();
			await this._waitForQueuedWorkAdmission(options.signal);
			this._assertDirectTurnAdmissionAvailable();
			if (this.pendingMessageCount > 0) this._scheduleSessionInputPump();
			const admission = await this._acquireTurnAdmission(options.signal);
			try {
				this._assertDirectTurnAdmissionAvailable();
				if (this._queuedWorkPauses.size > 0) {
					admission.release();
					await this._waitForQueuedWorkAdmission(options.signal);
					continue;
				}
				// queueIfBusy callers enqueue behind pending work at preflight; they need ownership, not a drained queue.
				if (
					(options.allowStreaming === true && this.isStreaming) ||
					options.allowPendingQueue === true ||
					(this.pendingMessageCount === 0 &&
						this._activeSessionInput === undefined &&
						!this._pumpingSessionInput &&
						!this._sessionInputPumpRequested)
				) {
					// This is the ownership commit point: no prompt/session state has
					// been consumed yet, and from here the session owns delivery.
					throwIfPromptAdmissionCancelled(options.signal);
					return admission;
				}
			} catch (error) {
				admission.release();
				throw error;
			}
			admission.release();
			await waitForPromptAdmission(this.waitForSessionInputIdle(), options.signal);
			this._assertDirectTurnAdmissionAvailable();
		}
	}

	private async _waitForQueuedWorkAdmission(signal?: AbortSignal): Promise<void> {
		while (this._queuedWorkPauses.size > 0) {
			this._assertDirectTurnAdmissionAvailable();
			let wake = () => {};
			const wait = new Promise<void>((resolve) => {
				wake = resolve;
				this._queuedWorkAdmissionWaiters.add(resolve);
			});
			try {
				await waitForPromptAdmission(wait, signal);
			} finally {
				this._queuedWorkAdmissionWaiters.delete(wake);
			}
			this._assertDirectTurnAdmissionAvailable();
		}
	}

	/** Resume the scheduler after requestAbort/abortForUpdateRestart suspended it; owned pause leases are unaffected. */
	resumeQueuedWork(): boolean {
		this._sessionInputPumpSuspended = false;
		this._scheduleSessionInputPump();
		return this.pendingMessageCount > 0;
	}

	async waitForSessionInputIdle(): Promise<void> {
		while (true) {
			const pump = this._sessionInputPump;
			await pump;
			if (pump === this._sessionInputPump && !this._sessionInputPumpRequested && !this._pumpingSessionInput) return;
		}
	}

	async waitForIdle(): Promise<void> {
		while (true) {
			const pump = this._sessionInputPump;
			const acceptedPrompts = [...this._acceptedPromptCompletions];
			await Promise.all([pump, ...acceptedPrompts]);
			await this.agent.waitForIdle();
			if (
				pump === this._sessionInputPump &&
				acceptedPrompts.length === this._acceptedPromptCompletions.size &&
				acceptedPrompts.every((completion) => this._acceptedPromptCompletions.has(completion)) &&
				!this._sessionInputPumpRequested &&
				!this._pumpingSessionInput &&
				!this.agent.state.isStreaming &&
				this._acceptedAgentMessagePrompt === undefined
			) {
				return;
			}
		}
	}

	getPendingNextTurnMessageSnapshots(): readonly CustomMessage[] {
		const messages = this._pendingNextTurnMessages.map((message) => cloneCustomMessage(message));
		const accepted = this._acceptedAgentMessagePrompt;
		if (accepted && !accepted.cleared && accepted.turnStarted) {
			messages.push(...undeliveredPendingNextTurnMessages(accepted).map((message) => cloneCustomMessage(message)));
		}
		return messages;
	}

	getAcceptedPromptSnapshot(): AcceptedAgentInputSnapshot | undefined {
		const accepted = this._acceptedAgentMessagePrompt;
		if (!accepted || accepted.cleared || accepted.turnStarted) {
			return undefined;
		}
		return {
			...createQueuedAgentInputSnapshotFromUserMessage(accepted.text, accepted.message),
			agentMessageId: accepted.agentMessageId,
			nextTurn: undeliveredPendingNextTurnMessages(accepted).map((message) => cloneCustomMessage(message)),
		};
	}

	restorePendingNextTurnMessages(messages: readonly CustomMessage[]): void {
		this._pendingNextTurnMessages.push(...messages.map((message) => cloneCustomMessage(message)));
	}

	hasQueuedFollowUp(queueKey: string): boolean {
		return (
			this._followUpMessages.some((message) => message.queueKey === queueKey) ||
			this._activePendingPromptWithQueueKey(queueKey) !== undefined
		);
	}

	/**
	 * The active-input prompt owning `queueKey` while it still counts as
	 * pending. Once handed off it belongs to the running turn, so a same-key
	 * follow-up must queue for the next turn instead of coalescing away.
	 */
	private _activePendingPromptWithQueueKey(queueKey: string): PreparedPromptInput | undefined {
		const active = this._activeSessionInput;
		if (active?.kind !== "prompt" || active.phase !== "preparing" || active.cancelled) return undefined;
		return active.items.find((item) => item.queueKey === queueKey);
	}

	removeQueuedFollowUp(queueKey: string): boolean {
		const removedSteering = this._steeringMessages.filter(
			(message): message is PreparedPromptInput => message.kind === "prompt" && message.queueKey === queueKey,
		);
		const removedFollowUp = this._followUpMessages.filter(
			(message): message is PreparedPromptInput => message.kind === "prompt" && message.queueKey === queueKey,
		);
		const active = this._removeActivePreparingPrompts((message) => message.queueKey === queueKey);
		removedSteering.push(...active.steering);
		removedFollowUp.push(...active.followUp);
		if (removedSteering.length === 0 && removedFollowUp.length === 0) return false;
		const removed = new Set<QueuedSessionInput>([...removedSteering, ...removedFollowUp]);
		this._steeringMessages = this._steeringMessages.filter((message) => !removed.has(message));
		this._followUpMessages = this._followUpMessages.filter((message) => !removed.has(message));
		for (const message of removed) {
			this._rejectAgentMessage(
				message.agentMessageId,
				new Error("Queued agent message was cleared before delivery."),
			);
		}
		this._emitQueueUpdate();
		return true;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	requestAbort(): void {
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._cancelPostCompactionContinue();
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		this.abortBash();
		this._pendingRequestedRefine = undefined;
		this._autoRefineBranchVersion++;
		this._autoRefineReviewAbort?.abort();
		this._refineAbortController?.abort();
		this.agent.abort();
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		const compactionOperation = this._compactionOperation;
		const branchSummaryOperation = this._branchSummaryOperation;
		this.requestAbort();
		this._cancelActiveRlmChildRuns("Parent session aborted");
		this._goalAbortInProgress = this._goalState.status === "active";
		try {
			await Promise.allSettled([
				this.agent.waitForIdle(),
				this._agentEventQueue,
				...(compactionOperation ? [compactionOperation] : []),
				...(branchSummaryOperation ? [branchSummaryOperation] : []),
			]);
		} finally {
			this._goalAbortInProgress = false;
		}
	}

	abortForUpdateRestart(): void {
		// Cancel scheduled pumps and suspend new ones: queued inputs must survive
		// into the restart manifest instead of starting a turn during teardown.
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._cancelPostCompactionContinue();
		this.abortRetry();
		this._cancelActiveRlmChildRuns("Parent session aborted for update restart");
		this._goalAbortInProgress = this._goalState.status === "active";
		this.agent.abort();
		if (this._goalAbortInProgress) {
			void this.agent
				.waitForIdle()
				.then(() => this._agentEventQueue)
				.catch(() => undefined)
				.finally(() => {
					this._goalAbortInProgress = false;
				});
		}
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	private _queueModelSelectEmit(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		const emit = () =>
			this._modelSelectEmitContext.run(true, () => this._emitModelSelect(nextModel, previousModel, source));
		this._modelSelectEmitQueueIdle = false;
		const promise = this._modelSelectEmitQueue.then(emit, emit);
		const queued = promise.catch(() => {});
		this._modelSelectEmitQueue = queued;
		void queued.finally(() => {
			if (this._modelSelectEmitQueue === queued) {
				this._modelSelectEmitQueueIdle = true;
			}
		});
		return promise;
	}

	/**
	 * Set model directly.
	 * Validates that the model is available, saves to session and settings.
	 * @throws Error if the model is not available
	 */
	async setModel(model: Model<any>, options: ModelSelectOptions = {}): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		if (!(await this._modelRegistry.canUseModel(model))) {
			throw new Error(`Model "${model.provider}/${model.id}" is not available for the current Prime team.`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(model, previousModel, "set");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}
	}

	private _trackModelSelectEmitError(emitPromise: Promise<void>): void {
		void emitPromise.catch((error) => {
			this._extensionRunner.emitError({
				extensionPath: "<internal>",
				event: "model_select",
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		});
	}

	private _shouldWaitForModelSelectEmit(options: ModelSelectOptions): boolean {
		return options.waitForExtensions !== false && !this._modelSelectEmitContext.getStore();
	}

	private _pendingModelSelectEmit(): Promise<void> | undefined {
		if (!this._modelSelectEmitContext.getStore() && !this._modelSelectEmitQueueIdle) {
			return this._modelSelectEmitQueue;
		}
		return undefined;
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelSelectOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.refreshAvailableModels();
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableModels.some((model) => modelsAreEqual(model, scoped.model)),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
		const serviceTier = this._getServiceTierForModelSwitch();

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(next.model, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return { model: next.model, thinkingLevel: this.thinkingLevel, serviceTier: this.serviceTier, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.refreshAvailableModels();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(nextModel, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return { model: nextModel, thinkingLevel: this.thinkingLevel, serviceTier: this.serviceTier, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	setServiceTier(serviceTier: ServiceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		const preferenceChanged = effectiveServiceTier !== this._serviceTierPreference;
		const effectiveTierChanged = effectiveServiceTier !== this.agent.state.serviceTier;
		if (!preferenceChanged && !effectiveTierChanged) {
			return;
		}
		this._serviceTierPreference = effectiveServiceTier;
		if (preferenceChanged) {
			this.sessionManager.appendServiceTierChange(effectiveServiceTier);
			if (this.model && supportsFastMode(this.model)) {
				this.settingsManager.setDefaultServiceTier(effectiveServiceTier);
			}
		}
		if (effectiveTierChanged) {
			this.agent.state.serviceTier = effectiveServiceTier;
			this._emit({ type: "service_tier_changed", serviceTier: effectiveServiceTier });
		}
	}

	private _getEffectiveServiceTier(serviceTier: ServiceTier): ServiceTier {
		return serviceTier === "priority" && (!this.model || !supportsFastMode(this.model)) ? "default" : serviceTier;
	}

	private _getServiceTierForModelSwitch(): ServiceTier {
		return this._serviceTierPreference;
	}

	private _clampServiceTierForModel(serviceTier: ServiceTier = this.serviceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		if (effectiveServiceTier === this.agent.state.serviceTier) {
			return;
		}
		this.agent.state.serviceTier = effectiveServiceTier;
		this._emit({ type: "service_tier_changed", serviceTier: effectiveServiceTier });
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// Added to history (not a nextTurn message) so it also reaches the continue()-driven
	// auto-compaction resume, which never injects nextTurn messages.
	private async _notifyKernelStateAfterCompaction(): Promise<void> {
		const provisioner = this._ipythonKernelProvisioner;
		// No kernel means no state to remind about; only stay silent in that case.
		if (!provisioner?.hasRunningKernel) return;
		// Bound the probe so a wedged kernel can't stall recovery, and abort it on timeout so
		// the kernel's serialized execution queue isn't left occupied by a never-resolving cell.
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), KERNEL_STATE_LISTING_TIMEOUT_MS);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		let names: string[] | null;
		try {
			names = await provisioner.listNamespaceNames(abort.signal).catch(() => null);
		} finally {
			clearTimeout(timer);
		}
		// null is a listing failure/timeout; only claim state survived if the kernel is still up
		// (it may have died in the window since the check above).
		if (names === null && !provisioner.hasRunningKernel) return;
		const detail =
			names === null
				? ""
				: names.length > 0
					? ` These names are still defined: ${names.join(", ")}.`
					: " You have not defined any names yet.";
		const content = [
			"<ipython_state>",
			`Your IPython kernel persisted through compaction; all variables, imports, and helpers you defined remain available.${detail}`,
			"</ipython_state>",
		].join("\n");
		const message = {
			role: "custom" as const,
			customType: "ipython_state",
			content,
			display: false,
			timestamp: Date.now(),
		} satisfies CustomMessage;
		// Insert before a trailing assistant error so overflow-retry cleanup can still strip it.
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		const insertBeforeError = last?.role === "assistant" && (last as AssistantMessage).stopReason === "error";
		if (insertBeforeError) {
			messages.splice(messages.length - 1, 0, message);
		} else {
			messages.push(message);
		}
		this.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, undefined);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * Tell the model when a resumed session revived its IPython kernel state, so it
	 * knows which variables are actually available instead of assuming the kernel is
	 * the one it left. Delivered as context before the next turn.
	 */
	private _onIpythonStateRestored(result: RestoreResult): void {
		const lines = ["<ipython_state_restored>"];
		if (result.restored.length > 0) {
			lines.push(
				`Your IPython kernel state was revived from your previous session. These names are available again: ${result.restored.join(", ")}.`,
			);
		} else {
			lines.push(
				"Your previous IPython kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.",
			);
		}
		if (result.failed.length > 0) {
			lines.push(
				`These could not be restored and must be recreated if needed: ${result.failed.map((f) => f.name).join(", ")}.`,
			);
		}
		lines.push("</ipython_state_restored>");
		void this.sendCustomMessage(
			{
				customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
				content: lines.join("\n"),
				display: true,
				details: { restored: result.restored.length > 0 },
			},
			{ deliverAs: "nextTurn" },
		).catch(() => {});
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string, options: { skipAbort?: boolean } = {}): Promise<CompactionResult> {
		if (options.skipAbort && this.isStreaming) {
			throw new Error("Cannot compact without aborting while the agent is running.");
		}
		const hadPostCompactionContinue = this._postCompactionContinuationScheduled;
		this._disconnectFromAgent();
		if (!options.skipAbort) await this.abort();
		let didCompact = false;
		this._compactionAbortController = new AbortController();
		let resolveCompactionOperation: () => void = () => {};
		const compactionOperation = new Promise<void>((resolve) => {
			resolveCompactionOperation = resolve;
		});
		this._compactionOperation = compactionOperation;
		this._emit({ type: "compaction_start", reason: "manual", customInstructions });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers } = await this._getRequiredRequestAuth(this.model);
			const result = await this._performCompaction({
				model: this.model,
				apiKey,
				headers,
				customInstructions,
				signal: this._compactionAbortController.signal,
			});

			this._emit({
				type: "compaction_end",
				reason: "manual",
				result,
				aborted: false,
				willRetry: false,
				customInstructions,
			});
			didCompact = true;
			// A manual compaction satisfies any pending model request; on failure the
			// request stays scheduled for the next turn boundary.
			this._pendingRequestedCompaction = undefined;
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const skipped = error instanceof CompactionSkippedError;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : skipped ? message : `Compaction failed: ${message}`,
				errorSeverity: skipped ? "warning" : "error",
				customInstructions,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
			if (this._compactionOperation === compactionOperation) {
				this._compactionOperation = undefined;
			}
			resolveCompactionOperation();
			this._scheduleSessionInputPump();
			if (didCompact) {
				this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
				if (hadPostCompactionContinue) {
					this._schedulePostCompactionContinue();
				}
				// Queued agent or session-owned inputs resume the loop; defer refine
				// behind them instead of interleaving it before their turns.
				this._scheduleAutoRefineAfterCompaction(
					hadPostCompactionContinue || this.agent.hasQueuedMessages() || this.pendingMessageCount > 0,
				);
			}
		}
	}

	/**
	 * Shared compaction core behind /compact, auto-compaction, and the compact
	 * skill. Throws CompactionSkippedError when there is nothing to compact and
	 * Error("Compaction cancelled") on abort or extension cancel.
	 */
	private async _performCompaction(options: {
		model: Model<any>;
		apiKey: string;
		headers?: Record<string, string>;
		customInstructions?: string;
		signal: AbortSignal;
	}): Promise<CompactionResult> {
		const { model, apiKey, headers, customInstructions, signal } = options;
		const pathEntries = this.sessionManager.getBranch();
		const settings = this.settingsManager.getCompactionSettings();

		const preparation = prepareCompaction(pathEntries, settings);
		if (!preparation) {
			const lastEntry = pathEntries[pathEntries.length - 1];
			if (lastEntry?.type === "compaction") {
				throw new CompactionSkippedError("Already compacted");
			}
			throw new CompactionSkippedError("Session is too short to compact — try again once it grows");
		}

		let extensionCompaction: CompactionResult | undefined;
		let fromExtension = false;

		if (this._extensionRunner.hasHandlers("session_before_compact")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_compact",
				preparation,
				branchEntries: pathEntries,
				customInstructions,
				signal,
			})) as SessionBeforeCompactResult | undefined;

			if (result?.cancel) {
				throw new Error("Compaction cancelled");
			}

			if (result?.compaction) {
				extensionCompaction = result.compaction;
				fromExtension = true;
			}
		}

		const { summary, firstKeptEntryId, tokensBefore, details } =
			extensionCompaction ??
			(await compact(preparation, model, apiKey, headers, customInstructions, signal, this.thinkingLevel));

		if (signal.aborted) {
			throw new Error("Compaction cancelled");
		}

		this.sessionManager.appendCompaction(
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromExtension,
			customInstructions,
		);
		const newEntries = this.sessionManager.getEntries();
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		this._mergeUnpersistedCompactionOutcomes(this.agent.state.messages);
		this._restoreLateIpythonSentAgentMessages();

		// Get the saved compaction entry for the extension event
		const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
			| CompactionEntry
			| undefined;
		if (savedCompactionEntry) {
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
		}
		await this._notifyKernelStateAfterCompaction();

		return { summary, firstKeptEntryId, tokensBefore, details };
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	private _localHarnessStateDir(): string | undefined {
		return (
			getLocalHarnessStateDir(this.sessionManager.getSessionArtifactDir()) ??
			(this._rlmSessionDir ? getLocalHarnessStateDir(this._rlmSessionDir) : undefined)
		);
	}

	private _autoRefineAllowedForSession(): boolean {
		return this._rlmDepth === 0 && this._localHarnessStateDir() !== undefined;
	}

	private _cancelPostCompactionContinue(): void {
		if (this._postCompactionContinuationTimer) {
			clearTimeout(this._postCompactionContinuationTimer);
			this._postCompactionContinuationTimer = undefined;
		}
		this._postCompactionContinuationScheduled = false;
		this._scheduledPostCompactionContinuationMessages = [];
	}

	private _discardPendingAutoRefine(options: { cancelPostCompactionContinue?: boolean } = {}): void {
		this._compactAutoRefinePending = false;
		this._turnIntervalAutoRefinePending = false;
		this._pendingAutoRefineReview = undefined;
		if (options.cancelPostCompactionContinue) {
			this._cancelPostCompactionContinue();
		}
	}

	private async _invalidatePendingAutoRefineForBranchChange(): Promise<void> {
		this._autoRefineReviewAbort?.abort();
		this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		this._assistantTurnsSinceAutoRefine = 0;
		// Increment branch version BEFORE aborting/awaiting the serialized plan.
		// This invalidates the plan's branchVersion check at the boundary
		// so even if the plan completes, the boundary will reject it
		// (bgResult.branchVersion !== this._autoRefineBranchVersion).
		this._autoRefineBranchVersion++;
		// Abort the in-flight refine/bplan controller so any pending
		// _planRefine or _reviewAutoRefine call settles via signal abort
		// rather than hanging forever.
		this._refineAbortController?.abort();
		// Await and clear serialized background plan if in flight.
		if (this._serializedPlanInFlight) {
			await this._consumeSerializedBackgroundPlan(async () => false);
		}
		while (this._refinePlanInFlight) {
			await this._refinePlanInFlight;
		}
		await this._waitForRefineIdle();
	}

	/**
	 * Consume a refine request that was scheduled by the agent-callable refine
	 * skill (refine.run). Fire-and-forget: the refine() method handles its own
	 * background planning, idle wait, application, and error recovery. Called
	 * at the turn boundary after compaction checks and before auto-refine
	 * scheduling so the manual request takes priority.
	 */
	private _emitRefineFailed(error: unknown): void {
		this._emit({
			type: "refine_failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	private _consumePendingRequestedRefine(): boolean {
		const pending = this._pendingRequestedRefine;
		if (!pending) return false;
		this._pendingRequestedRefine = undefined;
		void this.refine(pending).catch((error) => this._emitRefineFailed(error));
		return true;
	}

	private _scheduleAutoRefineAfterAgentEnd(): void {
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		if (this._pendingAutoRefineReview) {
			this._scheduleAutoRefine(this._pendingAutoRefineReview.reason);
			return;
		}
		if (this._compactAutoRefinePending) {
			if (this._postCompactionContinuationScheduled) {
				return;
			}
			this._scheduleAutoRefine("compact");
			return;
		}

		this._scheduleAutoRefine("turn_interval");
	}

	private _scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void {
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		if (this._serializedRefine) {
			// Serialized sessions must service compaction-triggered refinement at
			// shouldStopAfterTurn (or disposal), never through the interactive path.
			this._compactAutoRefinePending = true;
			return;
		}
		if (willContinueAfterCompaction) {
			this._compactAutoRefinePending = true;
			return;
		}

		this._scheduleAutoRefine("compact");
	}

	private _schedulePostCompactionContinue(): void {
		if (this._postCompactionContinuationScheduled) {
			return;
		}
		this._postCompactionContinuationScheduled = true;
		this._scheduledPostCompactionContinuationMessages = [...this._postCompactionContinuationMessages];
		this._postCompactionContinuationTimer = setTimeout(() => {
			this._postCompactionContinuationTimer = undefined;
			void this._runScheduledPostCompactionContinue();
		}, 100);
	}

	/** Whether any snapshot of scheduled continuation messages is still session-owned. */
	private _sessionOwnsScheduledContinuations(continuationMessages: AgentMessage[]): boolean {
		return continuationMessages.some((message) => this._postCompactionContinuationMessages.includes(message));
	}

	private async _runScheduledPostCompactionContinue(): Promise<void> {
		await this._waitForRefineIdle();
		if (!this._postCompactionContinuationScheduled) {
			return;
		}
		if (this.isStreaming || this.isCompacting || this.isRetrying || this._queuedWorkPauses.size > 0) {
			this._postCompactionContinuationScheduled = false;
			this._schedulePostCompactionContinue();
			return;
		}

		const continuationMessages = [...this._scheduledPostCompactionContinuationMessages];
		if (continuationMessages.length > 0 && !this._sessionOwnsScheduledContinuations(continuationMessages)) {
			this._cancelPostCompactionContinue();
			this._scheduleAutoRefineAfterAgentEnd();
			return;
		}
		// An empty queue is not idle: the pump owns items moved into _activeSessionInput before handoff.
		if (
			this.pendingMessageCount > 0 ||
			this._activeSessionInput !== undefined ||
			this._pumpingSessionInput ||
			this._sessionInputPumpRequested
		) {
			this._scheduleSessionInputPump();
			await this._sessionInputPump;
			if (this._postCompactionContinuationScheduled) {
				this._postCompactionContinuationScheduled = false;
				const shouldReschedule =
					continuationMessages.length === 0
						? this.pendingMessageCount > 0
						: this._sessionOwnsScheduledContinuations(continuationMessages);
				if (shouldReschedule) {
					this._schedulePostCompactionContinue();
				} else {
					this._scheduledPostCompactionContinuationMessages = [];
					this._scheduleAutoRefineAfterAgentEnd();
				}
			}
			return;
		}

		this._postCompactionContinuationScheduled = false;
		try {
			await this.agent.continue();
			this._forgetConsumedPostCompactionContinuations(continuationMessages);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("already processing")) {
				this._schedulePostCompactionContinue();
			}
		}
	}

	private _forgetConsumedPostCompactionContinuations(continuationMessages: AgentMessage[]): void {
		if (continuationMessages.length === 0) {
			return;
		}
		const continuationMessageSet = new Set(continuationMessages);
		const stillQueued = new Set(this.agent.removeQueuedMessages((message) => continuationMessageSet.has(message)));
		for (const message of stillQueued) {
			this.agent.followUp(message);
		}
		for (const message of continuationMessages) {
			if (!stillQueued.has(message)) {
				this._queuedAutonomousContinuationSnapshots.delete(message);
			}
		}
		this._postCompactionContinuationMessages = this._postCompactionContinuationMessages.filter(
			(message) => !continuationMessageSet.has(message) || stillQueued.has(message),
		);
	}

	private _shouldSkipAutoRefineForActiveAgent(): boolean {
		return this.isStreaming || this.isCompacting;
	}

	private _scheduleDeferredAutoRefineIfIdle(): void {
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent() || this._pendingAutoRefineReview) {
			return;
		}
		if (this._turnIntervalAutoRefinePending) {
			this._turnIntervalAutoRefinePending = false;
			this._scheduleAutoRefine("turn_interval");
		}
	}

	private _scheduleAutoRefine(reason: AutoRefineReason, branchVersion = this._autoRefineBranchVersion): void {
		const timer = setTimeout(() => {
			this._scheduledAutoRefineTimers.delete(timer);
			if (branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			const operation = this._maybeAutoRefine(reason);
			this._autoRefineOperations.add(operation);
			void operation.finally(() => this._autoRefineOperations.delete(operation)).catch(() => undefined);
		}, 0);
		this._scheduledAutoRefineTimers.add(timer);
	}

	private async _maybeAutoRefine(reason: AutoRefineReason): Promise<void> {
		if (this._disposed || this._disposing) {
			this._discardPendingAutoRefine();
			return;
		}
		if (!this._autoRefineAllowedForSession()) {
			this._discardPendingAutoRefine();
			return;
		}

		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._discardPendingAutoRefine();
			return;
		}
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent()) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}

		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;

		const pendingReview = this._pendingAutoRefineReview;
		if (pendingReview) {
			// A failed refine stamps the cooldown; keep the pending review for later.
			if (underCooldown) {
				return;
			}
			await this._runApprovedRefine(pendingReview.reason, pendingReview.review);
			return;
		}

		if (reason === "compact" && !settings.compact) {
			this._compactAutoRefinePending = false;
			reason = "turn_interval";
		}
		if (reason === "turn_interval" && this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		if (underCooldown) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}
		if (reason === "turn_interval") {
			this._turnIntervalAutoRefinePending = false;
		}
		if (!this.model) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			}
			return;
		}
		this._autoRefineInProgress = true;
		const turnsSinceLastReview = this._assistantTurnsSinceAutoRefine;
		const branchVersion = this._autoRefineBranchVersion;
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		let approvedReview: AutoRefineReview | undefined;
		try {
			const review = await this._reviewAutoRefine({ reason, turnsSinceLastReview }, reviewAbort.signal);
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				const preserveTurnIntervalReview =
					reason === "compact" && this._assistantTurnsSinceAutoRefine >= settings.turnInterval;
				if (preserveTurnIntervalReview) {
					this._turnIntervalAutoRefinePending = true;
				} else {
					this._lastAutoRefineReviewAt = nowMs;
					this._assistantTurnsSinceAutoRefine = 0;
				}
				if (reason === "compact") {
					this._compactAutoRefinePending = false;
				}
				return;
			}
			if (this._shouldSkipAutoRefineForActiveAgent()) {
				this._pendingAutoRefineReview = { reason, review };
				return;
			}
			approvedReview = review;
		} catch {
			// Failed review: stamp the cooldown so a persistent failure (bad auth,
			// unparseable output) doesn't retry a full review on every agent end.
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
			// When a refine follows, _runApprovedRefine schedules the deferred pass.
			if (!approvedReview) {
				this._scheduleDeferredAutoRefineIfIdle();
			}
		}
		if (approvedReview) {
			await this._runApprovedRefine(reason, approvedReview);
		}
	}

	private async _runApprovedRefine(reason: AutoRefineReason, review: AutoRefineReview): Promise<void> {
		this._autoRefineInProgress = true;
		try {
			await this.refine({ instructions: autoRefineInstructions(reason, review) });
			this._pendingAutoRefineReview = undefined;
			this._turnIntervalAutoRefinePending = false;
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			if (reason === "compact") {
				this._compactAutoRefinePending = false;
			}
		} catch {
			// Auto-refine is opportunistic; manual /refine remains available.
			// Stamp the cooldown so a persistently failing refine doesn't retry
			// (via a retained pending review) on every agent end.
			this._lastAutoRefineReviewAt = Date.now();
		} finally {
			this._autoRefineInProgress = false;
			this._scheduleDeferredAutoRefineIfIdle();
		}
	}

	private async _reviewAutoRefine(context: AutoRefineReviewRequest, signal?: AbortSignal): Promise<AutoRefineReview> {
		if (this._autoRefineReviewer) {
			return this._autoRefineReviewer(context, signal);
		}
		const model = this.model;
		if (!model) {
			return { shouldRefine: false, rationale: "No model selected." };
		}
		const { apiKey, headers } = await this._getRequiredRequestAuth(model);
		return reviewAutoRefine(
			this.agent.state.messages,
			this._loadMergedHarnessState(),
			this._loadRefinementHistory(),
			model,
			apiKey,
			context,
			headers,
			signal,
			this.thinkingLevel,
		);
	}

	/** Global harness state overlaid with this session's local state, when persisted. */
	private _loadMergedHarnessState(): HarnessState {
		const localHarnessStateDir = this._localHarnessStateDir();
		return mergeHarnessStates(
			loadHarnessState(getGlobalHarnessStateDir(), "global"),
			localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined,
		);
	}

	private _loadRefinementHistory(): RefinementResult[] {
		return mergeRefinementHistory(
			loadGlobalRefinementHistory(getGlobalHarnessStateDir()),
			getRefinementHistory(this.sessionManager.getEntries().filter((entry) => entry.type === "custom")),
		);
	}

	/**
	 * Refine editable continual harness state: prompt notes, memory, skills, and subagent specs.
	 * The base system prompt is intentionally not editable through this path.
	 *
	 * Planning runs in the background and does NOT block turn entry points
	 * (`_waitForRefineIdle` only waits for `_refineInFlight`). Only the fast
	 * application phase (disk I/O + in-memory mutation) blocks turn entry points.
	 */
	async refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
		internal: { skipAbort?: boolean } = {},
	): Promise<RefinementResult> {
		// Queued /refine executes from the session-input pump between turns;
		// refine never aborts the agent (planning is backgrounded and the apply
		// phase waits for quiescence), so skipAbort only asserts the pump's
		// idle invariant instead of changing abort behavior.
		if (internal.skipAbort && this.isStreaming) {
			throw new Error("Cannot refine without aborting while the agent is running.");
		}
		// Wait for any existing refine (both planning and application) before
		// starting a new run. This serializes concurrent /refine calls so two
		// planning phases cannot race into concurrent _applyRefine calls that
		// overwrite harness state.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else {
				// A serialized background plan is in flight (started during an
				// active turn at message_end). Wait for planning and for the active
				// turn to settle so its normal checkpoint can consume the plan.
				const serializedPlanInFlight = this._serializedPlanInFlight;
				await serializedPlanInFlight;
				if (this._refineInFlight || this._refinePlanInFlight) {
					continue;
				}
				await this.agent.waitForIdle();
				// Aborted turns skip shouldStopAfterTurn. Drop their settled plan
				// after idle so a later public refine cannot spin on it forever.
				if (this._serializedPlanInFlight === serializedPlanInFlight) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			}
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		// Background planning phase — does NOT block turn entry points
		const planRun = this._planRefine(options, refineAbort.signal);
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (e) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			throw e;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		// Block new turns before waiting for the current turn to finish. One shared
		// settled promise covers the full transition and apply critical section.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			// Wait for the session to become quiescent before applying. Planning is
			// allowed to overlap active user work, but application must not disconnect
			// event handling until that work and its queued events have completed.
			await this.agent.waitForIdle();
			while (true) {
				const eventQueue = this._agentEventQueue;
				const compactionOp = this._compactionOperation;
				const branchSummaryOp = this._branchSummaryOperation;
				await Promise.allSettled([
					eventQueue,
					...(compactionOp ? [compactionOp] : []),
					...(branchSummaryOp ? [branchSummaryOp] : []),
				]);
				if (
					eventQueue === this._agentEventQueue &&
					compactionOp === this._compactionOperation &&
					branchSummaryOp === this._branchSummaryOperation
				) {
					break;
				}
			}
			if (this._disposed || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			return await this._applyRefine(plan, options, refineAbort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._scheduleSessionInputPump();
		}
	}

	/**
	 * Block a new agent turn until any in-flight refine application phase has
	 * reattached event handling; otherwise the turn's messages are never
	 * persisted or rendered.
	 *
	 * The idle-wait and application phase (`_refineInFlight`) block here. The
	 * background planning phase (`_refinePlanInFlight`) does NOT block turns.
	 * Refine failures surface to the refine caller, not here.
	 */
	private async _waitForRefineIdle(): Promise<void> {
		while (this._refineInFlight) {
			await this._refineInFlight;
		}
	}

	/**
	 * Background planning phase: runs the LLM planning call via `planRefinement`.
	 * Does not disconnect from or abort the agent. Returns the plan without
	 * applying anything.
	 */
	private async _planRefine(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		signal: AbortSignal,
	): Promise<RefinementPlan> {
		if (this._disposed) {
			throw new Error("Cannot refine a disposed session.");
		}

		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const model = this.model;
		const { apiKey, headers } = await this._getRequiredRequestAuth(model);
		const globalHarnessStateDir = getGlobalHarnessStateDir();
		const localHarnessStateDir = this._localHarnessStateDir();
		const requestedScope = options.global ? "global" : "local";
		if (!options.rollbackId && requestedScope === "local" && !localHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const globalPlanningState = loadHarnessState(globalHarnessStateDir, "global");
		const localPlanningState = localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined;
		const planningState =
			requestedScope === "global"
				? globalPlanningState
				: mergeHarnessStates(globalPlanningState, localPlanningState);
		const history = this._loadRefinementHistory();
		const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
		let baselineScope = rollbackTarget
			? (inferRefinementResultScope(rollbackTarget) ?? requestedScope)
			: requestedScope;
		let baselineHarnessStateDir = baselineScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
		if (rollbackTarget?.harnessStatePath) {
			baselineHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
			baselineScope = resolve(baselineHarnessStateDir) === resolve(globalHarnessStateDir) ? "global" : "local";
		}
		if (!baselineHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const baselineState = rollbackTarget
			? loadHarnessState(baselineHarnessStateDir, baselineScope)
			: baselineScope === "global"
				? globalPlanningState
				: localPlanningState!;
		const plan = await planRefinement(
			this.agent.state.messages,
			planningState,
			history,
			model,
			apiKey,
			options,
			headers,
			signal,
			this.thinkingLevel,
		);
		if (this._disposed || signal.aborted) {
			throw new Error("Refinement cancelled because the session was disposed.");
		}
		return { ...plan, baselineState };
	}

	/**
	 * Synchronous application phase: disconnects from the agent, aborts any
	 * in-flight agent run, applies the refinement plan to disk and memory, then
	 * reconnects. This is the only phase that blocks turn entry points.
	 */
	private async _applyRefine(
		plan: RefinementPlan,
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
	): Promise<RefinementResult> {
		if (this._disposed) {
			throw new Error("Cannot refine a disposed session.");
		}
		// The caller has already set _refineInFlight and waited for agent idle.
		// Disconnect only for the brief apply + save + reconnect critical section.
		this._disconnectFromAgent();

		try {
			const globalHarnessStateDir = getGlobalHarnessStateDir();
			const localHarnessStateDir = this._localHarnessStateDir();
			const requestedScope = options.global ? "global" : "local";
			const history = this._loadRefinementHistory();
			const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
			let targetScope = plan.rollbackScope ?? requestedScope;
			let targetHarnessStateDir = targetScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
			if (targetScope === "local" && rollbackTarget?.harnessStatePath) {
				if (!existsSync(rollbackTarget.harnessStatePath)) {
					throw new Error(
						`Local refinement ${rollbackTarget.id} state file not found: ${rollbackTarget.harnessStatePath}`,
					);
				}
				targetHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
				// Legacy records predate scope fields and default to "local" but may point
				// at the global store; honor the recorded path so its entries stay global.
				if (resolve(targetHarnessStateDir) === resolve(globalHarnessStateDir)) {
					targetScope = "global";
				}
			}
			if (!targetHarnessStateDir) {
				throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
			}
			// Re-read the target state immediately before applying so concurrent kernel
			// (`rlm.harness`) writes during the LLM pass are not clobbered.
			const state = loadHarnessState(targetHarnessStateDir, targetScope);
			const proposal = {
				...plan.proposal,
				edits: plan.proposal.edits.map((edit) => {
					const localPrefix = "local:";
					const globalPrefix = "global:";
					return {
						...edit,
						id: edit.id?.startsWith(localPrefix)
							? edit.id.slice(localPrefix.length)
							: edit.id?.startsWith(globalPrefix)
								? edit.id.slice(globalPrefix.length)
								: edit.id,
					};
				}),
			};
			if (this._disposed || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			const result = applyRefinementProposal(state, proposal, {
				id: plan.id,
				rollbackOf: plan.rollbackOf,
				scope: targetScope,
				baselineState: plan.baselineState,
			});
			result.harnessStatePath = saveHarnessState(targetHarnessStateDir, state);
			if (targetScope === "global") {
				appendGlobalRefinement(globalHarnessStateDir, result);
			}
			this.sessionManager.appendCustomEntry("prime-agent.refinement", result);
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
			this.agent.state.systemPrompt = this._baseSystemPrompt;
			try {
				this._emit({ type: "refine_complete", result });
			} catch {
				// Listener failures must not flip a successful refinement into
				// a reported failure — the refinement is already persisted.
			}
			try {
				await this._extensionRunner.emit({
					type: "refine_complete",
					id: result.id,
					summary: result.summary,
					appliedEdits: result.appliedEdits.filter((edit) => edit.applied).length,
					scope: result.scope ?? "local",
				});
			} catch {
				// Extension emit failures must not flip a successful refinement
				// into a reported failure — the refinement is already persisted.
			}
			return result;
		} finally {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			if (!this._disposed) {
				this._reconnectToAgent();
			}
		}
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, and continue only for stopped in-progress loops or queued messages
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private _getThresholdContextTokens(
		assistantMessage: AssistantMessage,
		compactionTimestamp: number | undefined,
	): number | undefined {
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex !== null) {
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionTimestamp !== undefined &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= compactionTimestamp
			) {
				return undefined;
			}
			return estimate.tokens;
		}
		if (assistantMessage.stopReason === "error") return undefined;
		return calculateContextTokens(assistantMessage.usage);
	}

	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		queueAutonomousContinuation = true,
	): Promise<boolean> {
		// An abort drops any compaction the model requested this turn, even on the
		// pre-prompt path (skipAbortedCheck=false) which continues to threshold checks.
		if (assistantMessage.stopReason === "aborted") {
			this._pendingRequestedCompaction = undefined;
			// An abort also drops any pending explicit refine.run request: the
			// turn that would service it (non-serialized: _consumePendingRequestedRefine
			// at agent_end; serialized: the shouldStopAfterTurn checkpoint) never
			// runs for an aborted turn, so a stale request would leak into the
			// next turn or checkpoint.
			this._pendingRequestedRefine = undefined;
			if (this._serializedPlanInFlight) {
				const serializedPlanInFlight = this._serializedPlanInFlight;
				this._autoRefineBranchVersion++;
				this._refineAbortController?.abort();
				await serializedPlanInFlight.catch(() => undefined);
				if (this._serializedPlanInFlight === serializedPlanInFlight) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			}
			if (skipAbortedCheck) return false;
		}

		const settings = this.settingsManager.getCompactionSettings();
		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip overflow/threshold checks if this assistant message is older than the
		// latest compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		const assistantIsFromBeforeCompaction =
			compactionTimestamp !== undefined && assistantMessage.timestamp <= compactionTimestamp;

		// Case 1: Overflow - takes priority over a pending model request so the error
		// strip + retry still happen; the compaction it runs consumes the request.
		if (
			!assistantIsFromBeforeCompaction &&
			(settings.enabled || this._pendingRequestedCompaction !== undefined) &&
			sameModel &&
			isContextOverflow(assistantMessage, contextWindow)
		) {
			if (this._overflowRecovery !== "idle") {
				if (this._overflowRecovery === "attempted") {
					this._overflowRecovery = "reported";
					this._endCompactionUnsuccessfully(
						"overflow",
						"failed",
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
					);
				}
				return false;
			}

			this._overflowRecovery = "attempted";
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", true);
		}

		// Case 2: Model-requested (compact skill); runs even with auto-compaction off.
		if (this._pendingRequestedCompaction !== undefined) {
			return await this._runAutoCompaction("requested", false);
		}

		if (!settings.enabled || assistantIsFromBeforeCompaction) return false;

		// Case 3: Threshold - context is getting large.
		// Use the full-session estimate so messages appended after the last successful
		// assistant usage are included, matching the /usage context display.
		const contextTokens = this._getThresholdContextTokens(assistantMessage, compactionTimestamp);
		if (contextTokens === undefined) return false;
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			if (
				queueAutonomousContinuation &&
				(await this._queueAutonomousContinuationForThresholdCompaction(assistantMessage))
			) {
				this._continueAfterThresholdCompaction = true;
			}
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run automatic (threshold/overflow) or model-requested compaction
	 * with events.
	 */
	/** Emit an unsuccessful compaction_end and durably record the outcome. */
	private _endCompactionUnsuccessfully(
		reason: CompactionOutcomeReason,
		outcome: CompactionOutcome,
		message: string,
		options: { aborted?: boolean; errorSeverity?: "warning" | "error"; customInstructions?: string } = {},
	): void {
		this._persistCompactionOutcome(reason, outcome, message);
		this._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted: options.aborted ?? false,
			willRetry: false,
			// Aborts are user-initiated; they carry no error message on the event.
			errorMessage: options.aborted ? undefined : message,
			errorSeverity: options.errorSeverity,
			customInstructions: options.customInstructions,
		});
	}

	private _persistCompactionOutcome(
		reason: CompactionOutcomeReason,
		outcome: CompactionOutcome,
		message: string,
	): void {
		let outcomeMessage = createCompactionOutcomeMessage(message, { reason, outcome });
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				outcomeMessage.customType,
				outcomeMessage.content,
				outcomeMessage.display,
				outcomeMessage.details,
			);
		} catch (error) {
			const persistenceError = error instanceof Error ? error.message : String(error);
			outcomeMessage = createCompactionOutcomeMessage(
				`${message}\n\nThis compaction outcome could not be saved to session history: ${persistenceError}`,
				{ reason, outcome },
			);
			// Not in the session file, so context rebuilds would drop the disclosure.
			this._unpersistedCompactionOutcomes.push(outcomeMessage);
		}
		this.agent.state.messages.push(outcomeMessage);
		this._emit({ type: "message_start", message: outcomeMessage });
		this._emit({ type: "message_end", message: outcomeMessage });
	}

	private async _runAutoCompaction(
		reason: "overflow" | "threshold" | "requested",
		willRetry: boolean,
	): Promise<boolean> {
		// Any compaction consumes a pending model request and honors its instructions
		// (overflow recovery can fire first and take the request with it).
		const pending = this._pendingRequestedCompaction;
		this._pendingRequestedCompaction = undefined;
		const customInstructions = pending?.customInstructions;
		const shouldContinueAfterCompaction =
			(reason === "threshold" || reason === "requested") && this._continueAfterThresholdCompaction;
		const queuedAutonomousContinuationsForThisCompaction =
			reason === "threshold" && shouldContinueAfterCompaction
				? this._pendingThresholdCompactionAutonomousMessages.splice(0)
				: [];
		this._continueAfterThresholdCompaction = false;

		// A requested compaction stopped the loop on purpose; don't stall if it fails.
		const resumeAfterFailure = () => {
			if (
				reason === "requested" &&
				(shouldContinueAfterCompaction || this.agent.hasQueuedMessages() || this.pendingMessageCount > 0)
			) {
				this._schedulePostCompactionContinue();
			}
		};

		this._emit({ type: "compaction_start", reason, customInstructions });
		this._autoCompactionAbortController = new AbortController();

		try {
			const authResult = this.model ? await this._modelRegistry.getApiKeyAndHeaders(this.model) : undefined;
			if (!this.model || !authResult || !authResult.ok || !authResult.apiKey) {
				const detail =
					!this.model || !authResult
						? "no model is selected"
						: authResult.ok
							? "no API key is available"
							: authResult.error;
				this._endCompactionUnsuccessfully(reason, "failed", `Compaction failed: ${detail}`);
				this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
					reason === "threshold" && shouldContinueAfterCompaction,
					queuedAutonomousContinuationsForThisCompaction,
				);
				resumeAfterFailure();
				return false;
			}

			const result = await this._performCompaction({
				model: this.model,
				apiKey: authResult.apiKey,
				headers: authResult.headers,
				customInstructions,
				signal: this._autoCompactionAbortController.signal,
			});

			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry, customInstructions });
			// Queued work lives in both the agent queues and the session-owned queues.
			const hasQueuedMessages = this.agent.hasQueuedMessages() || this.pendingMessageCount > 0;
			const willContinueAfterCompaction = willRetry || shouldContinueAfterCompaction || hasQueuedMessages;

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}

				this._schedulePostCompactionContinue();
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
				return true;
			} else if (shouldContinueAfterCompaction || hasQueuedMessages) {
				// Compaction can intentionally stop a tool loop between turns.
				// Queued follow-up/steering/custom messages can also be waiting.
				this._schedulePostCompactionContinue();
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
			} else {
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
			}
			return false;
		} catch (error) {
			this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
				reason === "threshold" && shouldContinueAfterCompaction,
				queuedAutonomousContinuationsForThisCompaction,
			);
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted =
				errorMessage === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			if (aborted) {
				this._endCompactionUnsuccessfully(
					reason,
					"cancelled",
					`${reason === "requested" ? "Requested c" : "C"}ompaction cancelled`,
					{ aborted: true, customInstructions },
				);
				return false;
			}
			if (error instanceof CompactionSkippedError) {
				this._endCompactionUnsuccessfully(
					reason,
					"skipped",
					reason === "requested"
						? `Requested compaction skipped: ${errorMessage}`
						: `Auto-compaction skipped: ${errorMessage}`,
					{ errorSeverity: "warning", customInstructions },
				);
				resumeAfterFailure();
				return false;
			}
			this._endCompactionUnsuccessfully(
				reason,
				"failed",
				reason === "overflow"
					? `Context overflow recovery failed: ${errorMessage}`
					: reason === "requested"
						? `Requested compaction failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
				{ customInstructions },
			);
			resumeAfterFailure();
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
			this._scheduleSessionInputPump();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	/**
	 * Set the provider for extra env vars merged over process.env in extension
	 * pi.exec() subprocesses. The function is read at exec time, so a host (e.g.
	 * the daemon) can update the underlying value per attach without rebinding.
	 */
	setExecEnvProvider(provider: (() => Record<string, string | undefined> | undefined) | undefined): void {
		this._execEnvProvider = provider;
		const extensions = this._resourceLoader.getExtensions();
		extensions.runtime.getExecEnv = provider;
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				getSignal: () => this.agent.signal,
				abort: () => this.abort(),
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		];
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);
		const allowedCustomTools = allCustomTools.filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allowedCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allowedCustomTools, runner);
		// Resolve the runner at call time so a rebuild/reload rebinds built-in tools to the
		// live runner instead of wedging them on the invalidated one's stale-ctx guard.
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			() => this._extensionRunner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const pythonSkills = getPythonSkillRuntimeInfo(this._modelVisibleSkills());
		let configuredBaseToolDefinitions: Record<string, ToolDefinition>;
		if (this._baseToolsOverride) {
			configuredBaseToolDefinitions = Object.fromEntries(
				Object.entries(this._baseToolsOverride).map(([name, tool]) => [
					name,
					createToolDefinitionFromAgentTool(tool),
				]),
			);
		} else {
			// Rebuilding (e.g. /reload) replaces the provisioner; drop the previous
			// kernel so the session never holds two live kernels. Gate the new kernel's
			// startup on the old one's dispose (which flushes a final snapshot), so a
			// reload can't restore from a snapshot the old kernel is still writing.
			const previousDispose = this._ipythonKernelProvisioner?.dispose();
			this._ipythonKernelSnapshotDir = this.sessionManager.getSessionArtifactDir();
			// Only surface the "revived from your previous session" notice on the first
			// build (a genuine resume). A later rebuild (/reload) restores state silently
			// for continuity — the conversation is unchanged, so there's nothing to flag.
			const notifyRestore = !this._ipythonRuntimeBuilt;
			this._ipythonKernelProvisioner = new IpythonKernelProvisioner(this._cwd, {
				env: this._rlmKernelEnv(),
				sessionId: this.sessionId,
				hostHandlers: this._createKernelHostHandlers(),
				pythonSkills,
				snapshotDir: this._ipythonKernelSnapshotDir,
				readyGate: previousDispose,
				onRestore: notifyRestore ? (result) => this._onIpythonStateRestored(result) : undefined,
			});
			configuredBaseToolDefinitions = createAllToolDefinitions(this._cwd, {
				ipython: {
					provisioner: this._ipythonKernelProvisioner,
					commandPrefix: this.settingsManager.getShellCommandPrefix(),
					shellPath: this.settingsManager.getShellPath(),
					onLateSentAgentMessage: (toolCallId, message) =>
						this._recordLateIpythonSentAgentMessage(toolCallId, message),
				},
			});
		}

		this._baseToolDefinitions = new Map(
			Object.entries(configuredBaseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}
		// Re-apply on (re)build so the provider survives /reload. Guarded: the
		// runtime object can be shared across sessions from one ResourceLoader
		// (RLM children), so a provider-less session must not wipe the owner's.
		if (this._execEnvProvider) {
			extensionsResult.runtime.getExecEnv = this._execEnvProvider;
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride ? Object.keys(this._baseToolsOverride) : ["ipython"];
		const baseActiveToolNames = [...(options.activeToolNames ?? defaultActiveToolNames)];
		if (this._goalState.status === "active" && this._includeGoals) {
			// An active goal needs ipython so the model can reach the goal skill.
			baseActiveToolNames.push("ipython");
		}
		this._refreshToolRegistry({
			activeToolNames: [...new Set(baseActiveToolNames)],
			includeAllExtensionTools: options.includeAllExtensionTools,
		});

		// Prewarm when configured, or whenever we're resuming a session that already
		// has a kernel snapshot — so its state is revived and the model is told what
		// came back before the first turn, rather than a turn later when the kernel
		// would otherwise lazily start on first use.
		const hasSnapshot =
			!!this._ipythonKernelSnapshotDir && existsSync(snapshotPathIn(this._ipythonKernelSnapshotDir));
		if ((this._prewarmIpythonKernel || hasSnapshot) && this.getActiveToolNames().includes("ipython")) {
			this._ipythonKernelProvisioner?.prewarm();
		}

		// Subsequent builds are in-process rebuilds (/reload), not a fresh resume.
		this._ipythonRuntimeBuilt = true;
	}

	/**
	 * Skills exposed to the model (system prompt + kernel). The bundled goal
	 * and compact skills are withheld when disabled for this session.
	 */
	private _modelVisibleSkills(): Skill[] {
		let skills = this._resourceLoader.getSkills().skills;
		if (!this._includeGoals) {
			skills = skills.filter((skill) => skill.name !== GOAL_SKILL_NAME);
		}
		if (!this._includeCompactSkill) {
			skills = skills.filter((skill) => skill.name !== COMPACT_SKILL_NAME);
		}
		if (!this._autoRefineAllowedForSession()) {
			skills = skills.filter((skill) => skill.name !== REFINE_SKILL_NAME);
		}
		if (!this._agentMessageController) {
			skills = skills.filter((skill) => skill.name !== AGENT_MESSAGE_SKILL_NAME);
		}
		if (!this._agentObserveController) {
			skills = skills.filter((skill) => skill.name !== AGENT_OBSERVE_SKILL_NAME);
		}
		if (!this._agentObserveController || !this._rlmHeartbeatController) {
			skills = skills.filter((skill) => skill.name !== ORCHESTRATION_HEARTBEAT_SKILL_NAME);
		}
		return skills;
	}

	/** Typed handlers for host requests arriving from the IPython kernel comm bridge. */
	private _createKernelHostHandlers(): HostRequestHandlers {
		const handlers: HostRequestHandlers = {
			"rlm.run": createRlmRunHostHandler(({ prompt, kwargs, cellSourceCode }) =>
				this.runRlmChild(prompt, kwargs, cellSourceCode),
			),
			"rlm.find_models": createRlmFindModelsHostHandler((query, limit) => this.findRlmModels(query, limit)),
			"rlm.list_subagents": createRlmListSubagentsHostHandler(() => this.listRlmSubagents()),
			"rlm.delete_subagent": createRlmDeleteSubagentHostHandler((target) => this.deleteRlmSubagent(target)),
			"model.info": async () => ({
				id: this.model?.id ?? null,
				provider: this.model?.provider ?? null,
				input: this.model?.input ?? [],
			}),
		};
		if (this._includeGoals) {
			for (const type of ["goal.get", "goal.create", "goal.complete"]) {
				handlers[type] = async (payload) => this.handleGoalHostRequest(type, payload);
			}
		}
		if (this._includeCompactSkill) {
			for (const type of ["compact.run", "compact.status"]) {
				handlers[type] = async (payload) => this.handleCompactHostRequest(type, payload);
			}
		}
		if (this._autoRefineAllowedForSession()) {
			for (const type of ["refine.run", "refine.status"]) {
				handlers[type] = async (payload) => this.handleRefineHostRequest(type, payload);
			}
		}
		if (this._rlmHeartbeatController) {
			for (const type of [
				"rlm_heartbeat.list",
				"rlm_heartbeat.create",
				"rlm_heartbeat.update",
				"rlm_heartbeat.delete",
			]) {
				handlers[type] = async (payload) => this.handleRlmHeartbeatHostRequest(type, payload);
			}
		}
		const visibleKernelSkillNames = new Set(
			this._modelVisibleSkills()
				.filter((skill) => !skill.disableModelInvocation)
				.map((skill) => skill.name),
		);
		if (this._agentMessageController && visibleKernelSkillNames.has(AGENT_MESSAGE_SKILL_NAME)) {
			Object.assign(
				handlers,
				createAgentMessageHostHandlers({
					listAgents: () =>
						this.handleAgentMessageHostRequest("agent_message.list") as AgentSessionMessageListResult,
					sendAgentMessage: async (input) =>
						(await this.handleAgentMessageHostRequest("agent_message.send", {
							target: input.target,
							message: input.message,
							mode: input.deliveryMode,
						})) as AgentSessionMessageReceipt,
				}),
			);
		}
		if (this._agentObserveController) {
			Object.assign(
				handlers,
				createAgentObserveHostHandlers({
					listAgents: () => this.handleAgentObserveHostRequest("agent_observe.list") as AgentObserveListResult,
					getAgent: (target) =>
						this.handleAgentObserveHostRequest("agent_observe.get", { target }) as AgentObserveAgentSnapshot,
					recentMessages: (input) =>
						this.handleAgentObserveHostRequest("agent_observe.recent", {
							target: input.target,
							limit: input.limit,
							max_chars: input.maxChars,
						}) as AgentObserveRecentMessagesResult,
				}),
			);
		}
		if (this._mcpManager) {
			Object.assign(handlers, this._mcpManager.hostHandlers());
		}
		return handlers;
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		// Re-read auth.json: a login saved by the client process (daemon mode) must be
		// visible here so MCP skill gating sees the new credentials.
		this._modelRegistry.authStorage.reload();
		resetApiProviders();
		// Re-read mcpServers and re-register user MCP providers from the reloaded settings.
		this._mcpManager?.refresh();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	private _rlmKernelEnv(): Record<string, string> {
		const env: Record<string, string> = {
			RLM_DEPTH: String(this._rlmDepth),
			RLM_MAX_DEPTH: String(this._rlmMaxDepth),
			RLM_GLOBAL_HARNESS_STATE_DIR: getGlobalHarnessStateDir(),
		};
		const rlmSessionDir = this._ensureRlmSessionDir();
		if (rlmSessionDir) {
			env.RLM_SESSION_DIR = rlmSessionDir;
			// Keep kernel writes and host reads (system prompt, review, /refine) on
			// the same local harness path. Subagents prefer their own artifact dir;
			// ephemeral sessions fall back to the RLM session dir once it exists.
			env.RLM_HARNESS_STATE_DIR = this._localHarnessStateDir() ?? getLocalHarnessStateDir(rlmSessionDir)!;
		}
		this._addWebsearchKeyEnv(env);
		return env;
	}

	private _addWebsearchKeyEnv(env: Record<string, string>): void {
		if (this._agentDir) {
			env.PRIME_AGENT_CODING_AGENT_DIR = this._agentDir;
		}

		if (process.env[SERPER_ENV_VAR]?.trim()) {
			return;
		}
		// Inject only when a websearch skill (bundled or custom) is actually loaded,
		// so the key isn't exposed to kernels that can't use it.
		if (!this._resourceLoader.getSkills().skills.some((skill) => skill.name === WEBSEARCH_SKILL_NAME)) {
			return;
		}
		const cred = this._modelRegistry.authStorage.get(SERPER_CREDENTIAL_ID);
		if (cred?.type !== "api_key") {
			return;
		}
		const resolved = resolveConfigValue(cred.key)?.trim();
		if (resolved) {
			env[SERPER_ENV_VAR] = resolved;
		}
	}

	// Undefined when there's no persistent artifact dir (e.g. the viewer client):
	// don't mkdtemp here, since this runs on every kernel build but a viewer never
	// does RLM work. The temp dir is created lazily in _createChildRlmSessionDir.
	private _ensureRlmSessionDir(): string | undefined {
		if (this._rlmSessionDir) {
			mkdirSync(this._rlmSessionDir, { recursive: true });
			return this._rlmSessionDir;
		}

		const sessionArtifactDir = this.sessionManager.getSessionArtifactDir();
		if (sessionArtifactDir) {
			mkdirSync(sessionArtifactDir, { recursive: true });
			this._rlmSessionDir = sessionArtifactDir;
			return sessionArtifactDir;
		}

		return undefined;
	}

	private _createChildRlmSessionDir(): string {
		const parentDir = this._ensureRlmSessionDir() ?? this._createEphemeralRlmSessionDir();
		for (let i = 0; i < 100; i++) {
			const childDir = join(parentDir, `sub-${randomUUID().slice(0, 8)}`);
			try {
				mkdirSync(childDir);
				return childDir;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					continue;
				}
				throw error;
			}
		}
		throw new Error("Unable to create unique RLM child session directory");
	}

	private _createEphemeralRlmSessionDir(): string {
		this._rlmSessionDir = mkdtempSync(join(tmpdir(), "prime-agent-rlm-"));
		return this._rlmSessionDir;
	}

	private _usageForCurrentMessages(): RlmUsage {
		const usage = emptyRlmUsage();
		for (const message of this.agent.state.messages) {
			if (message.role === "assistant") {
				addUsage(usage, (message as AssistantMessage).usage);
			}
		}
		return usage;
	}

	/** Context size (tokens) of this session's latest assistant turn, for live subagent display. */
	_contextTokensForCurrentMessages(): number | undefined {
		const last = this._findLastAssistantMessage();
		return last ? calculateContextTokens(last.usage) : undefined;
	}

	setCurrentRecap(recap: string | undefined): void {
		if (this._currentRecap === recap) {
			return;
		}
		this._currentRecap = recap;
		this._emit({ type: "recap_update", recap });
	}

	getCurrentRecap(): string | undefined {
		return this._currentRecap;
	}

	private _assistantUsageForCurrentMessages(): Usage {
		const usage = emptyUsage();
		for (const message of this.agent.state.messages) {
			if (message.role === "assistant") {
				addAssistantUsage(usage, (message as AssistantMessage).usage);
			}
		}
		return usage;
	}

	private _findAssistantEntryForMessage(message: AssistantMessage): SessionMessageEntry | undefined {
		return this.sessionManager
			.getEntries()
			.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message === message);
	}

	private _attributeRlmChildUsageToParent(
		childUsage: Usage,
		parentAssistant = this._findLastAssistantMessage(),
	): void {
		if (!parentAssistant) {
			return;
		}
		const parentEntry = this._findAssistantEntryForMessage(parentAssistant);
		attributeChildUsage(parentAssistant.usage, childUsage);
		if (parentEntry) {
			this.sessionManager.appendChildUsageAttribution(parentEntry.id, childUsage, parentAssistant.usage);
		}
	}

	private _assistantTurnCount(): number {
		return this.agent.state.messages.filter((message) => message.role === "assistant").length;
	}

	private _createRlmSubagentRuntimeOptions(options: {
		id: string;
		prompt: string;
		sessionName: string;
		spawnCode?: string;
		sessionDir: string;
		model: Model<any>;
	}): CreateRlmSubagentRuntimeOptions {
		return {
			parentSession: this,
			id: options.id,
			prompt: options.prompt,
			sessionName: options.sessionName,
			spawnCode: options.spawnCode,
			sessionDir: options.sessionDir,
			model: options.model,
			thinkingLevel: clampThinkingLevel(options.model, this.thinkingLevel) as ThinkingLevel,
			serviceTier:
				this.serviceTier === "priority" && !supportsFastMode(options.model) ? "default" : this.serviceTier,
			scopedModels: [...this._scopedModels],
			activeToolNames: this.getActiveToolNames(),
			allowedToolNames: this._allowedToolNames ? [...this._allowedToolNames] : undefined,
			customTools: [...this._customTools],
			includeGoals: this._includeGoals,
			includeCompactSkill: this._includeCompactSkill,
			rlmDepth: this._rlmDepth + 1,
			rlmMaxDepth: this._rlmMaxDepth,
			rlmParentNodeId: options.id,
		};
	}

	private async _createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
		if (this._subagentRuntimeHost) {
			return await this._subagentRuntimeHost.createRlmSubagentRuntime(options);
		}

		return this._createInlineRlmSubagentRuntime(options);
	}

	private async _releaseRlmSubagentRuntime(
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: RlmSubagentReleaseStatus,
	): Promise<void> {
		if (this._subagentRuntimeHost?.releaseRlmSubagentRuntime) {
			await this._subagentRuntimeHost.releaseRlmSubagentRuntime(runtime, options, status);
			return;
		}

		// Inline: keep a successful run readable (disposed with the parent); errored or
		// cancelled runs have nothing useful to show, so dispose them now. retainFinished…
		// disposes the child itself when it declines, so only dispose here otherwise.
		if (status === "done") {
			// Trace sharing is best-effort telemetry for every completed run, retained
			// or not. Rate-limit retries can take minutes, so it must not delay the
			// model-facing rlm.run result.
			void flushAgentTraceUpload(runtime.session.sessionManager).catch(() => undefined);
			if (!options.parentSession.retainFinishedRlmChildSession(options.id, runtime.session)) {
				runtime.session.dispose();
			}
		} else {
			runtime.session.dispose();
		}
	}

	private _createInlineRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): RlmSubagentRuntime {
		const childSessionManager = SessionManager.create(this._cwd, options.sessionDir);
		if (options.parentSession.sessionFile) {
			childSessionManager.newSession({ parentSession: options.parentSession.sessionFile });
		}
		childSessionManager.appendModelChange(options.model.provider, options.model.id);
		childSessionManager.appendThinkingLevelChange(options.thinkingLevel);
		childSessionManager.appendServiceTierChange(options.serviceTier);

		const childAgent = new Agent({
			initialState: {
				systemPrompt: "",
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				serviceTier: options.serviceTier,
				tools: [],
			},
			convertToLlm: this.agent.convertToLlm,
			transformContext: this.agent.transformContext,
			streamFn: this.agent.streamFn,
			getApiKey: this.agent.getApiKey,
			onPayload: this.agent.onPayload,
			onResponse: this.agent.onResponse,
			steeringMode: this.settingsManager.getSteeringMode(),
			followUpMode: this.settingsManager.getFollowUpMode(),
			sessionId: childSessionManager.getSessionId(),
			thinkingBudgets: this.settingsManager.getThinkingBudgets(),
			transport: this.settingsManager.getTransport(),
			maxRetryDelayMs: this.settingsManager.getProviderRetrySettings().maxRetryDelayMs,
			toolExecution: this.agent.toolExecution,
		});

		const child = new AgentSession({
			agent: childAgent,
			sessionManager: childSessionManager,
			settingsManager: this.settingsManager,
			cwd: this._cwd,
			agentDir: this._agentDir,
			scopedModels: options.scopedModels,
			resourceLoader: this._resourceLoader,
			customTools: options.customTools,
			modelRegistry: this._modelRegistry,
			initialActiveToolNames: options.activeToolNames,
			allowedToolNames: options.allowedToolNames,
			includeGoals: options.includeGoals,
			includeCompactSkill: options.includeCompactSkill,
			rlmDepth: options.rlmDepth,
			rlmMaxDepth: options.rlmMaxDepth,
			rlmSessionDir: options.sessionDir,
			rlmParentNodeId: options.rlmParentNodeId,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		if (child.sessionName !== options.sessionName) {
			try {
				child.setSessionName(options.sessionName);
			} catch (error) {
				child.dispose();
				throw error;
			}
		}
		options.onSessionPublished?.(child);

		return { session: child };
	}

	private _cancelActiveRlmChildRuns(reason: string): void {
		for (const run of this._activeRlmChildRuns.values()) {
			this._cancelRlmChildRun(run, reason);
		}
	}

	private _cancelRlmChildRun(run: RlmChildRun, reason: string): boolean {
		if (run.status !== "running" && run.status !== "queued") {
			return false;
		}
		run.status = "cancelled";
		run.error = reason;
		run.abort();
		// Surface the cancellation immediately; the run's own terminal update is
		// delayed indefinitely when the child is stuck mid-stream, which is
		// exactly when users reach for the kill.
		run.emitUpdate?.();
		return true;
	}

	/** Status of a direct RLM child run, while the run is still tracked. */
	getRlmChildRunStatus(childId: string): RlmChildAgentStatus | undefined {
		return this._activeRlmChildRuns.get(childId)?.status;
	}

	/** Current direct-child registry for the model-facing rlm.list_subagents API. */
	listRlmSubagents(): RlmListSubagentsResult {
		const daemonChildren = new Map<string, AgentSessionMessageAgentSummary>();
		const listedAgents = this._agentMessageController?.listAgents();
		const parentActiveSessionId = listedAgents?.current?.activeSessionId;
		if (parentActiveSessionId) {
			for (const agent of listedAgents.agents) {
				if (
					agent.runtimeKind === "subagent" &&
					agent.parentActiveSessionId === parentActiveSessionId &&
					agent.rlmChildId
				) {
					daemonChildren.set(agent.rlmChildId, agent);
				}
			}
		}

		const subagents: RlmListSubagentsResult["subagents"] = [];
		const recorded = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			if (this._deletingRlmChildren.has(run.id) || run.status === "error" || run.status === "cancelled") {
				continue;
			}
			const daemonChild = daemonChildren.get(run.id);
			subagents.push({
				rlm_child_id: run.id,
				active_session_id: daemonChild?.activeSessionId ?? null,
				session_id: daemonChild?.sessionId ?? run.session?.sessionId ?? null,
				session_name: daemonChild?.sessionName ?? run.session?.sessionName ?? run.sessionName,
				session_dir: run.sessionDir,
				status: run.status === "done" ? "completed" : "running",
			});
			recorded.add(run.id);
		}
		for (const [childId, childSession] of this._retainedRlmChildSessions) {
			if (
				this._deletingRlmChildren.has(childId) ||
				recorded.has(childId) ||
				this._retryableRlmSubagentDeletions.has(childId)
			) {
				continue;
			}
			const daemonChild = daemonChildren.get(childId);
			const sessionDir = childSession._rlmSessionDir;
			if (!sessionDir) {
				continue;
			}
			subagents.push({
				rlm_child_id: childId,
				active_session_id: daemonChild?.activeSessionId ?? null,
				session_id: daemonChild?.sessionId ?? childSession.sessionId,
				session_name:
					daemonChild?.sessionName ?? childSession.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
				session_dir: sessionDir,
				status: "completed",
			});
		}
		return { subagents };
	}

	private _rlmSubagentMatchesTarget(entry: RlmSubagentRegistryEntry, target: string): boolean {
		return (
			entry.rlm_child_id === target ||
			entry.active_session_id === target ||
			entry.session_id === target ||
			entry.session_name === target
		);
	}

	private _resolveDirectRlmSubagent(target: string): RlmSubagentRegistryEntry {
		const candidates = [...this.listRlmSubagents().subagents, ...this._retryableRlmSubagentDeletions.values()];
		const matches = candidates.filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		if (matches.length === 0) {
			throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
		}
		if (matches.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		return matches[0]!;
	}

	/** Delete a running or retained direct child selected from this parent session's registry. */
	async deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult> {
		const inFlight = [...this._deletingRlmChildren.values()].filter(({ subagent }) =>
			this._rlmSubagentMatchesTarget(subagent, target),
		);
		const directMatches = [
			...this.listRlmSubagents().subagents,
			...this._retryableRlmSubagentDeletions.values(),
		].filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		const matchingChildIds = new Set([
			...inFlight.map(({ subagent }) => subagent.rlm_child_id),
			...directMatches.map((subagent) => subagent.rlm_child_id),
		]);
		if (matchingChildIds.size > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		if (inFlight[0]) {
			return inFlight[0].promise;
		}

		const subagent = directMatches[0] ?? this._resolveDirectRlmSubagent(target);
		const deletion = this._deleteResolvedRlmSubagent(subagent);
		this._deletingRlmChildren.set(subagent.rlm_child_id, { subagent, promise: deletion });
		try {
			return await deletion;
		} finally {
			if (this._deletingRlmChildren.get(subagent.rlm_child_id)?.promise === deletion) {
				this._deletingRlmChildren.delete(subagent.rlm_child_id);
			}
		}
	}

	private _deleteRlmSubagentSession(childId: string, session: AgentSession): Promise<void> {
		if (this._subagentRuntimeHost) {
			return this._subagentRuntimeHost.deleteRlmSubagentRuntime(childId, session);
		}
		return session.disposeAsync();
	}

	private _removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void {
		run?.unsubscribe?.();
		this._retainedRlmChildUnsubscribes.get(childId)?.();
		this._retainedRlmChildUnsubscribes.delete(childId);
		this._retainedRlmChildSessions.delete(childId);
		this._retryableRlmSubagentDeletions.delete(childId);
		if (!run || this._activeRlmChildRuns.get(childId) === run) {
			this._activeRlmChildRuns.delete(childId);
		}
		if (run) {
			run.abort = noopRlmChildAbort;
			run.unsubscribe = undefined;
			run.rejectTask = undefined;
			run.session = undefined;
		}
	}

	private _emitRlmSubagentRemoval(subagent: RlmSubagentRegistryEntry): void {
		this._emit({
			type: "rlm_child_update",
			child: {
				id: subagent.rlm_child_id,
				parentId: this._rlmParentNodeId,
				activeSessionId: subagent.active_session_id ?? undefined,
				sessionName: subagent.session_name,
				label: subagent.session_name,
				status: "cancelled",
				sessionDir: subagent.session_dir,
				error: "Deleted by parent orchestrator",
			},
		});
	}

	private async _deleteResolvedRlmSubagent(subagent: RlmSubagentRegistryEntry): Promise<RlmDeleteSubagentResult> {
		const childId = subagent.rlm_child_id;
		const run = this._activeRlmChildRuns.get(childId);
		if (run) {
			if (!this._cancelRlmChildRun(run, "Deleted by parent orchestrator")) {
				this._emitRlmSubagentRemoval(subagent);
			}
			const liveSession = run.session;
			if (liveSession) {
				try {
					await this._deleteRlmSubagentSession(childId, liveSession);
				} catch (error) {
					// The initial run was cancelled even though host closure failed. Reject its
					// public promise now. Parent teardown owns cleanup once it starts, so do not
					// repopulate maps that dispose() has already cleared.
					run.rejectTask?.(new Error("Deleted by parent orchestrator"));
					if (this._disposed || this._disposing) {
						this._removeRlmSubagentTracking(childId, run);
						void liveSession.disposeAsync().catch(() => undefined);
						throw error;
					}
					this._retainedRlmChildSessions.set(childId, liveSession);
					this._retryableRlmSubagentDeletions.set(childId, subagent);
					if (run.unsubscribe) {
						this._retainedRlmChildUnsubscribes.set(childId, run.unsubscribe);
					}
					this._activeRlmChildRuns.delete(childId);
					run.abort = noopRlmChildAbort;
					run.unsubscribe = undefined;
					run.rejectTask = undefined;
					run.session = undefined;
					throw error;
				}
				// Runtime closure is the deletion boundary. Reject the public call and do
				// not wait for provider/tool work that ignored abort; the tombstone blocks
				// any late retention by the detached work task.
				run.rejectTask?.(new Error("Deleted by parent orchestrator"));
				this._deletedRlmChildIds.add(childId);
				this._removeRlmSubagentTracking(childId, run);
				return { subagent };
			}

			// Runtime creation has not published a session. Detach immediately rather
			// than blocking on tool/runtime startup; keep the selector snapshot until
			// the eventual release succeeds or becomes hidden/retryable on failure.
			run.detachedDeletion = subagent;
			run.rejectTask?.(new Error("Deleted by parent orchestrator"));
			this._deletedRlmChildIds.add(childId);
			// Keep the cancelled run tracked until startup settles. It stays hidden from
			// list/delete, reserves its selectors against reuse, and lets daemon startup's
			// open guard tear the half-bound runtime down before it becomes addressable.
			return { subagent };
		}

		this._emitRlmSubagentRemoval(subagent);

		const retained = this._retainedRlmChildSessions.get(childId);
		if (retained) {
			try {
				await this._deleteRlmSubagentSession(childId, retained);
			} catch (error) {
				if (this._disposed || this._disposing) {
					this._removeRlmSubagentTracking(childId);
					void retained.disposeAsync().catch(() => undefined);
				} else {
					// Hide failed cleanup from the public registry while preserving the
					// original selector and session for an explicit retry.
					this._retryableRlmSubagentDeletions.set(childId, subagent);
				}
				throw error;
			}
		}
		this._deletedRlmChildIds.add(childId);
		this._removeRlmSubagentTracking(childId);
		return { subagent };
	}

	/**
	 * Retain a finished child session for the parent lifetime so inspectors and
	 * daemon-hosted agent messaging can keep addressing it. Returns false (and disposes
	 * the child) when the parent is already tearing down, so the caller can drop the
	 * matching event forwarder too.
	 */
	retainFinishedRlmChildSession(childId: string, session: AgentSession): boolean {
		// A child can finish concurrently while the parent is (or has) torn down; don't
		// resurrect the map (it would never be disposed), just drop the child now.
		if (this._disposed || this._disposing) {
			void session.disposeAsync().catch(() => undefined);
			return false;
		}
		if (this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId)) {
			return false;
		}
		this._retainedRlmChildSessions.set(childId, session);
		return true;
	}

	/** True when any direct or nested subagent is still running or queued. */
	hasRunningRlmChildren(): boolean {
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.status === "running" || run.status === "queued") {
				return true;
			}
			if (run.session?.hasRunningRlmChildren()) {
				return true;
			}
		}
		// A finished direct child can still have a running nested subagent.
		for (const session of this._retainedRlmChildSessions.values()) {
			if (session.hasRunningRlmChildren()) {
				return true;
			}
		}
		return false;
	}

	// Inline (non-daemon) mode only; daemon clients attach to the child session directly.
	getRlmChildSession(childId: string): AgentSession | undefined {
		const direct = this._activeRlmChildRuns.get(childId)?.session ?? this._retainedRlmChildSessions.get(childId);
		if (direct) {
			return direct;
		}
		for (const candidate of this._activeRlmChildRuns.values()) {
			const nested = candidate.session?.getRlmChildSession(childId);
			if (nested) {
				return nested;
			}
		}
		for (const retained of this._retainedRlmChildSessions.values()) {
			const nested = retained.getRlmChildSession(childId);
			if (nested) {
				return nested;
			}
		}
		return undefined;
	}

	/**
	 * Cancel a single RLM child run by id, searching nested child sessions.
	 *
	 * @returns true when a running or queued run was cancelled; false when the
	 * id is unknown or the run already finished.
	 */
	cancelRlmChildRun(childId: string, reason = "Cancelled by user"): boolean {
		const run = this._activeRlmChildRuns.get(childId);
		if (run) {
			return this._cancelRlmChildRun(run, reason);
		}
		for (const candidate of this._activeRlmChildRuns.values()) {
			if (candidate.session?.cancelRlmChildRun(childId, reason)) {
				return true;
			}
		}
		// A finished, retained child can still have a running nested subagent.
		for (const retained of this._retainedRlmChildSessions.values()) {
			if (retained.cancelRlmChildRun(childId, reason)) {
				return true;
			}
		}
		return false;
	}

	private _assertRlmSubagentSessionNameAvailable(name: string): void {
		if (this._pendingRlmSubagentSessionNames.has(name)) {
			throw new Error(`RLM subagent session name "${name}" is already in use`);
		}
		const conflictsWithSelector = (endpoint: {
			activeSessionId: string;
			sessionId: string;
			sessionName?: string;
			rlmChildId?: string;
		}) =>
			endpoint.activeSessionId === name ||
			endpoint.sessionId === name ||
			endpoint.sessionName === name ||
			endpoint.rlmChildId === name;
		for (const [childId, run] of this._activeRlmChildRuns) {
			if (
				childId === name ||
				run.sessionName === name ||
				run.session?.sessionId === name ||
				run.session?.sessionName === name
			) {
				throw new Error(`RLM subagent session name "${name}" is already in use`);
			}
		}
		for (const [childId, session] of this._retainedRlmChildSessions) {
			if (childId === name || session.sessionId === name || session.sessionName === name) {
				throw new Error(`RLM subagent session name "${name}" is already in use`);
			}
		}
		for (const subagent of this._retryableRlmSubagentDeletions.values()) {
			if (this._rlmSubagentMatchesTarget(subagent, name)) {
				throw new Error(`RLM subagent session name "${name}" is already in use`);
			}
		}
		const listedAgents = this._agentMessageController?.listAgents();
		if (
			listedAgents &&
			((listedAgents.current ? conflictsWithSelector(listedAgents.current) : false) ||
				listedAgents.agents.some(conflictsWithSelector))
		) {
			throw new Error(`RLM subagent session name "${name}" is already in use`);
		}
	}

	private async _authenticatedRlmModels(): Promise<Model<Api>[]> {
		return (await this._modelRegistry.getExecutableModels()).filter((model) => {
			const status = this._modelRegistry.getProviderAuthStatus(model.provider);
			return status.source !== "stale" && status.label !== "expired";
		});
	}

	async findRlmModels(query: string, limit: number): Promise<RlmFindModelsResult> {
		return { models: findRlmModelMatches(query, await this._authenticatedRlmModels(), limit) };
	}

	private _rlmModelFallback(reference: string, parentModel: Model<Api>, reason: string): RlmSubagentModelSelection {
		const parentSelector = `${parentModel.provider}/${parentModel.id}`;
		return {
			model: parentModel,
			warning: `Requested subagent model "${reference}" ${reason}. Used the parent model "${parentSelector}" instead. Tell the user the subagent ran with "${parentSelector}", not "${reference}".`,
		};
	}

	private async _resolveRlmSubagentModel(reference: string | undefined): Promise<RlmSubagentModelSelection> {
		const parentModel = this.model;
		if (!parentModel) {
			throw new Error(formatNoModelSelectedMessage());
		}
		if (!reference) {
			return { model: parentModel };
		}

		const normalizedReference = reference.toLowerCase();
		if (`${parentModel.provider}/${parentModel.id}`.toLowerCase() === normalizedReference) {
			return { model: parentModel };
		}
		const model = (await this._authenticatedRlmModels()).find(
			(candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === normalizedReference,
		);
		if (!model) {
			return this._rlmModelFallback(reference, parentModel, "is unavailable, unauthenticated, or expired");
		}

		const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			return this._rlmModelFallback(reference, parentModel, "failed authentication preflight");
		}
		return { model };
	}

	private async _startRlmChildRun(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
	): Promise<RlmChildRun> {
		const { name: rawName, model: rawModel, ...unsupported } = kwargs;
		const unsupportedKwargs = Object.keys(unsupported);
		if (unsupportedKwargs.length > 0) {
			throw new Error(`Unsupported rlm.run kwargs: ${unsupportedKwargs.sort().join(", ")}`);
		}
		const requestedSessionName = normalizeRequestedRlmSubagentSessionName(rawName);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel);
		if (requestedSessionName) {
			assertDirectAgentMessageTarget(requestedSessionName);
		}
		if (this._rlmDepth >= this._rlmMaxDepth) {
			throw new Error(
				`RLM recursion depth limit reached (RLM_DEPTH=${this._rlmDepth}, RLM_MAX_DEPTH=${this._rlmMaxDepth})`,
			);
		}
		if (requestedSessionName) {
			this._assertRlmSubagentSessionNameAvailable(requestedSessionName);
			this._pendingRlmSubagentSessionNames.add(requestedSessionName);
		}
		let modelSelection: RlmSubagentModelSelection;
		try {
			modelSelection = await this._resolveRlmSubagentModel(requestedModel);
		} finally {
			if (requestedSessionName) {
				this._pendingRlmSubagentSessionNames.delete(requestedSessionName);
			}
		}
		if (this._disposed || this._disposing) {
			throw new Error("Cannot start a subagent after the parent session has been disposed");
		}

		const childSessionDir = this._createChildRlmSessionDir();
		const childNodeId = basename(childSessionDir);
		const sessionName = requestedSessionName ?? createDefaultRlmSubagentSessionName(prompt, childNodeId);
		if (!requestedSessionName) {
			this._assertRlmSubagentSessionNameAvailable(sessionName);
		}
		const startedAt = Date.now();
		const parentAssistantForUsage = this._findLastAssistantMessage();
		const label = rlmChildLabel(prompt);
		let answerPreview: string | undefined;
		let durationMs: number | undefined;
		let toolUseCount = 0;
		let runningToolCount = 0;
		let activity: RlmChildAgentActivity | undefined;
		// Held for emitChildUpdate so post-run events (a retained child's forwarder still
		// fires) keep reading recap/tokens after run.session is cleared in the finally.
		let childSession: AgentSession | undefined;
		const run: RlmChildRun = {
			id: childNodeId,
			prompt,
			sessionName,
			sessionDir: childSessionDir,
			status: "running",
			abort: noopRlmChildAbort,
		};
		this._activeRlmChildRuns.set(run.id, run);
		// Status-only relay; the conversation is read from the child's own session.
		const emitChildUpdate = () => {
			const childModel = childSession?.model ?? modelSelection.model;
			this._emit({
				type: "rlm_child_update",
				child: {
					id: childNodeId,
					parentId: this._rlmParentNodeId,
					sessionName: childSession?.sessionName ?? sessionName,
					model: `${childModel.provider}/${childModel.id}`,
					label,
					status: run.status,
					durationMs,
					answerPreview,
					toolUseCount: toolUseCount > 0 ? toolUseCount : undefined,
					tokenCount: childSession?._contextTokensForCurrentMessages(),
					recap: childSession?.getCurrentRecap(),
					sessionDir: childSessionDir,
					activity,
					error: run.error,
				},
			});
		};
		run.emitUpdate = emitChildUpdate;
		emitChildUpdate();

		const publishChildSession = (child: AgentSession) => {
			childSession = child;
			// A host can publish before its create promise resolves. Do not restore the
			// live-session pointer if deletion already removed this run in the meantime.
			if (this._activeRlmChildRuns.get(run.id) !== run) {
				return;
			}
			run.session = child;
			run.abort = () => {
				void child.abort();
			};
		};
		const subagentOptions: CreateRlmSubagentRuntimeOptions = {
			...this._createRlmSubagentRuntimeOptions({
				id: childNodeId,
				prompt,
				sessionName,
				spawnCode,
				sessionDir: childSessionDir,
				model: modelSelection.model,
			}),
			onSessionPublished: publishChildSession,
		};
		let childRuntime: RlmSubagentRuntime | undefined;
		let unsubscribeChild: (() => void) | undefined;
		const deletedTask = new Promise<never>((_resolve, reject) => {
			run.rejectTask = reject;
		});

		const workTask = (async (): Promise<RlmInternalRunResult> => {
			try {
				if (isRlmChildRunCancelled(run)) {
					throw new Error(run.error ?? "RLM child cancelled");
				}
				childRuntime = await this._createRlmSubagentRuntime(subagentOptions);
				const child = childRuntime.session;
				if (child.sessionName !== subagentOptions.sessionName) {
					child.setSessionName(subagentOptions.sessionName);
				}
				publishChildSession(child);
				const unsubscribeChildEvents = child.subscribe((event) => {
					if (event.type === "rlm_child_update") {
						this._emit(event);
						return;
					}
					switch (event.type) {
						case "session_info_changed":
						case "recap_update":
							emitChildUpdate();
							break;
						case "message_start":
						case "message_update":
						case "message_end": {
							if (event.message.role === "assistant") {
								const text = compactRlmText(readAssistantText(event.message as AssistantMessage));
								if (text) {
									answerPreview = text;
								}
								activity = { kind: "writing" };
								emitChildUpdate();
							}
							break;
						}
						case "tool_execution_start": {
							toolUseCount += 1;
							runningToolCount += 1;
							activity = { kind: "executing", toolName: event.toolName };
							emitChildUpdate();
							break;
						}
						case "tool_execution_end": {
							runningToolCount = Math.max(0, runningToolCount - 1);
							// Stay "executing" while sibling tools from the same turn run.
							if (runningToolCount === 0) {
								activity = { kind: "waiting" };
								emitChildUpdate();
							}
							break;
						}
					}
				});
				let childEventsSubscribed = true;
				unsubscribeChild = () => {
					if (!childEventsSubscribed) {
						return;
					}
					childEventsSubscribed = false;
					unsubscribeChildEvents();
				};
				run.unsubscribe = unsubscribeChild;
				if (isRlmChildRunCancelled(run)) {
					await child.abort();
					throw new Error(run.error ?? "RLM child cancelled");
				}
				await child.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
				await child.agent.waitForIdle();
				if (isRlmChildRunCancelled(run)) {
					throw new Error(run.error ?? "RLM child cancelled");
				}
				const answer = child.getLastAssistantText() ?? "";
				const usage = child._usageForCurrentMessages();
				const assistantUsage = child._assistantUsageForCurrentMessages();
				this._attributeRlmChildUsageToParent(assistantUsage, parentAssistantForUsage);
				run.status = "done";
				durationMs = Date.now() - startedAt;
				activity = undefined;
				const compactAnswer = compactRlmText(answer);
				if (compactAnswer) {
					answerPreview = compactAnswer;
				}
				emitChildUpdate();
				const result: RlmRunResult = {
					answer,
					usage,
					turns: child._assistantTurnCount(),
					session_dir: childSessionDir,
					model: `${modelSelection.model.provider}/${modelSelection.model.id}`,
					...(modelSelection.warning ? { warning: modelSelection.warning } : {}),
				};
				run.result = result;
				return { ...result, assistantUsage };
			} catch (error) {
				if (run.status !== "cancelled") {
					run.status = "error";
				}
				durationMs = Date.now() - startedAt;
				run.error = error instanceof Error ? error.message : String(error);
				activity = undefined;
				emitChildUpdate();
				throw error;
			} finally {
				const releaseStatus: RlmSubagentReleaseStatus =
					run.status === "cancelled" || run.status === "error" ? run.status : "done";
				try {
					if (childRuntime) {
						await this._releaseRlmSubagentRuntime(childRuntime, subagentOptions, releaseStatus).catch((error) => {
							run.releaseError = error;
							return Promise.reject(error);
						});
					}
				} finally {
					// A later successful cancelled/error release supersedes an earlier failed
					// delete attempt; drop its hidden retry entry and selector reservation.
					if (!run.releaseError && releaseStatus !== "done" && this._retryableRlmSubagentDeletions.has(run.id)) {
						this._removeRlmSubagentTracking(run.id, run);
					}
					if (run.releaseError && releaseStatus !== "done" && childSession && run.detachedDeletion) {
						try {
							// Early deletion returned before runtime creation completed. If normal
							// release fails, use the host's delete path as a second cleanup attempt.
							await this._deleteRlmSubagentSession(run.id, childSession);
						} catch {
							// Keep a hidden selector-addressable cleanup entry rather than orphaning
							// a host runtime after delete already returned successfully.
							if (!this._disposed && !this._disposing) {
								this._retainedRlmChildSessions.set(run.id, childSession);
								this._retryableRlmSubagentDeletions.set(run.id, run.detachedDeletion);
							}
						} finally {
							run.detachedDeletion = undefined;
						}
					}
					// A host release failure after successful work leaves a retryable parent
					// entry. Failed/cancelled runs remain omitted from the public registry.
					if (
						run.releaseError &&
						releaseStatus === "done" &&
						childSession &&
						!this._disposed &&
						!this._disposing &&
						!this._deletedRlmChildIds.has(run.id)
					) {
						this._retainedRlmChildSessions.set(run.id, childSession);
					} else if (
						run.releaseError &&
						releaseStatus !== "done" &&
						childSession &&
						!this._retryableRlmSubagentDeletions.has(run.id)
					) {
						// Failed/cancelled runs are not registry entries, so make a best-effort
						// local cleanup unless the session is deliberately retained for retry.
						await childSession.disposeAsync().catch(() => undefined);
					}
					// Keep the forwarder only if the child was actually retained (retention can
					// decline when the parent is disposing or deleting it); otherwise drop it.
					if (unsubscribeChild) {
						if (this._retainedRlmChildSessions.has(run.id)) {
							this._retainedRlmChildUnsubscribes.set(run.id, unsubscribeChild);
						} else {
							unsubscribeChild();
						}
					}
					run.abort = noopRlmChildAbort;
					run.unsubscribe = undefined;
					run.rejectTask = undefined;
					run.session = undefined;
					this._activeRlmChildRuns.delete(run.id);
				}
			}
		})();
		run.task = Promise.race([workTask, deletedTask]);
		return run;
	}

	async runRlmChild(prompt: string, kwargs: Record<string, unknown> = {}, spawnCode?: string): Promise<RlmRunResult> {
		const run = await this._startRlmChildRun(prompt, kwargs, spawnCode);
		if (!run.task) {
			throw new Error("RLM child failed to start");
		}
		const result = await run.task;
		return {
			answer: result.answer,
			usage: result.usage,
			turns: result.turns,
			session_dir: result.session_dir,
			model: result.model,
			...(result.warning ? { warning: result.warning } : {}),
		};
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		if (this._isFauxProviderQueueExhausted(message)) {
			return false;
		}

		if (this._isAgentLifecycleFailure(message)) {
			return false;
		}

		if (this._isStructuredPermanentProviderRetryExhausted(message)) {
			return false;
		}

		return true;
	}

	private _isFauxProviderQueueExhausted(message: AssistantMessage): boolean {
		return message.provider === "faux" && message.errorMessage === "No more faux responses queued";
	}

	private _isAgentLifecycleFailure(message: AssistantMessage): boolean {
		return message.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure") ?? false;
	}

	private _getProviderStreamFailureDetails(message: AssistantMessage): Record<string, unknown> | undefined {
		const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
		const details = failure?.details;
		if (!details || typeof details !== "object") {
			return undefined;
		}
		return details;
	}

	private _getProviderStreamFailureKind(message: AssistantMessage): string | undefined {
		const kind = this._getProviderStreamFailureDetails(message)?.kind;
		return typeof kind === "string" ? kind : undefined;
	}

	private _isStructuredPermanentProviderFailure(message: AssistantMessage): boolean {
		const kind = this._getProviderStreamFailureKind(message);
		return kind === "auth" || kind === "invalid_request" || kind === "refusal";
	}

	private _isStructuredPermanentProviderRetryExhausted(message: AssistantMessage): boolean {
		return this._retryAttempt > 0 && this._isStructuredPermanentProviderFailure(message);
	}

	private _getProviderStreamFailureAuthStatus(message: AssistantMessage): number | undefined {
		const details = this._getProviderStreamFailureDetails(message);
		if (!details) {
			return undefined;
		}

		const kind = details.kind;
		if (kind !== "auth") {
			return undefined;
		}

		const status = details.status;
		if (typeof status === "number") {
			return status;
		}
		if (typeof status === "string") {
			const parsed = Number(status);
			return Number.isInteger(parsed) ? parsed : undefined;
		}
		return undefined;
	}

	private _isConcreteProviderAuthFailure(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		const structuredStatus = this._getProviderStreamFailureAuthStatus(message);
		if (structuredStatus === 401 || structuredStatus === 403) {
			return true;
		}

		if (/\b(?:401|403)\b/.test(message.errorMessage) && /\bstatus code\b/i.test(message.errorMessage)) {
			return true;
		}

		return (
			/\b(?:401|403)\b/.test(message.errorMessage) &&
			/auth|unauthori[sz]ed|forbidden|api.?key|token|credential/i.test(message.errorMessage)
		);
	}

	private _captureRetryAuthFailureSource(message: AssistantMessage): AuthSourceToken | undefined {
		const token = this._modelRegistry.getCurrentProviderAuthSourceToken(message.provider);
		if (!token) {
			return undefined;
		}
		if (
			!this._retryAuthFailureSources.some(
				(existing) =>
					existing.provider === token.provider &&
					existing.source === token.source &&
					existing.identityFingerprint === token.identityFingerprint &&
					existing.valueFingerprint === token.valueFingerprint,
			)
		) {
			this._retryAuthFailureSources.push(token);
		}
		return token;
	}

	private _markProviderAuthStale(message: AssistantMessage, authSourceTokens?: readonly AuthSourceToken[]): boolean {
		if (authSourceTokens && authSourceTokens.length > 0) {
			let marked = false;
			for (const token of authSourceTokens) {
				marked = this._modelRegistry.markProviderAuthSourceStale(token) || marked;
			}
			if (marked) {
				this._emit({ type: "auth_stale", provider: message.provider, sourceTokens: authSourceTokens });
			}
			return marked;
		}
		const marked = this._modelRegistry.markProviderAuthStale(message.provider);
		if (marked) {
			this._emit({ type: "auth_stale", provider: message.provider });
		}
		return marked;
	}

	private _markProviderAuthStaleForRetryFailure(
		message: AssistantMessage,
		options?: { markAuthStaleOnFailure?: boolean; authSourceTokens?: readonly AuthSourceToken[] },
	): boolean {
		const authSourceTokens =
			this._retryAuthFailureSources.length > 0 ? this._retryAuthFailureSources : options?.authSourceTokens;
		if ((authSourceTokens?.length ?? 0) > 0 || options?.markAuthStaleOnFailure) {
			const marked = this._markProviderAuthStale(message, authSourceTokens);
			if (marked && message.errorMessage) {
				message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
			}
			return marked;
		}
		return false;
	}

	private _finishActiveRetryWithFailure(message: AssistantMessage): void {
		if (this._retryAttempt === 0) {
			return;
		}
		this._markProviderAuthStaleForRetryFailure(message);
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt,
			finalError: message.errorMessage,
		});
		this._retryAttempt = 0;
		this._retryAuthFailureSources = [];
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	private async _handleRetryableError(
		message: AssistantMessage,
		options?: { markAuthStaleOnFailure?: boolean; authSourceTokens?: readonly AuthSourceToken[] },
	): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAuthFailureSources = [];
			this._resolveRetry();
			return false;
		}

		// Retry promise is created synchronously in _handleAgentEvent for agent_end.
		// Keep a defensive fallback here in case a future refactor bypasses that path.
		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			// Max retries exceeded, emit final failure and reset
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
			this._resolveRetry(); // Resolve so waitForRetry() completes
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAttempt = 0;
			this._retryAbortController = undefined;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this._resolveRetry();
			this._retryAuthFailureSources = [];
			return false;
		}
		this._retryAbortController = undefined;

		// Retry via continue() - use setTimeout to break out of event handler chain
		setTimeout(() => {
			this.agent.continue().catch(() => {
				// Retry failed - will be caught by next agent_end
			});
		}, 0);

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		if (this._retryAbortController) {
			this._retryAbortController.abort();
			return;
		}
		if (this._retryAttempt > 0) {
			this._autoCompactionAbortController?.abort();
			this._cancelPostCompactionContinue();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: "Retry cancelled",
			});
			this._retryAttempt = 0;
		}
		this._retryAuthFailureSources = [];
		this._resolveRetry();
	}

	/**
	 * Wait for any in-progress retry to complete.
	 * Returns immediately if no retry is in progress.
	 */
	private async waitForRetry(): Promise<void> {
		if (!this._retryPromise) {
			return;
		}

		await this._retryPromise;
		await this.agent.waitForIdle();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	/** Whether an accepted prompt is still running or waiting for retry completion. */
	get hasAcceptedPromptInFlight(): boolean {
		return this._acceptedPromptCompletions.size > 0 || this._acceptedAgentMessagePrompt !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations; transient?: boolean },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
				},
			);

			if (!options?.transient) {
				this.recordBashResult(command, result, options);
			}
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Run a user-initiated bash command (! / !! prefix), emitting bash_start,
	 * bash_output, and bash_end session events so any attached client can render
	 * streaming output. Extensions can intercept execution via the user_bash event.
	 * Execution failures are reported through bash_end rather than a rejected promise;
	 * only the already-running guard and extension dispatch errors reject.
	 * @param command The bash command to execute
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 */
	async runUserBash(
		command: string,
		options?: { excludeFromContext?: boolean; transient?: boolean; runId?: string },
	): Promise<void> {
		if (this.isBashRunning) {
			throw new Error("A bash command is already running");
		}
		// Claim the bash slot synchronously: isBashRunning is otherwise false until
		// executeBash installs its abort controller, which would let a second command
		// slip through during the user_bash extension dispatch below.
		this._userBashRunning = true;
		this._userBashAbortRequested = false;
		// Echoed on bash_start/bash_end so the requesting client can tell its own
		// run apart from other clients' runs broadcast on the same session.
		const identity = {
			...(options?.transient ? { transient: true } : {}),
			...(options?.runId !== undefined ? { runId: options.runId } : {}),
		};
		let end: UserBashEndDetails;
		try {
			end = await this.runUserBashLocked(
				command,
				options?.excludeFromContext ?? false,
				options?.transient ?? false,
				identity,
			);
		} finally {
			this._userBashRunning = false;
		}
		// Emitted after the slot is released so clients never observe a bash_end
		// while the session still rejects new commands as already running.
		this._emit({ type: "bash_end", ...end, ...identity });
		void this._drainQueuedMessagesAfterBash().catch(() => undefined);
	}

	private async _drainQueuedMessagesAfterBash(): Promise<void> {
		await this.agent.waitForIdle();
		this._scheduleSessionInputPump();
	}

	private async runUserBashLocked(
		command: string,
		excludeFromContext: boolean,
		transient: boolean,
		identity: { transient?: boolean; runId?: string },
	): Promise<UserBashEndDetails> {
		const eventResult = await this._extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// Transient runs (side-conversation bash) live only in their pane: they
		// are never recorded, so reloads and rebuilds cannot resurface them.
		const record = transient
			? () => {}
			: (result: BashResult) => this.recordBashResult(command, result, { excludeFromContext });

		this._emit({ type: "bash_start", command, excludeFromContext, ...identity });
		try {
			// If an extension returned a full result, surface it without executing
			if (eventResult?.result) {
				const result = eventResult.result;
				if (result.output) {
					this._emit({ type: "bash_output", chunk: result.output });
				}
				record(result);
				return {
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					fullOutputPath: result.fullOutputPath,
				};
			}

			// An abort that arrived before the process spawned (during extension
			// dispatch) has no abort controller to act on; honor it here instead.
			if (this._userBashAbortRequested) {
				record({ output: "", exitCode: undefined, cancelled: true, truncated: false });
				return { exitCode: undefined, cancelled: true, truncated: false };
			}

			const result = await this.executeBash(command, (chunk) => this._emit({ type: "bash_output", chunk }), {
				excludeFromContext,
				operations: eventResult?.operations,
				transient,
			});
			return {
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
				fullOutputPath: result.fullOutputPath,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Persist the failure like every other outcome so replayed transcripts
			// and the LLM context reflect that the command did not run.
			record({ output: `bash failed: ${errorMessage}`, exitCode: undefined, cancelled: false, truncated: false });
			return {
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				errorMessage,
			};
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		// A user bash command may not have spawned yet (extension dispatch in
		// progress); flag the request so runUserBash cancels before executing.
		if (this._userBashRunning && this._bashAbortController === undefined) {
			this._userBashAbortRequested = true;
		}
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined || this._userBashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	private _branchNavigationQueue: Promise<void> = Promise.resolve();

	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const previous = this._branchNavigationQueue;
		let release = () => {};
		this._branchNavigationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this._navigateTree(targetId, options);
		} finally {
			release();
		}
	}

	private async _navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const queuedWorkPause = this.acquireQueuedWorkPause();
		let admission: { owner: symbol; release(): void } | undefined;
		try {
			admission = await this._acquireTurnAdmission();
			return await this._turnAdmissionContext.run(admission.owner, async () => {
				await this.agent.waitForIdle();
				await this._agentEventQueue;
				return this._navigateTreeUnderPause(targetId, targetEntry, options);
			});
		} finally {
			queuedWorkPause.release();
			admission?.release();
		}
	}

	private async _navigateTreeUnderPause(
		targetId: string,
		targetEntry: NonNullable<ReturnType<SessionManager["getEntry"]>>,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target after admitted work has settled.
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Do not switch branches while /refine has detached event handling and is
		// about to persist harness/session entries for the current branch.
		await this._invalidatePendingAutoRefineForBranchChange();

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();
		let resolveBranchSummaryOperation: () => void = () => {};
		const branchSummaryOperation = new Promise<void>((resolve) => {
			resolveBranchSummaryOperation = resolve;
		});
		this._branchSummaryOperation = branchSummaryOperation;

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			this._mergeUnpersistedCompactionOutcomes(this.agent.state.messages);
			this._restoreLateIpythonSentAgentMessages();
			this._reloadGoalStateFromBranch();
			this._invalidateQueuedPromptPreparation();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			if (this._branchSummaryOperation === branchSummaryOperation) {
				this._branchSummaryOperation = undefined;
			}
			resolveBranchSummaryOperation();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/** RLM session dir holding sub-* child sessions, without creating directories. */
	private _rlmSessionDirForReading(): string | undefined {
		return this._rlmSessionDir ?? this.sessionManager.getSessionArtifactDir();
	}

	private _contextWindowResolver(): ContextWindowResolver {
		return (provider, modelId) => this._modelRegistry.find(provider, modelId)?.contextWindow;
	}

	/**
	 * Build the agent context overview for /context: this session as the root
	 * plus one node per RLM sub-agent, recursively. Running children are read
	 * from their live sessions; completed children from their persisted session
	 * dirs, so the tree survives child disposal and session resume.
	 */
	getContextTree(): ContextTreeNode {
		const resolveContextWindow = this._contextWindowResolver();
		const { ownUsage, totalUsage } = computeOwnAndTotalUsage(
			this.sessionManager.getBranch(),
			this.sessionManager.getEntries(),
		);

		const children: ContextTreeNode[] = [];
		const liveIds = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			liveIds.add(run.id);
			const node =
				run.session?.getContextTree() ?? loadContextTreeChildFromDisk(run.sessionDir, resolveContextWindow);
			children.push({
				...(node ?? {
					ownUsage: emptyUsage(),
					totalUsage: emptyUsage(),
					children: [],
				}),
				id: run.id,
				label: rlmChildLabel(run.prompt),
				status: run.status,
			});
		}
		children.push(...loadContextTreeChildrenFromDisk(this._rlmSessionDirForReading(), resolveContextWindow, liveIds));

		const model = this.model;
		return {
			id: "root",
			label: this.sessionName ?? "main agent",
			status: "active",
			model: model ? { provider: model.provider, id: model.id } : undefined,
			ownUsage,
			totalUsage,
			contextUsage: this.getContextUsage(),
			children,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolve(outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}

function isRlmHeartbeatStatusUpdate(value: unknown): value is AgentRlmHeartbeatStatusUpdate {
	return value === "pause" || value === "resume";
}

function rlmHeartbeatHostResponse(job: AgentCronJob): Record<string, unknown> {
	return {
		id: job.id,
		status: job.status,
		label: job.label ?? null,
		delivery_mode: job.deliveryMode ?? "steer",
		instruction: job.prompt,
		schedule: job.schedule,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		next_run_at: job.nextRunAt ?? null,
		last_run_at: job.lastRunAt ?? null,
		last_error: job.lastError ?? null,
		run_count: job.runCount,
	};
}
