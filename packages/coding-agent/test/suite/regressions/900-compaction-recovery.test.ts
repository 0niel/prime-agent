import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens, generateSummary, prepareCompaction } from "../../../src/core/compaction/index.js";
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

	it("truncates one oversized message before issuing a summary request", async () => {
		await generateSummary([{ role: "user", content: "x".repeat(900_000), timestamp: 1 }], model, 2_000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [, context, options] = completeSimpleMock.mock.calls[0];
		const prompt = context.messages[0].content[0].text as string;
		expect(prompt.length).toBeLessThan(model.contextWindow * 2);
		expect(prompt).toContain("oversized message truncated for compaction");
		expect(options.maxTokens).toBe(1_600);
	});

	it("rolls many messages through sequential bounded requests", async () => {
		const messages: AgentMessage[] = Array.from({ length: 20 }, (_, index) => ({
			role: "user" as const,
			content: `message-${index} ${"payload ".repeat(700)}`,
			timestamp: index,
		}));

		const summary = await generateSummary(messages, model, 2_000, "test-key");

		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
		for (const [, context] of completeSimpleMock.mock.calls) {
			const prompt = context.messages[0].content[0].text as string;
			expect(prompt.length).toBeLessThan(model.contextWindow * 2);
		}
		expect(summary).toMatch(/^summary-/);
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
