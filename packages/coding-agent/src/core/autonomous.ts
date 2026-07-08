import { spawnSync } from "node:child_process";
import type { AssistantMessage, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";

export interface AgentAutonomousConfig {
	enabled?: boolean;
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	continuationPrompt?: string;
	gates?: AgentAutonomousGateConfig;
}

export interface AgentAutonomousGateConfig {
	commands?: string[];
	maxRetries?: number;
	timeoutMs?: number;
}

export interface AgentAutonomousGateFailure {
	command: string;
	attempt: number;
	exitText: string;
	output: string;
}

export interface AgentAutonomousStatus {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates">>;
	gates: Required<AgentAutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: AgentAutonomousGateFailure;
}

export const DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT =
	"No human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.";

export const DEFAULT_AUTONOMOUS_LIMITS: Required<
	Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates">
> = {
	maxContinuations: 3,
	maxTurns: 12,
	maxTokens: 80_000,
	timeoutMs: 30 * 60 * 1000,
};

export const DEFAULT_AUTONOMOUS_GATES: Required<AgentAutonomousGateConfig> = {
	commands: [],
	maxRetries: 3,
	timeoutMs: 5 * 60 * 1000,
};

export interface AutonomousRuntimeState {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: Required<Omit<AgentAutonomousConfig, "enabled" | "continuationPrompt" | "gates">>;
	continuationPrompt: string;
	gates: Required<AgentAutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: GateFailure;
	lastGateFailureSnapshot?: GitWorktreeSnapshot;
	gitBaseline?: GitWorktreeSnapshot;
}

export interface AutonomousDecision {
	shouldContinue: boolean;
	reason: "missing_terminal_evidence" | "gate_failed" | "not_needed" | "limit_reached";
}

interface GitWorktreeSnapshot {
	status: string;
	diff: string;
}

type GateFailure = AgentAutonomousGateFailure;

export function createAutonomousRuntimeState(
	config?: AgentAutonomousConfig,
	options: { cwd?: string } = {},
): AutonomousRuntimeState {
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
		gates: {
			commands: [...(config?.gates?.commands ?? DEFAULT_AUTONOMOUS_GATES.commands)],
			maxRetries: normalizeLimit(config?.gates?.maxRetries, DEFAULT_AUTONOMOUS_GATES.maxRetries),
			timeoutMs: normalizeLimit(config?.gates?.timeoutMs, DEFAULT_AUTONOMOUS_GATES.timeoutMs),
		},
		gateAttempts: {},
		lastGateFailure: undefined,
		lastGateFailureSnapshot: undefined,
		gitBaseline: enabled ? captureGitWorktreeSnapshot(options.cwd) : undefined,
	};
}

export function setAutonomousEnabled(
	state: AutonomousRuntimeState,
	enabled: boolean,
	options: { cwd?: string } = {},
): void {
	state.enabled = enabled;
	if (enabled) {
		state.continuationsUsed = 0;
		state.turnsUsed = 0;
		state.tokensUsed = 0;
		state.startedAt = Date.now();
		state.gateAttempts = {};
		state.lastGateFailure = undefined;
		state.lastGateFailureSnapshot = undefined;
		state.gitBaseline = captureGitWorktreeSnapshot(options.cwd);
	} else {
		state.startedAt = undefined;
		state.gateAttempts = {};
		state.lastGateFailure = undefined;
		state.lastGateFailureSnapshot = undefined;
		state.gitBaseline = undefined;
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
		gates: { ...state.gates, commands: [...state.gates.commands] },
		gateAttempts: { ...state.gateAttempts },
		lastGateFailure: state.lastGateFailure ? { ...state.lastGateFailure } : undefined,
	};
}

export function addAutonomousUsage(state: AutonomousRuntimeState, usage: Usage | undefined): void {
	if (!state.enabled) {
		return;
	}
	state.turnsUsed++;
	state.tokensUsed += autonomousTokenDelta(usage);
}

export function addAutonomousContinuation(state: AutonomousRuntimeState): void {
	if (!state.enabled) {
		return;
	}
	state.continuationsUsed++;
}

function autonomousTokenDelta(usage: Usage | undefined): number {
	if (!usage) {
		return 0;
	}
	// Cache-read tokens are repeated context served from provider cache. Counting them
	// cumulatively makes long autonomous verifier loops exhaust their host-side token
	// budget far before the non-cached work reaches the configured cap.
	return usage.input + usage.output + usage.cacheWrite;
}

export function nextAutonomousContinuation(
	state: AutonomousRuntimeState,
	message: AssistantMessage,
	options: { cwd?: string } = {},
	now = Date.now(),
): UserMessage | undefined {
	if (!state.enabled) {
		return undefined;
	}
	const decision = shouldAutonomouslyContinue(state, message, options, now);
	if (!decision.shouldContinue) {
		return undefined;
	}
	state.continuationsUsed++;
	return {
		role: "user",
		content: [
			{
				type: "text",
				text:
					decision.reason === "gate_failed"
						? (buildGateFailureContinuation(state, now) ?? state.continuationPrompt)
						: state.continuationPrompt,
			},
		],
		timestamp: now,
	};
}

