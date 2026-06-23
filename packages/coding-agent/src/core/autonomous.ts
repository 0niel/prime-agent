import type { AssistantMessage, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";

export interface AgentAutonomousConfig {
	enabled?: boolean;
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	continuationPrompt?: string;
}

export interface AgentAutonomousStatus {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt">>;
}

export const DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT =
	"Continue autonomously. Make a reasonable assumption, inspect the repo, run tests, and only stop when you have a validated patch or a concrete external blocker. If you are blocked, state the exact blocker and the evidence.";

export const DEFAULT_AUTONOMOUS_LIMITS: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt">> = {
	maxContinuations: 3,
	maxTurns: 12,
	maxTokens: 80_000,
	timeoutMs: 30 * 60 * 1000,
};

export interface AutonomousRuntimeState {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt">>;
	continuationPrompt: string;
}

export interface AutonomousDecision {
	shouldContinue: boolean;
	reason: "asks_user" | "soft_blocker" | "real_blocker" | "not_needed" | "limit_reached";
}

export function createAutonomousRuntimeState(config?: AgentAutonomousConfig): AutonomousRuntimeState {
	const enabled = config?.enabled === true;
	return {
		enabled,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		startedAt: enabled ? Date.now() : undefined,
		limits: {
			maxContinuations: normalizeLimit(config?.maxContinuations, DEFAULT_AUTONOMOUS_LIMITS.maxContinuations),
			maxTurns: normalizeLimit(config?.maxTurns, DEFAULT_AUTONOMOUS_LIMITS.maxTurns),
			maxTokens: normalizeLimit(config?.maxTokens, DEFAULT_AUTONOMOUS_LIMITS.maxTokens),
			timeoutMs: normalizeLimit(config?.timeoutMs, DEFAULT_AUTONOMOUS_LIMITS.timeoutMs),
		},
		continuationPrompt: config?.continuationPrompt?.trim() || DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
	};
}

export function setAutonomousEnabled(state: AutonomousRuntimeState, enabled: boolean): void {
	state.enabled = enabled;
	if (enabled) {
		state.continuationsUsed = 0;
		state.turnsUsed = 0;
		state.tokensUsed = 0;
		state.startedAt = Date.now();
	} else {
		state.startedAt = undefined;
	}
}

export function autonomousStatus(state: AutonomousRuntimeState): AgentAutonomousStatus {
	return {
		enabled: state.enabled,
		continuationsUsed: state.continuationsUsed,
		turnsUsed: state.turnsUsed,
		tokensUsed: state.tokensUsed,
		startedAt: state.startedAt,
		limits: { ...state.limits },
	};
}

export function addAutonomousUsage(state: AutonomousRuntimeState, usage: Usage | undefined): void {
	if (!state.enabled) {
		return;
	}
	state.turnsUsed++;
	state.tokensUsed += usage?.totalTokens ?? 0;
}

export function nextAutonomousContinuation(
	state: AutonomousRuntimeState,
	message: AssistantMessage,
	now = Date.now(),
): UserMessage | undefined {
	if (!state.enabled) {
		return undefined;
	}
	const decision = shouldAutonomouslyContinue(state, message, now);
	if (!decision.shouldContinue) {
		return undefined;
	}
	state.continuationsUsed++;
	return {
		role: "user",
		content: [{ type: "text", text: state.continuationPrompt }],
		timestamp: now,
	};
}

export function shouldAutonomouslyContinue(
	state: AutonomousRuntimeState,
	message: AssistantMessage,
	now = Date.now(),
): AutonomousDecision {
	if (!state.enabled || message.stopReason === "error" || message.stopReason === "aborted") {
		return { shouldContinue: false, reason: "not_needed" };
	}
	if (autonomousLimitReached(state, now)) {
		return { shouldContinue: false, reason: "limit_reached" };
	}
	const text = assistantText(message);
	if (!text) {
		return { shouldContinue: false, reason: "not_needed" };
	}
	if (isRealExternalBlocker(text)) {
		return { shouldContinue: false, reason: "real_blocker" };
	}
	if (asksUserForHelp(text)) {
		return { shouldContinue: true, reason: "asks_user" };
	}
	if (reportsSoftBlocker(text)) {
		return { shouldContinue: true, reason: "soft_blocker" };
	}
	return { shouldContinue: false, reason: "not_needed" };
}

export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function autonomousLimitReached(state: AutonomousRuntimeState, now: number): boolean {
	if (state.continuationsUsed >= state.limits.maxContinuations) {
		return true;
	}
	if (state.turnsUsed >= state.limits.maxTurns) {
		return true;
	}
	if (state.tokensUsed >= state.limits.maxTokens) {
		return true;
	}
	return state.startedAt !== undefined && now - state.startedAt >= state.limits.timeoutMs;
}

function asksUserForHelp(text: string): boolean {
	const normalized = normalize(text);
	return [
		/\bcan you\b/,
		/\bcould you\b/,
		/\bdo you want\b/,
		/\bwhich\b.*\?/,
		/\bwhat should\b/,
		/\bplease (provide|confirm|choose|tell|share)\b/,
		/\blet me know\b/,
		/\bneed your\b/,
		/\bwaiting for\b.*\b(user|you|input|confirmation)\b/,
	].some((pattern) => pattern.test(normalized));
}

function reportsSoftBlocker(text: string): boolean {
	const normalized = normalize(text);
	return [
		/\bi'?m blocked\b/,
		/\bi am blocked\b/,
		/\bi'?m stuck\b/,
		/\bi am stuck\b/,
		/\bcannot proceed\b/,
		/\bcan't proceed\b/,
		/\bblocked until\b/,
	].some((pattern) => pattern.test(normalized));
}

function isRealExternalBlocker(text: string): boolean {
	const normalized = normalize(text);
	const blockerLanguage =
		/\b(blocked|cannot proceed|can't proceed|cannot continue|can't continue|need|requires|required)\b/.test(
			normalized,
		);
	if (!blockerLanguage) {
		return false;
	}
	return [
		/\b(api key|credential|secret|token|oauth|login|sign in|authenticate|authentication)\b/,
		/\b(permission denied|access denied|403|401|unauthorized|forbidden)\b/,
		/\b(service outage|network unavailable|rate limit|quota exceeded)\b/,
		/\bmanual approval\b/,
		/\bexternal account\b/,
	].some((pattern) => pattern.test(normalized));
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) {
		return fallback;
	}
	return Math.trunc(value);
}
