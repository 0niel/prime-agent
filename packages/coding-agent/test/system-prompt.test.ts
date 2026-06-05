import { describe, expect, test } from "vitest";
import { DEFAULT_RLM_EXTRA_IMPORT_LABELS } from "../src/core/kernel/bootstrap.js";
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
		kind: "markdown",
	};
}

function pythonSkill(name: string, importName = name.replaceAll("-", "_")): Skill {
	const base = skill(name);
	return {
		...base,
		kind: "python",
		python: {
			importName,
			packagePath: `/skills/${name}`,
			pyprojectPath: `/skills/${name}/pyproject.toml`,
		},
	};
}

describe("buildRlmPrompt", () => {
	test("builds the rlm prompt without recursion", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toBe(
			[
				"You are a general purpose agent that uses code to solve tasks.",
				"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
				"When you are done, stop calling tools and state your final answer.",
				"A Python project's interpreter can be in `PATH`. If not use the appropriate `.venv`.",
				"",
				"Working directory: /repo",
				"Conversation log: /repo/.pi/sessions/session.jsonl",
				"",
				"Configured Python skills for IPython: `websearch`.",
				"When available, each Python skill is an async callable by the same import name. Inspect with `help(<skill>)` or `inspect.signature(<skill>.run)`.",
				"If a Python skill is unavailable, calling it raises a RuntimeError with the import error.",
				"Each Python skill may also be available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
				"",
				"Use `ipython` for both Python and shell work. For repository shell commands, prefer IPython shell syntax: `!rg ...`, `!npm run check`, or `%%bash` for multi-line scripts. Do not wrap ordinary shell commands in Python subprocesses unless you need Python-level processing.",
				"",
				"Each `!cmd` and each `%%bash` cell runs in a throw-away subshell, so shell-level state (`cd`, `export`, `source`, shell variables) does NOT carry to later cells. To persist state, either chain dependent steps inside one cell (e.g. `!cd build && make`, or a single `%%bash` block that sources then uses a venv), or use kernel-level equivalents that survive across calls: `%cd <dir>` for the working directory and `os.environ['VAR'] = '...'` (or `%env VAR=...`) for environment variables — these apply to all subsequent `!` and `%%bash` calls.",
				"",
				"Python state in the kernel, by contrast, persists across cells: named variables, helper functions, classes, imports, and shell-output captures via `out = !cmd` (a list of lines) all remain available in every later turn. Tool calls are themselves Python `await` expressions, so their return values can be bound to variables and composed into program logic just like any other call.",
				"",
				`The kernel has these Python imports available: ${DEFAULT_RLM_EXTRA_IMPORT_LABELS.join(", ")}. Import them directly; no pip install needed.`,
				"",
				"Call at most one built-in tool per turn.",
			].join("\n"),
		);
	});

	test("only documents ipython shell prefixes when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).not.toContain("Use `ipython` for both Python and shell work");
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

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.pi/sessions/session.jsonl");
		expect(prompt).toContain("await rlm('sub-task')");
		expect(prompt).toContain("asyncio.gather");
		expect(prompt).toContain("asyncio.create_task");
		expect(prompt).toContain("sub-agent work that can run in the background");
		expect(prompt).toContain("do not block the main execution path");
		expect(prompt).toContain("keep the task handle");
		expect(prompt).toContain("normal task callbacks");
		expect(prompt).toContain("task.done()");
		expect(prompt).toContain("await task");
		expect(prompt).toContain("RLMResult.answer");
		expect(prompt).not.toContain("simple named task dictionary");
		expect(prompt).not.toContain("rlm_tasks");
		expect(prompt).not.toContain("globals().setdefault");
		expect(prompt).not.toContain("rlm.background");
		expect(prompt).not.toContain("notify='wake'");
		expect(prompt).not.toContain("notify='silent'");
		expect(prompt).toContain("Use `ipython` for both Python and shell work");
		expect(prompt).toContain("yaml (PyYAML)");
		expect(prompt).toContain("dotenv (python-dotenv)");
		expect(prompt).toContain("bs4 (Beautiful Soup)");
		expect(prompt).toContain("prefer IPython shell syntax");
		expect(prompt).toContain("Each `!cmd` and each `%%bash` cell runs in a throw-away subshell");
		expect(prompt).toContain("Python state in the kernel, by contrast, persists across cells");
		expect(prompt).toContain("Do not wrap ordinary shell commands in Python subprocesses");
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
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
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

	test("markdown skills are included in rlm harness prompts without Python pre-imports", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [skill("websearch")],
			cwd: "/repo",
		});

		expect(prompt).not.toContain("Configured Python skills for IPython");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>websearch</name>");
		expect(prompt).toContain("<type>markdown</type>");
		expect(prompt).toContain("<location>/skills/websearch/SKILL.md</location>");
	});

	test("Python skills are configured for IPython and included in skill metadata", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("web-search")],
			cwd: "/repo",
		});

		expect(prompt).toContain("Configured Python skills for IPython: `web_search`.");
		expect(prompt).toContain("<name>web-search</name>");
		expect(prompt).toContain("<type>python</type>");
		expect(prompt).toContain("<python_import>web_search</python_import>");
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
