import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../../src/core/compaction/index.js";
import { SessionManager, type SessionTreeNode } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

function flattenTree(roots: SessionTreeNode[]): SessionTreeNode[] {
	const result: SessionTreeNode[] = [];
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		result.push(node);
		stack.push(...node.children);
	}
	return result;
}

describe("SessionManager compacted history memory", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("evicts old payloads, preserves disk history, and hydrates an old branch on demand", async () => {
		const tempDir = join(tmpdir(), `compacted-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		const oldUserText = `old-user-${"u".repeat(512 * 1024)}`;
		const oldAssistantText = `old-assistant-${"a".repeat(512 * 1024)}`;
		const oldCustomText = `old-custom-${"c".repeat(512 * 1024)}`;
		const oldUserId = session.appendMessage(userMsg(oldUserText));
		const oldAssistantId = session.appendMessage(assistantMsg(oldAssistantText));
		const childUsage = {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const aggregateUsage = {
			...childUsage,
			input: 700,
			output: 77,
			totalTokens: 777,
		};
		session.appendChildUsageAttribution(oldAssistantId, childUsage, aggregateUsage);
		session.appendCustomMessageEntry("large-custom", oldCustomText, true, { payload: oldCustomText });
		const recentUserId = session.appendMessage(userMsg("recent user"));
		const recentAssistantId = session.appendMessage(assistantMsg("recent assistant"));
		session.appendCompaction("compact summary", recentUserId, 1000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const diskBeforeEviction = readFileSync(sessionFile, "utf8");

		expect(session.evictCompactedHistoryPayloads()).toBe(3);
		expect(session.getEvictedHistoryPayloadCount()).toBe(3);
		expect(readFileSync(sessionFile, "utf8")).toBe(diskBeforeEviction);
		const residentJson = JSON.stringify(session.getResidentEntries());
		expect(residentJson).toContain("[Compacted history stored on disk]");
		expect(residentJson.length).toBeLessThan(100_000);
		const context = session.buildSessionContext();
		expect(context.messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "assistant"]);
		expect(JSON.stringify(context.messages)).toContain("recent assistant");
		expect(JSON.stringify(context.messages)).not.toContain("old-assistant-");
		session.appendMessage(userMsg("after compaction"));
		expect(readFileSync(sessionFile, "utf8")).toContain(oldAssistantText);
		expect(JSON.stringify(session.buildSessionContext())).toContain("after compaction");

		const treeJson = JSON.stringify(flattenTree(session.getTree()));
		expect(treeJson).toContain("[Compacted history stored on disk]");
		expect(treeJson).not.toContain(oldAssistantText);

		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getEvictedHistoryPayloadCount()).toBe(3);
		const structuralCollection = await collectEntriesForBranchSummary(
			reopened,
			reopened.getLeafId(),
			oldAssistantId,
			{
				includePayloads: false,
			},
		);
		expect(structuralCollection.entries.length).toBeGreaterThan(0);
		expect(reopened.getEvictedHistoryPayloadCount()).toBe(3);
		expect(JSON.stringify(reopened.getEntry(oldUserId))).not.toContain(oldUserText);
		expect(JSON.stringify(reopened.getResidentBranch())).not.toContain(oldAssistantText);
		expect(JSON.stringify(reopened.getBranch())).toContain(oldAssistantText);
		expect(reopened.getEvictedHistoryPayloadCount()).toBe(3);
		expect(JSON.stringify(reopened.getBranch(oldAssistantId))).toContain(oldAssistantText);
		expect(reopened.getEvictedHistoryPayloadCount()).toBe(3);
		const payloadCollection = await collectEntriesForBranchSummary(reopened, reopened.getLeafId(), oldAssistantId);
		expect(JSON.stringify(payloadCollection.entries)).toContain(oldCustomText);
		expect(reopened.getEvictedHistoryPayloadCount()).toBe(3);
		const targetedAssistant = (await reopened.getEntriesById(new Set([oldAssistantId]))).get(oldAssistantId);
		expect(JSON.stringify(targetedAssistant)).toContain(oldAssistantText);
		expect(targetedAssistant).toMatchObject({
			type: "message",
			message: { role: "assistant", usage: { totalTokens: 777 } },
		});
		expect(reopened.getEvictedHistoryPayloadCount()).toBe(3);
		await reopened.hydrateBranchPayloads(oldAssistantId);
		reopened.branch(oldAssistantId);
		reopened.evictCompactedHistoryPayloads();
		expect(reopened.getEvictedHistoryPayloadCount()).toBeGreaterThan(0);
		const hydratedOldUser = reopened.getResidentEntries().find((entry) => entry.id === oldUserId);
		expect(hydratedOldUser).toMatchObject({ type: "message", message: { role: "user", content: oldUserText } });
		expect(JSON.stringify(reopened.buildSessionContext())).toContain(oldAssistantText);

		const evictedBeforeFullRead = reopened.getEvictedHistoryPayloadCount();
		const fullyHydrated = reopened.getEntries();
		expect(reopened.getEvictedHistoryPayloadCount()).toBe(evictedBeforeFullRead);
		expect(JSON.stringify(fullyHydrated)).toContain(oldCustomText);

		reopened.appendMessage(userMsg("forked active branch"));
		const reopenedFork = SessionManager.open(sessionFile, tempDir);
		expect(reopenedFork.getEvictedHistoryPayloadCount()).toBeGreaterThan(0);
		expect(JSON.stringify(reopenedFork.buildSessionContext())).toContain(oldAssistantText);
		expect(JSON.stringify(reopenedFork.buildSessionContext())).toContain("forked active branch");
		const inactiveRecentAssistant = reopenedFork.getResidentEntries().find((entry) => entry.id === recentAssistantId);
		expect(inactiveRecentAssistant).toMatchObject({
			type: "message",
			message: { content: [{ type: "text", text: expect.stringContaining("[Compacted history stored on disk]") }] },
		});
	});
	it("fails safely instead of rewriting previews when compacted disk history disappears", () => {
		const tempDir = join(tmpdir(), `compacted-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg(`historic-${"h".repeat(128 * 1024)}`));
		session.appendMessage(assistantMsg("historic response"));
		const recentUserId = session.appendMessage(userMsg("recent user"));
		session.appendMessage(assistantMsg("recent assistant"));
		session.appendCompaction("compact summary", recentUserId, 1000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		expect(session.evictCompactedHistoryPayloads()).toBeGreaterThan(0);
		const residentCount = session.getResidentEntries().length;
		rmSync(sessionFile);

		expect(() => session.getEntries()).toThrow(/history is unavailable on disk/);
		expect(() => session.getBranch()).toThrow(/history is unavailable on disk/);
		expect(() => session.appendMessage(userMsg("must not recreate from previews"))).toThrow(
			/full history is unavailable on disk/,
		);
		expect(session.getResidentEntries()).toHaveLength(residentCount);
		expect(() => session.flushNow()).toThrow(/full history is unavailable on disk/);
		expect(readFileSync.bind(undefined, sessionFile, "utf8")).toThrow();
	});

	it("target-loads compacted entries with escaped and long persisted IDs", async () => {
		const tempDir = join(tmpdir(), `compacted-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		const oldText = "historic entry with unusual id";
		const oldUserId = session.appendMessage(userMsg(oldText));
		session.appendMessage(assistantMsg("historic assistant"));
		const recentUserId = session.appendMessage(userMsg("recent user"));
		session.appendMessage(assistantMsg("recent assistant"));
		session.appendCompaction("compact summary", recentUserId, 1000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const unusualId = `historic-"-\\-${"x".repeat(160)}`;
		const entries = readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
		for (const entry of entries) {
			if (entry.id === oldUserId) entry.id = unusualId;
			if (entry.parentId === oldUserId) entry.parentId = unusualId;
		}
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const reopened = await SessionManager.openAsync(sessionFile, tempDir);
		expect(reopened.getEvictedHistoryPayloadCount()).toBeGreaterThan(0);
		const loaded = (await reopened.getEntriesById(new Set([unusualId]))).get(unusualId);
		expect(loaded).toMatchObject({ type: "message", message: { role: "user", content: oldText } });
		expect(reopened.getEvictedHistoryPayloadCount()).toBeGreaterThan(0);

		writeFileSync(
			sessionFile,
			`${entries
				.filter((entry) => entry.id !== unusualId)
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		await expect(collectEntriesForBranchSummary(reopened, reopened.getLeafId(), "missing-target")).rejects.toThrow(
			/unavailable for branch summary/,
		);
	});

	it("bounds branch traversal when persisted parent links contain a cycle", async () => {
		const tempDir = join(tmpdir(), `compacted-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		const oldUserId = session.appendMessage(userMsg("historic user"));
		session.appendMessage(assistantMsg("historic assistant"));
		const recentUserId = session.appendMessage(userMsg("recent user"));
		session.appendMessage(assistantMsg("recent assistant"));
		const compactionId = session.appendCompaction("compact summary", recentUserId, 1000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		const entries = readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
		const oldUser = entries.find((entry) => entry.id === oldUserId);
		if (!oldUser) throw new Error("missing historic user entry");
		oldUser.parentId = compactionId;
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const reopened = await SessionManager.openAsync(sessionFile, tempDir);
		const branch = reopened.getResidentBranch();
		expect(branch.length).toBeGreaterThan(0);
		expect(new Set(branch.map((entry) => entry.id)).size).toBe(branch.length);
		expect(reopened.buildSessionContext().messages.length).toBeGreaterThan(0);
		expect(reopened.getLatestAgentStatus()).toBeUndefined();
	});

	it("bounds commands, metadata, diagnostics, and unknown fields in evicted messages", () => {
		const tempDir = join(tmpdir(), `compacted-fields-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		const long = (label: string) => `${label}-${label[0]?.repeat(128 * 1024)}`;
		const bashCommand = long("bash-command");
		const unknown = long("unknown-extra");
		const oversizedFieldName = `extension-field-${"k".repeat(128 * 1024)}`;

		const bashId = session.appendMessage({
			role: "bashExecution",
			command: bashCommand,
			output: long("bash-output"),
			exitCode: 7,
			cancelled: false,
			truncated: true,
			fullOutputPath: long("output-path"),
			timestamp: Date.now(),
			extra: unknown,
		} as never);
		session.appendMessage({
			...assistantMsg(long("assistant-content")),
			responseId: long("response-id"),
			diagnostics: { stack: long("diagnostic-stack") },
			extra: unknown,
		} as never);
		session.appendMessage({
			role: "toolResult",
			toolCallId: long("tool-call"),
			toolName: long("tool-name"),
			content: [{ type: "text", text: long("tool-content") }],
			details: { value: long("tool-details") },
			isError: true,
			timestamp: Date.now(),
			extra: unknown,
		} as never);
		session.appendMessage({
			role: "branchSummary",
			summary: long("branch-summary"),
			fromId: long("from-id"),
			timestamp: Date.now(),
			extra: unknown,
		} as never);
		session.appendMessage({
			role: "compactionSummary",
			summary: long("compaction-summary"),
			tokensBefore: 123,
			retainedMessageCount: 2,
			customInstructions: long("instructions"),
			timestamp: Date.now(),
			extra: unknown,
		} as never);
		const extensionRoleId = session.appendMessage({
			role: "extension_merged_role",
			content: long("extension-content"),
			metadata: { nested: long("extension-metadata") },
			timestamp: Date.now(),
			extra: unknown,
			[oversizedFieldName]: "bounded key value",
			extensionMarker: true,
		} as never);
		const recentUserId = session.appendMessage(userMsg("recent user"));
		session.appendMessage(assistantMsg("recent assistant"));
		session.appendCompaction("compact summary", recentUserId, 1000);

		expect(session.evictCompactedHistoryPayloads()).toBe(6);
		const resident = session.getResidentEntries();
		const residentJson = JSON.stringify(resident);
		expect(residentJson.length).toBeLessThan(50_000);
		expect(residentJson).not.toContain(unknown);
		expect(residentJson).not.toContain(long("diagnostic-stack"));
		expect(residentJson).not.toContain(long("tool-details"));
		const extensionRoleEntry = resident.find((entry) => entry.id === extensionRoleId);
		expect(extensionRoleEntry).toMatchObject({
			type: "message",
			message: {
				role: "extension_merged_role",
				content: expect.stringContaining("[Compacted history stored on disk]"),
				timestamp: expect.any(Number),
			},
		});
		expect(JSON.stringify(extensionRoleEntry)).not.toContain(long("extension-content"));
		expect(JSON.stringify(extensionRoleEntry)).not.toContain(long("extension-metadata"));
		if (extensionRoleEntry?.type !== "message") throw new Error("missing extension role entry");
		const extensionKeys = Object.keys(extensionRoleEntry.message);
		expect(Math.max(...extensionKeys.map((key) => key.length))).toBeLessThanOrEqual(256);
		expect(extensionKeys).not.toContain(oversizedFieldName);
		expect(extensionKeys.some((key) => oversizedFieldName.startsWith(key) && key !== "extensionMarker")).toBe(false);
		expect(extensionRoleEntry.message).toMatchObject({ extensionMarker: true });
		const bashEntry = resident.find((entry) => entry.id === bashId);
		expect(bashEntry).toMatchObject({
			type: "message",
			message: { role: "bashExecution", exitCode: 7, cancelled: false, truncated: true },
		});
		if (bashEntry?.type !== "message" || bashEntry.message.role !== "bashExecution") {
			throw new Error("missing compacted bash message");
		}
		expect(bashEntry.message.command).toContain("[Compacted history stored on disk]");
		expect(bashEntry.message.command).not.toBe(bashCommand);
		expect(Object.keys(bashEntry.message).sort()).toEqual(
			[
				"cancelled",
				"command",
				"exitCode",
				"excludeFromContext",
				"fullOutputPath",
				"output",
				"role",
				"timestamp",
				"truncated",
			].sort(),
		);
	});
});
