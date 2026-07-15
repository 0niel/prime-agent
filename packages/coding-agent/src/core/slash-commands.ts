import { APP_NAME } from "../config.js";
import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	/** Shown in autocomplete before the description, e.g. "[instructions]" */
	argumentHint?: string;
	/** Hidden names that resolve to this command without being shown as commands. */
	aliases?: readonly string[];
	takesArgument?: boolean;
}

export interface ParsedSlashCommand {
	name: string;
	args: string;
}

export interface ResolvedSlashCommand extends ParsedSlashCommand {
	originalName: string;
	isAlias: boolean;
}

interface BuiltinSlashCommandAlias {
	name: string;
	aliasFor: string;
}

const CANONICAL_BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "effort", description: "Set reasoning/thinking level", argumentHint: "[level]", takesArgument: true },
	{ name: "fast", description: "Toggle OpenAI Fast mode" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{
		name: "btw",
		description: "Ask one side question without adding it to the session",
		argumentHint: "<question>",
		takesArgument: true,
	},
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info" },
	{ name: "system-prompt", description: "Show the exact system prompt sent to the model" },
	{ name: "logs", description: "Show where daemon and client logs are saved" },
	{
		name: "traces",
		description: "Opt in or out of Prime Agent trace sharing",
		argumentHint: "[status|on|off|upload|login]",
	},
	{ name: "context", description: "Show token, cost, and context usage for agent and sub-agents" },
	{ name: "changelog", description: "Show changelog entries" },
	{
		name: "update",
		description: `Update ${APP_NAME} and installed packages`,
		argumentHint: "[source|--self|--extensions]",
		takesArgument: true,
	},
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{
		name: "mcp",
		description: "Open MCP Connections or manage MCP integrations",
		argumentHint: "[list|login <name>|logout <name>]",
		takesArgument: true,
	},
	{ name: "new", description: "Start a new session" },
	{
		name: "compact",
		description: "Compact the session context; optional instructions focus the summary",
		argumentHint: "[instructions]",
	},
	{ name: "refine", description: "Refine continual harness prompt notes, skills, subagents, and memory" },
	{
		name: "goal",
		description: "Set or view a persistent goal; supports pause, resume, and clear",
		argumentHint: "[objective]",
		takesArgument: true,
	},
	{
		name: "heartbeat",
		description:
			"Set or view a persistent heartbeat; delivery defaults to steer, use --follow-up to queue; supports pause, resume, stop, and clear",
		argumentHint: "[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]",
		takesArgument: true,
	},
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{
		name: "fullscreen",
		description: "Toggle fullscreen (alternate screen) rendering with scrollable transcript",
		argumentHint: "[on|off]",
		takesArgument: true,
	},
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

const BUILTIN_SLASH_COMMAND_ALIASES: ReadonlyArray<BuiltinSlashCommandAlias> = [
	{ name: "clear", aliasFor: "new" },
	{ name: "usage", aliasFor: "context" },
	{ name: "thinking", aliasFor: "effort" },
	{ name: "rename", aliasFor: "name" },
	{ name: "side", aliasFor: "btw" },
];

function buildBuiltinSlashCommands(): ReadonlyArray<BuiltinSlashCommand> {
	const canonicalByName = new Map(CANONICAL_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
	const aliasesByTarget = new Map<string, string[]>();
	for (const alias of BUILTIN_SLASH_COMMAND_ALIASES) {
		const target = canonicalByName.get(alias.aliasFor);
		if (!target) {
			throw new Error(`Slash command alias '/${alias.name}' targets unknown command '/${alias.aliasFor}'`);
		}
		const targetAliases = aliasesByTarget.get(alias.aliasFor);
		if (targetAliases) {
			targetAliases.push(alias.name);
		} else {
			aliasesByTarget.set(alias.aliasFor, [alias.name]);
		}
	}
	return CANONICAL_BUILTIN_SLASH_COMMANDS.map((command) => ({
		...command,
		...(aliasesByTarget.has(command.name) ? { aliases: aliasesByTarget.get(command.name) } : {}),
	}));
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = buildBuiltinSlashCommands();

const BUILTIN_SLASH_COMMAND_BY_NAME = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
const BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME = new Map(
	BUILTIN_SLASH_COMMANDS.flatMap((command) => command.aliases?.map((alias) => [alias, command.name] as const) ?? []),
);

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

export function resolveBuiltinSlashCommandName(name: string): string {
	return BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME.get(name) ?? name;
}

export function isBuiltinSlashCommandName(name: string): boolean {
	return BUILTIN_SLASH_COMMAND_BY_NAME.has(name) || BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME.has(name);
}

export function builtinSlashCommandTakesArgument(name: string): boolean {
	return BUILTIN_SLASH_COMMAND_BY_NAME.get(resolveBuiltinSlashCommandName(name))?.takesArgument === true;
}

export function resolveSlashCommand(command: ParsedSlashCommand): ResolvedSlashCommand {
	const name = resolveBuiltinSlashCommandName(command.name);
	return {
		...command,
		name,
		originalName: command.name,
		isAlias: name !== command.name,
	};
}
