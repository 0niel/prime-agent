import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { createHarness, type Harness } from "../harness.js";

function createGoalHostTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId, params) => {
			const session = sessionRef.current;
			if (!session) throw new Error("test session is not initialized");
			const code = (params as { code: string }).code;
			const separator = code.indexOf(" ");
			const type = separator < 0 ? code : code.slice(0, separator);
			const payload = separator < 0 ? {} : (JSON.parse(code.slice(separator + 1)) as Record<string, unknown>);
			return {
				content: [{ type: "text", text: JSON.stringify(session.handleGoalHostRequest(type, payload)) }],
				details: {},
			};
		},
	};
}

describe("#986 blocked goal continuation", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("stops autonomous continuation after the model explicitly pauses for external input", async () => {
		const sessionRef: { current?: AgentSession } = {};
		harness = await createHarness({ tools: [createGoalHostTool(sessionRef)] });
		sessionRef.current = harness.session;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: 'goal.pause {"reason":"waiting for go-live approval"}',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Waiting for go-live approval."),
			fauxAssistantMessage("unwanted repeated continuation"),
		]);

		await harness.session.prompt("/goal ship every billing story");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			lastReason: "waiting for go-live approval",
			continuationsUsed: 0,
		});
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "goal_context",
			),
		).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("validates model-driven pause and resume transitions", async () => {
		harness = await createHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "ship release" });

		expect(() => harness?.session.handleGoalHostRequest("goal.pause", { reason: "   " })).toThrow(
			"Goal pause reason must not be empty",
		);
		const paused = harness.session.handleGoalHostRequest("goal.pause", { reason: "  waiting for approval  " });
		expect(paused.goal).toMatchObject({
			status: "paused",
			last_reason: "waiting for approval",
		});
		expect(() => harness?.session.handleGoalHostRequest("goal.pause", { reason: "again" })).toThrow("no active goal");

		const resumed = harness.session.handleGoalHostRequest("goal.resume");
		expect(resumed.goal).toMatchObject({ status: "active" });
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "goal_context"),
		).toBe(false);
		expect(() => harness?.session.handleGoalHostRequest("goal.resume")).toThrow("no paused goal");
	});
});
