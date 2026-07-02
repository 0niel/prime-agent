import type { CustomMessage } from "../messages.js";

export const PLAN_MODE_CONTEXT_CUSTOM_TYPE = "plan_mode_context";
export const PLAN_MODE_EXITED_CUSTOM_TYPE = "plan_mode_exited";

// Injected as a conversation message, not a system-prompt append, so the system
// prompt and its provider cache stay stable across toggles.
const PLAN_MODE_PROMPT = [
	"<plan_mode>",
	"Plan mode is active. Your job this turn is to investigate and produce a plan the user can act on — not to make changes. It stays active until the user turns it off; treat any request to make changes as a request to plan those changes, not perform them.",
	"",
	"You may explore and run non-mutating actions that improve the plan. You must not perform mutating actions.",
	"",
	"Allowed (non-mutating): reading and searching files, static analysis and repo exploration, read-only commands, and dry-runs / tests / builds that only touch caches or build artifacts, not repo-tracked files.",
	"",
	"Not allowed (mutating): editing, creating, or deleting files; running formatters or linters that rewrite files; applying patches, migrations, or codegen; git commits; and any side-effectful command whose purpose is to carry out the work rather than plan it.",
	"",
	'When in doubt: if the action is better described as "doing the work" than "planning the work," don\'t do it. Mutating operations are blocked and raise PlanModeError — do not retry them or look for a workaround; the block is intentional.',
	"",
	"Explore first, then present a concrete plan: the goal, the specific changes you'd make (files/functions/approach), and how you'd verify them. Make it detailed enough to hand off. When the plan is ready, tell the user they can turn off plan mode to proceed. If the user's request is a pure question rather than a change, just answer it — no plan needed.",
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

// One-shot notice on the turn after plan mode is turned off — otherwise the
// per-turn message just stops appearing, which the model can't observe.
export function createPlanModeExitedMessage(): CustomMessage {
	return {
		role: "custom",
		customType: PLAN_MODE_EXITED_CUSTOM_TYPE,
		content:
			"<plan_mode_off>Plan mode has been turned off. You may now edit files and run commands normally.</plan_mode_off>",
		display: false,
		timestamp: Date.now(),
	};
}
