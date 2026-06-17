import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import type { AgentStatus } from "../src/core/session-manager.js";
import {
	agentStatusChanged,
	buildStatusContext,
	parseAgentStatusResponse,
} from "../src/modes/daemon/daemon-session-summarizer.js";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function assistantMessage(text: string, tools: string[] = []): AgentMessage {
	const content = [{ type: "text", text }, ...tools.map((name) => ({ type: "tool_use", name, id: name, input: {} }))];
	return { role: "assistant", content, timestamp: 0 } as unknown as AgentMessage;
}

describe("daemon session summarizer", () => {
	describe("parseAgentStatusResponse", () => {
		test("parses summary and completion verdict for an idle session", () => {
			const result = parseAgentStatusResponse("SUMMARY: Added the API reference page.\nSTATUS: COMPLETED", false);
			expect(result).toEqual({ summary: "Added the API reference page", taskState: "completed" });
		});

		test("maps NEEDS_INPUT for idle sessions", () => {
			const result = parseAgentStatusResponse("SUMMARY: Asked which database to target\nSTATUS: NEEDS_INPUT", false);
			expect(result?.taskState).toBe("needs_input");
		});

		test("omits the verdict while working", () => {
			const result = parseAgentStatusResponse("SUMMARY: Refactoring token validation\nSTATUS: WORKING", true);
			expect(result).toEqual({ summary: "Refactoring token validation" });
		});

		test("falls back to needs_input on an unrecognized or hedged idle verdict", () => {
			expect(parseAgentStatusResponse("SUMMARY: Something\nSTATUS: WORKING", false)?.taskState).toBe("needs_input");
			expect(parseAgentStatusResponse("SUMMARY: Something\nSTATUS: MAYBE", false)?.taskState).toBe("needs_input");
			expect(parseAgentStatusResponse("SUMMARY: Something", false)?.taskState).toBe("needs_input");
		});

		test("requires the SUMMARY marker and never surfaces free-form text", () => {
			// A chatty/reasoning model that narrates instead of answering yields no
			// recap rather than leaking its thinking.
			expect(parseAgentStatusResponse("Investigating the failing test.", true)).toBeUndefined();
			expect(
				parseAgentStatusResponse(
					"We need to produce exactly two lines: SUMMARY: <one present-tense clause> and STATUS: with a",
					false,
				),
			).toBeUndefined();
		});

		test("takes the answer after inline reasoning and strips think tags", () => {
			const reasoning =
				"<think>Let me decide. The agent finished editing.</think>\nSUMMARY: Updated the login handler\nSTATUS: COMPLETED";
			expect(parseAgentStatusResponse(reasoning, false)).toEqual({
				summary: "Updated the login handler",
				taskState: "completed",
			});
		});

		test("ignores an echoed prompt template", () => {
			const echoed = "SUMMARY: <one present-tense clause, at most 12 words, no trailing period>\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(echoed, true)).toBeUndefined();
		});

		test("strips reasoning tag variants before parsing", () => {
			for (const tag of ["think", "thinking", "reasoning", "redacted_thinking"]) {
				const text = `<${tag}>deliberating about the answer</${tag}>\nSUMMARY: Wired the recap line\nSTATUS: COMPLETED`;
				expect(parseAgentStatusResponse(text, false)).toEqual({
					summary: "Wired the recap line",
					taskState: "completed",
				});
			}
		});

		test("returns undefined when no summary is present", () => {
			expect(parseAgentStatusResponse("", false)).toBeUndefined();
			expect(parseAgentStatusResponse("STATUS: COMPLETED", false)).toBeUndefined();
		});
	});

	describe("buildStatusContext", () => {
		test("includes the agent state and the trailing conversation with tool names", () => {
			const context = buildStatusContext(
				[userMessage("add a login endpoint"), assistantMessage("Editing the router", ["Edit", "Bash"])],
				true,
			);
			expect(context).toContain("<agent-state>working</agent-state>");
			expect(context).toContain("user: add a login endpoint");
			expect(context).toContain("assistant: Editing the router [tools: Edit, Bash]");
		});

		test("marks idle sessions as finished", () => {
			expect(buildStatusContext([userMessage("hi")], false)).toContain("idle (finished its turn)");
		});

		test("only keeps the most recent messages", () => {
			const messages = Array.from({ length: 20 }, (_, i) => userMessage(`message ${i}`));
			const context = buildStatusContext(messages, false);
			expect(context).toContain("message 19");
			expect(context).not.toContain("message 0\n");
		});
	});

	describe("agentStatusChanged", () => {
		const base: AgentStatus = { summary: "Working on it", taskState: "needs_input", basedOnMessageCount: 4 };
		test("is true when there is no previous status", () => {
			expect(agentStatusChanged(undefined, { summary: "x" })).toBe(true);
		});
		test("detects summary and verdict changes", () => {
			expect(agentStatusChanged(base, { summary: "Working on it", taskState: "needs_input" })).toBe(false);
			expect(agentStatusChanged(base, { summary: "Done", taskState: "needs_input" })).toBe(true);
			expect(agentStatusChanged(base, { summary: "Working on it", taskState: "completed" })).toBe(true);
		});
	});
});
