import { describe, expect, test } from "vitest";
import { DEFAULT_RLM_EXTRA_IMPORT_LABELS } from "../src/core/kernel/bootstrap.js";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { HarnessState } from "../src/core/refinement/index.js";
import type { Skill } from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createIpythonToolDefinition } from "../src/core/tools/ipython.js";

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
				"",
				"Working directory: /repo",
				"Conversation log: /repo/.pi/sessions/session.jsonl",
				`Pre-installed Python packages: ${DEFAULT_RLM_EXTRA_IMPORT_LABELS.join(", ")}.`,
				"Install additional packages with `uv pip install <pkg>` (this is a uv-managed venv with no pip module).",
				"",
				"Installed skills (pre-imported): `websearch`.",
				"Each skill is an async function by the same name. Inspect with `help(<skill>)` or `inspect.signature(<skill>.run)`.",
				"Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
				"",
				"IPython is the agent's long-lived notebook: a persistent control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns or compaction.",
				"",
				"Do not assume IPython is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use IPython to coordinate the process and analyze what comes back.",
				"",
				"When running shell commands from IPython, use `%%bash` cells. If you use `%%bash`, it must be the first line of the code cell: no comments, spaces, blank lines, imports, or Python statements before it. Avoid `!cmd` shell escapes for project commands so shell behavior is explicit and multi-line commands share one shell context.",
				"",
				"Important: do not install dependencies into the IPython kernel just to make an external project import or run there. If a project import, test, script, CLI, or dependency check is needed, run it through that project's own environment and normal command interface. For example, in a Python repo use its documented commands, `uv run ...`, `.venv/bin/python ...`, or the active project interpreter from the repo root. Treat failures from that native environment as the relevant result.",
				"",
				"Use Python for reading, searching, and editing files — it gives you reusable variables you can slice, filter, and act on without re-reading. Always assign read/search results to named variables so you can revisit them later.",
				"",
				"Each `%%bash` cell runs in a throw-away subshell, so shell-level state (`cd`, `export`, `source`, shell variables) does NOT carry to later cells. Keep dependent shell steps inside one `%%bash` cell when they need shared shell state, or use kernel-level equivalents that survive across calls: `%cd <dir>` for the working directory and `os.environ['VAR'] = '...'` (or `%env VAR=...`) for environment variables — these apply to all subsequent `%%bash` calls.",
				"",
				"Python state in the kernel, by contrast, persists across cells: named variables, helper functions, classes, imports, notes, parsed outputs, and helper data structures all remain available in every later turn. Tool calls are themselves Python `await` expressions, so their return values can be bound to variables and composed into program logic just like any other call.",
				"",
				"Global continual harness state is available as `rlm.harness` and `rlm.get_harness_state()`. Use it to record reset-free improvements to prompt notes, memory, reusable skills, and subagent specs that should persist across Prime Agent sessions. Use explicit CRUD calls such as `rlm.harness.create_memory(...)`, `rlm.harness.update_memory(...)`, `rlm.harness.delete_memory(...)`, `rlm.harness.create_skill(...)`, `rlm.harness.update_skill(...)`, `rlm.harness.delete_skill(...)`, `rlm.harness.create_subagent(...)`, `rlm.harness.update_subagent(...)`, `rlm.harness.delete_subagent(...)`, `rlm.harness.create_prompt_note(...)`, `rlm.harness.update_prompt_note(...)`, `rlm.harness.delete_prompt_note(...)`, plus `rlm.harness.record_refinement(...)` and `rlm.harness.overview()`.",
				"",
				"RLM-native call contract for refined entries: installed Python skills are called from IPython as `await <skill_import>(...)` with keyword arguments, or as `<skill_import> ...` from shell when a CLI exists. Harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Harness subagent entries are reusable delegation specs; invoke them by turning the spec into a concise task prompt and calling `await rlm('sub-task')`, or `await asyncio.gather(rlm('task1'), rlm('task2'))` for independent parallel subagents. Do not invent non-native wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries.",
				"",
				"Treat harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant harness component, validate on the next action, then record the outcome. Do not rewrite the whole harness when a focused memory, skill, prompt note, or subagent spec is enough.",
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

		expect(prompt).not.toContain("IPython is the agent's long-lived notebook");
	});

	test("documents the %%bash first-line rule when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toContain("it must be the first line of the code cell");
	});

	test("documents preferring Python for reading and searching files when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Use Python for reading, searching, and editing files");
		expect(prompt).toContain("Always assign read/search results to named variables");
	});

	test("includes the edit skill guidance only when the edit skill is installed", () => {
		const withEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["edit"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(withEdit).toContain('await edit(path="pkg/file.py", old_str=old, new_str=new)');
		expect(withEdit).toContain("triple double quotes");

		const withoutEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(withoutEdit).not.toContain("await edit(path=");
	});
});

