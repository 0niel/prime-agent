import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import type { ExtensionFactory } from "../../src/core/extensions/types.js";
import type { GoalHostResponse } from "../../src/core/goals.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

function assistantWithUsage(message: string | AssistantMessage, usage: Partial<Usage>): AssistantMessage {
	const base = typeof message === "string" ? fauxAssistantMessage(message) : message;
	return {
		...base,
		usage: {
			...base.usage,
			...usage,
			cost: {
				...base.usage.cost,
				...usage.cost,
			},
		},
	};
}

function goalContextMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "goal_context",
	);
}

function visibleAssistantTexts(harness: Harness): string[] {
	return getAssistantTexts(harness).filter(Boolean);
}

function currentAgentContext(harness: Harness): AgentContext {
	const state = harness.session.agent.state;
	return {
		systemPrompt: state.systemPrompt,
		messages: [...state.messages],
		tools: [...state.tools],
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}

/**
 * Stand-in for the real ipython tool. Goal calls reach the host over the
 * kernel comm bridge while an ipython cell executes; this stub mirrors that
 * timing by dispatching `goal.*` host requests from inside tool execution.
 *
 * Cell format: `goal.<op>` optionally followed by a JSON payload, e.g.
 * `goal.create {"objective": "write a note"}`.
 */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId, params) => {
			const session = sessionRef.current;
			if (!session) {
				throw new Error("test session is not initialized");
			}
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			}
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	};
}

const COMPLETE_GOAL_CELL = { code: "goal.complete" };

function createWaitingTool(): {
	tool: AgentTool;
	release: () => void;
	waitForStart: (harness: Harness) => Promise<void>;
} {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				const abort = () => reject(new Error("aborted"));
				signal?.addEventListener("abort", abort, { once: true });
				toolRelease.then(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				});
			});
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
				terminate: true,
			};
		},
	};
	return {
		tool,
		release: () => releaseToolExecution?.(),
		waitForStart: (harness) =>
			new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "tool_execution_start" && event.toolName === "wait") {
						unsubscribe();
						resolve();
					}
				});
			}),
	};
}

