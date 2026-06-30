import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";

const originalPrimeApiKey = process.env.PRIME_API_KEY;

afterEach(() => {
	if (originalPrimeApiKey === undefined) {
		delete process.env.PRIME_API_KEY;
	} else {
		process.env.PRIME_API_KEY = originalPrimeApiKey;
	}
});

describe("Prime Inference models", () => {
	it("registers the Prime Inference catalog", () => {
		const modelIds = getModels("prime-inference").map((model) => model.id);

		// Lower bound, not an exact count — the catalog grows with each release and an
		// exact number breaks on every routine addition. The membership checks below
		// are the meaningful assertions.
		expect(modelIds.length).toBeGreaterThanOrEqual(28);
		expect(modelIds).toEqual(
			expect.arrayContaining([
				"anthropic/claude-opus-4.7",
				"anthropic/claude-opus-4.8",
				"deepseek/deepseek-v4-pro",
				"minimax/minimax-m3",
				"moonshotai/kimi-k2.7-code",
				"nvidia/nemotron-3-super-120b-a12b",
				"openai/gpt-5.4",
				"openai/gpt-5.5",
				"prime-intellect/intellect-3",
				"qwen/qwen3-coder-next",
				"qwen/qwen3-vl-235b-a22b-thinking",
				"x-ai/grok-4.20",
				"z-ai/glm-5",
				"z-ai/glm-5.1",
				"z-ai/glm-5.2",
			]),
		);
		expect(modelIds).not.toContain("google/gemini-2.5-pro");
	});

	it("registers the default OpenAI-compatible model", () => {
		const model = getModel("prime-inference", "openai/gpt-5.5");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("prime-inference");
		expect(model.baseUrl).toBe("https://api.pinference.ai/api/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1050000);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});

	it("marks known reasoning-capable Prime Inference model families", () => {
		const opus48 = getModel("prime-inference", "anthropic/claude-opus-4.8");
		expect(opus48.reasoning).toBe(true);
		expect(opus48.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
		expect(getSupportedThinkingLevels(opus48)).toContain("xhigh");
		expect(getSupportedThinkingLevels(opus48)).toContain("max");

		expect(getModel("prime-inference", "anthropic/claude-opus-4.7").reasoning).toBe(true);
		const deepseekV4Flash = getModel("prime-inference", "deepseek/deepseek-v4-flash");
		expect(deepseekV4Flash.reasoning).toBe(true);
		expect(deepseekV4Flash.compat).toMatchObject({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		const glm51 = getModel("prime-inference", "z-ai/glm-5.1");
		expect(glm51.reasoning).toBe(true);
		expect(glm51.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "zai",
		});
		const glm52 = getModel("prime-inference", "z-ai/glm-5.2");
		expect(glm52.reasoning).toBe(true);
		expect(glm52.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "zai",
		});
		expect(getModel("prime-inference", "qwen/qwen3-coder-next").reasoning).toBe(false);
		expect(getModel("prime-inference", "x-ai/grok-4.20").reasoning).toBe(true);
		expect(getModel("prime-inference", "minimax/minimax-m3").reasoning).toBe(true);
		expect(getModel("prime-inference", "moonshotai/kimi-k2.7-code").reasoning).toBe(true);
	});

	it("resolves PRIME_API_KEY from the environment", () => {
		process.env.PRIME_API_KEY = "test-prime-key";

		expect(findEnvKeys("prime-inference")).toEqual(["PRIME_API_KEY"]);
		expect(getEnvApiKey("prime-inference")).toBe("test-prime-key");
	});

	it("requires an explicit Prime Inference API key", () => {
		delete process.env.PRIME_API_KEY;

		expect(findEnvKeys("prime-inference")).toBeUndefined();
		expect(getEnvApiKey("prime-inference")).toBeUndefined();
	});
});
