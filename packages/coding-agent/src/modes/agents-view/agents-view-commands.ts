/**
 * Slash command support for the agents view.
 *
 * The agents view is session-less, so only a small whitelist of global
 * built-in commands runs here. Other built-in names are swallowed with a
 * pointer to open an agent instead of spawning a junk agent, while unknown
 * "/..." text passes through untouched — prompt templates, skills, and
 * extension commands are expanded by the daemon-side session.
 */

import { BUILTIN_SLASH_COMMANDS, type BuiltinSlashCommand } from "../../core/slash-commands.js";

const AGENTS_VIEW_COMMAND_NAMES = ["login", "logout", "model", "quit"] as const;

export type AgentsViewCommandName = (typeof AGENTS_VIEW_COMMAND_NAMES)[number];

/** Descriptions that differ from the in-session built-in. */
const AGENTS_VIEW_COMMAND_DESCRIPTIONS: Partial<Record<AgentsViewCommandName, string>> = {
	model: "Select the model for new agents",
};

export const AGENTS_VIEW_SLASH_COMMANDS: readonly BuiltinSlashCommand[] = AGENTS_VIEW_COMMAND_NAMES.map((name) => {
	const builtin = BUILTIN_SLASH_COMMANDS.find((command) => command.name === name);
	if (!builtin) {
		throw new Error(`Agents view command '/${name}' is not a built-in slash command`);
	}
	return { ...builtin, description: AGENTS_VIEW_COMMAND_DESCRIPTIONS[name] ?? builtin.description };
});

export interface ParsedSlashCommand {
	name: string;
	args: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
	if (!text.startsWith("/")) {
		return undefined;
	}
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	if (!name) {
		return undefined;
	}
	return { name, args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim() };
}

export type AgentsViewCommandKind =
	/** Whitelisted built-in that runs directly in the agents view. */
	| "agents-view"
	/** Built-in that only works inside an open agent session. */
	| "session-only"
	/** Not a built-in; passes through to the daemon session untouched. */
	| "unknown";

export function classifyAgentsViewCommand(name: string): AgentsViewCommandKind {
	if ((AGENTS_VIEW_COMMAND_NAMES as readonly string[]).includes(name)) {
		return "agents-view";
	}
	if (BUILTIN_SLASH_COMMANDS.some((command) => command.name === name)) {
		return "session-only";
	}
	return "unknown";
}
