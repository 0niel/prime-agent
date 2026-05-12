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
		"You are a coding agent. You solve tasks by writing and executing code, observing results, and iterating one step at a time.",
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
		skillLines.push(`Installed skills (pre-imported): ${installed}.`);
		skillLines.push(
			"Each skill is an async function by the same name. Inspect with `help(<skill>)` or `inspect.signature(<skill>.run)`.",
		);
		skillLines.push(
			"Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
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
			"For long-running sub-agents that should not block your own work, use `handle = await rlm.background('sub-task')`. The returned handle has `.id`, `.session_dir`, `await handle.status()`, `await handle.wait(timeout=30)`, and `await handle.result(timeout=30)`. By default, completion notices are kept passive and become context on a later turn.",
			"Use `await rlm.background('sub-task', notify='wake')` only when the user explicitly asked to be told as soon as background work finishes. Wake notifications are batched, hidden from the user, and may start a later assistant turn so you can send a concise update. Use `notify='silent'` when you only want to poll the handle yourself.",
		);
	}

	if (activeTools.includes("ipython")) {
		parts.push(
			"",
			"Use `ipython` for both Python and shell work. For repository shell commands, prefer IPython shell syntax: `!rg ...`, `!npm run check`, or `%%bash` for multi-line scripts. Do not wrap ordinary shell commands in Python subprocesses unless you need Python-level processing.",
		);
	}

	if (activeTools.length > 0) {
		parts.push("", "Call at most one built-in tool per turn.");
	}

	return parts.join("\n");
}
