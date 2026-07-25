import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import { createSessionSlashCommandMessage } from "../../src/core/messages.js";
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
import { parseSessionSlashCommand } from "../../src/core/slash-commands.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";
import { createDeferred, createWaitingHarness, gatedHook, withStreaming } from "./scheduling.js";

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

type SteeringStopInternals = {
	_steeringStopPending: boolean;
	_clearQueuedGoalContexts(): void;
};

function testAgentMessage(id: string, message: string) {
	return createAgentSessionMessage({
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		target: { activeSessionId: "target-active", sessionId: "target-session" },
		deliveryMode: "steer",
	});
}

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

function refinePlanJson(summary: string, edits: unknown[] = []): string {
	return JSON.stringify({
		summary,
		rationale: `${summary} rationale`,
		expectedOutcome: `${summary} outcome`,
		edits,
	});
}

function createAutoRefineHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	return createHarness({ ...options, persistSession: true });
}

const skipReviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));

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

	it.each([
		{
			name: "review runs after the configured turn interval",
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			turns: 2,
			reason: "turn_interval" as AutoRefineReason,
			review: {
				shouldRefine: true,
				rationale: "durable lesson found",
				instructions: "capture the durable lesson",
			},
			expectedReviewContext: { reason: "turn_interval", turnsSinceLastReview: 2 },
			refineFragments: ["capture the durable lesson", "local harness entries", "Do not promote anything global"],
			turnsAfter: 0,
			compactPendingAfter: undefined as boolean | undefined,
			scheduleCalledWith: undefined as AutoRefineReason | undefined,
			queuedMessages: false,
		},
		{
			name: "compact hook does not require the turn interval",
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
			turns: 0,
			reason: "compact" as AutoRefineReason,
			review: { shouldRefine: false, rationale: "nothing durable" },
			expectedReviewContext: { reason: "compact", turnsSinceLastReview: 0 },
			refineFragments: undefined as string[] | undefined,
			turnsAfter: undefined as number | undefined,
			compactPendingAfter: undefined,
			scheduleCalledWith: undefined,
			queuedMessages: false,
		},
		{
			name: "falls back to turn-interval review when compact auto-refine is disabled",
			settings: { autoRefine: { enabled: true, compact: false, turnInterval: 2, cooldownMs: 0 } },
			turns: 2,
			reason: "compact" as AutoRefineReason,
			review: { shouldRefine: false, rationale: "nothing durable" },
			expectedReviewContext: { reason: "turn_interval", turnsSinceLastReview: 2 },
			refineFragments: undefined,
			turnsAfter: undefined,
			compactPendingAfter: false as boolean | undefined,
			scheduleCalledWith: undefined,
			queuedMessages: false,
		},
		{
			name: "declined compact review preserves an already-due turn interval",
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			turns: 2,
			reason: "compact" as AutoRefineReason,
			review: { shouldRefine: false, rationale: "nothing compact-specific" },
			expectedReviewContext: undefined as { reason: string; turnsSinceLastReview: number } | undefined,
			refineFragments: undefined,
			turnsAfter: 2,
			compactPendingAfter: undefined,
			scheduleCalledWith: "turn_interval" as AutoRefineReason | undefined,
			queuedMessages: false,
		},
		{
			name: "queued follow-up messages do not make an idle agent active",
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			turns: 1,
			reason: "turn_interval" as AutoRefineReason,
			review: {
				shouldRefine: true,
				rationale: "durable lesson found",
				instructions: "capture the durable lesson",
			},
			expectedReviewContext: { reason: "turn_interval", turnsSinceLastReview: 1 },
			refineFragments: [],
			turnsAfter: undefined,
			compactPendingAfter: undefined,
			scheduleCalledWith: undefined,
			queuedMessages: true,
		},
	])(
		"auto-refine $name",
		async ({
			settings,
			turns,
			reason,
			review,
			expectedReviewContext,
			refineFragments,
			turnsAfter,
			compactPendingAfter,
			scheduleCalledWith,
			queuedMessages,
		}) => {
			const reviewer = vi.fn(async () => review);
			const harness = await createAutoRefineHarness({ settings, autoRefineReviewer: reviewer });
			harnesses.push(harness);
			const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
			const internals = harness.session as unknown as AutoRefineInternals;
			internals._assistantTurnsSinceAutoRefine = turns;
			const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});
			if (queuedMessages) vi.spyOn(harness.session.agent, "hasQueuedMessages").mockReturnValue(true);

			await internals._maybeAutoRefine(reason);

			if (expectedReviewContext !== undefined) {
				expect(reviewer).toHaveBeenCalledWith(expectedReviewContext, expect.any(AbortSignal));
			}
			if (refineFragments === undefined) {
				expect(refine).not.toHaveBeenCalled();
			} else {
				expect(refine).toHaveBeenCalled();
				for (const fragment of refineFragments) {
					expect(refine).toHaveBeenCalledWith(
						expect.objectContaining({ instructions: expect.stringContaining(fragment) }),
					);
				}
			}
			if (turnsAfter !== undefined) expect(internals._assistantTurnsSinceAutoRefine).toBe(turnsAfter);
			if (compactPendingAfter !== undefined) expect(internals._compactAutoRefinePending).toBe(compactPendingAfter);
			if (scheduleCalledWith !== undefined) expect(scheduleAutoRefine).toHaveBeenCalledWith(scheduleCalledWith);
		},
	);

	it.each([
		{
			name: "waits for planned post-compaction continuation",
			act: (internals: AutoRefineInternals, expectSchedule: (called: boolean) => void) => {
				internals._scheduleAutoRefineAfterCompaction(true);
				expect(internals._compactAutoRefinePending).toBe(true);
				expectSchedule(false);
				internals._scheduleAutoRefineAfterAgentEnd();
				expect(internals._compactAutoRefinePending).toBe(true);
			},
		},
		{
			name: "waits until the scheduled post-compaction continuation starts",
			act: (internals: AutoRefineInternals, expectSchedule: (called: boolean) => void) => {
				internals._compactAutoRefinePending = true;
				internals._postCompactionContinuationScheduled = true;
				internals._scheduleAutoRefineAfterAgentEnd();
				expectSchedule(false);
				internals._postCompactionContinuationScheduled = false;
				internals._scheduleAutoRefineAfterAgentEnd();
			},
		},
		{
			name: "runs immediately when no post-compaction continuation is planned",
			act: (internals: AutoRefineInternals) => {
				internals._scheduleAutoRefineAfterCompaction(false);
				expect(internals._compactAutoRefinePending).toBe(false);
			},
		},
	])("auto-refine compact hook $name", async ({ act }) => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		act(internals, (called) =>
			called ? expect(scheduleAutoRefine).toHaveBeenCalled() : expect(scheduleAutoRefine).not.toHaveBeenCalled(),
		);

		expect(scheduleAutoRefine).toHaveBeenCalledWith("compact");
		expect(scheduleAutoRefine).toHaveBeenCalledTimes(1);
	});

	it("runs a turn-interval review after a concurrent compact review declines", async () => {
		vi.useFakeTimers();
		const compactReviewGate = createDeferred();
		const reviewer = vi.fn(async ({ reason }: { reason: AutoRefineReason }) => {
			if (reason === "compact") {
				await compactReviewGate.promise;
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

			compactReviewGate.resolve();
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

	it.each([
		{ name: "requestAbort", abort: (harness: Harness) => harness.session.requestAbort() },
		{
			name: "abortForUpdateRestart",
			abort: (harness: Harness) => harness.session.abortForUpdateRestart(),
		},
	])("cancels scheduled post-compaction continuation at $name without dropping queued input", async ({ abort }) => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		try {
			internals._schedulePostCompactionContinue();
			await harness.session.followUp("queued across abort");

			abort(harness);
			await vi.advanceTimersByTimeAsync(100);

			expect(continueAgent).not.toHaveBeenCalled();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(harness.session.getFollowUpMessages()).toEqual(["queued across abort"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps scheduled post-compaction continuation when session-input pump compaction skips without aborting", async () => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		try {
			internals._schedulePostCompactionContinue();

			await expect(harness.session.compact(undefined, { skipAbort: true })).rejects.toThrow(
				"Session is too short to compact",
			);

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

	it.each([
		{
			trigger: "compact" as AutoRefineReason,
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
			turns: 0,
			expectedContext: { reason: "compact", turnsSinceLastReview: 0 },
			resumeWhenIdle: false,
		},
		{
			trigger: "turn_interval" as AutoRefineReason,
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 60_000 } },
			turns: 2,
			expectedContext: { reason: "turn_interval", turnsSinceLastReview: 2 },
			resumeWhenIdle: true,
		},
	])(
		"auto-refine $trigger defers an approved refine if the agent becomes active during review",
		async ({ trigger, settings, turns, expectedContext, resumeWhenIdle }) => {
			const reviewStarted = createDeferred();
			const reviewer = vi.fn(async () => {
				await reviewStarted.promise;
				withStreaming(harness, true);
				return { shouldRefine: true, rationale: "durable lesson" };
			});
			const harness = await createAutoRefineHarness({ settings, autoRefineReviewer: reviewer });
			harnesses.push(harness);
			const internals = harness.session as unknown as AutoRefineInternals;
			internals._assistantTurnsSinceAutoRefine = turns;
			const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

			const autoRefinePromise = internals._maybeAutoRefine(trigger);
			expect(reviewer).toHaveBeenCalledWith(expectedContext, expect.any(AbortSignal));
			reviewStarted.resolve();
			await autoRefinePromise;

			expect(refine).not.toHaveBeenCalled();
			expect(internals._pendingAutoRefineReview).toBeDefined();
			if (trigger === "compact") expect(internals._compactAutoRefinePending).toBe(false);

			if (resumeWhenIdle) {
				withStreaming(harness, false);
				await internals._maybeAutoRefine(trigger);

				expect(reviewer).toHaveBeenCalledTimes(1);
				expect(refine).toHaveBeenCalledWith(
					expect.objectContaining({ instructions: expect.stringContaining("durable lesson") }),
				);
				expect(internals._pendingAutoRefineReview).toBeUndefined();
			}
		},
	);

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
		const reviewGate = createDeferred();
		const signals: Array<AbortSignal | undefined> = [];
		const reviewer = vi.fn(
			async (_context: { reason: AutoRefineReason; turnsSinceLastReview: number }, signal?: AbortSignal) => {
				signals.push(signal);
				await reviewGate.promise;
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
		reviewGate.resolve();
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
		const firstPlanGate = createDeferred();
		const firstPlanStartedPromise = createDeferred();
		harness.setResponses([
			async () => {
				firstPlanStartedPromise.resolve();
				await firstPlanGate.promise;
				return fauxAssistantMessage(refinePlanJson("first"));
			},
			fauxAssistantMessage(refinePlanJson("second")),
		]);

		const firstRefine = harness.session.refine({ instructions: "first refine" });
		await firstPlanStartedPromise.promise;
		const secondRefine = harness.session.refine({ instructions: "second refine" });
		await Promise.resolve();

		expect(harness.getPendingResponseCount()).toBe(1);

		firstPlanGate.resolve();
		await firstRefine;
		await secondRefine;

		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not persist or reconnect an in-flight refine after dispose", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const planGate = createDeferred();
		const planStartedPromise = createDeferred();
		harness.setResponses([
			async () => {
				planStartedPromise.resolve();
				await planGate.promise;
				return fauxAssistantMessage(
					refinePlanJson("stale refine", [
						{
							action: "create",
							kind: "memory",
							id: "stale_after_dispose",
							title: "Stale after dispose",
							content: "This must not be saved.",
						},
					]),
				);
			},
		]);
		const internals = harness.session as unknown as { _reconnectToAgent(): void };
		const reconnect = vi.spyOn(internals, "_reconnectToAgent");
		const entriesBeforeDispose = harness.sessionManager.getEntries().length;

		const refine = harness.session.refine({ instructions: "write stale state" });
		await planStartedPromise.promise;
		harness.session.dispose();
		planGate.resolve();

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

	it("waits for an active direct prompt before navigating", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();
		let navigated = false;
		const navigation = harness.session.navigateTree(target!.id).then(() => {
			navigated = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(navigated).toBe(false);

		releaseToolExecution();
		await promptPromise;
		await navigation;
		expect(navigated).toBe(true);
	});

	it("keeps queued work paused until tree navigation events settle", async () => {
		const treeEvent = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", async () => treeEvent.promise);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("queued")]);
		await harness.session.prompt("first");
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();

		const navigation = harness.session.navigateTree(target!.id, { summarize: false });
		await harness.session.followUp("after navigation", undefined, { resumeIfIdle: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getUserTexts(harness)).not.toContain("after navigation");

		treeEvent.resolve();
		await navigation;
		await vi.waitFor(() => expect(getUserTexts(harness)).toContain("after navigation"));
	});

	it("does not apply stale auto-refine cooldown when a review completes after branch navigation", async () => {
		const reviewStarted = createDeferred();
		const reviewer = vi.fn(async () => {
			await reviewStarted.promise;
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
		reviewStarted.resolve();
		await autoRefinePromise;

		expect(refine).not.toHaveBeenCalled();
		expect(internals._lastAutoRefineReviewAt).toBe(beforeReviewAt);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
		expect(internals._pendingAutoRefineReview).toBeUndefined();
	});

	it.each([
		{
			name: "sessions without a local harness directory",
			makeHarness: () =>
				createHarness({
					settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
					autoRefineReviewer: skipReviewer,
				}),
			expectRefineChecked: true,
		},
		{
			name: "subagent sessions",
			makeHarness: () =>
				createAutoRefineHarness({
					settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
					rlmDepth: 1,
					autoRefineReviewer: skipReviewer,
				}),
			expectRefineChecked: false,
		},
	])("auto-refine is skipped for $name", async ({ makeHarness, expectRefineChecked }) => {
		skipReviewer.mockClear();
		const harness = await makeHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		await internals._maybeAutoRefine("turn_interval");
		internals._scheduleAutoRefineAfterCompaction(false);
		internals._scheduleAutoRefineAfterAgentEnd();

		expect(skipReviewer).not.toHaveBeenCalled();
		if (expectRefineChecked) expect(refine).not.toHaveBeenCalled();
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

	it.each([
		{ reason: "turn_interval" as AutoRefineReason, turns: 1, pendingFlag: "_turnIntervalAutoRefinePending" as const },
		{ reason: "compact" as AutoRefineReason, turns: 0, pendingFlag: "_compactAutoRefinePending" as const },
	])(
		"auto-refine review obeys the cooldown and preserves a $reason checkpoint",
		async ({ reason, turns, pendingFlag }) => {
			const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
			const harness = await createAutoRefineHarness({
				settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
				autoRefineReviewer: reviewer,
			});
			harnesses.push(harness);
			const internals = harness.session as unknown as AutoRefineInternals;
			internals._assistantTurnsSinceAutoRefine = turns;
			internals._lastAutoRefineReviewAt = Date.now();

			await internals._maybeAutoRefine(reason);

			expect(reviewer).not.toHaveBeenCalled();
			expect(internals[pendingFlag]).toBe(true);
		},
	);

	it.each([
		{
			name: "local display prefixes before applying local refine edits",
			seedGlobal: true,
			seedLocal: true,
			editId: "local:shared",
			refineOptions: { instructions: "update the local shared memory" },
			updatedContent: "Updated local content",
			expectLocalContent: "Updated local content" as string | undefined,
			expectGlobalContent: "Global content" as string | undefined,
		},
		{
			name: "global display prefixes before applying local refine edits",
			seedGlobal: false,
			seedLocal: true,
			editId: "global:shared",
			refineOptions: { instructions: "update local memory" },
			updatedContent: "Updated local content",
			expectLocalContent: "Updated local content" as string | undefined,
			expectGlobalContent: undefined as string | undefined,
		},
		{
			name: "global display prefixes before applying global refine edits",
			seedGlobal: true,
			seedLocal: false,
			editId: "global:shared",
			refineOptions: { instructions: "update the global shared memory", global: true },
			updatedContent: "Updated global content",
			expectLocalContent: undefined as string | undefined,
			expectGlobalContent: "Updated global content" as string | undefined,
		},
	])(
		"strips $name",
		async ({
			seedGlobal,
			seedLocal,
			editId,
			refineOptions,
			updatedContent,
			expectLocalContent,
			expectGlobalContent,
		}) => {
			const harness = await createAutoRefineHarness();
			harnesses.push(harness);
			const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
			process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
			try {
				const globalDir = getGlobalHarnessStateDir();
				const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
				const seedMemory = (scope: "global" | "local", dir: string, content: string) => {
					const state = loadHarnessState(dir, scope);
					applyRefinementProposal(
						state,
						{
							summary: `${scope} shared memory`,
							rationale: "seed",
							expectedOutcome: "seeded",
							edits: [{ action: "create", kind: "memory", id: "shared", title: "Shared", content }],
						},
						{ id: `seed_${scope}`, scope },
					);
					saveHarnessState(dir, state);
				};
				if (seedGlobal) seedMemory("global", globalDir, "Global content");
				if (seedLocal) seedMemory("local", localDir, "Local content");
				harness.setResponses([
					fauxAssistantMessage(
						JSON.stringify({
							summary: "Update shared memory",
							rationale: "The display id was selected from merged state.",
							expectedOutcome: "Only the targeted entry changes.",
							edits: [
								{ action: "update", kind: "memory", id: editId, title: "Shared", content: updatedContent },
							],
						}),
					),
				]);

				const result = await harness.session.refine(refineOptions);

				expect(result.appliedEdits[0]).toMatchObject({ id: "shared", applied: true });
				if (expectLocalContent !== undefined) {
					expect(loadHarnessState(localDir, "local").entries.memory.shared.content).toBe(expectLocalContent);
					expect(loadHarnessState(localDir, "local").entries.memory["global:shared"]).toBeUndefined();
				}
				if (expectGlobalContent !== undefined) {
					expect(loadHarnessState(globalDir, "global").entries.memory.shared.content).toBe(expectGlobalContent);
				}
			} finally {
				if (previousAgentDir === undefined) {
					delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
				} else {
					process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
				}
			}
		},
	);

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
					refinePlanJson("Create original local memory", [
						{
							action: "create",
							kind: "memory",
							id: "remember_me",
							title: "Original memory",
							content: "Original content should be rolled back.",
						},
					]),
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
			const planGate = createDeferred();
			const planStartedPromise = createDeferred();
			const promptGate = createDeferred();
			const promptStartedPromise = createDeferred();
			let promptSignal: AbortSignal | undefined;
			harness.setResponses([
				async () => {
					planStartedPromise.resolve();
					await planGate.promise;
					return fauxAssistantMessage(refinePlanJson("no-op"));
				},
				async (_context, options) => {
					promptSignal = options?.signal;
					promptStartedPromise.resolve();
					await promptGate.promise;
					return fauxAssistantMessage("prompt reply");
				},
			]);

			const refinePromise = harness.session.refine({ instructions: "background refine" });
			await planStartedPromise.promise;

			const promptPromise = harness.session.prompt("hello during refine");
			await promptStartedPromise.promise;
			// With backgrounded refine planning, the prompt does NOT wait for the
			// planning LLM pass. It starts immediately and streams its response
			// while planning is still in flight. The application phase waits for
			// the agent to be idle before disconnecting and applying.
			expect(harness.getPendingResponseCount()).toBe(0);

			planGate.resolve();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(promptSignal?.aborted).toBe(false);

			let refineSettled = false;
			void refinePromise.finally(() => {
				refineSettled = true;
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(refineSettled).toBe(false);

			promptGate.resolve();
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

	it("preserves a same-entry harness write made during background planning", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
			const initialState = loadHarnessState(localDir, "local");
			applyRefinementProposal(
				initialState,
				{
					summary: "Seed memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "shared",
							title: "Shared",
							content: "planning baseline",
						},
					],
				},
				{ id: "seed_shared", scope: "local" },
			);
			saveHarnessState(localDir, initialState);

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
							summary: "Update shared memory",
							rationale: "planned update",
							expectedOutcome: "updated",
							edits: [
								{
									action: "update",
									kind: "memory",
									id: "shared",
									title: "Shared",
									content: "stale planned content",
								},
							],
						}),
					);
				},
			]);

			const refinePromise = harness.session.refine({ instructions: "update shared memory" });
			await planStartedPromise;
			const concurrentState = loadHarnessState(localDir, "local");
			concurrentState.entries.memory.shared.content = "concurrent kernel content";
			concurrentState.entries.memory.shared.version++;
			saveHarnessState(localDir, concurrentState);
			releasePlan?.();

			const result = await refinePromise;
			expect(result.appliedEdits).toMatchObject([
				{ applied: false, error: "entry changed during refinement planning" },
			]);
			expect(loadHarnessState(localDir, "local").entries.memory.shared.content).toBe("concurrent kernel content");
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

	it("admits extension commands immediately while completion tracks the handler", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", { description: "Test", handler: async () => gate });
					pi.registerCommand("fail", {
						description: "Fail",
						handler: async () => {
							throw new Error("extension exploded");
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const extensionErrors: string[] = [];
		harness.session.bindExtensions({ onError: (error) => extensionErrors.push(error.error) });

		await expect(harness.session.promptUntilAccepted("/testcmd")).resolves.toBeUndefined();
		let completed = false;
		const completion = harness.session.promptAndWait("/testcmd").then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		release?.();
		await completion;
		await expect(harness.session.promptAndWait("/fail")).rejects.toThrow("extension exploded");
		expect(extensionErrors).toEqual(["extension exploded"]);
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

	it.each([
		{
			name: "coalesces follow-up messages with the same queue key",
			prompts: [
				{ text: "heartbeat", key: "heartbeat:one" },
				{ text: "heartbeat", key: "heartbeat:one" },
			],
			capturePreflightOnLast: false,
			expectedPreflights: undefined as boolean[] | undefined,
			removeKey: undefined as string | undefined,
			expectedQueue: ["heartbeat"],
			expectedFinalUsers: undefined as string[] | undefined,
		},
		{
			name: "reports failed preflight when a duplicate follow-up queue key is not queued",
			prompts: [
				{ text: "heartbeat", key: "heartbeat:one" },
				{ text: "heartbeat", key: "heartbeat:one" },
			],
			capturePreflightOnLast: true,
			expectedPreflights: [false],
			removeKey: undefined,
			expectedQueue: ["heartbeat"],
			expectedFinalUsers: undefined,
		},
		{
			name: "keeps separate follow-up messages for different queue keys",
			prompts: [
				{ text: "heartbeat one", key: "heartbeat:one" },
				{ text: "heartbeat two", key: "heartbeat:two" },
			],
			capturePreflightOnLast: false,
			expectedPreflights: undefined,
			removeKey: undefined,
			expectedQueue: ["heartbeat one", "heartbeat two"],
			expectedFinalUsers: undefined,
		},
		{
			name: "removes only the matching coalesced follow-up when texts match",
			prompts: [
				{ text: "same heartbeat", key: "heartbeat:one" },
				{ text: "same heartbeat", key: "heartbeat:two" },
			],
			capturePreflightOnLast: false,
			expectedPreflights: undefined,
			removeKey: "heartbeat:one",
			expectedQueue: ["same heartbeat"],
			expectedFinalUsers: ["start", "same heartbeat"],
		},
		{
			name: "removes coalesced follow-up messages by queue key",
			prompts: [{ text: "heartbeat", key: "heartbeat:one" }],
			capturePreflightOnLast: false,
			expectedPreflights: undefined,
			removeKey: "heartbeat:one",
			expectedQueue: [],
			expectedFinalUsers: ["start"],
		},
	])(
		"$name",
		async ({ prompts, capturePreflightOnLast, expectedPreflights, removeKey, expectedQueue, expectedFinalUsers }) => {
			const waiting = await createWaitingHarness();
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			const preflightResults: boolean[] = [];

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				...prompts.map((_, index) => fauxAssistantMessage(`done ${index}`)),
			]);
			await waitForToolStart;
			for (const [index, prompt] of prompts.entries()) {
				await harness.session.prompt(prompt.text, {
					streamingBehavior: "followUp",
					followUpQueueKey: prompt.key,
					...(capturePreflightOnLast && index === prompts.length - 1
						? { preflightResult: (didSucceed: boolean) => preflightResults.push(didSucceed) }
						: {}),
				});
			}
			if (removeKey !== undefined) {
				expect(harness.session.removeQueuedFollowUp(removeKey)).toBe(true);
			}

			if (expectedPreflights !== undefined) expect(preflightResults).toEqual(expectedPreflights);
			expect(harness.session.getFollowUpMessages()).toEqual(expectedQueue);

			releaseToolExecution();
			await promptPromise;
			if (expectedFinalUsers !== undefined) expect(getUserTexts(harness)).toEqual(expectedFinalUsers);
		},
	);

	it.each([
		{
			name: "clearQueue",
			queue: async (harness: Harness, text: string, _id: string) => {
				await harness.session.steer(text);
			},
			remove: (harness: Harness, _text: string) => harness.session.clearQueue(),
		},
		{
			name: "clearQueuedUserMessagesMatching",
			queue: async (harness: Harness, text: string, id: string) => {
				await harness.session.queueAgentMessagePrompt(text, "steer", testAgentMessage(id, text));
			},
			remove: (harness: Harness, text: string) =>
				harness.session.clearQueuedUserMessagesMatching((candidate) => candidate === text),
		},
		{
			name: "removeQueuedFollowUp",
			queue: async (harness: Harness, text: string, id: string) => {
				await harness.session.steer(text, undefined, { queueKey: id });
			},
			remove: (harness: Harness, _text: string, id: string) => harness.session.removeQueuedFollowUp(id),
		},
		{
			name: "goal-context cleanup",
			queue: async (harness: Harness, text: string, _id: string) => {
				await harness.session.sendCustomMessage(
					{ customType: "goal_context", content: text, display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				);
			},
			remove: (harness: Harness, _text: string) =>
				(harness.session as unknown as SteeringStopInternals)._clearQueuedGoalContexts(),
		},
	])("reconciles steering stop state after $name removes queued steering", async ({ queue, remove }) => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const internals = harness.session as unknown as SteeringStopInternals;
		let providerCalls = 0;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			() => {
				providerCalls++;
				return fauxAssistantMessage("continued without a stale stop");
			},
		]);
		await waitForToolStart;
		await queue(harness, "remove me", "remove-key");
		expect(internals._steeringStopPending).toBe(true);

		remove(harness, "remove me", "remove-key");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(internals._steeringStopPending).toBe(false);

		releaseToolExecution();
		await promptPromise;
		expect(providerCalls).toBe(1);
	});

	it("removes goal context while its steering handoff is still preparing", async () => {
		const hook = gatedHook({ prompt: "stale goal context" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const pause = harness.session.acquireQueuedWorkPause();
		withStreaming(harness, true);
		await harness.session.sendCustomMessage(
			{ customType: "goal_context", content: "stale goal context", display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		withStreaming(harness, false);
		pause.release();
		await hook.reached;

		(harness.session as unknown as SteeringStopInternals)._clearQueuedGoalContexts();
		hook.release();
		await harness.session.waitForIdle();

		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "goal_context"),
		).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("keeps steering stop pending while a steering handoff is still preparing", async () => {
		const hook = gatedHook({ prompt: "active steering" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		const internals = harness.session as unknown as SteeringStopInternals;
		harness.setResponses([fauxAssistantMessage("delivered")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.steer("active steering", undefined, { resumeIfIdle: true });
		pause.release();
		await hook.reached;

		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(internals._steeringStopPending).toBe(true);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
		expect(internals._steeringStopPending).toBe(true);

		hook.release();
		await harness.session.waitForIdle();
		expect(internals._steeringStopPending).toBe(false);
		expect(getUserTexts(harness)).toEqual(["active steering"]);
	});

	it.each([
		{
			name: "clearQueuedUserMessagesMatching",
			queueRemoved: (harness: Harness) =>
				harness.session.queueAgentMessagePrompt(
					"remove me",
					"steer",
					testAgentMessage("remove-message", "remove me"),
				),
			remove: (harness: Harness) =>
				harness.session.clearQueuedUserMessagesMatching((candidate) => candidate === "remove me"),
		},
		{
			name: "removeQueuedFollowUp",
			queueRemoved: (harness: Harness) => harness.session.steer("remove me", undefined, { queueKey: "remove-key" }),
			remove: (harness: Harness) => harness.session.removeQueuedFollowUp("remove-key"),
		},
		{
			name: "goal-context cleanup",
			queueRemoved: (harness: Harness) =>
				harness.session.sendCustomMessage(
					{ customType: "goal_context", content: "remove me", display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				),
			remove: (harness: Harness) => (harness.session as unknown as SteeringStopInternals)._clearQueuedGoalContexts(),
		},
	])(
		"preserves steering stop state after $name when another steering input remains",
		async ({ queueRemoved, remove }) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const internals = harness.session as unknown as SteeringStopInternals;
			withStreaming(harness, true);
			await queueRemoved(harness);
			await harness.session.steer("keep me");

			remove(harness);

			expect(harness.session.getSteeringMessages()).toEqual(["keep me"]);
			expect(internals._steeringStopPending).toBe(true);
		},
	);

	it("removes preparing inputs and re-prepares when the last batch anchor changes", async () => {
		const firstPreparation = createDeferred();
		const prepared: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						prepared.push(event.prompt);
						if (prepared.length === 1) await firstPreparation.promise;
						return {
							systemPrompt: `${event.systemPrompt}
prepared:${event.prompt}`,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		const responseGate = createDeferred();
		let providerSystemPrompt = "";
		harness.setResponses([
			async (context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				await responseGate.promise;
				return fauxAssistantMessage("remaining response");
			},
		]);
		const removedAgentMessage = agentPromptText("agentmsg_remove", "remove");
		const keptAgentMessage = agentPromptText("agentmsg_keep", "keep");
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("ordinary");
		await harness.session.queueAgentMessagePrompt(removedAgentMessage, "followUp", undefined);
		await harness.session.queueAgentMessagePrompt(keptAgentMessage, "followUp", undefined);
		await harness.session.followUp("last anchor", undefined, { queueKey: "heartbeat:one" });
		pause.release();
		await vi.waitFor(() => expect(prepared).toEqual(["last anchor"]));

		expect(harness.session.clearQueuedUserMessagesMatching((text) => text === removedAgentMessage)).toEqual({
			steering: [],
			followUp: [removedAgentMessage],
		});
		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(true);
		firstPreparation.resolve();
		await vi.waitFor(() => expect(providerSystemPrompt).not.toBe(""));
		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(false);
		responseGate.resolve();
		await harness.session.waitForIdle();

		expect(prepared).toEqual(["last anchor", keptAgentMessage]);
		expect(providerSystemPrompt).toContain(`prepared:${keptAgentMessage}`);
		expect(providerSystemPrompt).not.toContain("prepared:last anchor");
		expect(getUserTexts(harness)).toEqual(["ordinary", keptAgentMessage]);
	});

	it("keeps cleared prompts out of the handoff snapshot during the refine wait", async () => {
		let sessionInternals: { _refineInFlight?: Promise<void> };
		let clearDuringRefineWait: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						// Stall the pre-handoff refine wait and clear the queued agent
						// message inside that window; the handoff snapshot must not
						// deliver it.
						let releaseRefine: (() => void) | undefined;
						sessionInternals._refineInFlight = new Promise<void>((resolve) => {
							releaseRefine = resolve;
						});
						setTimeout(() => {
							clearDuringRefineWait?.();
							sessionInternals._refineInFlight = undefined;
							releaseRefine?.();
						}, 0);
						return {};
					});
				},
			],
		});
		harnesses.push(harness);
		sessionInternals = harness.session as unknown as { _refineInFlight?: Promise<void> };
		harness.setResponses([fauxAssistantMessage("kept response")]);

		const clearedAgentMessage = agentPromptText("agentmsg_cleared", "cleared");
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("kept");
		await harness.session.queueAgentMessagePrompt(clearedAgentMessage, "followUp", undefined);
		harness.session.setFollowUpMode("all");
		let cleared: { steering: string[]; followUp: string[] } | undefined;
		clearDuringRefineWait = () => {
			cleared = harness.session.clearQueuedUserMessagesMatching((text) => text === clearedAgentMessage);
		};
		pause.release();
		await harness.session.waitForIdle();

		expect(cleared).toEqual({ steering: [], followUp: [clearedAgentMessage] });
		expect(getUserTexts(harness)).toEqual(["kept"]);
	});

	it("does not start a queued turn after abortForUpdateRestart", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerCalls = 0;
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		harness.setResponses([
			async () => {
				await firstGate;
				return fauxAssistantMessage("first done");
			},
			() => {
				providerCalls++;
				return fauxAssistantMessage("must not run");
			},
		]);

		const first = harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		await harness.session.followUp("queued for restart");
		harness.session.abortForUpdateRestart();
		releaseFirst?.();
		await first.catch(() => undefined);
		await harness.session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The queued input must survive into the restart manifest instead of
		// starting a fresh turn during teardown.
		expect(providerCalls).toBe(0);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued for restart"]);
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

	it.each([
		{
			lane: "steering",
			mode: "one-at-a-time" as const,
			responses: [fauxAssistantMessage("handled steer 1"), fauxAssistantMessage("handled steer 2")],
			queue: (harness: Harness) => [harness.session.steer("steer 1"), harness.session.steer("steer 2")],
			expectedUsers: ["start", "steer 1", "steer 2"],
			expectedAssistants: ["", "handled steer 1", "handled steer 2"],
			expectedBatch: undefined as string[] | undefined,
		},
		{
			lane: "follow-up",
			mode: "one-at-a-time" as const,
			responses: [
				fauxAssistantMessage("original turn complete"),
				fauxAssistantMessage("handled follow-up 1"),
				fauxAssistantMessage("handled follow-up 2"),
			],
			queue: (harness: Harness) => [
				harness.session.followUp("follow-up 1"),
				harness.session.followUp("follow-up 2"),
			],
			expectedUsers: ["start", "follow-up 1", "follow-up 2"],
			expectedAssistants: ["", "original turn complete", "handled follow-up 1", "handled follow-up 2"],
			expectedBatch: undefined as string[] | undefined,
		},
		{
			lane: "steering",
			mode: "all" as const,
			responses: [fauxAssistantMessage("batched steer response")],
			queue: (harness: Harness) => [harness.session.steer("steer 1"), harness.session.steer("steer 2")],
			expectedUsers: undefined,
			expectedAssistants: ["", "batched steer response"],
			expectedBatch: ["start", "steer 1", "steer 2"] as string[] | undefined,
		},
		{
			lane: "follow-up",
			mode: "all" as const,
			responses: [
				fauxAssistantMessage("original turn complete"),
				fauxAssistantMessage("batched follow-up response"),
			],
			queue: (harness: Harness) => [
				harness.session.followUp("follow-up 1"),
				harness.session.followUp("follow-up 2"),
			],
			expectedUsers: undefined,
			expectedAssistants: ["", "original turn complete", "batched follow-up response"],
			expectedBatch: ["start", "follow-up 1", "follow-up 2"] as string[] | undefined,
		},
	])(
		"delivers $lane messages in order in $mode mode",
		async ({ lane, mode, responses, queue, expectedUsers, expectedAssistants, expectedBatch }) => {
			const waiting = await createWaitingHarness();
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			if (mode === "all") {
				if (lane === "steering") harness.session.setSteeringMode("all");
				else harness.session.setFollowUpMode("all");
			}
			let batchedUserMessages: string[] | undefined;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				...responses.slice(0, -1),
				(context) => {
					batchedUserMessages = context.messages
						.filter((message) => message.role === "user")
						.map((message) => getMessageText(message));
					return responses[responses.length - 1]!;
				},
			]);

			await waitForToolStart;
			await Promise.all(queue(harness));
			releaseToolExecution();
			await promptPromise;

			if (expectedUsers !== undefined) expect(getUserTexts(harness)).toEqual(expectedUsers);
			if (expectedBatch !== undefined) expect(batchedUserMessages).toEqual(expectedBatch);
			expect(getAssistantTexts(harness)).toEqual(expectedAssistants);
		},
	);

	it.each([
		{
			deliverAs: "steer" as const,
			content: "steer custom" as string | ({ type: "text"; text: string } | ImageContent)[],
			expectedText: "steer custom",
			interimResponses: [] as ReturnType<typeof fauxAssistantMessage>[],
			capturedPreparation: false,
		},
		{
			deliverAs: "followUp" as const,
			content: [
				{ type: "text" as const, text: "follow-up custom" },
				{ type: "image" as const, data: "image-data", mimeType: "image/png" },
			] as string | ({ type: "text"; text: string } | ImageContent)[],
			expectedText: "follow-up custom",
			interimResponses: [fauxAssistantMessage("original turn complete")],
			capturedPreparation: true,
		},
	])(
		"queues custom messages with deliverAs $deliverAs while streaming",
		async ({ deliverAs, content, expectedText, interimResponses, capturedPreparation }) => {
			const waiting = await createWaitingHarness();
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			let sawCustomMessage = false;
			let preparedText: string | undefined;
			let preparedImages: ImageContent[] | undefined;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				...interimResponses,
				(context) => {
					sawCustomMessage = context.messages.some(
						(message) =>
							message.role === "user" &&
							typeof message.content !== "string" &&
							message.content.some((part) => part.type === "text" && part.text === expectedText),
					);
					return fauxAssistantMessage("done");
				},
			]);

			await waitForToolStart;
			if (capturedPreparation) {
				vi.spyOn(harness.session.extensionRunner, "emitBeforeAgentStart").mockImplementationOnce(
					async (text, images) => {
						preparedText = text;
						preparedImages = images;
						return undefined;
					},
				);
			}
			await harness.session.sendCustomMessage(
				{ customType: "queue-test", content, display: true, details: { value: 1 } },
				{ deliverAs },
			);
			releaseToolExecution();
			await promptPromise;

			expect(sawCustomMessage).toBe(true);
			if (capturedPreparation) {
				expect(preparedText).toBe(expectedText);
				expect(preparedImages).toEqual([{ type: "image", data: "image-data", mimeType: "image/png" }]);
			}
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "queue-test",
				),
			).toBe(true);
		},
	);

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([fauxAssistantMessage("seed")]);
		await harness.session.prompt("seed");
		vi.spyOn(
			harness.session as unknown as { _checkCompaction(): Promise<boolean> },
			"_checkCompaction",
		).mockImplementationOnce(async () => {
			await harness.session.sendCustomMessage(
				{ customType: "next-turn", content: "carry this", display: true, details: {} },
				{ deliverAs: "nextTurn" },
			);
			return false;
		});

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
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"custom",
			"user",
			"assistant",
		]);
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

	function agentPromptText(id: string, body: string): string {
		return `Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: ${id}\n\n${body}`;
	}

	it.each([
		{
			name: "only internally queued agent-message prompts",
			lane: "followUp" as const,
			plain: agentPromptText("agentmsg_spoof", "ordinary user text"),
			internal: agentPromptText("agentmsg_real", "real agent text"),
		},
		{
			name: "internally queued agent-message steering prompts by message identity",
			lane: "steer" as const,
			plain: agentPromptText("agentmsg_shared", "shared text"),
			internal: agentPromptText("agentmsg_shared", "shared text"),
		},
	])("clears $name", async ({ lane, plain, internal }) => {
		const harness = await createHarness();
		harnesses.push(harness);

		if (lane === "followUp") await harness.session.followUp(plain);
		else await harness.session.steer(plain);
		await harness.session.queueAgentMessagePrompt(internal, lane);

		expect(harness.session.clearQueuedUserMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: lane === "steer" ? [internal] : [],
			followUp: lane === "followUp" ? [internal] : [],
		});
		const remaining =
			lane === "followUp" ? harness.session.getFollowUpMessages() : harness.session.getSteeringMessages();
		expect(remaining).toEqual([plain]);
	});

	it("clears the agent queue when a queue update listener clears a newly queued steering prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt = agentPromptText("agentmsg_queue_update_clear", "clear during update");
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

	it("clearQueue and terminal preparation errors reject delivery and completion waiters", async () => {
		// clearQueue while an active batch is preparing rejects every prompt's waiters.
		let preparationStarted: (() => void) | undefined;
		const waitForPreparation = new Promise<void>((resolve) => {
			preparationStarted = resolve;
		});
		let pause: { release(): void } | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						preparationStarted?.();
						pause = harness.session.acquireQueuedWorkPause();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		withStreaming(harness, true);
		const firstDelivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_clear_first");
		const firstCompletion = harness.session.promptAndWait("clear first while preparing", {
			agentMessageId: "agentmsg_clear_first",
			streamingBehavior: "followUp",
			resumeIfIdle: true,
		});
		const completion = harness.session.promptAndWait("clear second while preparing", {
			streamingBehavior: "followUp",
			resumeIfIdle: true,
		});
		const firstCompletionRejection = expect(firstCompletion).rejects.toThrow("cleared before delivery");
		const completionRejection = expect(completion).rejects.toThrow("cleared before delivery");
		withStreaming(harness, false);
		await waitForPreparation;
		expect(pause).toBeDefined();

		expect(harness.session.clearQueue()).toEqual({
			steering: [],
			followUp: ["clear first while preparing", "clear second while preparing"],
		});
		pause?.release();
		await firstCompletionRejection;
		await completionRejection;
		await expect(firstDelivery).rejects.toThrow("cleared before delivery");
		await harness.session.waitForSessionInputIdle();
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);

		harness.setResponses([fauxAssistantMessage("later response")]);
		await expect(
			harness.session.promptAndWait("later prompt", { agentMessageId: "agentmsg_clear_first" }),
		).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toEqual(["later prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["later response"]);

		// Terminal queued-prompt preparation errors reject both delivery and completion.
		const errors: string[] = [];
		const authHarness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(authHarness);
		await authHarness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		withStreaming(authHarness, true);
		const delivery = authHarness.session.waitForAgentMessagePromptDelivery("agentmsg_terminal");
		const terminalCompletion = authHarness.session.promptAndWait("cannot start", {
			agentMessageId: "agentmsg_terminal",
			streamingBehavior: "followUp",
			resumeIfIdle: true,
		});
		const terminalRejection = expect(terminalCompletion).rejects.toThrow("No API key");
		await vi.waitFor(() => expect(authHarness.session.getFollowUpMessages()).toEqual(["cannot start"]));
		withStreaming(authHarness, false);
		await authHarness.session.waitForSessionInputIdle();

		await expect(delivery).rejects.toThrow("No API key");
		await terminalRejection;
		expect(authHarness.session.getFollowUpMessages()).toEqual([]);
		expect(errors).toEqual([expect.stringContaining("No API key")]);
	});

	it("keeps queued agent-message delivery waiters pending on abort until the message is delivered", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt = agentPromptText("agentmsg_abort", "survive the abort");
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

		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_abort");
		await harness.session.queueAgentMessagePrompt(agentPrompt, "followUp");
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

	it("keeps a second one-at-a-time input queued when both use the same message object", async () => {
		const firstResponse = createDeferred();
		const firstProviderStarted = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setFollowUpMode("one-at-a-time");
		harness.setResponses([
			async () => {
				firstProviderStarted.resolve();
				await firstResponse.promise;
				return fauxAssistantMessage("first done");
			},
			fauxAssistantMessage("second done"),
		]);
		const payload: AgentSessionMessagePayload = {
			id: "agentmsg_same_object",
			source: AGENT_MESSAGE_SOURCE,
			message: "same object",
			deliveryMode: "follow_up" as const,
			target: { activeSessionId: "worker-active", sessionId: "worker-session" },
		};
		const message = createAgentSessionMessage(payload);
		const prompt = createAgentSessionMessagePrompt(payload);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);
		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);
		pause.release();

		await firstProviderStarted.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual([prompt]);
		firstResponse.resolve();
		await harness.session.waitForIdle();

		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.messages.filter((item) => item === message)).toHaveLength(2);
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
	});

	it("releases hundreds of external promptAndWait outcomes for pre-registered id reuse", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		for (let index = 0; index < 300; index++) {
			const id = `agentmsg_completed_${index}`;
			harness.setResponses([fauxAssistantMessage(`done ${index}`)]);
			await expect(
				harness.session.promptAndWait(`prompt ${index}`, { agentMessageId: id }),
			).resolves.toBeUndefined();
		}

		const reusedId = "agentmsg_completed_0";
		let delivered = false;
		const delivery = harness.session.waitForAgentMessagePromptDelivery(reusedId).then(() => {
			delivered = true;
		});
		await Promise.resolve();
		expect(delivered).toBe(false);

		harness.setResponses([fauxAssistantMessage("reused done")]);
		await harness.session.acceptAgentMessagePrompt(agentPromptText(reusedId, "reused prompt"));
		await expect(delivery).resolves.toBeUndefined();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toHaveLength(301);
		expect(getAssistantTexts(harness)).toHaveLength(301);
	});

	it("resolves pre-registered queued and direct agent-message delivery waiters once prompts start", async () => {
		const blocked = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_start", async () => blocked.promise);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		withStreaming(harness, true);
		const queuedDelivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_sync");
		await harness.session.followUp("agent message", undefined, {
			agentMessageId: "agentmsg_sync",
			resumeIfIdle: true,
		});
		withStreaming(harness, false);

		// Queued delivery resolves on message_start, before the gated turn completes.
		await expect(queuedDelivery).resolves.toBeUndefined();
		blocked.resolve();
		await harness.session.waitForIdle();

		harness.setResponses([fauxAssistantMessage("direct reply")]);
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_direct");
		await harness.session.acceptAgentMessagePrompt(agentPromptText("agentmsg_direct", "direct delivery"));
		await expect(delivery).resolves.toBeUndefined();
	});

	it("settles disposal and post-delivery handoff failures with distinct errors", async () => {
		// Dispose rejects pending waiters with distinct delivery and completion errors.
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt = agentPromptText("agentmsg_dispose", "dispose me");
		withStreaming(harness, true);
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_dispose");
		const completion = harness.session.promptAndWait(agentPrompt, {
			agentMessageId: "agentmsg_dispose",
			streamingBehavior: "followUp",
		});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual([agentPrompt]));
		harness.session.dispose();

		await expect(delivery).rejects.toThrow("disposed before prompt delivery");
		await expect(completion).rejects.toThrow("disposed before prompt completion");

		// A handoff failure after the prompt entered agent state rejects completion only.
		const handoffHarness = await createHarness();
		harnesses.push(handoffHarness);
		const prompt = handoffHarness.session.agent.prompt.bind(handoffHarness.session.agent);
		vi.spyOn(handoffHarness.session.agent, "prompt").mockImplementationOnce(async (messages) => {
			await prompt(messages);
			throw new Error("handoff failed after delivery");
		});
		withStreaming(handoffHarness, true);
		const handoffCompletion = handoffHarness.session.promptAndWait("delivered then failed", {
			streamingBehavior: "followUp",
		});
		await vi.waitFor(() => expect(handoffHarness.session.getFollowUpMessages()).toEqual(["delivered then failed"]));
		withStreaming(handoffHarness, false);

		expect(handoffHarness.session.resumeQueuedWork()).toBe(true);
		await expect(handoffCompletion).rejects.toThrow("handoff failed after delivery");
		expect(getUserTexts(handoffHarness)).toEqual(["delivered then failed"]);
		expect(handoffHarness.session.getFollowUpMessages()).toEqual([]);
	});

	it.each([
		{ behavior: "steer", queue: (harness: Harness) => harness.session.steer("/testcmd queued") },
		{ behavior: "followUp", queue: (harness: Harness) => harness.session.followUp("/testcmd queued") },
	])("throws when queueing an extension command with $behavior", async ({ queue }) => {
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

		await expect(queue(harness)).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("keeps admitted prompts in session queues instead of Agent queues", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled queued prompt"),
		]);
		await waitForToolStart;
		await harness.session.followUp("session owned", undefined, { resumeIfIdle: true });

		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["session owned"]);

		releaseToolExecution();
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "session owned"]);
	});

	it("treats queued session commands as hard boundaries with durable outcomes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("before command"),
			fauxAssistantMessage("after command"),
		]);
		await waitForToolStart;
		await harness.session.followUp("first");
		await harness.session.prompt("/autonomous status", { streamingBehavior: "followUp" });
		await harness.session.followUp("second");

		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "first", "second"]);
		const commandMessages = harness.session.messages.filter(
			(message): message is Extract<(typeof harness.session.messages)[number], { role: "custom" }> =>
				message.role === "custom" && message.customType.startsWith("session_slash_command"),
		);
		expect(commandMessages.map((message) => message.customType)).toEqual(["session_slash_command"]);
		expect(commandMessages.map((message) => message.content)).toEqual(["/autonomous status"]);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "autonomous_status",
			),
		).toBe(true);
	});

	it("settles queued command delivery after durable invocation and before gated completion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = createDeferred<void>();
		const release = createDeferred<void>();
		vi.spyOn(harness.session, "refine").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return emptyRefinementResult();
		});
		const pause = harness.session.acquireQueuedWorkPause();
		const id = "agentmsg_gated_command";
		const delivery = harness.session.waitForAgentMessagePromptDelivery(id);
		let completionSettled = false;
		const completion = harness.session.promptAndWait("/refine --local", { agentMessageId: id }).finally(() => {
			completionSettled = true;
		});

		pause.release();
		await started.promise;
		await expect(delivery).resolves.toBeUndefined();
		expect(completionSettled).toBe(false);
		release.resolve();
		await expect(completion).resolves.toBeUndefined();
	});

	it("keeps queued command delivery successful when execution fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		vi.spyOn(harness.session, "refine").mockRejectedValue(new Error("refine execution failed"));
		const pause = harness.session.acquireQueuedWorkPause();
		const id = "agentmsg_failed_command";
		const delivery = harness.session.waitForAgentMessagePromptDelivery(id);
		const completion = harness.session.promptAndWait("/refine --local", { agentMessageId: id });

		pause.release();
		await expect(delivery).resolves.toBeUndefined();
		await expect(completion).rejects.toThrow("refine execution failed");
	});

	it("rejects queued command delivery and completion when the invocation append fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("durable invocation append failed");
		});
		const pause = harness.session.acquireQueuedWorkPause();
		const id = "agentmsg_command_append_failed";
		const delivery = harness.session.waitForAgentMessagePromptDelivery(id);
		const completion = harness.session.promptAndWait("/autonomous status", { agentMessageId: id });

		pause.release();
		await expect(delivery).rejects.toThrow("durable invocation append failed");
		await expect(completion).rejects.toThrow("durable invocation append failed");
	});

	it("restores command envelopes as commands and other slash-prefixed messages literally", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("literal handled")]);
		const command = parseSessionSlashCommand("/autonomous status");
		expect(command).toBeDefined();

		await harness.session.restoreFollowUpMessage(command!.text, undefined, {
			agentMessageId: "agentmsg_restored_command",
			customMessage: createSessionSlashCommandMessage(command!),
		});
		const mismatchedCommand = parseSessionSlashCommand("/autonomous on");
		expect(mismatchedCommand).toBeDefined();
		await harness.session.restoreFollowUpMessage(command!.text, undefined, {
			customMessage: createSessionSlashCommandMessage(mismatchedCommand!),
		});
		await harness.session.restoreFollowUpMessage("/autonomous off", undefined, {
			customMessage: {
				role: "custom",
				customType: "restored-literal",
				content: "/autonomous off",
				display: true,
				timestamp: Date.now(),
			},
		});
		expect(harness.session.getFollowUpQueueSnapshots()).toEqual([
			expect.objectContaining({
				text: command!.text,
				agentMessageId: "agentmsg_restored_command",
				customMessage: expect.objectContaining({ customType: "session_slash_command" }),
			}),
			expect.objectContaining({
				text: command!.text,
				customMessage: expect.objectContaining({ customType: "session_slash_command" }),
			}),
			expect.objectContaining({
				text: "/autonomous off",
				customMessage: expect.objectContaining({ customType: "restored-literal" }),
			}),
		]);
		harness.session.resumeQueuedWork();
		await harness.session.waitForIdle();

		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(getUserTexts(harness)).toEqual([]);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "restored-literal",
			),
		).toBe(true);
		expect(
			harness.session.messages.filter(
				(message) =>
					message.role === "custom" &&
					message.customType === "session_slash_command" &&
					(message.details as { command?: { text?: string } } | undefined)?.command?.text === command!.text,
			),
		).toHaveLength(1);
	});

	it("serializes concurrent trigger-turn custom messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await Promise.all([
			harness.session.sendCustomMessage(
				{ customType: "first", content: "first", display: false },
				{ triggerTurn: true },
			),
			harness.session.sendCustomMessage(
				{ customType: "second", content: "second", display: false },
				{ triggerTurn: true },
			),
		]);

		expect(
			harness.session.messages.filter((message) => message.role === "custom").map((message) => message.content),
		).toEqual(["first", "second"]);
	});

	it("pumps follow-up work admitted during a trigger-turn custom message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let queued = false;
		harness.setResponses([
			async () => {
				queued = await harness.session.restoreFollowUpMessage("queued during custom turn");
				return fauxAssistantMessage("custom done");
			},
			fauxAssistantMessage("follow-up done"),
		]);

		await harness.session.sendCustomMessage(
			{ customType: "trigger", content: "trigger", display: false },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();

		expect(queued).toBe(true);
		expect(getUserTexts(harness)).toEqual(["queued during custom turn"]);
		expect(getAssistantTexts(harness)).toEqual(["custom done", "follow-up done"]);
	});

	it("rejects triggerTurn promptly when pending input is suspended", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.restoreFollowUpMessage("suspended");
		harness.session.abortForUpdateRestart();
		const prompt = vi.spyOn(harness.session.agent, "prompt");

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "trigger", content: "trigger", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("queued session input is suspended");

		expect(prompt).not.toHaveBeenCalled();
		expect(harness.session.getFollowUpMessages()).toEqual(["suspended"]);
	});

	it("rechecks queued-work pauses acquired at the direct-admission boundary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("direct done")]);
		const internals = harness.session as unknown as {
			_acquireTurnAdmission(): Promise<{ owner: symbol; release(): void }>;
		};
		const acquireTurnAdmission = internals._acquireTurnAdmission.bind(internals);
		let pause: { release(): void } | undefined;
		let first = true;
		internals._acquireTurnAdmission = async () => {
			const admission = await acquireTurnAdmission();
			if (first) {
				first = false;
				pause = harness.session.acquireQueuedWorkPause();
			}
			return admission;
		};
		const prompt = harness.session.prompt("direct");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(getUserTexts(harness)).toEqual([]);
		pause?.release();
		await prompt;
		expect(getUserTexts(harness)).toEqual(["direct"]);
	});

	it("rejects disposal while direct admission waits behind a pause", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const release = vi.spyOn(pause, "release");
		const prompt = vi.spyOn(harness.session.agent, "prompt");
		const trigger = harness.session.sendCustomMessage(
			{ customType: "trigger", content: "trigger", display: false },
			{ triggerTurn: true },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		harness.session.dispose();
		await expect(trigger).rejects.toThrow("session is disposing or disposed");

		expect(prompt).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});

	it("rejects a post-disposal direct call without prompting the agent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const prompt = vi.spyOn(harness.session.agent, "prompt");
		harness.session.dispose();

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "trigger", content: "trigger", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("session is disposing or disposed");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("resumes explicitly admitted and restored work after abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.abort();
		await harness.session.followUp("resume if idle", undefined, { resumeIfIdle: true });
		await harness.session.waitForIdle();
		await harness.session.abort();
		await harness.session.restoreFollowUpMessage("explicit resume");
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["resume if idle", "explicit resume"]);
	});

	it("waits for all admitted session inputs to finish", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("first", undefined, { resumeIfIdle: true });
		await harness.session.followUp("second", undefined, { resumeIfIdle: true });
		pause.release();

		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["first", "second"]);
		expect(getAssistantTexts(harness)).toEqual(["first response", "second response"]);
	});

	it("preserves queued command images in restart snapshots", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);
		const image = { type: "image" as const, mimeType: "image/png", data: "image-data" };

		await harness.session.prompt("/goal inspect image", { streamingBehavior: "followUp", images: [image] });

		expect(harness.session.getFollowUpQueueSnapshots()).toEqual([
			expect.objectContaining({ text: "/goal inspect image", images: [image] }),
		]);
	});

	it("does not coalesce steering inputs that share a follow-up queue key", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.pauseQueuedWork();
		withStreaming(harness, true);

		await harness.session.steer("first", undefined, { queueKey: "same" });
		await harness.session.steer("second", undefined, { queueKey: "same" });

		expect(harness.session.getSteeringMessages()).toEqual(["first", "second"]);
	});

	it("rejects both agent-message outcome legs when keyed follow-ups coalesce", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);
		await harness.session.followUp("existing", undefined, { queueKey: "same" });

		const expandedId = "agentmsg_coalesced_expanded";
		const earlyExpandedDelivery = expect(
			harness.session.waitForAgentMessagePromptDelivery(expandedId),
		).rejects.toThrow("equivalent follow-up is already pending");
		const completion = expect(
			harness.session.promptAndWait("duplicate", {
				streamingBehavior: "followUp",
				followUpQueueKey: "same",
				agentMessageId: expandedId,
			}),
		).rejects.toThrow("equivalent follow-up is already pending");
		await Promise.all([earlyExpandedDelivery, completion]);

		const restoredId = "agentmsg_coalesced_restored";
		const earlyRestoredDelivery = expect(
			harness.session.waitForAgentMessagePromptDelivery(restoredId),
		).rejects.toThrow("equivalent follow-up is already pending");
		await expect(
			harness.session.restoreFollowUpMessage("restored duplicate", undefined, {
				queueKey: "same",
				agentMessageId: restoredId,
			}),
		).resolves.toBe(false);
		await earlyRestoredDelivery;
		expect(harness.session.getFollowUpMessages()).toEqual(["existing"]);
	});

	it.each(["queued", "preparing"] as const)(
		"keeps a coalesced duplicate with its $phase agent-message owner",
		async (phase) => {
			const prepared = createDeferred<void>();
			const releasePreparation = createDeferred<void>();
			const harness = await createHarness({
				extensionFactories:
					phase === "preparing"
						? [
								(pi) => {
									pi.on("before_agent_start", async () => {
										prepared.resolve();
										await releasePreparation.promise;
									});
								},
							]
						: [],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("accepted done")]);
			const pause = phase === "queued" ? harness.session.acquireQueuedWorkPause() : undefined;
			const id = `agentmsg_${phase}_coalesced_owner`;
			withStreaming(harness, true);
			const earlyDelivery = harness.session.waitForAgentMessagePromptDelivery(id);

			const completion = harness.session.promptAndWait("accepted", {
				streamingBehavior: "followUp",
				followUpQueueKey: "same",
				agentMessageId: id,
				resumeIfIdle: true,
			});
			if (phase === "queued") {
				await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["accepted"]));
			} else {
				withStreaming(harness, false);
				await prepared.promise;
				await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual([]));
			}
			await expect(
				harness.session.restoreFollowUpMessage("duplicate", undefined, { queueKey: "same", agentMessageId: id }),
			).resolves.toBe(false);

			withStreaming(harness, false);
			pause?.release();
			releasePreparation.resolve();
			await expect(earlyDelivery).resolves.toBeUndefined();
			await expect(completion).resolves.toBeUndefined();
			expect(getUserTexts(harness)).toEqual(["accepted"]);
		},
	);

	it("retains active preparation while blocking duplicate and direct admission", async () => {
		let hookRuns = 0;
		let pause: { release(): void } | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt === "queued") {
							hookRuns++;
							pause = harness.session.acquireQueuedWorkPause();
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued done"), fauxAssistantMessage("direct done")]);
		withStreaming(harness, true);
		await harness.session.followUp("queued", undefined, { queueKey: "same", resumeIfIdle: true });
		withStreaming(harness, false);
		await vi.waitFor(() => expect(pause).toBeDefined());

		expect(await harness.session.followUp("duplicate", undefined, { queueKey: "same" })).toBe(false);
		const direct = harness.session.prompt("direct");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getUserTexts(harness)).toEqual([]);
		pause?.release();
		await direct;

		expect(hookRuns).toBe(1);
		expect(getUserTexts(harness)).toEqual(["queued", "direct"]);
	});

	it("stops before another turn when more steering remains", async () => {
		const tool: AgentTool = {
			name: "instant",
			label: "Instant",
			description: "Returns immediately",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("instant", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("second handled"),
		]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.steer("first", undefined, { resumeIfIdle: true });
		await harness.session.steer("second", undefined, { resumeIfIdle: true });
		pause.release();
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["first", "second"]);
		expect(getAssistantTexts(harness)).toEqual(["", "second handled"]);
	});

	it.each([
		{
			action: "refine",
			run: (harness: Harness) => harness.session.refine({}, { skipAbort: true }),
		},
		{
			action: "compact",
			run: (harness: Harness) => harness.session.compact(undefined, { skipAbort: true }),
		},
	])("rejects skip-abort $action while a turn is active", async ({ action, run }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);

		await expect(run(harness)).rejects.toThrow(`Cannot ${action} without aborting while the agent is running.`);
	});

	it("serializes queued prompt preparation with a direct prompt handoff", async () => {
		const gate = gatedHook({ prompt: "direct" });
		const harness = await createHarness({ extensionFactories: [gate.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("direct done"), fauxAssistantMessage("queued done")]);

		const direct = harness.session.prompt("direct");
		await gate.reached;
		await harness.session.followUp("queued", undefined, { resumeIfIdle: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(getUserTexts(harness)).toEqual([]);

		gate.release();
		await direct;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["direct", "queued"]);
	});

	it("defers work queued after direct admission until the direct handoff", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("direct done"), fauxAssistantMessage("queued done")]);
		const internals = harness.session as unknown as {
			_acquireDirectTurnAdmission(options?: { allowStreaming?: boolean }): Promise<{
				owner: symbol;
				release(): void;
			}>;
		};
		const acquireDirectTurnAdmission = internals._acquireDirectTurnAdmission.bind(internals);
		let queuedAtBoundary = false;
		internals._acquireDirectTurnAdmission = async (options = {}) => {
			const admission = await acquireDirectTurnAdmission(options);
			if (!queuedAtBoundary) {
				queuedAtBoundary = true;
				await harness.session.followUp("queued", undefined, { resumeIfIdle: true });
			}
			return admission;
		};

		await harness.session.prompt("direct");
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["direct", "queued"]);
	});

	it("serializes an extension command behind an unrelated navigation owner", async () => {
		let targetId: string | undefined;
		const navigationGate = createDeferred();
		let navigationStarts = 0;
		let commandNavigated = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						if (navigationStarts++ === 0) await navigationGate.promise;
					});
					pi.registerCommand("back", {
						description: "Navigate back",
						handler: async (_args, ctx) => {
							await ctx.navigateTree(targetId!, { summarize: false });
							commandNavigated = true;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async (target, options) => harness.session.navigateTree(target, options),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		targetId = harness.sessionManager.getEntries().find((entry) => entry.type === "message")?.id;
		expect(targetId).toBeDefined();
		await harness.session.prompt("two");
		const secondId = harness.sessionManager.getLeafId();

		const unrelatedNavigation = harness.session.navigateTree(targetId!, { summarize: false });
		await vi.waitFor(() => expect(navigationStarts).toBe(1));
		const extensionCommand = harness.session.prompt("/back");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(commandNavigated).toBe(false);

		navigationGate.resolve();
		await unrelatedNavigation;
		await extensionCommand;
		expect(commandNavigated).toBe(true);
		expect(navigationStarts).toBe(2);
		expect(harness.sessionManager.getLeafId()).not.toBe(secondId);
	});

	it("waitForIdle observes a run that starts at its final idle boundary", async () => {
		const responseGate = createDeferred();
		const waitForResponseStart = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				waitForResponseStart.resolve();
				await responseGate.promise;
				return fauxAssistantMessage("late done");
			},
		]);
		const agentWaitForIdle = harness.session.agent.waitForIdle.bind(harness.session.agent);
		let waitCalls = 0;
		vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(async () => {
			await agentWaitForIdle();
			if (waitCalls++ === 0) void harness.session.agent.prompt("late run");
		});

		let idle = false;
		const waiting = harness.session.waitForIdle().then(() => {
			idle = true;
		});
		await waitForResponseStart.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(idle).toBe(false);

		responseGate.resolve();
		await waiting;
		expect(idle).toBe(true);
	});
	it("parses queued refine rollback ids and global placement without consuming instruction text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		for (const [command, options] of [
			["/refine rollback refine_123", { rollbackId: "refine_123", global: false }],
			["/refine rollback refine_456 --global", { rollbackId: "refine_456", global: true }],
			["/refine --global rollback refine_789", { rollbackId: "refine_789", global: true }],
			["/refine --global focus on validation", { instructions: "focus on validation", global: true }],
			[
				"/refine update docs to explain --global",
				{ instructions: "update docs to explain --global", global: false },
			],
		] as const) {
			await harness.session.prompt(command);
			expect(refine).toHaveBeenLastCalledWith(options, { skipAbort: true });
		}
	});

	it("reports a missing queued refine rollback id without invoking refine", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const refine = vi.spyOn(harness.session, "refine");

		await harness.session.prompt("/refine rollback");

		expect(refine).not.toHaveBeenCalled();
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "custom" &&
					message.customType === "session_slash_command_result" &&
					message.content === "Command failed: Usage: /refine rollback <refinement-id>",
			),
		).toBe(true);
	});
});
