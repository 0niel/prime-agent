import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import { listCatalogFamilySessions, listSavedSessionSiblings, resolveCatalogSessionMatch } from "../src/modes/daemon/daemon-catalog-process.js";

function session(id: string, name: string | undefined, path: string): SessionInfo {
	return {
		id,
		name,
		path,
		cwd: "/tmp/project",
		rlmDepth: 0,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

describe("daemon catalog selector resolution", () => {
	it("reads only a saved child's persisted sibling set", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		const first = SessionManager.create(root, join(root, "first"));
		first.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const second = SessionManager.create(root, join(root, "second"));
		second.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: "first", sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: "second", sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("resolves relative parent headers from each child session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-relative-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		const parentFile = parent.getSessionFile()!;
		const firstDir = join(root, "first");
		const first = SessionManager.create(root, firstDir);
		first.newSession({ parentSession: relative(firstDir, parentFile), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const secondDir = join(root, "second");
		const second = SessionManager.create(root, secondDir);
		second.newSession({ parentSession: relative(secondDir, parentFile), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: "first", sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: "second", sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("walks artifact family topology without accepting invalid rows or collapsing conflicting durable identities", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-family-topology-"));
		const sessionDir = join(root, "sessions");
		const registryPath = (parentId: string) =>
			join(root, "session-artifacts", parentId, "rlm-subagents.jsonl");
		const writeRegistry = (parentId: string, entries: unknown[]) => {
			const path = registryPath(parentId);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"));
		};
		const rootSession = SessionManager.create(root, sessionDir);
		rootSession.newSession({ id: "root" });
		rootSession.appendSessionInfo("root");
		const parent = SessionManager.create(root, join(root, "parent"));
		parent.newSession({ id: "parent", parentSession: rootSession.getSessionFile(), rlmDepth: 1 });
		parent.appendSessionInfo("parent");
		const child = SessionManager.create(root, join(root, "child"));
		child.newSession({ id: "child", parentSession: parent.getSessionFile(), rlmDepth: 2 });
		child.appendSessionInfo("child");
		const duplicate = SessionManager.create(root, join(root, "duplicate"));
		duplicate.newSession({ id: "child", parentSession: parent.getSessionFile(), rlmDepth: 2 });
		duplicate.appendSessionInfo("duplicate");
		const deleted = SessionManager.create(root, join(root, "deleted"));
		deleted.newSession({ id: "deleted", parentSession: rootSession.getSessionFile(), rlmDepth: 1 });
		deleted.appendSessionInfo("deleted");
		const unreadable = join(root, "unreadable.jsonl");
		mkdirSync(unreadable, { recursive: true });

		writeRegistry(rootSession.getSessionId(), [
			{ type: "rlm_subagent", childId: "parent", sessionFile: parent.getSessionFile(), status: "completed" },
			{ type: "rlm_subagent", childId: "deleted", sessionFile: deleted.getSessionFile(), status: "deleted" },
			{ type: "rlm_subagent", childId: "unreadable", sessionFile: unreadable, status: "completed" },
			{ type: "rlm_subagent", childId: "malformed", status: "completed" },
			"{not json",
		]);
		writeRegistry(parent.getSessionId(), [
			{ type: "rlm_subagent", childId: "child", sessionFile: child.getSessionFile(), status: "completed" },
			{ type: "rlm_subagent", childId: "duplicate", sessionFile: duplicate.getSessionFile(), status: "completed" },
		]);

		const family = await listCatalogFamilySessions(sessionDir);
		expect(family).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "root", rlmDepth: 0 }),
				expect.objectContaining({ id: "parent", rlmDepth: 1 }),
				expect.objectContaining({ id: "child", name: "child", rlmDepth: 2, path: child.getSessionFile() }),
				expect.objectContaining({ id: "child", name: "duplicate", rlmDepth: 2, path: duplicate.getSessionFile() }),
			]),
		);
		expect(family).toHaveLength(4);
		expect(family.map((entry) => entry.path)).not.toContain(deleted.getSessionFile());
		expect(family.map((entry) => entry.path)).not.toContain(unreadable);
		expect(family.filter((entry) => entry.id === "child")).toHaveLength(2);
	});

	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});
});
