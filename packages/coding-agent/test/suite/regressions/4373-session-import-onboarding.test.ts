import { chmodSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionsDir } from "../../../src/config.js";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { listOpenCodeSessions } from "../../../src/core/session-import/adapters/opencode.js";
import {
	detectSessionImportFileKind,
	discoverSessionImports,
	importExternalSessionFile,
	importSessionsAndSkills,
	type SessionImportInventory,
} from "../../../src/core/session-import/index.js";
import { importSkillDirectory } from "../../../src/core/session-import/skills.js";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionHeader,
	SessionManager,
} from "../../../src/core/session-manager.js";
import { SessionImportSelectorComponent } from "../../../src/modes/interactive/components/session-import-selector.js";
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
					{ type: "thinking", thinking: "Claude thinking", signature: "claude-thinking-signature" },
					{ type: "redacted_thinking", data: "claude-redacted-payload" },
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
				model_provider: "openai",
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
			payload: {
				type: "function_call",
				call_id: "codex-tool",
				namespace: "codex_app",
				name: "set_thread_title",
				arguments: '{"title":"Imported session"}',
			},
		},
		{
			type: "response_item",
			timestamp: "2026-01-02T00:00:05.000Z",
			payload: { type: "function_call_output", call_id: "codex-tool", output: "Codex tool output" },
		},
		{
			type: "response_item",
			timestamp: "2026-01-02T00:00:05.500Z",
			payload: { type: "function_call_output", call_id: "codex-tool", output: "Duplicate Codex tool output" },
		},
	]);
	writeJsonl(join(home, ".codex", "sessions", "2026", "01", "01", "codex-subagent.jsonl"), [
		{
			type: "session_meta",
			timestamp: "2026-01-02T00:00:00.000Z",
			payload: {
				id: "codex-subagent",
				cwd: "/workspace/codex",
				thread_source: "subagent",
				source: { subagent: { other: "guardian" } },
				model_provider: "openai",
			},
		},
		{
			type: "event_msg",
			timestamp: "2026-01-02T00:00:01.000Z",
			payload: {
				type: "user_message",
				message: "The following is the Codex agent history whose request action you are assessing.",
			},
		},
	]);
	createSkill(home, join(".codex", "skills"), "codex-skill");
}

function createOpenCodeFixture(home: string): void {
	const directory = join(home, ".local", "share", "opencode");
	mkdirSync(directory, { recursive: true });
	const now = Date.now();
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
			.run("opencode-session", "/workspace/opencode", "OpenCode title", now, now + 10_000);
		database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
			"opencode-user",
			"opencode-session",
			now + 1_000,
			JSON.stringify({
				role: "user",
				time: { created: now + 1_000 },
				model: { providerID: "openai", modelID: "gpt-test" },
			}),
		);
		database
			.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)")
			.run(
				"opencode-user-text",
				"opencode-user",
				"opencode-session",
				now + 1_000,
				JSON.stringify({ type: "text", text: "OpenCode user prompt" }),
			);
		database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
			"opencode-assistant",
			"opencode-session",
			now + 2_000,
			JSON.stringify({
				role: "assistant",
				time: { created: now + 2_000 },
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
			now + 2_000,
			JSON.stringify({ type: "reasoning", text: "OpenCode thinking", time: { start: now + 2_000 } }),
		);
		insertPart.run(
			"opencode-text",
			"opencode-assistant",
			"opencode-session",
			now + 3_000,
			JSON.stringify({ type: "text", text: "OpenCode assistant" }),
		);
		insertPart.run(
			"opencode-tool",
			"opencode-assistant",
			"opencode-session",
			now + 4_000,
			JSON.stringify({
				type: "tool",
				callID: "opencode-tool",
				tool: "bash",
				state: {
					status: "completed",
					input: { command: "pwd" },
					output: "OpenCode tool output",
					time: { start: now + 4_000, end: now + 5_000 },
				},
			}),
		);
		insertPart.run(
			"opencode-after-tool",
			"opencode-assistant",
			"opencode-session",
			now + 6_000,
			JSON.stringify({ type: "text", text: "OpenCode after tool" }),
		);
	} finally {
		database.close();
	}
	createSkill(home, join(".config", "opencode", "skills"), "opencode-skill");
}

