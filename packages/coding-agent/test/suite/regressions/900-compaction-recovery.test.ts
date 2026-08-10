import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildSummarizationPrompt,
	estimateContextTokens,
	estimateSummaryRequestTokens,
	estimateTextTokens,
	generateSummary,
	prepareCompaction,
} from "../../../src/core/compaction/index.js";
import { buildSessionContext, type SessionEntry } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

const model: Model<"anthropic-messages"> = {
	id: "small-context",
	name: "Small Context",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 2_000,
};

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		...fauxAssistantMessage(text, { stopReason }),
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		timestamp: 2,
	};
}

function entry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
}

describe("#900 bounded compaction recovery", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockImplementation(async () =>
			fauxAssistantMessage(`summary-${completeSimpleMock.mock.calls.length}`),
		);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rolls every segment of one oversized message through bounded requests", async () => {
		const tailSentinel = "OVERSIZED_MESSAGE_TAIL_SENTINEL";
		completeSimpleMock.mockImplementation(async (_model, context) => {
			const prompt = context.messages[0].content[0].text as string;
			return fauxAssistantMessage(
				prompt.includes(tailSentinel)
					? `## Next Steps\n1. Preserve ${tailSentinel}\n\n## Critical Context\n- tail was observed`
					: "rolling checkpoint",
			);
		});
		const content = `HEAD_SENTINEL_${"x".repeat(120_000)}_${tailSentinel}`;

		const summary = await generateSummary([{ role: "user", content, timestamp: 1 }], model, 2_000, "test-key");

		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
		const prompts = completeSimpleMock.mock.calls.map(([, context]) => context.messages[0].content[0].text as string);
		expect(prompts.join("\n")).toContain("HEAD_SENTINEL");
		expect(prompts.join("\n")).toContain(tailSentinel);
		expect(prompts.join("\n")).not.toContain("oversized message truncated");
		expect(summary).toContain(tailSentinel);
	});

	it("preserves oversized tool-result tails now that requests are externally bounded", async () => {
		const tailSentinel = "TOOL_RESULT_TAIL_SENTINEL";
		completeSimpleMock.mockImplementation(async (_model, context) => {
			const prompt = context.messages[0].content[0].text as string;
			return fauxAssistantMessage(prompt.includes(tailSentinel) ? `checkpoint ${tailSentinel}` : "checkpoint");
		});

		const summary = await generateSummary(
			[
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: `${"tool output ".repeat(10_000)}${tailSentinel}` }],
					isError: false,
					timestamp: 1,
				},
			],
			model,
			2_000,
			"test-key",
		);

		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
		expect(summary).toContain(tailSentinel);
	});

	it("makes strict progress at the continuation-marker Unicode boundary", async () => {
		const boundaryModel = { ...model };
		const maxTokens = Math.min(1_600, boundaryModel.maxTokens, Math.floor(boundaryModel.contextWindow * 0.15));
		const safetyTokens = Math.max(256, Math.min(8_192, Math.floor(boundaryModel.contextWindow * 0.08)));
		const maxPromptTokens = boundaryModel.contextWindow - maxTokens - safetyTokens - estimateSummaryRequestTokens("");
		const previousSummary = "stable";
		const fixedPrompt = (instructions: string) =>
			`<conversation>\n\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${buildSummarizationPrompt(instructions, "rolling")}`;
		const availableWithOneInstructionCharacter = maxPromptTokens - Buffer.byteLength(fixedPrompt("x"), "utf8") - 32;
		const customInstructions = "x".repeat(availableWithOneInstructionCharacter - 41 + 1);
		expect(maxPromptTokens - Buffer.byteLength(fixedPrompt(customInstructions), "utf8") - 32).toBe(41);
		completeSimpleMock.mockResolvedValue(fauxAssistantMessage(previousSummary));
		const character = "\u{10ffff}";

		await generateSummary(
			[{ role: "user", content: character.repeat(30), timestamp: 1 }],
			boundaryModel,
			2_000,
			"test-key",
			undefined,
			undefined,
			customInstructions,
			previousSummary,
		);

		const prompts = completeSimpleMock.mock.calls.map(([, context]) => context.messages[0].content[0].text as string);
		expect(prompts.length).toBeGreaterThan(1);
		expect(prompts.length).toBeLessThan(100);
		expect(prompts.join("").split(character)).toHaveLength(31);
	});

	it("keeps every request within the estimated model budget for byte-fallback Unicode", async () => {
		const denseUnicode = `${"\u{10ffff}".repeat(12_000)}${"\u0080".repeat(12_000)}`;
		expect(estimateTextTokens(denseUnicode)).toBeGreaterThan(denseUnicode.length);

		await generateSummary([{ role: "user", content: denseUnicode, timestamp: 1 }], model, 2_000, "test-key");

		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
		for (const [, context, options] of completeSimpleMock.mock.calls) {
			const prompt = context.messages[0].content[0].text as string;
			const estimatedTotal = estimateSummaryRequestTokens(prompt) + options.maxTokens;
			expect(estimatedTotal).toBeLessThanOrEqual(model.contextWindow - 256);
		}
	});

	it("compresses the complete prior checkpoint without clipping Next Steps or Critical Context", async () => {
		const nextSentinel = "NEXT_STEPS_TAIL_SENTINEL";
		const criticalSentinel = "CRITICAL_CONTEXT_TAIL_SENTINEL";
		completeSimpleMock.mockImplementation(async (_model, context) => {
			const prompt = context.messages[0].content[0].text as string;
			const next = prompt.includes(nextSentinel) ? `\n## Next Steps\n1. ${nextSentinel}` : "";
			const critical = prompt.includes(criticalSentinel) ? `\n## Critical Context\n- ${criticalSentinel}` : "";
			return fauxAssistantMessage(`rolling checkpoint${next}${critical}`);
		});
		const previousSummary = `## Goal\nrecover\n${"prior detail ".repeat(15_000)}\n## Next Steps\n1. ${nextSentinel}\n## Critical Context\n- ${criticalSentinel}`;

		const summary = await generateSummary(
			[{ role: "user", content: "new message", timestamp: 1 }],
			model,
			2_000,
			"test-key",
			undefined,
			undefined,
			undefined,
			previousSummary,
		);

		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
		expect(
			completeSimpleMock.mock.calls.some(([, context]) =>
				(context.messages[0].content[0].text as string).includes(nextSentinel),
			),
		).toBe(true);
		expect(summary).toContain(nextSentinel);
		expect(summary).toContain(criticalSentinel);
	});

	it("rolls many messages through sequential bounded requests", async () => {
		const messages: AgentMessage[] = Array.from({ length: 20 }, (_, index) => ({
			role: "user" as const,
			content: `message-${index} ${"payload ".repeat(700)}`,
			timestamp: index,
		}));

		const summary = await generateSummary(messages, model, 2_000, "test-key");

		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
		for (const [, context, options] of completeSimpleMock.mock.calls) {
			const prompt = context.messages[0].content[0].text as string;
			expect(estimateSummaryRequestTokens(prompt) + options.maxTokens).toBeLessThanOrEqual(
				model.contextWindow - 256,
			);
		}
		expect(summary).toMatch(/^summary-/);
	});

	it.each([
		{ label: "length-limited", response: fauxAssistantMessage("partial", { stopReason: "length" }) },
		{ label: "aborted", response: fauxAssistantMessage("partial", { stopReason: "aborted" }) },
		{ label: "empty", response: fauxAssistantMessage("") },
	])("rejects $label rolling checkpoints instead of consuming input", async ({ response }) => {
		completeSimpleMock.mockResolvedValue(response);

		await expect(
			generateSummary([{ role: "user", content: "must survive", timestamp: 1 }], model, 2_000, "test-key"),
		).rejects.toThrow(/Summarization failed: (incomplete|empty)/);
	});

	it("keeps retry debris in the journal topology but excludes it from model and compaction context", () => {
		const failed = assistant("PARTIAL_RETRY_DEBRIS", "error");
		const entries: SessionEntry[] = [
			entry("u1", null, { role: "user", content: "old request ".repeat(1_000), timestamp: 1 }),
			entry("failed", "u1", failed),
			{
				type: "custom_message",
				id: "outcome",
				parentId: "failed",
				timestamp: new Date().toISOString(),
				customType: "compaction_outcome",
				content: "COMPACTION_FAILURE_DIAGNOSTIC",
				display: true,
			},
			entry("u2", "outcome", { role: "user", content: "new request", timestamp: 3 }),
			entry("a2", "u2", assistant("healthy response")),
		];

		const context = buildSessionContext(entries);
		expect(entries.map((item) => item.id)).toEqual(["u1", "failed", "outcome", "u2", "a2"]);
		expect(context.messages).not.toContain(failed);
		expect(context.messages.some((message) => message.role === "custom")).toBe(false);
		expect(
			estimateContextTokens([
				failed,
				{
					role: "custom",
					customType: "compaction_outcome",
					content: "x".repeat(40_000),
					display: true,
					timestamp: 3,
				},
			]).tokens,
		).toBe(0);

		const preparation = prepareCompaction(entries, {
			enabled: true,
			reserveTokens: 1_000,
			keepRecentTokens: 1,
		});
		const summarized = preparation?.messagesToSummarize ?? [];
		expect(summarized).not.toContain(failed);
		expect(summarized.some((message) => message.role === "custom")).toBe(false);
	});

	it("preflights compaction for directly accepted agent messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ack")]);
		const internals = harness.session as unknown as { _runPreTurnCompaction(): Promise<void> };
		const preflight = vi.spyOn(internals, "_runPreTurnCompaction").mockResolvedValue();

		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload");
		await harness.session.agent.waitForIdle();

		expect(preflight).toHaveBeenCalledTimes(1);
	});

	it("falls back to a raw estimate when usage predates compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const staleAssistant = assistant("old response");
		staleAssistant.timestamp = 1;
		harness.session.agent.state.messages = [
			staleAssistant,
			{ role: "user", content: "x".repeat(800_000), timestamp: 3 },
		];
		const internals = harness.session as unknown as {
			_getThresholdContextTokens(message: AssistantMessage, compactionTimestamp: number): number | undefined;
		};

		const tokens = internals._getThresholdContextTokens(staleAssistant, 2);

		expect(tokens).toBeGreaterThan(190_000);
	});
});
