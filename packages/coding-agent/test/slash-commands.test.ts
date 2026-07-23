import { describe, expect, test } from "vitest";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinSlashCommandTakesArgument,
	isBuiltinSlashCommandName,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
	resolveSlashCommand,
} from "../src/core/slash-commands.js";

describe("built-in slash commands", () => {
	test("exposes heartbeat without exposing a cron slash command", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).toContain("heartbeat");
		expect(commandNames).not.toContain("cron");
	});

	test("exposes heartbeat syntax guidance", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "heartbeat")).toMatchObject({
			description:
				"Set or view a persistent heartbeat; delivery defaults to steer, use --follow-up to queue; supports pause, resume, stop, and clear",
			argumentHint: "[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]",
			takesArgument: true,
		});
	});

	test("exposes /effort for selecting the thinking level", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "effort")).toMatchObject({
			description: "Set reasoning/thinking level",
			argumentHint: "[level]",
			aliases: ["thinking"],
		});
	});

	test("describes both /import modes", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "import")).toMatchObject({
			description: "Import harness history, or import and resume a supported session file",
		});
	});

	test("exposes /btw as an argument command with /side as an alias", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "btw")).toMatchObject({
			argumentHint: "<question>",
			aliases: ["side"],
			takesArgument: true,
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "side")).toBeUndefined();
		expect(builtinSlashCommandTakesArgument("side")).toBe(true);
	});

	test("describes /mcp as the MCP Connections menu entry point", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "mcp")).toMatchObject({
			description: "Open MCP Connections or manage MCP integrations",
			argumentHint: "[list|login <name>|logout <name>]",
			takesArgument: true,
		});
	});

	test("exposes trace preview and backfill syntax", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "traces")).toMatchObject({
			description: "Preview, upload, or configure Prime Agent traces",
			argumentHint: "[status|on|off|preview|upload|upload-current|upload-all|login]",
		});
	});

	test("marks argument commands as taking a free-form argument", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "goal")).toMatchObject({
			takesArgument: true,
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "effort")).toMatchObject({
			takesArgument: true,
		});
		expect(builtinSlashCommandTakesArgument("goal")).toBe(true);
		expect(builtinSlashCommandTakesArgument("effort")).toBe(true);
		expect(builtinSlashCommandTakesArgument("thinking")).toBe(true);
		expect(builtinSlashCommandTakesArgument("heartbeat")).toBe(true);
		expect(builtinSlashCommandTakesArgument("mcp")).toBe(true);
		expect(builtinSlashCommandTakesArgument("new")).toBe(false);
		expect(builtinSlashCommandTakesArgument("clear")).toBe(false);
	});
});

describe("slash command aliases", () => {
	test("keeps aliases hidden on canonical command entries", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "clear")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "usage")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "rename")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "new")).toMatchObject({
			description: "Start a new session",
			aliases: ["clear"],
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "context")).toMatchObject({
			description: "Show token, cost, and context usage for agent and sub-agents",
			aliases: ["usage"],
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "name")).toMatchObject({
			description: "Set session display name",
			aliases: ["rename"],
		});
	});

	test("resolves /rename to /name through the alias path", () => {
		const parsed = parseSlashCommand("/rename my session");

		expect(isBuiltinSlashCommandName("rename")).toBe(true);
		expect(resolveBuiltinSlashCommandName("rename")).toBe("name");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "name",
			args: "my session",
			originalName: "rename",
			isAlias: true,
		});
	});

	test("resolves /clear to /new through the alias path", () => {
		const parsed = parseSlashCommand("/clear");

		expect(parsed).toEqual({ name: "clear", args: "" });
		expect(isBuiltinSlashCommandName("clear")).toBe(true);
		expect(resolveBuiltinSlashCommandName("clear")).toBe("new");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "new",
			args: "",
			originalName: "clear",
			isAlias: true,
		});
	});

	test("resolves /thinking to /effort through the alias path", () => {
		const parsed = parseSlashCommand("/thinking");

		expect(isBuiltinSlashCommandName("thinking")).toBe(true);
		expect(resolveBuiltinSlashCommandName("thinking")).toBe("effort");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "effort",
			args: "",
			originalName: "thinking",
			isAlias: true,
		});
	});

	test("preserves arguments when resolving aliases", () => {
		const parsed = parseSlashCommand("/usage latest turn");

		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "context",
			args: "latest turn",
			originalName: "usage",
			isAlias: true,
		});
	});

	test("resolves /side to /btw", () => {
		const parsed = parseSlashCommand("/side Is this cached?");

		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "btw",
			args: "Is this cached?",
			originalName: "side",
			isAlias: true,
		});
	});
});
