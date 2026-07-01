/**
 * Appended to the system prompt for each turn while plan mode is active.
 * Never baked into the base prompt so toggling takes effect on the next turn.
 */
export const PLAN_MODE_PROMPT = [
	"<plan_mode>",
	"Plan mode is active. The user wants analysis, answers, or a plan — not changes.",
	"",
	"Permissions while plan mode is on:",
	"- Allowed: reading any file, searching, and read-only commands (they run inside a read-only sandbox). Writes under temp and cache directories are permitted.",
	"- Blocked: creating, editing, or deleting files, and any command that mutates state (including git commits). Blocked operations raise PlanModeError at the OS/kernel level.",
	"",
	"If an operation fails with PlanModeError, do not retry it or look for a workaround — the block is intentional. Continue your investigation read-only.",
	"Finish by presenting your answer or a concrete plan. If changes are needed, tell the user what you would do and ask them to exit plan mode first.",
	"</plan_mode>",
].join("\n");

/** Mutating side tools blocked while plan mode is active (ipython is enforced in-kernel). */
export const PLAN_MODE_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);
