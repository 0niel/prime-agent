import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionsDir } from "../../../src/config.js";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import {
	discoverSessionImports,
	importSessionsAndSkills,
	type SessionImportInventory,
} from "../../../src/core/session-import/index.js";
import { buildSessionContext, loadEntriesFromFile, type SessionHeader } from "../../../src/core/session-manager.js";
import { OnboardingImportSelectorComponent } from "../../../src/modes/interactive/components/onboarding-import-selector.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function writeJsonl(path: string, entries: unknown[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function createSkill(home: string, relativeRoot: string, name: string): void {
	const directory = join(home, relativeRoot, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

function createClaudeFixture(home: string): void {
	const path = join(home, ".claude", "projects", "-project", "claude-session.jsonl");
	writeJsonl(path, [
		{
			type: "user",
			sessionId: "claude-session",
			cwd: "/workspace/claude",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "Claude user prompt" },
		},
		{
			type: "assistant",
			sessionId: "claude-session",
			cwd: "/workspace/claude",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				model: "claude-test",
				stop_reason: "tool_use",
				usage: { input_tokens: 2, output_tokens: 3 },
				content: [
					{ type: "thinking", thinking: "Claude thinking" },
					{ type: "text", text: "Claude assistant" },
					{ type: "tool_use", id: "claude-tool", name: "read", input: { path: "README.md" } },
				],
			},
		},
		{
			type: "user",
			sessionId: "claude-session",
			cwd: "/workspace/claude",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "claude-tool", content: "Claude tool output" }],
			},
		},
	]);
	mkdirSync(join(home, ".claude", "projects", "-project"), { recursive: true });
	writeFileSync(join(home, ".claude", "projects", "-project", "malformed.jsonl"), "not json\n");
	createSkill(home, join(".claude", "skills"), "claude-skill");
}

function createCodexFixture(home: string): void {
	const path = join(home, ".codex", "sessions", "2026", "01", "01", "codex-session.jsonl");
	writeJsonl(path, [
		{
			type: "session_meta",
			timestamp: "2026-01-02T00:00:00.000Z",
			payload: {
				id: "codex-session",
				cwd: "/workspace/codex",
				model_provider: "openai-codex",
			},
		},
		{
			type: "turn_context",
			timestamp: "2026-01-02T00:00:00.500Z",
			payload: { model: "gpt-test", cwd: "/workspace/codex" },
		},
		{
			type: "event_msg",
			timestamp: "2026-01-02T00:00:01.000Z",
			payload: { type: "user_message", message: "Codex user prompt" },
		},
		{
			type: "response_item",
			timestamp: "2026-01-02T00:00:02.000Z",
			payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Codex thinking" }] },
		},
		{
			type: "response_item",
			timestamp: "2026-01-02T00:00:03.000Z",
			payload: {
				type: "message",
				role: "assistant",
				phase: "commentary",
				content: [{ type: "output_text", text: "Codex assistant" }],
			},
		},
		{
			type: "response_item",
			timestamp: "2026-01-02T00:00:04.000Z",
			payload: { type: "function_call", call_id: "codex-tool", name: "exec", arguments: '{"cmd":"pwd"}' },
		},
		{
			type: "response_item",
			timestamp: "2026-01-02T00:00:05.000Z",
			payload: { type: "function_call_output", call_id: "codex-tool", output: "Codex tool output" },
		},
	]);
	createSkill(home, join(".codex", "skills"), "codex-skill");
}

function createOpenCodeFixture(home: string): void {
	const directory = join(home, ".local", "share", "opencode");
	mkdirSync(directory, { recursive: true });
	const database = new DatabaseSync(join(directory, "opencode.db"));
	try {
		database.exec(`
			CREATE TABLE session (
				id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
				time_created INTEGER, time_updated INTEGER
			);
			CREATE TABLE message (
				id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
			);
			CREATE TABLE part (
				id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
			);
		`);
		database
			.prepare("INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?)")
			.run("opencode-session", "/workspace/opencode", "OpenCode title", 1_767_312_000_000, 1_767_312_010_000);
		database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
			"opencode-user",
			"opencode-session",
			1_767_312_001_000,
			JSON.stringify({
				role: "user",
				time: { created: 1_767_312_001_000 },
				model: { providerID: "openai", modelID: "gpt-test" },
			}),
		);
		database
			.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)")
			.run(
				"opencode-user-text",
				"opencode-user",
				"opencode-session",
				1_767_312_001_000,
				JSON.stringify({ type: "text", text: "OpenCode user prompt" }),
			);
		database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
			"opencode-assistant",
			"opencode-session",
			1_767_312_002_000,
			JSON.stringify({
				role: "assistant",
				time: { created: 1_767_312_002_000 },
				providerID: "openai",
				modelID: "gpt-test",
				finish: "tool-calls",
				tokens: { input: 2, output: 3, cache: { read: 1, write: 0 } },
			}),
		);
		const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
		insertPart.run(
			"opencode-reasoning",
			"opencode-assistant",
			"opencode-session",
			1_767_312_002_000,
			JSON.stringify({ type: "reasoning", text: "OpenCode thinking", time: { start: 1_767_312_002_000 } }),
		);
		insertPart.run(
			"opencode-text",
			"opencode-assistant",
			"opencode-session",
			1_767_312_003_000,
			JSON.stringify({ type: "text", text: "OpenCode assistant" }),
		);
		insertPart.run(
			"opencode-tool",
			"opencode-assistant",
			"opencode-session",
			1_767_312_004_000,
			JSON.stringify({
				type: "tool",
				callID: "opencode-tool",
				tool: "bash",
				state: {
					status: "completed",
					input: { command: "pwd" },
					output: "OpenCode tool output",
					time: { start: 1_767_312_004_000, end: 1_767_312_005_000 },
				},
			}),
		);
	} finally {
		database.close();
	}
	createSkill(home, join(".config", "opencode", "skills"), "opencode-skill");
}