describe("AgentSession goals", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createGoalHarness(extraTools: AgentTool[] = []): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({ tools: [createFauxIpythonTool(sessionRef), ...extraTools] });
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	it("keeps continuing until the model completes the goal through ipython", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("I need another step."),
			fauxAssistantMessage("The work is complete."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(visibleAssistantTexts(harness)).toEqual([
			"I need another step.",
			"The work is complete.",
			"Goal complete.",
		]);
		expect(goalContextMessages(harness)).toHaveLength(3);
		expect(getMessageText(goalContextMessages(harness)[0])).toContain("<goal_context>");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 2,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("counts tokens from the goal completion turn", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{
					input: 4,
					output: 2,
					totalTokens: 6,
				},
			),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
		expect(harness.session.goalState.tokensUsed).toBeGreaterThan(0);
	});

	it("does not count post-completion turns against the finished goal", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 4, output: 2, totalTokens: 6 },
			),
			assistantWithUsage(
				"Goal complete; here is a long closing summary that must not be billed to the finished goal.",
				{ input: 20, output: 10, totalTokens: 30 },
			),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState.status).toBe("complete");
		const completeUpdates = harness.eventsOfType("goal_update").filter((event) => event.goal.status === "complete");
		expect(completeUpdates.length).toBeGreaterThan(0);
		const tokensAtCompletion = completeUpdates[0].goal.tokensUsed;
		expect(tokensAtCompletion).toBeGreaterThan(0);
		// The closing-summary turn runs after goal.complete() over the host bridge;
		// it must not increase the finished goal's token usage.
		expect(harness.session.goalState.tokensUsed).toBe(tokensAtCompletion);
	});

	it("returns the goal snapshot and completion report over the host bridge", async () => {
		const harness = await createGoalHarness();

		expect(harness.session.handleGoalHostRequest("goal.get")).toEqual({
			goal: null,
			remaining_tokens: null,
			completion_budget_report: null,
		});

		const created = harness.session.handleGoalHostRequest("goal.create", {
			objective: "write a benchmark note",
			token_budget: 50,
		});
		expect(created.goal).toMatchObject({
			objective: "write a benchmark note",
			status: "active",
			token_budget: 50,
			tokens_used: 0,
		});
		expect(created.remaining_tokens).toBe(50);

		const completed = harness.session.handleGoalHostRequest("goal.complete");
		expect(completed.goal).toMatchObject({ status: "complete" });
		expect(completed.completion_budget_report).toContain("tokens used: 0 of 50");
	});

	it("rejects malformed and unknown goal host requests", async () => {
		const harness = await createGoalHarness();

		expect(() => harness.session.handleGoalHostRequest("goal.create", {})).toThrow(
			"goal.create objective must be a string",
		);
		expect(() => harness.session.handleGoalHostRequest("goal.nonsense")).toThrow(
			'unknown goal request type "goal.nonsense"',
		);
		expect(() => harness.session.handleGoalHostRequest("goal.complete")).toThrow(
			"cannot complete goal because this thread has no goal",
		);

		harness.session.handleGoalHostRequest("goal.create", { objective: "first goal" });
		expect(() => harness.session.handleGoalHostRequest("goal.create", { objective: "second goal" })).toThrow(
			"already has an active goal",
		);
	});

	it("lets the model create a fresh goal after the previous one completed", async () => {
		const harness = await createGoalHarness();

		const first = harness.session.handleGoalHostRequest("goal.create", { objective: "first goal" });
		harness.session.handleGoalHostRequest("goal.complete");

		const second = harness.session.handleGoalHostRequest("goal.create", { objective: "second goal" });
		expect(second.goal).toMatchObject({ objective: "second goal", status: "active", tokens_used: 0 });
		expect(second.goal?.goal_id).not.toBe(first.goal?.goal_id);
		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "second goal",
			continuationsUsed: 0,
		});
	});

	it("rejects goal.create while a goal is paused", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		expect(harness.session.goalState.status).toBe("paused");
		expect(() => harness.session.handleGoalHostRequest("goal.create", { objective: "replacement" })).toThrow(
			"a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
		);
	});

	it("activates ipython when a slash goal starts from an inactive tool set", async () => {
		const harness = await createGoalHarness();
		harness.session.setActiveToolsByName([]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
	});

	it("adds ipython to the live continuation context when inactive at run start", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		harness.session.setActiveToolsByName([]);
		harness.setResponses([
			fauxAssistantMessage("Still working."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("continue");

		expect(visibleAssistantTexts(harness)).toEqual(["Still working.", "Goal complete."]);
		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
	});

	it("does not re-add deactivated tools on runtime rebuild without an active goal", async () => {
		const harness = await createGoalHarness();
		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);

		harness.session.setActiveToolsByName([]);
		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("keeps ipython active on active-goal runtime rebuild", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });

		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toEqual(["ipython"]);
	});

	it("does not reject continuation when goal error update listeners throw", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		harness.session.subscribe((event) => {
			if (event.type === "goal_update") {
				throw new Error("listener failed");
			}
		});
		harness.setResponses([fauxAssistantMessage("Still working.")]);

		await expect(harness.session.prompt("continue")).resolves.toBeUndefined();
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
		});
	});

	it("does not infer completion from an assistant claim without goal.complete", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("Done."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal write a greeting");

		expect(visibleAssistantTexts(harness)).toEqual(["Done.", "Goal complete."]);
		expect(goalContextMessages(harness)).toHaveLength(2);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
		});
	});

	it("lets the model create a persistent goal through ipython", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", { code: 'goal.create {"objective": "write a benchmark note"}' }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("Started the note."),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("Create a goal to write a benchmark note.");

		expect(visibleAssistantTexts(harness)).toEqual(["Started the note.", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			objective: "write a benchmark note",
			continuationsUsed: 1,
		});
	});

	it("reloads goal state after tree navigation", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([fauxAssistantMessage("before goal")]);
		await harness.session.prompt("normal prompt");
		const beforeGoalEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!beforeGoalEntry) {
			throw new Error("expected assistant entry before goal");
		}

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);
		await harness.session.prompt("/goal finish the task");
		expect(harness.session.goalState.status).toBe("complete");

		await harness.session.navigateTree(beforeGoalEntry.id, { summarize: false });

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "idle",
		});
	});

	it("keeps active goals sticky across normal user prompts", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("answered the side question"),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("answer a side question", { streamingBehavior: "followUp" });
		waiting.release();
		await promptPromise;

		expect(visibleAssistantTexts(harness)).toEqual(["answered the side question", "Goal complete."]);
		expect(
			harness.session.messages.some((message) => getMessageText(message).includes("answer a side question")),
		).toBe(true);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
		});
	});

	it.each([
		{ command: "/goal clear", status: "idle" },
		{ command: "/goal pause", status: "paused" },
	])("removes queued goal context after $command while streaming", async ({ command, status }) => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("stale goal response"),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("start a blocking turn");
		await waitForStart;
		await harness.session.prompt("/goal stale goal");
		await harness.session.prompt(command);
		waiting.release();
		await promptPromise;

		expect(goalContextMessages(harness)).toHaveLength(0);
		expect(visibleAssistantTexts(harness)).toEqual([]);
		expect(harness.session.goalState.status).toBe(status);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("pauses an active goal with /goal pause", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			lastReason: "Paused by user",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resumes a paused goal with /goal resume", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 0,
		});
	});

	it("does not resume a completed goal", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("/goal finish the task");
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not resume an errored goal", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("/goal do work");
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("reports active goal elapsed time on status reads and goal.get", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const waiting = createWaitingTool();
			const harness = await createGoalHarness([waiting.tool]);
			harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

			const waitForStart = waiting.waitForStart(harness);
			const promptPromise = harness.session.prompt("/goal track elapsed time");
			await waitForStart;
			vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));

			expect(harness.session.goalState.timeUsedSeconds).toBe(5);
			const response: GoalHostResponse = harness.session.handleGoalHostRequest("goal.get");
			expect(response.goal?.time_used_seconds).toBe(5);

			await harness.session.prompt("/goal pause");
			waiting.release();
			await promptPromise;
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears a goal with /goal clear without consuming a provider response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("/goal clear");

		expect(harness.session.messages).toEqual([]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not persist a goal when start preflight fails", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("/goal do task")).rejects.toThrow();

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "idle",
		});
		expect(harness.session.messages).toEqual([]);
	});

	it("completes a goal whose completing turn crosses the budget without a stale budget-limit steer", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 6, output: 5, totalTokens: 11 },
			),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal --budget 10 finish the task");

		expect(visibleAssistantTexts(harness)).toEqual(["Goal complete."]);
		const contextKinds = goalContextMessages(harness).map(
			(message) => (message as { details?: { kind?: string } }).details?.kind,
		);
		expect(contextKinds).not.toContain("budget_limit");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			tokenBudget: 10,
			lastReason: "Goal achieved",
		});
		expect(harness.session.goalState.tokensUsed).toBeGreaterThanOrEqual(10);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("marks an active goal budget_limited when token budget is reached", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			assistantWithUsage("Spent the budget.", { input: 6, output: 5, totalTokens: 11 }),
			fauxAssistantMessage("Wrapping up."),
		]);

		await harness.session.prompt("/goal --budget 10 do work");

		expect(visibleAssistantTexts(harness)).toEqual(["Spent the budget.", "Wrapping up."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
			continuationsUsed: 0,
		});
		expect(harness.session.goalState.tokensUsed).toBeGreaterThanOrEqual(10);
	});

	it("checks goal budget before continuation while event processing is delayed", async () => {
		let releaseMessageEnd: (() => void) | undefined;
		const blockedMessageEnd = new Promise<void>((resolve) => {
			releaseMessageEnd = resolve;
		});
		let didBlock = false;
		const extension: ExtensionFactory = (pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role === "assistant" && !didBlock) {
					didBlock = true;
					await blockedMessageEnd;
				}
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		harnesses.push(harness);
		harness.setResponses([
			assistantWithUsage("Spent the budget.", { input: 6, output: 5, totalTokens: 11 }),
			fauxAssistantMessage("Wrapping up."),
			fauxAssistantMessage("Should not continue."),
		]);

		const promptPromise = harness.session.prompt("/goal --budget 10 do work");
		try {
			await waitForCondition(() => harness.getPendingResponseCount() === 1);
		} finally {
			releaseMessageEnd?.();
		}
		await promptPromise;

		expect(visibleAssistantTexts(harness)).toEqual(["Spent the budget.", "Wrapping up."]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
			continuationsUsed: 0,
		});
	});

	it.each(["/goal --budget=1abc task", "/goal --budget 1.5 task", "/goal --budget 1e6 task"])(
		"rejects malformed goal budget %s",
		async (command) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("unused")]);

			await expect(harness.session.prompt(command)).rejects.toThrow("Goal token budget must be a positive integer.");

			expect(harness.session.goalState).toMatchObject({
				active: false,
				status: "idle",
			});
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("marks the goal as errored on terminal provider errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("/goal do work");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
			lastError: "invalid_api_key",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not continue when a terminal error reaches the continuation hook", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		const errorMessage = fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" });

		const continuationMessages = await harness.session.agent.getContinuationMessages?.({
			message: errorMessage,
			toolResults: [],
			context: currentAgentContext(harness),
			newMessages: [errorMessage],
		});

		expect(continuationMessages).toEqual([]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
			lastError: "invalid_api_key",
		});
	});

	it("keeps the goal active on aborted provider turns", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);

		await harness.session.prompt("/goal do work");

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("lets the user abort a goal turn, prompt in between, then resume the goal", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.abort();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
		});

		harness.setResponses([
			fauxAssistantMessage("answered the interjection"),
			fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("answer this before continuing the goal");

		expect(visibleAssistantTexts(harness)).toEqual(["answered the interjection", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
	});

	it("reports status without consuming a provider response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("/goal status");

		expect(harness.session.messages).toEqual([]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
