import { describe, expect, test } from "vitest";
import {
	BUILTIN_SLASH_COMMANDS,
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

	test("exposes /effort for selecting the thinking level", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "effort")).toMatchObject({
			description: "Set reasoning/thinking level",
			argumentHint: "[level]",
			aliases: ["thinking"],
		});
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
});
