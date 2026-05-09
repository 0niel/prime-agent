import { describe, expect, test } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { Skill } from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			source: "local",
			path: `/skills/${name}/SKILL.md`,
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
	};
}

describe("buildRlmPrompt", () => {
	test("matches the rlm harness prompt without recursion", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toBe(
			[
				"You are a coding agent. You solve tasks by writing and executing code, observing results, and iterating one step at a time.",
				"When you are done, stop calling tools and state your final answer.",
				"A Python project's interpreter can be in `PATH`. If not use the appropriate `.venv`.",
				"",
				"Working directory: /repo",
				"Conversation log: /repo/.pi/sessions/session.jsonl",
				"",
				"Installed skills (pre-imported): `websearch`.",
				"Each skill is an async function by the same name. Inspect with `help(<skill>)` or `inspect.signature(<skill>.run)`.",
				"Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
				"",
				"Call at most one built-in tool per turn.",
			].join("\n"),
		);
	});
});

describe("buildSystemPrompt", () => {
	test("uses the model-agnostic rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
		});

		expect(prompt).toContain("You are a coding agent.");
		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.pi/sessions/session.jsonl");
		expect(prompt).toContain("await rlm('sub-task')");
		expect(prompt).toContain("asyncio.gather");
		expect(prompt).toContain("Call at most one built-in tool per turn.");
		expect(prompt).not.toContain("# IPython Kernel Guidance");
		expect(prompt).not.toContain("Available tools:");
		expect(prompt).not.toContain("## Worked example:");
		expect(prompt).not.toContain("## Anti-patterns");
	});

	test("custom prompt override bypasses the rlm harness body", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["ipython"],
			appendSystemPrompt: "custom append",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("custom body");
		expect(prompt).not.toContain("# IPython Kernel Guidance");
		expect(prompt).not.toContain("You are a coding agent.");
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(prompt.indexOf("custom append"));
	});

	test("append system prompt content is included after the rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			appendSystemPrompt: "extra instruction",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt.indexOf("Call at most one built-in tool per turn.")).toBeLessThan(
			prompt.indexOf("extra instruction"),
		);
	});

	test("project context files are appended", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## AGENTS.md\n\nproject rules");
	});

	test("skills are included in rlm harness prompts", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [skill("websearch")],
			cwd: "/repo",
		});

		expect(prompt).toContain("Installed skills (pre-imported): `websearch`.");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>websearch</name>");
		expect(prompt).toContain("<location>/skills/websearch/SKILL.md</location>");
	});

	test("prompt guidelines are appended and deduplicated", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython", "dynamic_tool"],
			promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Additional Guidance");
		expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
	});
});
