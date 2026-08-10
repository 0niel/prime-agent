import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import {
	AGENT_TASK_STATES,
	CURRENT_SESSION_VERSION,
	readSessionInfo,
	SessionManager,
} from "../src/core/session-manager.js";

const CODEC_SCHEMA_REVISION = 3;
const CODEC_TIMESTAMP = "2026-01-02T03:04:05.000Z";
const CODEC_HEADER = {
	type: "session",
	version: CODEC_SCHEMA_REVISION,
	id: "codec-fixture-session",
	timestamp: CODEC_TIMESTAMP,
	cwd: "/codec-fixture/project",
	rlmDepth: 0,
};

function writeCodecFixture(filePath: string, entries: readonly Record<string, unknown>[]): void {
	writeFileSync(filePath, `${[CODEC_HEADER, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function assistantFixture(parentId: string | null = null): Record<string, unknown> {
	return {
		type: "message",
		id: "codec-assistant-message",
		parentId,
		timestamp: CODEC_TIMESTAMP,
		message: { role: "assistant", content: "fixture", timestamp: 0 },
	};
}

function readCodecEntries(filePath: string): Record<string, unknown>[] {
	return readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}
describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const expectedSessionDir = join(agentDir, "sessions");
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
			tools: ["ipython"],
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Working directory: ${sessionCwd}`);

		const ipythonTool = session.agent.state.tools.find((tool) => tool.name === "ipython");
		expect(ipythonTool).toBeTruthy();
		const result = await ipythonTool!.execute("test", { code: "%%bash\npwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});
});

describe("SessionManager durable codec compatibility", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), "pi-sdk-session-codec-fixture");
		rmSync(tempDir, { recursive: true, force: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each(AGENT_TASK_STATES)("writes and rereads the %s task-state codec", async (taskState) => {
		const sessionFile = join(tempDir, `${taskState}.jsonl`);
		writeCodecFixture(sessionFile, [assistantFixture()]);
		const manager = SessionManager.open(sessionFile, tempDir);

		manager.appendAgentStatus({
			summary: `Fixture ${taskState} verdict`,
			taskState,
			basedOnMessageCount: 1,
		});

		const entries = readCodecEntries(sessionFile);
		const stored = entries.at(-1);
		expect(entries[0]).toEqual(CODEC_HEADER);
		expect(CURRENT_SESSION_VERSION).toBe(CODEC_SCHEMA_REVISION);
		expect(stored).toMatchObject({
			type: "agent_status",
			parentId: "codec-assistant-message",
			status: {
				summary: `Fixture ${taskState} verdict`,
				taskState,
				basedOnMessageCount: 1,
			},
		});
		expect(Object.keys(stored ?? {}).sort()).toEqual(["id", "parentId", "status", "timestamp", "type"]);
		const storedStatus = stored?.status as Record<string, unknown> | undefined;
		expect(storedStatus).toBeDefined();
		expect(Object.keys(storedStatus!).sort()).toEqual(["basedOnMessageCount", "summary", "taskState"]);
		expect(manager.getLatestAgentStatus()).toEqual({
			summary: `Fixture ${taskState} verdict`,
			taskState,
			basedOnMessageCount: 1,
		});
		expect((await readSessionInfo(sessionFile))?.agentStatus).toEqual({
			summary: `Fixture ${taskState} verdict`,
			taskState,
			basedOnMessageCount: 1,
		});
	});

	it.each([
		["unknown task state", { summary: "Unknown verdict", taskState: "waiting", basedOnMessageCount: 1 }],
		["malformed task state", { summary: "Malformed verdict", taskState: 42, basedOnMessageCount: 1 }],
	])("marks a %s durable status as untrusted", async (_description, status) => {
		const sessionFile = join(tempDir, "invalid-status.jsonl");
		writeCodecFixture(sessionFile, [
			assistantFixture(),
			{
				type: "agent_status",
				id: "codec-invalid-status",
				parentId: "codec-assistant-message",
				timestamp: CODEC_TIMESTAMP,
				status,
			},
		]);

		const info = await readSessionInfo(sessionFile);
		expect(info).toMatchObject({ hasInvalidDurableState: true });
		expect(info?.agentStatus).toBeUndefined();
	});

	it.each(["hidden", "sleep"] as const)(
		"reads legacy %s lifecycle state as archived without rewriting its public JSON",
		async (legacyStatus) => {
			const sessionFile = join(tempDir, `${legacyStatus}.jsonl`);
			writeCodecFixture(sessionFile, [
				assistantFixture(),
				{
					type: "session_state",
					id: "codec-legacy-state",
					parentId: "codec-assistant-message",
					timestamp: CODEC_TIMESTAMP,
					state: { status: legacyStatus },
				},
			]);

			const manager = SessionManager.open(sessionFile, tempDir);
			expect(manager.getSessionState()).toEqual({ status: "archived" });
			// A current write appends a current state rather than mutating the legacy row.
			manager.appendSessionState({ status: "archived" });

			const entries = readCodecEntries(sessionFile);
			expect(entries[0]).toEqual(CODEC_HEADER);
			expect(entries.filter((entry) => entry.type === "session_state").map((entry) => entry.state)).toEqual([
				{ status: legacyStatus },
				{ status: "archived" },
			]);
			expect((await readSessionInfo(sessionFile))?.state).toEqual({ status: "archived" });
		},
	);
});
