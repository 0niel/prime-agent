import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import { listCatalogFamilySessions, listSavedSessionSiblings, resolveCatalogSessionMatch, setCatalogBeforeTrustedOpenForTest } from "../src/modes/daemon/daemon-catalog-process.js";

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
		parent.newSession({ rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const first = SessionManager.create(root, join(root, "session-artifacts", parent.getSessionId(), "sub-first"));
		first.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const second = SessionManager.create(root, join(root, "session-artifacts", parent.getSessionId(), "sub-second"));
		second.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: first.getSessionId(), sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: second.getSessionId(), sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!, sessionDir)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("resolves relative parent headers from each child session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-relative-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const parentFile = parent.getSessionFile()!;
		const firstDir = join(root, "session-artifacts", parent.getSessionId(), "sub-first");
		const first = SessionManager.create(root, firstDir);
		first.newSession({ parentSession: relative(firstDir, parentFile), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const secondDir = join(root, "session-artifacts", parent.getSessionId(), "sub-second");
		const second = SessionManager.create(root, secondDir);
		second.newSession({ parentSession: relative(secondDir, parentFile), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: first.getSessionId(), sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: second.getSessionId(), sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!, sessionDir)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("walks a trusted depth-two artifact family and fails closed for hostile artifacts", async () => {
		const makeFixture = (name: string, omitRootDepth = false) => {
			const root = mkdtempSync(join(tmpdir(), name));
			const sessionDir = join(root, "sessions");
			const registryPath = (parentId: string) => {
				const parentFile = [rootSession, parent, first, second].find((manager) => manager.getSessionId() === parentId)?.getSessionFile();
				return parentFile && dirname(parentFile) !== sessionDir
					? join(dirname(parentFile), "session-artifacts", parentId, "rlm-subagents.jsonl")
					: join(root, "session-artifacts", parentId, "rlm-subagents.jsonl");
			};
			const writeRegistry = (parentId: string, entries: unknown[]) => {
				const path = registryPath(parentId);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"));
			};
			const create = (id: string, dir: string, parentSession?: string, depth = 0) => {
				const manager = SessionManager.create(root, dir);
				manager.newSession({ id, parentSession, rlmDepth: depth });
				manager.appendSessionInfo(id);
				return manager;
			};
			const rootSession = create("root", sessionDir);
			if (omitRootDepth) {
				const rootFile = rootSession.getSessionFile()!;
				const [header, ...entries] = readFileSync(rootFile, "utf8").trimEnd().split(/\r?\n/);
				const persistedHeader = JSON.parse(header!) as Record<string, unknown>;
				delete persistedHeader.rlmDepth;
				writeFileSync(rootFile, [JSON.stringify(persistedHeader), ...entries].join("\n") + "\n");
			}
			const parent = create("parent", join(root, "session-artifacts", "root", "sub-parent"), rootSession.getSessionFile(), 1);
			const first = create("first", join(root, "session-artifacts", "parent", "sub-first"), parent.getSessionFile(), 2);
			const second = create("second", join(root, "session-artifacts", "parent", "sub-second"), parent.getSessionFile(), 2);
			writeRegistry("root", [
				{ type: "rlm_subagent", childId: "parent", sessionFile: parent.getSessionFile(), status: "completed" },
			]);
			writeRegistry("parent", [
				{ type: "rlm_subagent", childId: "first", sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: "second", sessionFile: second.getSessionFile(), status: "completed" },
			]);
			return { root, sessionDir, rootSession, parent, first, second, registryPath, writeRegistry };
		};
		const valid = makeFixture("prime-catalog-family-valid-", true);
		await expect(listCatalogFamilySessions(valid.sessionDir)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "root", rlmDepth: 0 }),
				expect.objectContaining({ id: "parent", rlmDepth: 1 }),
				expect.objectContaining({ id: "first", rlmDepth: 2 }),
				expect.objectContaining({ id: "second", rlmDepth: 2 }),
			]),
		);
		await expect(listSavedSessionSiblings(valid.first.getSessionFile()!, valid.sessionDir)).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "first" }), expect.objectContaining({ id: "second" })]),
		);

		const cases: Array<[string, (fixture: ReturnType<typeof makeFixture>) => void]> = [
			["id mismatch", (fixture) => fixture.writeRegistry("parent", [{ type: "rlm_subagent", childId: "wrong", sessionFile: fixture.first.getSessionFile(), status: "completed" }])],
			["parent mismatch", (fixture) => {
				const evil = SessionManager.create(fixture.root, join(fixture.root, "session-artifacts", "parent", "sub-evil"));
				evil.newSession({ id: "evil", parentSession: fixture.rootSession.getSessionFile(), rlmDepth: 2 });
				evil.appendSessionInfo("evil");
				fixture.writeRegistry("parent", [{ type: "rlm_subagent", childId: "evil", sessionFile: evil.getSessionFile(), status: "completed" }]);
			}],
			["depth mismatch", (fixture) => {
				const evil = SessionManager.create(fixture.root, join(fixture.root, "session-artifacts", "parent", "sub-evil"));
				evil.newSession({ id: "evil", parentSession: fixture.parent.getSessionFile(), rlmDepth: 7 });
				evil.appendSessionInfo("evil");
				fixture.writeRegistry("parent", [{ type: "rlm_subagent", childId: "evil", sessionFile: evil.getSessionFile(), status: "completed" }]);
			}],
			["external path", (fixture) => fixture.writeRegistry("parent", [{ type: "rlm_subagent", childId: "evil", sessionFile: join(tmpdir(), "outside.jsonl"), status: "completed" }])],
			["path alias", (fixture) => fixture.writeRegistry("parent", [{ type: "rlm_subagent", childId: "first", sessionFile: `${dirname(fixture.first.getSessionFile()!)}/../sub-first/first.jsonl`, status: "completed" }])],
			["cycle", (fixture) => fixture.writeRegistry("parent", [{ type: "rlm_subagent", childId: "root", sessionFile: fixture.rootSession.getSessionFile(), status: "completed" }])],
			["malformed", (fixture) => fixture.writeRegistry("parent", ["{not json"])] ,
			["record limit", (fixture) => fixture.writeRegistry("parent", Array.from({ length: 10_001 }, (_, index) => ({ type: "rlm_subagent", childId: `bad-${index}`, sessionFile: fixture.first.getSessionFile(), status: "completed" })))],
		];
		for (const [label, mutate] of cases) {
			const fixture = makeFixture(`prime-catalog-family-${label.replace(/\s/g, "-")}-`);
			mutate(fixture);
			await expect(listCatalogFamilySessions(fixture.sessionDir), label).rejects.toThrow("Invalid RLM artifact family topology");
		}
		const symlink = makeFixture("prime-catalog-family-symlink-");
		const alias = join(symlink.root, "session-artifacts", "parent", "sub-alias", "first.jsonl");
		mkdirSync(dirname(alias), { recursive: true });
		symlinkSync(symlink.first.getSessionFile()!, alias);
		symlink.writeRegistry("parent", [{ type: "rlm_subagent", childId: "first", sessionFile: alias, status: "completed" }]);
		await expect(listCatalogFamilySessions(symlink.sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
	});


	it("rejects symlinked roots and deterministic intermediate/final replacement races", async () => {
		const make = (name: string) => {
			const root = mkdtempSync(join(tmpdir(), name));
			const sessionDir = join(root, "sessions");
			const parent = SessionManager.create(root, sessionDir);
			parent.newSession({ id: "parent", rlmDepth: 0 });
			parent.appendSessionInfo("parent");
			const childDir = join(root, "session-artifacts", "parent", "sub-child");
			const child = SessionManager.create(root, childDir);
			child.newSession({ id: "child", parentSession: parent.getSessionFile(), rlmDepth: 1 });
			child.appendSessionInfo("child");
			const registry = join(root, "session-artifacts", "parent", "rlm-subagents.jsonl");
			mkdirSync(dirname(registry), { recursive: true });
			writeFileSync(registry, JSON.stringify({ type: "rlm_subagent", childId: "child", sessionFile: child.getSessionFile(), status: "completed" }));
			return { root, sessionDir, parent, child, childDir, registry };
		};

		const rootLink = make("prime-catalog-root-link-");
		const movedSessions = `${rootLink.sessionDir}-real`;
		renameSync(rootLink.sessionDir, movedSessions);
		symlinkSync(movedSessions, rootLink.sessionDir);
		await expect(listCatalogFamilySessions(rootLink.sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");

		const intermediate = make("prime-catalog-intermediate-swap-");
		let swappedIntermediate = false;
		setCatalogBeforeTrustedOpenForTest((path) => {
			if (swappedIntermediate || path !== intermediate.child.getSessionFile()) return;
			swappedIntermediate = true;
			const moved = `${intermediate.childDir}-real`;
			renameSync(intermediate.childDir, moved);
			symlinkSync(moved, intermediate.childDir);
		});
		await expect(listCatalogFamilySessions(intermediate.sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");

		const finalSwap = make("prime-catalog-final-swap-");
		let swappedFinal = false;
		setCatalogBeforeTrustedOpenForTest((path) => {
			if (swappedFinal || path !== finalSwap.child.getSessionFile()) return;
			swappedFinal = true;
			const moved = `${path}.real`;
			renameSync(path, moved);
			symlinkSync(moved, path);
		});
		await expect(listCatalogFamilySessions(finalSwap.sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		setCatalogBeforeTrustedOpenForTest(undefined);
	});

	it("parses session metadata from the same descriptor-bound bytes without a pathname reopen", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-no-reopen-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("bound-name");
		let removed = false;
		setCatalogBeforeTrustedOpenForTest((path) => {
			if (removed || path !== parent.getSessionFile()) return;
			removed = true;
			const original = `${path}.opened`;
			renameSync(path, original);
			writeFileSync(path, "not a session\n");
		});
		// The helper opens after the hook, so it must reject the replacement instead of
		// authorizing stale bytes. This pins the absence of a later readSessionInfo reopen.
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		setCatalogBeforeTrustedOpenForTest(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});
});
