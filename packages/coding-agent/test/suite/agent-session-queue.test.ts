import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyRefinementProposal,
	getGlobalHarnessStateDir,
	getHarnessStatePath,
	getLocalHarnessStateDir,
	type HarnessEntry,
	loadGlobalRefinementHistory,
	loadHarnessState,
	type RefinementResult,
	saveHarnessState,
} from "../../src/core/refinement/index.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";

type AutoRefineReason = "turn_interval" | "compact";

type AutoRefineInternals = {
	_maybeAutoRefine(reason: AutoRefineReason): Promise<void>;
	_scheduleAutoRefine(reason: AutoRefineReason): void;
	_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
	_scheduleAutoRefineAfterAgentEnd(): void;
	_schedulePostCompactionContinue(): void;
	_invalidatePendingAutoRefineForBranchChange(): Promise<void>;
	_cancelPostCompactionContinue(): void;
	_assistantTurnsSinceAutoRefine: number;
	_lastAutoRefineReviewAt: number;
	_compactAutoRefinePending: boolean;
	_turnIntervalAutoRefinePending: boolean;
	_postCompactionContinuationScheduled: boolean;
	_pendingAutoRefineReview?: unknown;
	_autoRefineInProgress: boolean;
	_autoRefineBranchVersion: number;
};

function emptyRefinementResult(): RefinementResult {
	return {
		id: "refine_test",
		summary: "test refinement",
		rationale: "test rationale",
		expectedOutcome: "test outcome",
		appliedEdits: [],
		harnessStatePath: "/tmp/harness_state.json",
	};
}

function createAutoRefineHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	return createHarness({ ...options, persistSession: true });
}

function setAgentStreaming(harness: Harness, isStreaming: boolean): void {
	(harness.session.agent.state as { isStreaming: boolean }).isStreaming = isStreaming;
}

