import { describe, expect, it } from "vitest";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";

describe("mergeAgentSessionRuntimeConfig", () => {
	it("applies session overrides without mutating default config", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: true,
			noEnv: true,
			extensionFlagValues: { plan: true },
		};

		const overrides: AgentSessionRuntimeConfig = {
			cwd: "/repo/session",
			model: "anthropic/claude-sonnet-4-5",
			tools: ["bash"],
			noTools: false,
			extensionFlagValues: { mode: "fast" },
		};
		const merged = mergeAgentSessionRuntimeConfig(defaults, overrides);

		expect(merged).toEqual({
			cwd: "/repo/session",
			agentDir: "/agent/default",
			model: "anthropic/claude-sonnet-4-5",
			tools: ["bash"],
			noTools: false,
			noEnv: true,
			extensionFlagValues: { plan: true, mode: "fast" },
		});
		expect(merged.tools).not.toBe(overrides.tools);
		expect(merged.extensionFlagValues).not.toBe(defaults.extensionFlagValues);
		expect(defaults).toEqual({
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: true,
			noEnv: true,
			extensionFlagValues: { plan: true },
		});
	});

	it("keeps default arrays when a session override omits them", () => {
		const defaults: AgentSessionRuntimeConfig = {
			appendSystemPrompt: ["default prompt"],
			models: ["openai/gpt-4o"],
			extensions: ["/agent/ext.js"],
			skills: ["/agent/skill.md"],
			promptTemplates: ["/agent/template.md"],
			themes: ["/agent/theme.json"],
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, { model: "openai/gpt-4o-mini" });
		expect(merged).toEqual({
			appendSystemPrompt: ["default prompt"],
			models: ["openai/gpt-4o"],
			extensions: ["/agent/ext.js"],
			skills: ["/agent/skill.md"],
			promptTemplates: ["/agent/template.md"],
			themes: ["/agent/theme.json"],
			model: "openai/gpt-4o-mini",
		});
		expect(merged.models).not.toBe(defaults.models);
		expect(merged.extensions).not.toBe(defaults.extensions);
	});

	it("deep-merges autonomous gate overrides", () => {
		const defaults: AgentSessionRuntimeConfig = {
			autonomous: {
				enabled: true,
				maxTurns: 20,
				gates: { commands: ["npm test"], maxRetries: 3 },
			},
		};

		const overrides: AgentSessionRuntimeConfig = {
			autonomous: {
				maxContinuations: 5,
				gates: { timeoutMs: 1000 },
			},
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, overrides);

		expect(merged.autonomous).toEqual({
			enabled: true,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
		expect(merged.autonomous?.gates?.commands).not.toBe(defaults.autonomous?.gates?.commands);
	});

	it("ignores undefined override values", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, {
			cwd: undefined,
			model: undefined,
			tools: undefined,
			noTools: false,
		});

		expect(merged).toEqual({
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: false,
		});
	});
});
