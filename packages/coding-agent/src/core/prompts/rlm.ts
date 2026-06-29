import { DEFAULT_RLM_EXTRA_IMPORT_LABELS } from "../kernel/bootstrap.js";

export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	activeTools?: string[];
}

const IPYTHON_CONTROL_PROMPT = [
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
	"Continual harness state is available as `rlm.harness` and `rlm.get_harness_state()`. CRUD calls are local to this Prime Agent session by default: `rlm.harness.create_memory(...)`, `rlm.harness.update_memory(...)`, `rlm.harness.delete_memory(...)`, `rlm.harness.create_skill(...)`, `rlm.harness.update_skill(...)`, `rlm.harness.delete_skill(...)`, `rlm.harness.create_subagent(...)`, `rlm.harness.update_subagent(...)`, `rlm.harness.delete_subagent(...)`, `rlm.harness.create_prompt_note(...)`, `rlm.harness.update_prompt_note(...)`, `rlm.harness.delete_prompt_note(...)`, plus `rlm.harness.record_refinement(...)` and `rlm.harness.overview()`. Use `global_=True` only for stable cross-session lessons; Python reserves `global`, so literal `global=True` is invalid syntax.",
	"",
	"Terminology: continual harness names the persisted prompt, memory, skill, and subagent layer; RLM names the runtime, IPython kernel, and native call interface exposed to the model.",
	"",
	"RLM-native call contract for refined continual harness entries: installed Python skills are called from IPython as `await <skill_import>(...)` with keyword arguments, or as `<skill_import> ...` from shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Continual harness subagent entries are reusable delegation specs; invoke them by turning the spec into a concise task prompt and calling `await rlm('sub-task')`, or `await asyncio.gather(rlm('task1'), rlm('task2'))` for independent parallel subagents. Do not invent non-native wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries.",
	"",
	"Treat continual harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant continual harness component, validate on the next action, then record the outcome. Do not rewrite the whole continual harness when a focused memory, skill, prompt note, or subagent spec is enough.",
].join("\n");

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const allowRecursion = options.allowRecursion ?? true;
	const activeTools = options.activeTools ?? [];
	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		`Working directory: ${cwd}`,
		`Conversation log: ${messagesPath}`,
		`Pre-installed Python packages: ${DEFAULT_RLM_EXTRA_IMPORT_LABELS.join(", ")}.`,
		"Install additional packages with `uv pip install <pkg>` (this is a uv-managed venv with no pip module).",
	];

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0) {
		const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
		skillLines.push(`Installed skills (pre-imported): ${installed}.`);
		skillLines.push(
			"Each skill is an async function by the same name. Inspect with `help(<skill>)` or `inspect.signature(<skill>.run)`.",
		);
		skillLines.push(
			"Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
		);
		if (installedSkills.includes("edit")) {
			skillLines.push(
				"For targeted existing-file edits, prefer the pre-imported async `edit` skill from IPython: `old = '''...'''; new = '''...'''; await edit(path=\"pkg/file.py\", old_str=old, new_str=new)`. Use exact old/new strings; if the text contains triple double quotes, use triple single-quoted variables or build `old`/`new` from inspected file slices.",
			);
		}
	}
	if (skillLines.length > 0) {
		parts.push("", ...skillLines);
	}

	if (allowRecursion) {
		parts.push(
			"",
			"A callable `rlm` is already in your global namespace — call it directly with `await rlm('sub-task')` to spawn a recursive sub-agent. Returns an `RLMResult` with `.answer` (string), `.usage`, `.turns`, and `.session_dir`.",
			"For parallel sub-agents, use normal Python async patterns such as `await asyncio.gather(rlm('task1'), rlm('task2'))`.",
			"For sub-agent work that can run in the background, keep the task handle from `asyncio.create_task(rlm('sub-task'))` so you do not block the main execution path; use normal task callbacks, `task.done()`, or `await task` later to observe completion and read the returned `RLMResult.answer`.",
		);
	}

	if (activeTools.includes("ipython")) {
		parts.push("", IPYTHON_CONTROL_PROMPT);
	}

	return parts.join("\n");
}
