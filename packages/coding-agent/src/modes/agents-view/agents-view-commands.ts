/**
 * Slash command support for the agents view.
 *
 * The agents view is session-less, so only a small whitelist of global
 * built-in commands runs here. Other built-in names are swallowed with a
 * pointer to open an agent instead of spawning a junk agent, while unknown
 * "/..." text passes through untouched — prompt templates, skills, and
 * extension commands are expanded by the daemon-side session.
 */

import {
	BUILTIN_SLASH_COMMANDS,
	type BuiltinSlashCommand,
	isBuiltinSlashCommandName,
	type ParsedSlashCommand,
	resolveBuiltinSlashCommandName,
} from "../../core/slash-commands.js";

const AGENTS_VIEW_COMMAND_NAMES = ["login", "logout", "model", "mcp", "resume", "quit"] as const;

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

export { type ParsedSlashCommand, parseSlashCommand } from "../../core/slash-commands.js";

export type AgentsViewCommandKind =
	/** Whitelisted built-in that runs directly in the agents view. */
	| "agents-view"
	/** Built-in that only works inside an open agent session. */
	| "session-only"
	/** Not a built-in; passes through to the daemon session untouched. */
	| "unknown";

export function classifyAgentsViewCommand(name: string): AgentsViewCommandKind {
	const canonicalName = resolveBuiltinSlashCommandName(name);
	if ((AGENTS_VIEW_COMMAND_NAMES as readonly string[]).includes(canonicalName)) {
		return "agents-view";
	}
	if (isBuiltinSlashCommandName(name)) {
		return "session-only";
	}
	return "unknown";
}

export function resolveAgentsViewCommand(command: ParsedSlashCommand): ParsedSlashCommand {
	return { ...command, name: resolveBuiltinSlashCommandName(command.name) };
}
