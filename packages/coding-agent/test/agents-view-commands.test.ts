import { describe, expect, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import {
	AGENTS_VIEW_SLASH_COMMANDS,
	classifyAgentsViewCommand,
	parseSlashCommand,
	resolveAgentsViewCommand,
} from "../src/modes/agents-view/agents-view-commands.js";

describe("parseSlashCommand", () => {
	test("parses a bare command", () => {
		expect(parseSlashCommand("/login")).toEqual({ name: "login", args: "" });
	});

	test("parses a command with arguments", () => {
		expect(parseSlashCommand("/model opus anthropic")).toEqual({ name: "model", args: "opus anthropic" });
	});

	test("trims argument whitespace", () => {
		expect(parseSlashCommand("/compact  focus on the bug ")).toEqual({ name: "compact", args: "focus on the bug" });
	});

	test("returns undefined for non-command text", () => {
		expect(parseSlashCommand("fix the bug")).toBeUndefined();
		expect(parseSlashCommand("")).toBeUndefined();
	});

	test("returns undefined for a lone slash", () => {
		expect(parseSlashCommand("/")).toBeUndefined();
		expect(parseSlashCommand("/ leading space")).toBeUndefined();
	});
});

describe("classifyAgentsViewCommand", () => {
	test("whitelisted global commands run in the agents view", () => {
		for (const name of ["login", "logout", "model", "resume", "quit"]) {
			expect(classifyAgentsViewCommand(name)).toBe("agents-view");
		}
	});

	test("other built-ins are session-only", () => {
		for (const name of ["compact", "fork", "settings", "new", "clear", "export"]) {
			expect(classifyAgentsViewCommand(name)).toBe("session-only");
		}
	});

	test("aliases classify by their canonical built-in target", () => {
		expect(classifyAgentsViewCommand("clear")).toBe("session-only");
		expect(resolveAgentsViewCommand({ name: "clear", args: "" })).toEqual({ name: "new", args: "" });
	});

	test("non-built-ins pass through for daemon-side expansion", () => {
		expect(classifyAgentsViewCommand("skill:create-pr")).toBe("unknown");
		expect(classifyAgentsViewCommand("my-template")).toBe("unknown");
	});
});

describe("AGENTS_VIEW_SLASH_COMMANDS", () => {
	test("every whitelisted command is a built-in with a description", () => {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		for (const command of AGENTS_VIEW_SLASH_COMMANDS) {
			expect(builtinNames.has(command.name)).toBe(true);
			expect(command.description.length).toBeGreaterThan(0);
		}
	});

	test("classification agrees with the command list", () => {
		for (const command of AGENTS_VIEW_SLASH_COMMANDS) {
			expect(classifyAgentsViewCommand(command.name)).toBe("agents-view");
		}
	});
});
