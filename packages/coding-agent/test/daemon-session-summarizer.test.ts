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

		test("extracts the recap from <recap> tags", () => {
			const text = "SUMMARY: <recap>Sending SSH auth retry to tcg-autoresearch-rl</recap>\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({
				summary: "Sending SSH auth retry to tcg-autoresearch-rl",
			});
		});

		test("drops chain-of-thought after the closing recap tag", () => {
			const text =
				"SUMMARY: <recap>Sending SSH auth retry to tcg-autoresearch-rl</recap> That's 5 words? Count: Sending(1) SSH(2) auth(3) retry(4) to(5) tcg-autoresearch-rl(6) = 6 words. Under..\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({
				summary: "Sending SSH auth retry to tcg-autoresearch-rl",
			});
		});

		test("cuts inline reasoning when the model omits the closing tag", () => {
			const text =
				"SUMMARY: Sending SSH auth retry to tcg-autoresearch-rl. That's 5 words? Count: Sending(1) SSH(2) = 6 words. Under\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({
				summary: "Sending SSH auth retry to tcg-autoresearch-rl",
			});
		});

		test("salvages the clean prefix before counting artifacts begin", () => {
			const text = "SUMMARY: Counting words(1) two(2) three(3) = 3 words\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({ summary: "Counting words" });
		});

		test("rejects a candidate whose counting starts at the very first word", () => {
			// No clean prefix to salvage — the recap is nothing but the artifact.
			const text = "SUMMARY: (1) word(2) count(3) = 3 words\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toBeUndefined();
		});

		test("rejects a rambling candidate that blows past the word ceiling", () => {
			const text =
				"SUMMARY: this is a very long rambling sentence that just keeps going and going well past any reasonable recap length\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toBeUndefined();
		});

		test("strips wrapping quotes the model adds around the recap", () => {
			const text = 'SUMMARY: <recap>"Wiring the recap line"</recap>\nSTATUS: COMPLETED';
			expect(parseAgentStatusResponse(text, false)).toEqual({
				summary: "Wiring the recap line",
				taskState: "completed",
			});
		});

		test("accepts RECAP: as a synonym for SUMMARY:", () => {
			const text = "RECAP: Restarting the daemon\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({ summary: "Restarting the daemon" });
		});

		test("ignores an open recap tag with no close", () => {
			const text = "SUMMARY: <recap>Editing the parser\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({ summary: "Editing the parser" });
		});

		test("keeps recaps that start with words also used in reasoning", () => {
			for (const recap of ["Waiting for CI to finish", "Let me know once tests pass", "Under review by the team"]) {
				expect(parseAgentStatusResponse(`SUMMARY: ${recap}\nSTATUS: WORKING`, true)).toEqual({ summary: recap });
			}
		});

		test("takes the last SUMMARY line when a draft is corrected", () => {
			const text = "SUMMARY: Draft recap\nSUMMARY: Final corrected recap\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({ summary: "Final corrected recap" });
		});

		test("falls back to a SUMMARY line when the tagged body is rejected", () => {
			// The tag body is pure counting (rejected); a later valid line must win.
			const text = "<recap>(1) two(2) = 2 words</recap>\nSUMMARY: Editing the parser\nSTATUS: WORKING";
			expect(parseAgentStatusResponse(text, true)).toEqual({ summary: "Editing the parser" });
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