function createPiFixture(home: string): void {
	const user: Message = {
		role: "user",
		content: "Pi user prompt",
		timestamp: 1_767_398_401_000,
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Pi thinking" },
			{ type: "text", text: "Pi assistant" },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 1_767_398_402_000,
	};
	writeJsonl(join(home, ".pi", "agent", "sessions", "project", "pi-session.jsonl"), [
		{
			type: "session",
			version: 3,
			id: "pi-session",
			timestamp: "2026-01-03T00:00:00.000Z",
			cwd: "/workspace/pi",
		},
		{ type: "message", id: "pi-user", parentId: null, timestamp: "2026-01-03T00:00:01.000Z", message: user },
		{
			type: "message",
			id: "pi-assistant",
			parentId: "pi-user",
			timestamp: "2026-01-03T00:00:02.000Z",
			message: assistant,
		},
	]);
	createSkill(home, join(".pi", "agent", "skills"), "pi-skill");
}

describe("ENG-4373 onboarding session import", () => {
	let root: string;
	let home: string;
	let agentDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		root = join(tmpdir(), `prime-agent-4373-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		home = join(root, "home");
		agentDir = join(root, "prime-agent");
		mkdirSync(home, { recursive: true });
		createClaudeFixture(home);
		createCodexFixture(home);
		createOpenCodeFixture(home);
		createPiFixture(home);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("imports all supported harnesses with thoughts, tool calls, results, and skills", async () => {
		const inventories = discoverSessionImports({ homeDir: home, agentDir, env: {} });
		expect(inventories.map((inventory) => inventory.source)).toEqual(["claude", "codex", "opencode", "pi"]);

		const result = await importSessionsAndSkills(
			inventories,
			inventories.map((inventory) => inventory.source),
			{ homeDir: home, agentDir, env: {} },
		);
		expect(result.sessionsImported).toBe(4);
		expect(result.sessionsSkipped).toBe(1);
		expect(result.sessionFailures).toBe(0);
		expect(result.skillsImported).toBe(4);

		const sessionFiles = readdirSync(getSessionsDir(agentDir))
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(getSessionsDir(agentDir), file));
		expect(sessionFiles).toHaveLength(4);

		const importedSources = new Set<string>();
		for (const sessionFile of sessionFiles) {
			const entries = loadEntriesFromFile(sessionFile);
			const header = entries[0] as SessionHeader;
			importedSources.add(header.importedFrom?.source ?? "");
			const context = buildSessionContext(entries.slice(1).filter((entry) => entry.type !== "session"));
			expect(context.messages.some((message) => message.role === "user")).toBe(true);
			expect(
				context.messages.some(
					(message) =>
						message.role === "assistant" && message.content.some((content) => content.type === "thinking"),
				),
			).toBe(true);
			if (header.importedFrom?.source !== "pi") {
				expect(
					context.messages.some(
						(message) =>
							message.role === "assistant" && message.content.some((content) => content.type === "toolCall"),
					),
				).toBe(true);
				expect(context.messages.some((message) => message.role === "toolResult")).toBe(true);
			}
		}
		expect(importedSources).toEqual(new Set(["claude", "codex", "opencode", "pi"]));

		for (const skill of ["claude-skill", "codex-skill", "opencode-skill", "pi-skill"]) {
			expect(readdirSync(join(agentDir, "skills", skill))).toContain("SKILL.md");
		}

		const retry = await importSessionsAndSkills(
			inventories,
			inventories.map((inventory) => inventory.source),
			{ homeDir: home, agentDir, env: {} },
		);
		expect(retry.sessionsImported).toBe(0);
		expect(retry.sessionsSkipped).toBe(5);
		expect(retry.skillsImported).toBe(0);
		expect(retry.skillsSkipped).toBe(4);
	});

	it("continues importing other sources when one source disappears", async () => {
		const inventories = discoverSessionImports({ homeDir: home, agentDir, env: {} });
		const codex = inventories.find((inventory) => inventory.source === "codex") as SessionImportInventory;
		const codexPath = codex.sessionReferences[0];
		expect(codexPath?.kind).toBe("file");
		if (codexPath?.kind === "file") {
			rmSync(codexPath.path);
		}

		const result = await importSessionsAndSkills(
			inventories,
			inventories.map((inventory) => inventory.source),
			{ homeDir: home, agentDir, env: {} },
		);
		expect(result.sessionsImported).toBe(3);
		expect(result.sessionFailures).toBe(1);
		expect(result.skillsImported).toBe(4);
	});

	it("selects harnesses rather than individual data types", () => {
		const inventories = discoverSessionImports({ homeDir: home, agentDir, env: {} }).slice(0, 2);
		const onSelect = vi.fn();
		const selector = new OnboardingImportSelectorComponent(inventories, onSelect, vi.fn());

		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(["codex"]);
	});
});