function createOpenCodeExportFixture(home: string): string {
	const path = join(home, "opencode-session.json");
	writeFileSync(
		path,
		JSON.stringify(
			{
				info: {
					id: "opencode-export",
					directory: "/workspace/opencode-export",
					title: "OpenCode export",
					time: { created: 1_767_571_200_000 },
				},
				messages: [
					{
						info: { role: "user", time: { created: 1_767_571_201_000 } },
						parts: [{ type: "text", text: "OpenCode export prompt" }],
					},
					{
						info: {
							role: "assistant",
							time: { created: 1_767_571_202_000 },
							providerID: "openai",
							modelID: "gpt-test",
							finish: "tool-calls",
						},
						parts: [
							{ type: "reasoning", text: "OpenCode export thinking" },
							{ type: "text", text: "OpenCode export response" },
							{
								type: "tool",
								callID: "opencode-export-tool",
								tool: "bash",
								state: {
									status: "completed",
									input: { command: "pwd" },
									output: "OpenCode export tool output",
									time: { start: 1_767_571_203_000, end: 1_767_571_204_000 },
								},
							},
						],
					},
				],
			},
			null,
			2,
		),
	);
	return path;
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
		const codexInventory = inventories.find((inventory) => inventory.source === "codex");
		expect(codexInventory?.sessionCount).toBe(1);
		expect(
			codexInventory?.sessionReferences.some(
				(reference) => reference.kind === "file" && reference.path.endsWith("codex-subagent.jsonl"),
			),
		).toBe(false);

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
			expect(header.importedFrom?.contentHash).toMatch(/^[a-f0-9]{64}$/);
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
			if (header.importedFrom?.source === "claude") {
				const thinking = context.messages
					.filter((message) => message.role === "assistant")
					.flatMap((message) => message.content)
					.filter((content) => content.type === "thinking");
				expect(thinking).toContainEqual(
					expect.objectContaining({ thinkingSignature: "claude-thinking-signature" }),
				);
				expect(thinking).toContainEqual(
					expect.objectContaining({
						thinkingSignature: "claude-redacted-payload",
						redacted: true,
					}),
				);
			}
			if (header.importedFrom?.source === "codex") {
				expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
			}
			if (header.importedFrom?.source === "opencode") {
				const totalUsage = context.messages
					.filter((message) => message.role === "assistant")
					.reduce((sum, message) => sum + message.usage.totalTokens, 0);
				expect(totalUsage).toBe(6);
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

		const claudeReference = inventories
			.find((inventory) => inventory.source === "claude")
			?.sessionReferences.find(
				(reference) => reference.kind === "file" && reference.path.endsWith("claude-session.jsonl"),
			);
		expect(claudeReference?.kind).toBe("file");
		if (claudeReference?.kind === "file") {
			writeFileSync(
				claudeReference.path,
				`${JSON.stringify({
					type: "user",
					sessionId: "claude-session",
					cwd: "/workspace/claude",
					timestamp: "2026-01-01T00:00:03.000Z",
					message: { role: "user", content: "Continued Claude prompt" },
				})}\n`,
				{ flag: "a" },
			);
		}

		const continued = await importSessionsAndSkills(
			inventories,
			inventories.map((inventory) => inventory.source),
			{ homeDir: home, agentDir, env: {} },
		);
		expect(continued.sessionsImported).toBe(1);
		expect(continued.sessionsSkipped).toBe(4);
		expect(readdirSync(getSessionsDir(agentDir)).filter((file) => file.endsWith(".jsonl"))).toHaveLength(5);
	});

	it("considers only the 50 most recently modified sessions from the last 30 days", () => {
		const project = join(home, ".claude", "projects", "-recent");
		const now = Date.now();
		for (let index = 0; index < 55; index++) {
			const path = join(project, `recent-${index.toString().padStart(2, "0")}.jsonl`);
			writeJsonl(path, [
				{
					type: "user",
					sessionId: `recent-${index}`,
					cwd: "/workspace/claude",
					timestamp: new Date(now - index * 1_000).toISOString(),
					message: { role: "user", content: `Recent prompt ${index}` },
				},
			]);
			const modifiedAt = new Date(now + 10_000 - index * 1_000);
			utimesSync(path, modifiedAt, modifiedAt);
		}
		const oldPath = join(project, "old.jsonl");
		writeJsonl(oldPath, [
			{
				type: "user",
				sessionId: "old",
				cwd: "/workspace/claude",
				timestamp: "2020-01-01T00:00:00.000Z",
				message: { role: "user", content: "Old prompt" },
			},
		]);
		const oldTime = new Date(now - 31 * 24 * 60 * 60 * 1_000);
		utimesSync(oldPath, oldTime, oldTime);

		const claude = discoverSessionImports({ homeDir: home, agentDir, env: {} }).find(
			(inventory) => inventory.source === "claude",
		);
		const paths =
			claude?.sessionReferences
				.filter((reference) => reference.kind === "file")
				.map((reference) => reference.path) ?? [];

		expect(claude?.sessionCount).toBe(50);
		expect(paths).toContain(join(project, "recent-00.jsonl"));
		expect(paths).not.toContain(join(project, "recent-54.jsonl"));
		expect(paths).not.toContain(oldPath);
	});

	it("detects and imports individual harness session files", async () => {
		const claudePath = join(home, ".claude", "projects", "-project", "claude-session.jsonl");
		const codexPath = join(home, ".codex", "sessions", "2026", "01", "01", "codex-session.jsonl");
		const piPath = join(home, ".pi", "agent", "sessions", "project", "pi-session.jsonl");
		const openCodePath = createOpenCodeExportFixture(home);
		const malformedPath = join(home, ".claude", "projects", "-project", "malformed.jsonl");

		await expect(detectSessionImportFileKind(claudePath)).resolves.toBe("claude");
		await expect(detectSessionImportFileKind(codexPath)).resolves.toBe("codex");
		await expect(detectSessionImportFileKind(piPath)).resolves.toBe("native");
		await expect(detectSessionImportFileKind(openCodePath)).resolves.toBe("opencode");
		await expect(detectSessionImportFileKind(malformedPath)).resolves.toBe("unknown");

		const claude = await importExternalSessionFile(claudePath, "claude", { homeDir: home, agentDir, env: {} });
		const codex = await importExternalSessionFile(codexPath, "codex", { homeDir: home, agentDir, env: {} });
		const openCode = await importExternalSessionFile(openCodePath, "opencode", {
			homeDir: home,
			agentDir,
			env: {},
		});
		expect(claude.status).toBe("imported");
		expect(codex.status).toBe("imported");
		expect(openCode.status).toBe("imported");

		for (const imported of [claude, codex, openCode]) {
			const entries = loadEntriesFromFile(imported.sessionFile);
			const header = entries[0] as SessionHeader;
			const state = [...entries].reverse().find((entry) => entry.type === "session_state");
			const context = SessionManager.open(imported.sessionFile, getSessionsDir(agentDir)).buildSessionContext();
			expect(header.importedFrom?.source).toBe(imported.source);
			expect(state?.type === "session_state" ? state.state.status : undefined).toBe("active");
			expect(context.model).toBeNull();
			expect(
				context.messages.some(
					(message) =>
						message.role === "assistant" && message.content.some((content) => content.type === "thinking"),
				),
			).toBe(true);
		}
		const codexContext = buildSessionContext(
			loadEntriesFromFile(codex.sessionFile)
				.slice(1)
				.filter((entry) => entry.type !== "session"),
		);
		expect(codexContext.messages.find((message) => message.role === "assistant")?.provider).toBe("openai");
		expect(
			codexContext.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => message.content)
				.find((content) => content.type === "toolCall")?.name,
		).toBe("codex_app_set_thread_title");

		await expect(
			importExternalSessionFile(claudePath, "claude", { homeDir: home, agentDir, env: {} }),
		).resolves.toMatchObject({
			sessionFile: claude.sessionFile,
			status: "existing",
		});
	});

	it("preserves response-only Codex turns while removing event duplicates and injected context", async () => {
		const path = join(home, "codex-mixed-users.jsonl");
		writeJsonl(path, [
			{
				type: "session_meta",
				timestamp: "2026-01-02T00:00:00.000Z",
				payload: { id: "codex-mixed-users", cwd: "/workspace/codex", model_provider: "openai" },
			},
			{
				type: "response_item",
				timestamp: "2026-01-02T00:00:01.000Z",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "First Codex turn" }],
				},
			},
			{
				type: "event_msg",
				timestamp: "2026-01-02T00:00:01.000Z",
				payload: { type: "user_message", message: "First Codex turn" },
			},
			{
				type: "response_item",
				timestamp: "2026-01-02T00:00:02.000Z",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "First Codex answer" }],
				},
			},
			{
				type: "response_item",
				timestamp: "2026-01-02T00:00:03.000Z",
				payload: {
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "<permissions instructions>ignored</permissions instructions>" },
						{ type: "input_text", text: "Second Codex turn" },
					],
				},
			},
			{
				type: "response_item",
				timestamp: "2026-01-02T00:00:04.000Z",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "Second Codex answer" }],
				},
			},
		]);

		const imported = await importExternalSessionFile(path, "codex", {
			agentDir,
			cwd: "/fallback/codex",
		});
		const context = SessionManager.open(imported.sessionFile, getSessionsDir(agentDir)).buildSessionContext();
		const users = context.messages
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((content) => (content.type === "text" ? content.text : "")).join("\n"),
			);
		const assistantText = context.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter((content) => content.type === "text")
			.map((content) => content.text);

		expect(users).toEqual(["First Codex turn", "Second Codex turn"]);
		expect(assistantText).toEqual(["First Codex answer", "Second Codex answer"]);
	});

	it("uses the requested cwd when imported source metadata has no cwd", async () => {
		const path = join(home, "claude-no-cwd.jsonl");
		writeJsonl(path, [
			{
				type: "user",
				sessionId: "claude-no-cwd",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "No cwd prompt" },
			},
		]);

		const directAgentDir = join(root, "direct-agent");
		const direct = await importExternalSessionFile(path, "claude", {
			agentDir: directAgentDir,
			cwd: "/fallback/direct",
		});
		expect((loadEntriesFromFile(direct.sessionFile)[0] as SessionHeader).cwd).toBe("/fallback/direct");

		const bulkAgentDir = join(root, "bulk-agent");
		const result = await importSessionsAndSkills(
			[
				{
					source: "claude",
					label: "Claude Code",
					sessionCount: 1,
					skillCount: 0,
					sessionReferences: [{ kind: "file", path }],
					skillDirectories: [],
				},
			],
			["claude"],
			{ agentDir: bulkAgentDir, cwd: "/fallback/bulk" },
		);
		expect(result.sessionsImported).toBe(1);
		const bulkFile = readdirSync(getSessionsDir(bulkAgentDir)).find((file) => file.endsWith(".jsonl"));
		expect(bulkFile).toBeDefined();
		expect((loadEntriesFromFile(join(getSessionsDir(bulkAgentDir), bulkFile!))[0] as SessionHeader).cwd).toBe(
			"/fallback/bulk",
		);
	});

	it("rejects non-regular import sources and oversized empty skill trees", async () => {
		await expect(detectSessionImportFileKind(home)).rejects.toThrow("regular file");

		const skill = join(root, "too-many-directories");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "---\nname: too-many\ndescription: too-many\n---\n");
		for (let index = 0; index < 2_000; index++) {
			mkdirSync(join(skill, `empty-${index}`));
		}
		expect(() => importSkillDirectory(skill, join(root, "skills"))).toThrow("safe import size limits");
	});

	it("filters Codex files without trustworthy top-level metadata", () => {
		const path = join(home, ".codex", "sessions", "2026", "01", "01", "codex-malformed-prefix.jsonl");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			`not json\n${JSON.stringify({
				type: "session_meta",
				timestamp: "2026-01-02T00:00:00.000Z",
				payload: {
					id: "codex-malformed-prefix",
					cwd: "/workspace/codex",
					model_provider: "openai",
				},
			})}\n`,
		);

		const codex = discoverSessionImports({ homeDir: home, agentDir, env: {} }).find(
			(inventory) => inventory.source === "codex",
		);
		expect(
			codex?.sessionReferences.some(
				(reference) => reference.kind === "file" && reference.path.endsWith("codex-malformed-prefix.jsonl"),
			),
		).toBe(false);
	});

	it("derives OpenCode database recency from messages and parts", () => {
		const databasePath = join(home, ".local", "share", "opencode", "opencode.db");
		const database = new DatabaseSync(databasePath);
		const now = Date.now();
		const old = now - 60 * 24 * 60 * 60 * 1_000;
		try {
			database
				.prepare("INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?)")
				.run("opencode-stale-refresh", "/workspace/stale", "Stale", old, now);
			database
				.prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
				.run(
					"opencode-stale-message",
					"opencode-stale-refresh",
					old,
					JSON.stringify({ role: "user", time: { created: old } }),
				);
			database
				.prepare("INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?)")
				.run("opencode-recent-part", "/workspace/recent", "Recent", old, old);
			database
				.prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
				.run(
					"opencode-recent-message",
					"opencode-recent-part",
					old,
					JSON.stringify({ role: "user", time: { created: old } }),
				);
			database
				.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)")
				.run(
					"opencode-recent-text",
					"opencode-recent-message",
					"opencode-recent-part",
					now,
					JSON.stringify({ type: "text", text: "Recent part" }),
				);
		} finally {
			database.close();
		}

		const sessions = listOpenCodeSessions(databasePath, now - 30 * 24 * 60 * 60 * 1_000, 50);
		expect(sessions.map((session) => session.id)).toContain("opencode-recent-part");
		expect(sessions.map((session) => session.id)).not.toContain("opencode-stale-refresh");
	});

	it("tries later OpenCode binaries when an earlier CLI returns no sessions", () => {
		if (process.platform === "win32") {
			return;
		}
		const cliHome = join(root, "cli-home");
		const emptyCommand = join(cliHome, "empty-opencode");
		const workingCommand = join(cliHome, ".opencode", "bin", "opencode");
		mkdirSync(join(workingCommand, ".."), { recursive: true });
		writeFileSync(emptyCommand, '#!/bin/sh\nprintf "[]\\n"\n');
		writeFileSync(
			workingCommand,
			`#!/bin/sh\nprintf '[{"id":"cli-session","updated":${Date.now()},"created":${Date.now()}}]\\n'\n`,
		);
		chmodSync(emptyCommand, 0o755);
		chmodSync(workingCommand, 0o755);

		const opencode = discoverSessionImports({
			homeDir: cliHome,
			agentDir,
			cwd: root,
			env: { OPENCODE_BIN: emptyCommand },
		}).find((inventory) => inventory.source === "opencode");

		expect(opencode?.sessionReferences).toContainEqual(
			expect.objectContaining({ kind: "opencode-cli", command: workingCommand, sessionId: "cli-session" }),
		);
	});

	it("keeps normal model restoration for native Prime Agent sessions", () => {
		const manager = SessionManager.inMemory("/workspace/codex");
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Imported Codex response" }],
			api: "openai-codex-responses",
			provider: "openai",
			model: "gpt-5.6-sol",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const context = manager.buildSessionContext();

		expect(context.model).toEqual({ provider: "openai", modelId: "gpt-5.6-sol" });
		expect(context.messages.find((message) => message.role === "assistant")?.provider).toBe("openai");
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
		const selector = new SessionImportSelectorComponent(inventories, onSelect, vi.fn());

		selector.handleInput("\x1b[A");
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(["codex"]);
	});

	it("presents the import action as the default CTA", () => {
		const inventories = discoverSessionImports({ homeDir: home, agentDir, env: {} }).slice(0, 2);
		const onSelect = vi.fn();
		const selector = new SessionImportSelectorComponent(inventories, onSelect, vi.fn());

		expect(selector.render(100).join("\n")).toContain("Import selected sessions and skills");
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(["claude", "codex"]);
	});
});
