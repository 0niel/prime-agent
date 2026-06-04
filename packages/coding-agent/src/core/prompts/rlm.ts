import { DEFAULT_RLM_EXTRA_IMPORT_LABELS } from "../kernel/bootstrap.js";

export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	activeTools?: string[];
}

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const allowRecursion = options.allowRecursion ?? true;
	const activeTools = options.activeTools ?? [];
	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"A Python project's interpreter can be in `PATH`. If not use the appropriate `.venv`.",
		"",
		`Working directory: ${cwd}`,
		`Conversation log: ${messagesPath}`,
	];

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0) {
		const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
		skillLines.push(`Configured Python skills for IPython: ${installed}.`);
		skillLines.push(
			"When available, each Python skill is an async callable by the same import name. Inspect with `help(<skill>)` or `inspect.signature(<skill>.run)`.",
		);
		skillLines.push("If a Python skill is unavailable, calling it raises a RuntimeError with the import error.");
		skillLines.push(
			"Each Python skill may also be available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
		);
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
		parts.push(
			"",
			"Use `ipython` for both Python and shell work. For repository shell commands, prefer IPython shell syntax: `!rg ...`, `!npm run check`, or `%%bash` for multi-line scripts. Do not wrap ordinary shell commands in Python subprocesses unless you need Python-level processing.",
			"",
			"Each `!cmd` and each `%%bash` cell runs in a throw-away subshell, so shell-level state (`cd`, `export`, `source`, shell variables) does NOT carry to later cells. To persist state, either chain dependent steps inside one cell (e.g. `!cd build && make`, or a single `%%bash` block that sources then uses a venv), or use kernel-level equivalents that survive across calls: `%cd <dir>` for the working directory and `os.environ['VAR'] = '...'` (or `%env VAR=...`) for environment variables — these apply to all subsequent `!` and `%%bash` calls.",
			"",
			"Python state in the kernel, by contrast, persists across cells: named variables, helper functions, classes, imports, and shell-output captures via `out = !cmd` (a list of lines) all remain available in every later turn. Tool calls are themselves Python `await` expressions, so their return values can be bound to variables and composed into program logic just like any other call.",
			"",
			`The kernel has these Python imports available: ${DEFAULT_RLM_EXTRA_IMPORT_LABELS.join(", ")}. Import them directly; no pip install needed.`,
		);
	}

	if (activeTools.length > 0) {
		parts.push("", "Call at most one built-in tool per turn.");
	}

	return parts.join("\n");
}