describe("buildSystemPrompt", () => {
	test("injects compact global harness context and refine guidance by default", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {
					focused_edits: {
						id: "focused_edits",
						kind: "prompt",
						title: "Focused edits",
						content: "Prefer small prompt, memory, skill, or subagent updates over broad rewrites.",
						path: "policy",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				memory: {
					validation: {
						id: "validation",
						kind: "memory",
						title: "Validation",
						content: "Run `npm run check` after PrimeAgent code changes.",
						path: "repo/prime-agent",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 2,
					},
				},
				skill: {
					review_refinement: {
						id: "review_refinement",
						kind: "skill",
						title: "Review refinement",
						content: "Check requested edit coverage, rollback safety, and validation commands.",
						path: "quality",
						reference: {
							type: "python",
							import: "agent_skills.review_refinement",
							callable: "review_refinement",
							call_pattern: "await review_refinement(task=...)",
						},
						arguments: {
							task: { type: "string", required: true, description: "Review task to perform." },
						},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				subagent: {
					refinement_reviewer: {
						id: "refinement_reviewer",
						kind: "subagent",
						title: "Refinement reviewer",
						content: "Review proposed harness edits for scope, evidence, and unintended behavior.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [
				{
					id: "refine_1",
					trigger: "Observed validation miss",
					changes: ["create memory:validation"],
					evidence: "manual test",
					outcome: "Future runs should name npm run check.",
					created_at: "2026-06-08T00:00:00.000Z",
				},
			],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("# Global Harness State");
		expect(prompt).toContain("Persistent harness state is global by default");
		expect(prompt).toContain("When to call `/refine`");
		expect(prompt).toContain("Call contract: use installed Python skills as `await <skill_import>(...)`");
		expect(prompt).toContain("Harness skill entries are Python REPL skills");
		expect(prompt).toContain("Harness subagent entries are invoked by composing a concise task prompt");
		expect(prompt).toContain("await rlm('sub-task')");
		expect(prompt).toContain("after a repeated failure");
		expect(prompt).toContain("a reusable tactic emerges");
		expect(prompt).toContain("validation shows a harness entry is wrong");
		expect(prompt).toContain("[focused_edits] Focused edits (policy, v1)");
		expect(prompt).toContain("[validation] Validation (repo/prime-agent, v2): Run `npm run check`");
		expect(prompt).toContain("[review_refinement] Review refinement (quality, v1)");
		expect(prompt).toContain("[refinement_reviewer] Refinement reviewer (review, v1)");
		expect(prompt).toContain("recent refinements: 1");
		expect(prompt).toContain("[refine_1] Observed validation miss: create memory:validation");
		expect(prompt.indexOf("# Global Harness State")).toBeGreaterThan(prompt.indexOf("Conversation log:"));
	});

	test("keeps injected harness context compact", () => {
		const longContent = "x".repeat(500);
		const memoryEntries: HarnessState["entries"]["memory"] = {};
		for (let i = 0; i < 8; i++) {
			memoryEntries[`memory_${i}`] = {
				id: `memory_${i}`,
				kind: "memory",
				title: `Memory ${i}`,
				content: longContent,
				path: "overflow",
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: "2026-06-08T00:00:00.000Z",
				updated_at: "2026-06-08T00:00:00.000Z",
				version: 1,
			};
		}
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: memoryEntries,
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("memory: 8");
		expect(prompt).toContain("- +2 more memory entries");
		expect(prompt).toContain(`${"x".repeat(177)}...`);
		expect(prompt).not.toContain(longContent);
	});

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
		expect(prompt).toContain("IPython is the agent's long-lived notebook");
		expect(prompt).toContain("yaml (PyYAML)");
		expect(prompt).toContain("dotenv (python-dotenv)");
		expect(prompt).toContain("bs4 (Beautiful Soup)");
		expect(prompt).toContain("Avoid `!cmd` shell escapes for project commands");
		expect(prompt).toContain("Each `%%bash` cell runs in a throw-away subshell");
		expect(prompt).toContain("Python state in the kernel, by contrast, persists across cells");
		expect(prompt).toContain("Global continual harness state is available as `rlm.harness`");
		expect(prompt).toContain(
			"record reset-free improvements to prompt notes, memory, reusable skills, and subagent specs",
		);
		expect(prompt).toContain("rlm.harness.create_memory");
		expect(prompt).toContain("rlm.harness.update_skill");
		expect(prompt).toContain("rlm.harness.delete_subagent");
		expect(prompt).toContain("rlm.harness.create_prompt_note");
		expect(prompt).not.toContain("rlm.harness.upsert_skill");
		expect(prompt).toContain("rlm.harness.record_refinement");
		expect(prompt).toContain("RLM-native call contract for refined entries");
		expect(prompt).toContain("await <skill_import>(...)");
		expect(prompt).toContain("Python `reference` and `arguments` contract");
		expect(prompt).toContain("await asyncio.gather(rlm('task1'), rlm('task2'))");
		expect(prompt).toContain("call_skill(...)");
		expect(prompt).toContain("run_subagent(...)");
		expect(prompt).toContain("named subagent registries");
		expect(prompt).toContain("Do not assume IPython is the native runtime");
		expect(prompt).toContain("do not install dependencies into the IPython kernel");
		expect(prompt).toContain("run it through that project's own environment");
		expect(prompt).not.toContain("!cd build && make");
		expect(prompt).not.toContain("out = !cmd");
		expect(prompt).not.toContain("Call at most one built-in tool per turn.");
		expect(prompt).not.toContain("# IPython Kernel Guidance");
		expect(prompt).not.toContain("Available tools:");
		expect(prompt).not.toContain("## Worked example:");
		expect(prompt).not.toContain("## Anti-patterns");
	});

	test("custom prompt override bypasses the rlm harness body", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					custom_memory: {
						id: "custom_memory",
						kind: "memory",
						title: "Custom memory",
						content: "Custom prompts still receive harness state.",
						path: "custom",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["ipython"],
			appendSystemPrompt: "custom append",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("custom body");
		expect(prompt).toContain("# Global Harness State");
		expect(prompt).toContain("[custom_memory] Custom memory (custom, v1)");
		expect(prompt).not.toContain("# IPython Kernel Guidance");
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(prompt.indexOf("# Global Harness State"));
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(prompt.indexOf("custom append"));
		expect(prompt.indexOf("# Global Harness State")).toBeLessThan(prompt.indexOf("custom append"));
	});

	test("append system prompt content is included after the rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			appendSystemPrompt: "extra instruction",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt.indexOf("Treat harness refinement as a small, evidence-backed update")).toBeLessThan(
			prompt.indexOf("extra instruction"),
		);
		expect(prompt).not.toContain("Call at most one built-in tool per turn.");
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

		expect(prompt).not.toContain("Installed skills (pre-imported)");
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

		expect(prompt).toContain("Installed skills (pre-imported): `web_search`.");
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

describe("createIpythonToolDefinition", () => {
	test("describes project checks as target-environment work", () => {
		const tool = createIpythonToolDefinition("/repo");

		expect(tool.description).toContain("Python scratchpad code");
		expect(tool.description).toContain("target project's own environment");
		expect(tool.promptSnippet).toContain("%%bash orchestration");
		const codeSchema = tool.parameters.properties.code;
		const codeDescription =
			"description" in codeSchema && typeof codeSchema.description === "string" ? codeSchema.description : "";
		expect(codeDescription).toContain("target project's own environment");
	});
});
