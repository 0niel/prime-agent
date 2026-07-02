import type { CustomMessage } from "../messages.js";

export const PLAN_MODE_CONTEXT_CUSTOM_TYPE = "plan_mode_context";

/**
 * Injected as a conversation message (not a system-prompt append) each turn while
 * plan mode is active, mirroring goal_context. Keeping it out of the system prompt
 * leaves that prompt — and its provider cache — stable across toggles.
 */
const PLAN_MODE_PROMPT = [
	"<plan_mode>",
	"Plan mode is active. The user wants analysis, answers, or a plan — not changes.",
	"",
	"While plan mode is on:",
	"- Allowed: reading any file, searching, and read-only commands. Writes under temp and cache directories are permitted.",
	"- Blocked: creating, editing, or deleting files, and any command that mutates state (including git commits). Blocked operations raise PlanModeError.",
	"",
	"If an operation raises PlanModeError, do not retry it or look for a workaround — the block is intentional. Continue read-only.",
	"Finish by presenting your answer or a concrete plan. If changes are needed, tell the user what you would do and ask them to exit plan mode first.",
	"</plan_mode>",
].join("\n");

/** Mutating side tools blocked while plan mode is active (ipython is enforced in-kernel). */
export const PLAN_MODE_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

export function createPlanModeContextMessage(): CustomMessage {
	return {
		role: "custom",
		customType: PLAN_MODE_CONTEXT_CUSTOM_TYPE,
		content: PLAN_MODE_PROMPT,
		display: false,
		timestamp: Date.now(),
	};
}