export function shouldAutonomouslyContinue(
	state: AutonomousRuntimeState,
	message: AssistantMessage,
	options: { cwd?: string } = {},
	now = Date.now(),
): AutonomousDecision {
	if (!state.enabled || message.stopReason === "error" || message.stopReason === "aborted") {
		return { shouldContinue: false, reason: "not_needed" };
	}
	if (state.gates.commands.length > 0) {
		const gateResult = runAutonomousQualityGates(state, options.cwd);
		if (gateResult === "passed") {
			return { shouldContinue: false, reason: "not_needed" };
		}
		if (gateResult === "retry_exhausted" || autonomousLimitReached(state, now)) {
			return { shouldContinue: false, reason: "limit_reached" };
		}
		return { shouldContinue: true, reason: "gate_failed" };
	}
	if (autonomousLimitReached(state, now)) {
		return { shouldContinue: false, reason: "limit_reached" };
	}
	return { shouldContinue: true, reason: "missing_terminal_evidence" };
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

type GateResult = "passed" | "failed" | "retry_exhausted";

function runAutonomousQualityGates(state: AutonomousRuntimeState, cwd: string | undefined): GateResult {
	if (!cwd) {
		return "failed";
	}
	for (const command of state.gates.commands) {
		const currentSnapshot = captureGitWorktreeSnapshot(cwd);
		if (
			state.lastGateFailure?.command === command &&
			state.lastGateFailureSnapshot &&
			gitWorktreeSnapshotsEqual(currentSnapshot, state.lastGateFailureSnapshot)
		) {
			const attempt = (state.gateAttempts[command] ?? state.lastGateFailure.attempt) + 1;
			state.gateAttempts[command] = attempt;
			state.lastGateFailure = {
				...state.lastGateFailure,
				attempt,
				exitText: "not rerun: workspace unchanged since previous failed gate",
				output:
					"The autonomous gate was not rerun because the workspace has not changed since this failure. Edit source files, tests, or a blocker artifact before attempting to finish again.",
			};
			return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
		}
		const result = spawnSync(command, {
			cwd,
			encoding: "utf8",
			shell: true,
			timeout: state.gates.timeoutMs,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const postRunSnapshot = captureGitWorktreeSnapshot(cwd);
		if (result.status === 0 && !result.error) {
			state.gateAttempts[command] = 0;
			if (state.lastGateFailure?.command === command) {
				state.lastGateFailure = undefined;
				state.lastGateFailureSnapshot = undefined;
			}
			continue;
		}
		const attempt = (state.gateAttempts[command] ?? 0) + 1;
		state.gateAttempts[command] = attempt;
		const exitText =
			result.error?.message ??
			(result.signal ? `terminated by ${result.signal}` : `exited ${result.status ?? "unknown"}`);
		state.lastGateFailure = {
			command,
			attempt,
			exitText,
			output: truncateGateOutput([result.stdout, result.stderr].filter(Boolean).join("\n").trim()),
		};
		state.lastGateFailureSnapshot = postRunSnapshot;
		return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
	}
	state.lastGateFailure = undefined;
	state.lastGateFailureSnapshot = undefined;
	return "passed";
}

function buildGateFailureContinuation(state: AutonomousRuntimeState, timestamp: number): string | undefined {
	const failure = state.lastGateFailure;
	if (!failure) {
		return undefined;
	}
	return (
		`Autonomous quality gate failed (attempt ${failure.attempt}/${state.gates.maxRetries}): \`${failure.command}\` ${failure.exitText}.\n` +
		(failure.output ? `\nOutput:\n${failure.output}\n` : "\n") +
		`\nContinue working. Fix the failure, then produce terminal evidence. Timestamp: ${new Date(timestamp).toISOString()}.`
	);
}

function gitWorktreeSnapshotsEqual(a: GitWorktreeSnapshot | undefined, b: GitWorktreeSnapshot | undefined): boolean {
	return !!a && !!b && a.status === b.status && a.diff === b.diff;
}

function captureGitWorktreeSnapshot(cwd: string | undefined): GitWorktreeSnapshot | undefined {
	if (!cwd) {
		return undefined;
	}
	const pathspec = [
		"--",
		".",
		":(exclude)verification",
		":(exclude)target",
		":(exclude).vf-prime-agent",
		":(exclude)Cargo.lock",
		":(exclude)submission.tar.gz",
		":(exclude)runner_args.log",
	];
	const status = spawnSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-uall", ...pathspec], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (status.status !== 0 || typeof status.stdout !== "string") {
		return undefined;
	}
	const diff = spawnSync("git", ["--no-optional-locks", "diff", "--no-ext-diff", "--binary", "HEAD", ...pathspec], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return {
		status: status.stdout,
		diff: diff.status === 0 && typeof diff.stdout === "string" ? diff.stdout : "",
	};
}

function truncateGateOutput(output: string, maxChars = 6000): string {
	if (output.length <= maxChars) {
		return output;
	}
	return `${output.slice(0, maxChars)}\n... [truncated ${output.length - maxChars} chars]`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) {
		return fallback;
	}
	return Math.trunc(value);
}
