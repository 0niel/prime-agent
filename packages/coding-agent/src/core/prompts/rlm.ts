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
		);
	}

	if (activeTools.includes("ipython")) {
		parts.push(
			"",
			"Inside `ipython`, prefix single-line shell commands with `!` (for example `!ls -la`) and use `%%bash` for multi-line shell scripts.",
		);
	}

	if (activeTools.length > 0) {
		parts.push("", "Call at most one built-in tool per turn.");
	}

	return parts.join("\n");
}