async function createWaitingHarness(
	options: {
		tools?: AgentTool[];
		extensionFactories?: Harness["session"]["extensionRunner"] extends never
			? never
			: Array<(pi: ExtensionAPI) => void>;
	} = {},
): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not count failed assistant messages toward the auto-refine interval", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		harness.setResponses([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "provider failed" })]);

		await harness.session.prompt("fail once");

		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("auto-refine review runs after the configured turn interval", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "durable lesson found",
			instructions: "capture the durable lesson",
		}));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledWith(
			{ reason: "turn_interval", turnsSinceLastReview: 2 },
			expect.any(AbortSignal),
		);
		expect(refine).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: expect.stringContaining("capture the durable lesson") }),
		);
		expect(refine).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: expect.stringContaining("local harness entries") }),
		);
		expect(refine).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: expect.stringContaining("Do not promote anything global") }),
		);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("auto-refine compact hook does not require the turn interval", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: false, rationale: "nothing durable" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 0;

		await internals._maybeAutoRefine("compact");

		expect(reviewer).toHaveBeenCalledWith({ reason: "compact", turnsSinceLastReview: 0 }, expect.any(AbortSignal));
		expect(refine).not.toHaveBeenCalled();
	});

	it("falls back to turn-interval review when compact auto-refine is disabled", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: false, rationale: "nothing durable" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, compact: false, turnInterval: 2, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;

		await internals._maybeAutoRefine("compact");

		expect(reviewer).toHaveBeenCalledWith(
			{ reason: "turn_interval", turnsSinceLastReview: 2 },
			expect.any(AbortSignal),
		);
		expect(internals._compactAutoRefinePending).toBe(false);
	});

	it("declined compact review preserves an already-due turn interval", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: false, rationale: "nothing compact-specific" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		await internals._maybeAutoRefine("compact");

		expect(internals._assistantTurnsSinceAutoRefine).toBe(2);
		expect(scheduleAutoRefine).toHaveBeenCalledWith("turn_interval");
	});

	it("auto-refine compact hook waits for planned post-compaction continuation", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		internals._scheduleAutoRefineAfterCompaction(true);

		expect(internals._compactAutoRefinePending).toBe(true);
		expect(scheduleAutoRefine).not.toHaveBeenCalled();

		internals._scheduleAutoRefineAfterAgentEnd();

		expect(internals._compactAutoRefinePending).toBe(true);
		expect(scheduleAutoRefine).toHaveBeenCalledWith("compact");
		expect(scheduleAutoRefine).toHaveBeenCalledTimes(1);
	});

	it("auto-refine compact hook waits until the scheduled post-compaction continuation starts", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});
		internals._compactAutoRefinePending = true;
		internals._postCompactionContinuationScheduled = true;

		internals._scheduleAutoRefineAfterAgentEnd();

		expect(scheduleAutoRefine).not.toHaveBeenCalled();

		internals._postCompactionContinuationScheduled = false;
		internals._scheduleAutoRefineAfterAgentEnd();

		expect(scheduleAutoRefine).toHaveBeenCalledWith("compact");
		expect(scheduleAutoRefine).toHaveBeenCalledTimes(1);
	});

	it("auto-refine compact hook runs immediately when no post-compaction continuation is planned", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		internals._scheduleAutoRefineAfterCompaction(false);

		expect(internals._compactAutoRefinePending).toBe(false);
		expect(scheduleAutoRefine).toHaveBeenCalledWith("compact");
	});

	it("runs a turn-interval review after a concurrent compact review declines", async () => {
		vi.useFakeTimers();
		let releaseCompactReview: (() => void) | undefined;
		const compactReviewGate = new Promise<void>((resolve) => {
			releaseCompactReview = resolve;
		});
		const reviewer = vi.fn(async ({ reason }: { reason: AutoRefineReason }) => {
			if (reason === "compact") {
				await compactReviewGate;
			}
			return { shouldRefine: false, rationale: `${reason} found nothing durable` };
		});
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;

		try {
			const compactReview = internals._maybeAutoRefine("compact");
			await Promise.resolve();
			await internals._maybeAutoRefine("turn_interval");

			expect(internals._turnIntervalAutoRefinePending).toBe(true);

			releaseCompactReview?.();
			await compactReview;
			await vi.runOnlyPendingTimersAsync();

			expect(reviewer.mock.calls.map(([context]) => context.reason)).toEqual(["compact", "turn_interval"]);
			expect(internals._turnIntervalAutoRefinePending).toBe(false);
			expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a scheduled post-compaction continuation when another run starts first", async () => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const continueAgent = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce(new Error("Agent is already processing. Wait for completion before continuing."))
			.mockResolvedValueOnce();

		try {
			internals._schedulePostCompactionContinue();
			await vi.advanceTimersByTimeAsync(100);

			expect(continueAgent).toHaveBeenCalledTimes(1);
			expect(internals._postCompactionContinuationScheduled).toBe(true);

			await vi.advanceTimersByTimeAsync(100);

			expect(continueAgent).toHaveBeenCalledTimes(2);
			expect(internals._postCompactionContinuationScheduled).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels scheduled post-compaction continuation on branch changes", async () => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		try {
			internals._schedulePostCompactionContinue();
			await internals._invalidatePendingAutoRefineForBranchChange();
			await vi.advanceTimersByTimeAsync(100);

			expect(continueAgent).not.toHaveBeenCalled();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps scheduled post-compaction continuation when manual compaction is skipped", async () => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		try {
			internals._schedulePostCompactionContinue();

			await expect(harness.session.compact()).rejects.toThrow("Session is too short to compact");

			expect(internals._postCompactionContinuationScheduled).toBe(true);
		} finally {
			internals._cancelPostCompactionContinue();
			vi.useRealTimers();
		}
	});

	it("does not run scheduled auto-refine after branch navigation", async () => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const maybeAutoRefine = vi.spyOn(internals, "_maybeAutoRefine").mockResolvedValue();
		try {
			internals._scheduleAutoRefine("compact");
			await internals._invalidatePendingAutoRefineForBranchChange();
			await vi.runAllTimersAsync();

			expect(maybeAutoRefine).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("auto-refine compact hook defers an approved refine if the agent becomes active during review", async () => {
		let finishReview: (() => void) | undefined;
		const reviewStarted = new Promise<void>((resolve) => {
			finishReview = resolve;
		});
		const reviewer = vi.fn(async () => {
			await reviewStarted;
			setAgentStreaming(harness, true);
			return { shouldRefine: true, rationale: "durable lesson" };
		});
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		const autoRefinePromise = internals._maybeAutoRefine("compact");
		expect(reviewer).toHaveBeenCalledWith({ reason: "compact", turnsSinceLastReview: 0 }, expect.any(AbortSignal));
		finishReview?.();
		await autoRefinePromise;

		expect(refine).not.toHaveBeenCalled();
		expect(internals._pendingAutoRefineReview).toBeDefined();
		expect(internals._compactAutoRefinePending).toBe(false);
	});

	it("auto-refine turn interval defers an approved refine if the agent becomes active during review", async () => {
		let finishReview: (() => void) | undefined;
		const reviewStarted = new Promise<void>((resolve) => {
			finishReview = resolve;
		});
		const reviewer = vi.fn(async () => {
			await reviewStarted;
			setAgentStreaming(harness, true);
			return { shouldRefine: true, rationale: "durable lesson" };
		});
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		const autoRefinePromise = internals._maybeAutoRefine("turn_interval");
		expect(reviewer).toHaveBeenCalledWith(
			{ reason: "turn_interval", turnsSinceLastReview: 2 },
			expect.any(AbortSignal),
		);
		finishReview?.();
		await autoRefinePromise;

		expect(refine).not.toHaveBeenCalled();
		expect(internals._pendingAutoRefineReview).toBeDefined();

		setAgentStreaming(harness, false);
		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledTimes(1);
		expect(refine).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: expect.stringContaining("durable lesson") }),
		);
		expect(internals._pendingAutoRefineReview).toBeUndefined();
	});

	it("auto-refine pending review uses the in-progress guard and catches refine failures", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 60_000 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._pendingAutoRefineReview = {
			reason: "turn_interval",
			review: { shouldRefine: true, rationale: "durable lesson" },
		};
		let guardWasSetDuringRefine = false;
		const refine = vi.spyOn(harness.session, "refine").mockImplementation(async () => {
			guardWasSetDuringRefine = internals._autoRefineInProgress;
			throw new Error("refine failed");
		});

		await internals._maybeAutoRefine("turn_interval");

		expect(refine).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: expect.stringContaining("durable lesson") }),
		);
		expect(guardWasSetDuringRefine).toBe(true);
		expect(internals._autoRefineInProgress).toBe(false);
		expect(internals._pendingAutoRefineReview).toBeDefined();
		// The failure stamps the cooldown so the retained pending review does not
		// retry on every agent end.
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);

		refine.mockResolvedValueOnce(emptyRefinementResult());
		await internals._maybeAutoRefine("turn_interval");

		expect(refine).toHaveBeenCalledTimes(1);
		expect(internals._pendingAutoRefineReview).toBeDefined();

		internals._lastAutoRefineReviewAt = 0;
		await internals._maybeAutoRefine("turn_interval");

		expect(internals._pendingAutoRefineReview).toBeUndefined();
	});

	it("keeps the turn counter and stamps the cooldown when an approved immediate refine fails", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;
		vi.spyOn(harness.session, "refine").mockRejectedValueOnce(new Error("refine failed"));

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledWith(
			{ reason: "turn_interval", turnsSinceLastReview: 2 },
			expect.any(AbortSignal),
		);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(2);
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);
	});

	it("does not refine when a review resolves after the session is disposed", async () => {
		let finishReview: (() => void) | undefined;
		const reviewGate = new Promise<void>((resolve) => {
			finishReview = resolve;
		});
		const signals: Array<AbortSignal | undefined> = [];
		const reviewer = vi.fn(
			async (_context: { reason: AutoRefineReason; turnsSinceLastReview: number }, signal?: AbortSignal) => {
				signals.push(signal);
				await reviewGate;
				return { shouldRefine: true, rationale: "durable lesson" };
			},
		);
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		const autoRefinePromise = internals._maybeAutoRefine("turn_interval");
		expect(reviewer).toHaveBeenCalledTimes(1);
		const entriesBeforeDispose = harness.sessionManager.getEntries().length;
		harness.session.dispose();
		expect(signals[0]?.aborted).toBe(true);
		finishReview?.();
		await autoRefinePromise;

		expect(refine).not.toHaveBeenCalled();
		expect(internals._pendingAutoRefineReview).toBeUndefined();
		expect(harness.sessionManager.getEntries().length).toBe(entriesBeforeDispose);

		// Disposal also invalidates any newly scheduled auto-refine.
		await internals._maybeAutoRefine("turn_interval");
		expect(reviewer).toHaveBeenCalledTimes(1);
	});

	it("stamps the cooldown when the auto-refine review fails", async () => {
		const reviewer = vi.fn(async () => {
			throw new Error("review failed");
		});
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledTimes(1);
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledTimes(1);
	});

	it("auto-refine pending review respects the cooldown", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._pendingAutoRefineReview = {
			reason: "turn_interval",
			review: { shouldRefine: true, rationale: "durable lesson" },
		};
		internals._lastAutoRefineReviewAt = Date.now();
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		await internals._maybeAutoRefine("turn_interval");

		expect(refine).not.toHaveBeenCalled();
		expect(internals._pendingAutoRefineReview).toBeDefined();
	});

	it("serializes concurrent refine calls", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		let releaseFirstPlan: (() => void) | undefined;
		const firstPlanGate = new Promise<void>((resolve) => {
			releaseFirstPlan = resolve;
		});
		let firstPlanStarted: (() => void) | undefined;
		const firstPlanStartedPromise = new Promise<void>((resolve) => {
			firstPlanStarted = resolve;
		});
		harness.setResponses([
			async () => {
				firstPlanStarted?.();
				await firstPlanGate;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "first",
						rationale: "first refine",
						expectedOutcome: "first finished",
						edits: [],
					}),
				);
			},
			fauxAssistantMessage(
				JSON.stringify({
					summary: "second",
					rationale: "second refine",
					expectedOutcome: "second finished",
					edits: [],
				}),
			),
		]);

		const firstRefine = harness.session.refine({ instructions: "first refine" });
		await firstPlanStartedPromise;
		const secondRefine = harness.session.refine({ instructions: "second refine" });
		await Promise.resolve();

		expect(harness.getPendingResponseCount()).toBe(1);

		releaseFirstPlan?.();
		await firstRefine;
		await secondRefine;

		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not persist or reconnect an in-flight refine after dispose", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		let releasePlan: (() => void) | undefined;
		const planGate = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		let planStarted: (() => void) | undefined;
		const planStartedPromise = new Promise<void>((resolve) => {
			planStarted = resolve;
		});
		harness.setResponses([
			async () => {
				planStarted?.();
				await planGate;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "stale refine",
						rationale: "the session was disposed before apply",
						expectedOutcome: "nothing is persisted",
						edits: [
							{
								action: "create",
								kind: "memory",
								id: "stale_after_dispose",
								title: "Stale after dispose",
								content: "This must not be saved.",
							},
						],
					}),
				);
			},
		]);
		const internals = harness.session as unknown as { _reconnectToAgent(): void };
		const reconnect = vi.spyOn(internals, "_reconnectToAgent");
		const entriesBeforeDispose = harness.sessionManager.getEntries().length;

		const refine = harness.session.refine({ instructions: "write stale state" });
		await planStartedPromise;
		harness.session.dispose();
		releasePlan?.();

		await expect(refine).rejects.toThrow();
		expect(reconnect).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBeforeDispose);
	});

	it("clears pending auto-refine state when navigating to another branch", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const targetEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(targetEntry).toBeDefined();
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 5;
		internals._compactAutoRefinePending = true;
		internals._pendingAutoRefineReview = {
			reason: "compact",
			review: { shouldRefine: true, rationale: "old branch" },
		};

		await harness.session.navigateTree(targetEntry!.id, { summarize: false });

		expect(internals._compactAutoRefinePending).toBe(false);
		expect(internals._pendingAutoRefineReview).toBeUndefined();
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("does not apply stale auto-refine cooldown when a review completes after branch navigation", async () => {
		let finishReview: (() => void) | undefined;
		const reviewStarted = new Promise<void>((resolve) => {
			finishReview = resolve;
		});
		const reviewer = vi.fn(async () => {
			await reviewStarted;
			return { shouldRefine: true, rationale: "old branch" };
		});
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
		const beforeReviewAt = internals._lastAutoRefineReviewAt;

		const autoRefinePromise = internals._maybeAutoRefine("turn_interval");
		expect(reviewer).toHaveBeenCalledWith(
			{ reason: "turn_interval", turnsSinceLastReview: 2 },
			expect.any(AbortSignal),
		);
		await internals._invalidatePendingAutoRefineForBranchChange();
		finishReview?.();
		await autoRefinePromise;

		expect(refine).not.toHaveBeenCalled();
		expect(internals._lastAutoRefineReviewAt).toBe(beforeReviewAt);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
		expect(internals._pendingAutoRefineReview).toBeUndefined();
	});

	it("auto-refine is skipped for sessions without a local harness directory", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
		const harness = await createHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		await internals._maybeAutoRefine("turn_interval");
		internals._scheduleAutoRefineAfterCompaction(false);
		internals._scheduleAutoRefineAfterAgentEnd();

		expect(reviewer).not.toHaveBeenCalled();
		expect(refine).not.toHaveBeenCalled();
		expect(scheduleAutoRefine).not.toHaveBeenCalled();
	});

	it("auto-refine is skipped for subagent sessions", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			rlmDepth: 1,
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		await internals._maybeAutoRefine("turn_interval");
		internals._scheduleAutoRefineAfterCompaction(false);
		internals._scheduleAutoRefineAfterAgentEnd();

		expect(reviewer).not.toHaveBeenCalled();
		expect(scheduleAutoRefine).not.toHaveBeenCalled();
	});

	it("preserves compact auto-refine pending state when no model is selected", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const state = harness.session.agent.state as { model: typeof harness.session.agent.state.model | undefined };
		state.model = undefined;
		const internals = harness.session as unknown as AutoRefineInternals;

		await internals._maybeAutoRefine("compact");

		expect(internals._compactAutoRefinePending).toBe(true);
	});

	it("auto-refine review obeys the cooldown", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		internals._lastAutoRefineReviewAt = Date.now();

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).not.toHaveBeenCalled();
	});

	it("auto-refine preserves a turn-interval checkpoint when cooldown is active", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		internals._lastAutoRefineReviewAt = Date.now();

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).not.toHaveBeenCalled();
		expect(internals._turnIntervalAutoRefinePending).toBe(true);
	});

	it("auto-refine preserves a compact checkpoint when cooldown is active", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._lastAutoRefineReviewAt = Date.now();

		await internals._maybeAutoRefine("compact");

		expect(reviewer).not.toHaveBeenCalled();
		expect(internals._compactAutoRefinePending).toBe(true);
	});

	it("queued follow-up messages do not make an idle agent active for auto-refine", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "durable lesson found",
			instructions: "capture the durable lesson",
		}));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		vi.spyOn(harness.session.agent, "hasQueuedMessages").mockReturnValue(true);
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledWith(
			{ reason: "turn_interval", turnsSinceLastReview: 1 },
			expect.any(AbortSignal),
		);
		expect(refine).toHaveBeenCalled();
	});

	it("strips local display prefixes before applying local refine edits", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const globalDir = getGlobalHarnessStateDir();
			const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
			const globalState = loadHarnessState(globalDir, "global");
			const localState = loadHarnessState(localDir, "local");
			applyRefinementProposal(
				globalState,
				{
					summary: "Global shared memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "shared",
							title: "Shared",
							content: "Global content",
						},
					],
				},
				{ id: "seed_global", scope: "global" },
			);
			applyRefinementProposal(
				localState,
				{
					summary: "Local shared memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "shared",
							title: "Shared",
							content: "Local content",
						},
					],
				},
				{ id: "seed_local", scope: "local" },
			);
			saveHarnessState(globalDir, globalState);
			saveHarnessState(localDir, localState);
			harness.setResponses([
				fauxAssistantMessage(
					JSON.stringify({
						summary: "Update local shared memory",
						rationale: "The local display id was selected from merged state.",
						expectedOutcome: "Only the local entry changes.",
						edits: [
							{
								action: "update",
								kind: "memory",
								id: "local:shared",
								title: "Shared",
								content: "Updated local content",
							},
						],
					}),
				),
			]);

			const result = await harness.session.refine({ instructions: "update the local shared memory" });

			expect(result.appliedEdits[0]).toMatchObject({ id: "shared", applied: true });
			expect(loadHarnessState(localDir, "local").entries.memory.shared.content).toBe("Updated local content");
			expect(loadHarnessState(globalDir, "global").entries.memory.shared.content).toBe("Global content");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("strips global display prefixes before applying local refine edits", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
			const localState = loadHarnessState(localDir, "local");
			applyRefinementProposal(
				localState,
				{
					summary: "Local memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "shared",
							title: "Shared",
							content: "Local content",
						},
					],
				},
				{ id: "seed_local", scope: "local" },
			);
			saveHarnessState(localDir, localState);
			harness.setResponses([
				fauxAssistantMessage(
					JSON.stringify({
						summary: "Update local memory",
						rationale: "The display id came from merged state.",
						expectedOutcome: "The local entry changes without a prefixed id.",
						edits: [
							{
								action: "update",
								kind: "memory",
								id: "global:shared",
								title: "Shared",
								content: "Updated local content",
							},
						],
					}),
				),
			]);

			const result = await harness.session.refine({ instructions: "update local memory" });

			expect(result.appliedEdits[0]).toMatchObject({ id: "shared", applied: true });
			expect(loadHarnessState(localDir, "local").entries.memory.shared.content).toBe("Updated local content");
			expect(loadHarnessState(localDir, "local").entries.memory["global:shared"]).toBeUndefined();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("strips global display prefixes before applying global refine edits", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const globalDir = getGlobalHarnessStateDir();
			const globalState = loadHarnessState(globalDir, "global");
			applyRefinementProposal(
				globalState,
				{
					summary: "Global shared memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "shared",
							title: "Shared",
							content: "Global content",
						},
					],
				},
				{ id: "seed_global", scope: "global" },
			);
			saveHarnessState(globalDir, globalState);
			harness.setResponses([
				fauxAssistantMessage(
					JSON.stringify({
						summary: "Update global shared memory",
						rationale: "The global display id was selected from the overview.",
						expectedOutcome: "Only the global entry changes.",
						edits: [
							{
								action: "update",
								kind: "memory",
								id: "global:shared",
								title: "Shared",
								content: "Updated global content",
							},
						],
					}),
				),
			]);

			const result = await harness.session.refine({
				instructions: "update the global shared memory",
				global: true,
			});

			expect(result.appliedEdits[0]).toMatchObject({ id: "shared", applied: true });
			expect(loadHarnessState(globalDir, "global").entries.memory.shared.content).toBe("Updated global content");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("rolls back copied local refinement history against the original local harness state", async () => {
		const original = await createAutoRefineHarness();
		const branched = await createAutoRefineHarness();
		harnesses.push(original, branched);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${original.tempDir}/agent`;
		try {
			const originalLocalDir = getLocalHarnessStateDir(original.sessionManager.getSessionArtifactDir())!;
			const branchedLocalDir = getLocalHarnessStateDir(branched.sessionManager.getSessionArtifactDir())!;
			const branchedState = loadHarnessState(branchedLocalDir, "local");
			applyRefinementProposal(
				branchedState,
				{
					summary: "Branch local memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "remember_me",
							title: "Branch memory",
							content: "Branch content should survive rollback of copied history.",
						},
					],
				},
				{ id: "seed_branch", scope: "local" },
			);
			saveHarnessState(branchedLocalDir, branchedState);
			original.setResponses([
				fauxAssistantMessage(
					JSON.stringify({
						summary: "Create original local memory",
						rationale: "seed",
						expectedOutcome: "Original local entry exists.",
						edits: [
							{
								action: "create",
								kind: "memory",
								id: "remember_me",
								title: "Original memory",
								content: "Original content should be rolled back.",
							},
						],
					}),
				),
			]);

			const originalRefinement = await original.session.refine({ instructions: "remember this locally" });
			branched.sessionManager.appendCustomEntry("prime-agent.refinement", originalRefinement);
			expect(loadHarnessState(originalLocalDir, "local").entries.memory.remember_me.content).toBe(
				"Original content should be rolled back.",
			);

			await branched.session.refine({ rollbackId: originalRefinement.id });

			expect(loadHarnessState(originalLocalDir, "local").entries.memory.remember_me).toBeUndefined();
			expect(loadHarnessState(branchedLocalDir, "local").entries.memory.remember_me.content).toBe(
				"Branch content should survive rollback of copied history.",
			);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("persists a prompt started while a background refine is in flight", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			let releasePlan: (() => void) | undefined;
			const planGate = new Promise<void>((resolve) => {
				releasePlan = resolve;
			});
			let planStarted: (() => void) | undefined;
			const planStartedPromise = new Promise<void>((resolve) => {
				planStarted = resolve;
			});
			harness.setResponses([
				async () => {
					planStarted?.();
					await planGate;
					return fauxAssistantMessage(
						JSON.stringify({
							summary: "no-op",
							rationale: "nothing to change",
							expectedOutcome: "unchanged",
							edits: [],
						}),
					);
				},
				fauxAssistantMessage("prompt reply"),
			]);

			const refinePromise = harness.session.refine({ instructions: "background refine" });
			await planStartedPromise;

			const promptPromise = harness.session.prompt("hello during refine");
			await new Promise((resolve) => setTimeout(resolve, 10));
			// The prompt must wait for the refine (its response is still queued);
			// running now would drop its events while the session is detached.
			expect(harness.getPendingResponseCount()).toBe(1);

			releasePlan?.();
			await refinePromise;
			await promptPromise;

			expect(
				harness
					.eventsOfType("message_end")
					.some((event) => event.message.role === "assistant" && getMessageText(event.message) === "prompt reply"),
			).toBe(true);
			const persistedAssistants = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
			expect(persistedAssistants).toHaveLength(1);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("rolls back a local refinement in a non-persisted session via the recorded state path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const recordedDir = join(harness.tempDir, "recorded-local", "harness");
			const recordedState = loadHarnessState(recordedDir, "local");
			const seeded = applyRefinementProposal(
				recordedState,
				{
					summary: "Seed local memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "remember_me",
							title: "Remember",
							content: "Content to roll back",
						},
					],
				},
				{ id: "refine_recorded", scope: "local" },
			);
			seeded.harnessStatePath = saveHarnessState(recordedDir, recordedState);
			harness.sessionManager.appendCustomEntry("prime-agent.refinement", seeded);

			const result = await harness.session.refine({ rollbackId: "refine_recorded" });

			expect(result.rollbackOf).toBe("refine_recorded");
			expect(loadHarnessState(recordedDir, "local").entries.memory.remember_me).toBeUndefined();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("keeps a legacy scope-less rollback in the global store with global scope", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const globalDir = getGlobalHarnessStateDir();
			const timestamp = new Date().toISOString();
			// Legacy (pre-scope) store: entries carry no scope fields.
			const legacyEntry = (id: string, content: string): HarnessEntry => ({
				id,
				kind: "memory",
				title: id,
				content,
				path: "general",
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: timestamp,
				updated_at: timestamp,
				version: 1,
			});
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				getHarnessStatePath(globalDir),
				JSON.stringify({
					schema: 1,
					entries: {
						prompt: {},
						memory: {
							legacy_target: legacyEntry("legacy_target", "Rolled back"),
							keep_me: legacyEntry("keep_me", "Untouched"),
						},
						skill: {},
						subagent: {},
					},
					refinements: [],
				}),
			);
			const legacyRefinement: RefinementResult = {
				id: "refine_legacy",
				summary: "legacy refinement",
				rationale: "legacy",
				expectedOutcome: "legacy",
				appliedEdits: [
					{
						action: "create",
						kind: "memory",
						id: "legacy_target",
						applied: true,
						after: legacyEntry("legacy_target", "Rolled back"),
					},
				],
				harnessStatePath: getHarnessStatePath(globalDir),
			};
			harness.sessionManager.appendCustomEntry("prime-agent.refinement", legacyRefinement);

			const result = await harness.session.refine({ rollbackId: "refine_legacy" });

			expect(result.scope).toBe("global");
			const stored = JSON.parse(readFileSync(getHarnessStatePath(globalDir), "utf8"));
			expect(stored.entries.memory.legacy_target).toBeUndefined();
			expect(stored.entries.memory.keep_me.scope).toBe("global");
			const rollbackRecord = loadGlobalRefinementHistory(globalDir).find(
				(item) => item.rollbackOf === "refine_legacy",
			);
			expect(rollbackRecord).toBeDefined();
			expect(rollbackRecord?.scope).toBe("global");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("dispatches extension commands immediately when prompted while idle", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
	});

	it("delivers extension-origin steering messages before the next LLM call", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "steer now",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("steer now", { deliverAs: "steer" });
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer now"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});

	it("coalesces follow-up messages with the same queue key", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		await harness.session.prompt("heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:one",
		});
		await harness.session.prompt("heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:one",
		});

		expect(harness.session.getFollowUpMessages()).toEqual(["heartbeat"]);

		releaseToolExecution();
		await promptPromise;
	});

	it("reports failed preflight when a duplicate follow-up queue key is not queued", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const preflightResults: boolean[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		await harness.session.prompt("heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:one",
		});
		await harness.session.prompt("heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:one",
			preflightResult: (didSucceed) => preflightResults.push(didSucceed),
		});

		expect(preflightResults).toEqual([false]);
		expect(harness.session.getFollowUpMessages()).toEqual(["heartbeat"]);
		releaseToolExecution();
		await promptPromise;
	});

	it("keeps separate follow-up messages for different queue keys", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first done"),
			fauxAssistantMessage("second done"),
		]);
		await waitForToolStart;
		await harness.session.prompt("heartbeat one", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:one",
		});
		await harness.session.prompt("heartbeat two", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:two",
		});

		expect(harness.session.getFollowUpMessages()).toEqual(["heartbeat one", "heartbeat two"]);

		releaseToolExecution();
		await promptPromise;
	});

	it("removes only the matching coalesced follow-up when texts match", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		await harness.session.prompt("same heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:one",
		});
		await harness.session.prompt("same heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:two",
		});

		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["same heartbeat"]);

		releaseToolExecution();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "same heartbeat"]);
	});

	it("removes coalesced follow-up messages by queue key", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		await harness.session.prompt("heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:one",
		});

		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		releaseToolExecution();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("delivers follow-up messages only after the current run finishes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const assistantSeenBeforeFollowUp: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				assistantSeenBeforeFollowUp.push(
					...context.messages
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						),
				);
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("after current run");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "after current run"]);
		expect(assistantSeenBeforeFollowUp).toContain("");
		expect(getAssistantTexts(harness)).toContain("follow-up response");
	});

	it("delivers multiple steering messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "handled steer 1", "handled steer 2"]);
	});

	it("delivers multiple follow-up messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("handled follow-up 1"),
			fauxAssistantMessage("handled follow-up 2"),
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"original turn complete",
			"handled follow-up 1",
			"handled follow-up 2",
		]);
	});

	it("delivers all steering messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched steer response");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "batched steer response"]);
	});

	it("delivers all follow-up messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "original turn complete", "batched follow-up response"]);
	});

	it("queues custom messages with deliverAs steer while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: { value: 1 } },
			{ deliverAs: "steer" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("queues custom messages with deliverAs followUp while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "follow-up custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "follow-up custom", display: true, details: { value: 1 } },
			{ deliverAs: "followUp" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "user", "assistant"]);
	});

	it("updates pendingMessageCount and removes queued text before message_start is emitted", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const countsAtQueuedMessageStart: number[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued"
			) {
				countsAtQueuedMessageStart.push(harness.session.pendingMessageCount);
			}
		});

		await waitForToolStart;
		await harness.session.steer("queued");
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution();
		await promptPromise;

		expect(countsAtQueuedMessageStart).toEqual([0]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("clears only internally queued agent-message prompts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const spoofed =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_spoof\n\nordinary user text";
		const real =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_real\n\nreal agent text";

		await harness.session.followUp(spoofed);
		await harness.session.queueAgentMessagePrompt(real, "followUp");

		expect(harness.session.clearQueuedAgentMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [],
			followUp: [real],
		});
		expect(harness.session.getFollowUpMessages()).toEqual([spoofed]);
	});

	it("clears internally queued agent-message steering prompts by message identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sharedText =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_shared\n\nshared text";

		await harness.session.steer(sharedText);
		await harness.session.queueAgentMessagePrompt(sharedText, "steer");

		expect(harness.session.clearQueuedAgentMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [sharedText],
			followUp: [],
		});
		expect(harness.session.getSteeringMessages()).toEqual([sharedText]);
	});

	it("clears the agent queue when a queue update listener clears a newly queued steering prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_queue_update_clear\n\nclear during update";
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_queue_update_clear");
		let cleared = false;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "queue_update" && !cleared) {
				cleared = true;
				harness.session.clearQueue();
			}
		});

		await harness.session.queueAgentMessagePrompt(agentPrompt, "steer");
		unsubscribe();
		await expect(delivery).rejects.toThrow("cleared before delivery");
		expect(harness.session.getSteeringMessages()).toEqual([]);

		let sawClearedPrompt = false;
		harness.setResponses([
			(context) => {
				sawClearedPrompt = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes("agentmsg_queue_update_clear"),
				);
				return fauxAssistantMessage("normal response");
			},
		]);
		await harness.session.prompt("normal");

		expect(sawClearedPrompt).toBe(false);
		expect(getUserTexts(harness)).toEqual(["normal"]);
	});

	it("settles late agent-message delivery waiters", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const deliveryInternals = harness.session as unknown as {
			waitForAgentMessagePromptDelivery(agentMessageId: string): Promise<void>;
			_resolveAgentMessageDelivery(agentMessageId: string): void;
			_rejectAgentMessageDelivery(agentMessageId: string, error: Error): void;
		};

		deliveryInternals._resolveAgentMessageDelivery("agentmsg_delivered");
		await expect(deliveryInternals.waitForAgentMessagePromptDelivery("agentmsg_delivered")).resolves.toBeUndefined();

		deliveryInternals._rejectAgentMessageDelivery("agentmsg_failed", new Error("cleared before delivery"));
		await expect(deliveryInternals.waitForAgentMessagePromptDelivery("agentmsg_failed")).rejects.toThrow(
			"cleared before delivery",
		);
	});

	it("keeps queued agent-message delivery waiters pending on abort until the message is delivered", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_abort\n\nsurvive the abort";
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;

		await harness.session.queueAgentMessagePrompt(agentPrompt, "followUp");
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_abort");
		let deliverySettled = false;
		void delivery.then(
			() => {
				deliverySettled = true;
			},
			() => {
				deliverySettled = true;
			},
		);
		expect(harness.session.pendingMessageCount).toBe(1);

		await harness.session.abort();
		await promptPromise;
		await Promise.resolve();

		// The waiter still represents actual delivery, and the surviving queued message has not delivered yet.
		expect(deliverySettled).toBe(false);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual([agentPrompt]);

		harness.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("handled follow-up")]);
		await harness.session.prompt("again");

		await expect(delivery).resolves.toBeUndefined();
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(getUserTexts(harness)).toContain(agentPrompt);
	});

	it("resolves direct agent-message delivery waiters when the accepted prompt starts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_direct\n\ndirect delivery";
		harness.setResponses([fauxAssistantMessage("direct reply")]);

		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_direct");
		await harness.session.acceptAgentMessagePrompt(agentPrompt);

		await expect(delivery).resolves.toBeUndefined();
	});

	it("rejects queued agent-message delivery waiters on dispose", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_dispose\n\ndispose me";
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_dispose");

		await harness.session.queueAgentMessagePrompt(agentPrompt, "followUp");
		harness.session.dispose();

		await expect(delivery).rejects.toThrow("cleared before delivery");
	});

	it("throws when queueing an extension command with steer", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.steer("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("throws when queueing an extension command with followUp", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.followUp("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});
});
