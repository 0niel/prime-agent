import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
	getCatalogHelperSpawnCountForTest,
	getOpenCatalogAuthorityFdCountForTest,
	listCatalogFamilySessions,
	listCatalogFamilySessionsWithLimitForTest,
	listSavedSessionSiblings,
	resolveCatalogSessionMatch,
	setCatalogAfterHelperResponseForTest,
	setCatalogAfterTrustedHeaderForTest,
	setCatalogBeforeTrustedOpenForTest,
	setCatalogHelperLaunchForTest,
} from "../src/modes/daemon/daemon-catalog-process.js";

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

function createCatalogFamilyFixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-catalog-default-session-dir-"));
	const sessionDir = join(root, "sessions");
	const parent = SessionManager.create(root, sessionDir);
	parent.newSession({ rlmDepth: 0 });
	parent.appendSessionInfo("parent");
	const first = SessionManager.create(root, join(root, "session-artifacts", parent.getSessionId(), "sub-11111111"));
	first.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
	first.appendSessionInfo("first");
	const second = SessionManager.create(root, join(root, "session-artifacts", parent.getSessionId(), "sub-22222222"));
	second.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
	second.appendSessionInfo("second");
	const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
	mkdirSync(dirname(registry), { recursive: true });
	// Registries key children by rlm child id ("sub-*"), never by session id.
	writeFileSync(
		registry,
		[
			{
				type: "rlm_subagent",
				childId: "sub-11111111",
				sessionFile: first.getSessionFile(),
				status: "completed",
			},
			{
				type: "rlm_subagent",
				childId: "sub-22222222",
				sessionFile: second.getSessionFile(),
				status: "completed",
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	return { root, sessionDir, parent, first, second };
}

async function withDefaultSessionDir<T>(sessionDir: string, callback: () => Promise<T>): Promise<T> {
	const previousSessionDir = process.env.PRIME_AGENT_SESSION_DIR;
	process.env.PRIME_AGENT_SESSION_DIR = sessionDir;
	try {
		return await callback();
	} finally {
		if (previousSessionDir === undefined) delete process.env.PRIME_AGENT_SESSION_DIR;
		else process.env.PRIME_AGENT_SESSION_DIR = previousSessionDir;
	}
}

describe("daemon catalog selector resolution", () => {
	it("reads only a saved child's persisted sibling set", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const first = SessionManager.create(root, join(root, "session-artifacts", parent.getSessionId(), "sub-11111111"));
		first.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		first.appendSessionInfo("first");
		first.appendSessionState({ status: "archived" });
		const second = SessionManager.create(
			root,
			join(root, "session-artifacts", parent.getSessionId(), "sub-22222222"),
		);
		second.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		second.appendSessionInfo("second");
		second.appendSessionState({ status: "active" });
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		// Reader compatibility for v2 headers does not relax registry provenance:
		// childId remains the writer's direct sub-* directory name.
		for (const child of [first, second]) {
			const file = child.getSessionFile()!;
			const [header, ...entries] = readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
			writeFileSync(file, `${JSON.stringify({ ...JSON.parse(header!), version: 2 })}\n${entries.join("\n")}\n`);
		}
		writeFileSync(
			registry,
			[
				{
					type: "rlm_subagent",
					childId: "sub-11111111",
					sessionFile: first.getSessionFile(),
					status: "completed",
				},
				{
					type: "rlm_subagent",
					childId: "sub-22222222",
					sessionFile: second.getSessionFile(),
					status: "completed",
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!, sessionDir)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first", state: { status: "archived" } }),
			expect.objectContaining({ id: second.getSessionId(), name: "second", state: { status: "active" } }),
		]);
	});

	it("uses the configured default session directory for family catalogs", async () => {
		const { root, sessionDir, parent, first, second } = createCatalogFamilyFixture();
		try {
			await withDefaultSessionDir(sessionDir, async () => {
				await expect(listCatalogFamilySessions()).resolves.toEqual(
					expect.arrayContaining([
						expect.objectContaining({ id: parent.getSessionId(), name: "parent" }),
						expect.objectContaining({ id: first.getSessionId(), name: "first" }),
						expect.objectContaining({ id: second.getSessionId(), name: "second" }),
					]),
				);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
	});

	it("uses the configured default session directory for saved siblings", async () => {
		const { root, sessionDir, first, second } = createCatalogFamilyFixture();
		try {
			await withDefaultSessionDir(sessionDir, async () => {
				await expect(listSavedSessionSiblings(first.getSessionFile()!)).resolves.toEqual([
					expect.objectContaining({ id: first.getSessionId() }),
					expect.objectContaining({ id: second.getSessionId() }),
				]);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
	});

	it("resolves relative parent headers from each child session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-relative-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const parentFile = parent.getSessionFile()!;
		const firstDir = join(root, "session-artifacts", parent.getSessionId(), "sub-11111111");
		const first = SessionManager.create(root, firstDir);
		first.newSession({ parentSession: relative(firstDir, parentFile), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const secondDir = join(root, "session-artifacts", parent.getSessionId(), "sub-22222222");
		const second = SessionManager.create(root, secondDir);
		second.newSession({ parentSession: relative(secondDir, parentFile), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{
					type: "rlm_subagent",
					childId: "sub-11111111",
					sessionFile: first.getSessionFile(),
					status: "completed",
				},
				{
					type: "rlm_subagent",
					childId: "sub-22222222",
					sessionFile: second.getSessionFile(),
					status: "completed",
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!, sessionDir)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId() }),
			expect.objectContaining({ id: second.getSessionId() }),
		]);
	});

	it("treats an absent session-artifacts directory as an empty family registry", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-no-artifacts-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");

		await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([
			expect.objectContaining({ id: "parent", rlmDepth: 0 }),
		]);
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
	});

	it("walks a trusted depth-two artifact family and fails closed for hostile artifacts", async () => {
		const makeFixture = (name: string, omitRootDepth = false) => {
			const root = mkdtempSync(join(tmpdir(), name));
			const sessionDir = join(root, "sessions");
			// The writer keeps a session's child registry beside its session dir:
			// <dirname(sessionDir)>/session-artifacts/<session id>.
			const registryPath = (parentId: string) => {
				const parentFile = [rootSession, parent, first, second]
					.find((manager) => manager.getSessionId() === parentId)
					?.getSessionFile();
				return parentFile
					? join(dirname(dirname(parentFile)), "session-artifacts", parentId, "rlm-subagents.jsonl")
					: join(root, "session-artifacts", parentId, "rlm-subagents.jsonl");
			};
			const writeRegistry = (parentId: string, entries: unknown[]) => {
				const path = registryPath(parentId);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(
					path,
					entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"),
				);
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
				writeFileSync(rootFile, `${[JSON.stringify(persistedHeader), ...entries].join("\n")}\n`);
			}
			const parent = create(
				"parent",
				join(root, "session-artifacts", "root", "sub-33333333"),
				rootSession.getSessionFile(),
				1,
			);
			const first = create(
				"first",
				join(root, "session-artifacts", "root", "sub-33333333", "sub-11111111"),
				parent.getSessionFile(),
				2,
			);
			const second = create(
				"second",
				join(root, "session-artifacts", "root", "sub-33333333", "sub-22222222"),
				parent.getSessionFile(),
				2,
			);
			writeRegistry("root", [
				{
					type: "rlm_subagent",
					childId: "sub-33333333",
					sessionFile: parent.getSessionFile(),
					status: "completed",
				},
			]);
			writeRegistry("parent", [
				{ type: "rlm_subagent", childId: "sub-11111111", sessionFile: first.getSessionFile(), status: "completed" },
				{
					type: "rlm_subagent",
					childId: "sub-22222222",
					sessionFile: second.getSessionFile(),
					status: "completed",
				},
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
			[
				"basename mismatch",
				(fixture) => {
					// A session file whose name does not match its header id is not a
					// writer-produced child and must not be authorized.
					const alias = join(dirname(fixture.first.getSessionFile()!), "impostor.jsonl");
					writeFileSync(alias, readFileSync(fixture.first.getSessionFile()!));
					fixture.writeRegistry("parent", [
						{ type: "rlm_subagent", childId: "sub-11111111", sessionFile: alias, status: "completed" },
					]);
				},
			],
			[
				"parent mismatch",
				(fixture) => {
					const evil = SessionManager.create(
						fixture.root,
						join(fixture.root, "session-artifacts", "parent", "sub-66666666"),
					);
					evil.newSession({ id: "evil", parentSession: fixture.rootSession.getSessionFile(), rlmDepth: 2 });
					evil.appendSessionInfo("evil");
					fixture.writeRegistry("parent", [
						{
							type: "rlm_subagent",
							childId: "sub-66666666",
							sessionFile: evil.getSessionFile(),
							status: "completed",
						},
					]);
				},
			],
			[
				"depth mismatch",
				(fixture) => {
					const evil = SessionManager.create(
						fixture.root,
						join(fixture.root, "session-artifacts", "parent", "sub-66666666"),
					);
					evil.newSession({ id: "evil", parentSession: fixture.parent.getSessionFile(), rlmDepth: 7 });
					evil.appendSessionInfo("evil");
					fixture.writeRegistry("parent", [
						{
							type: "rlm_subagent",
							childId: "sub-66666666",
							sessionFile: evil.getSessionFile(),
							status: "completed",
						},
					]);
				},
			],
			[
				"external path",
				(fixture) =>
					fixture.writeRegistry("parent", [
						{
							type: "rlm_subagent",
							childId: "sub-66666666",
							sessionFile: join(tmpdir(), "outside.jsonl"),
							status: "completed",
						},
					]),
			],
			[
				"path alias",
				(fixture) =>
					fixture.writeRegistry("parent", [
						{
							type: "rlm_subagent",
							childId: "sub-11111111",
							sessionFile: `${dirname(fixture.first.getSessionFile()!)}/../sub-11111111/first.jsonl`,
							status: "completed",
						},
					]),
			],
			[
				"cycle",
				(fixture) =>
					fixture.writeRegistry("parent", [
						{
							type: "rlm_subagent",
							childId: "sub-33333333",
							sessionFile: fixture.rootSession.getSessionFile(),
							status: "completed",
						},
					]),
			],
			["malformed", (fixture) => fixture.writeRegistry("parent", ["{not json"])],
			[
				"malformed child id",
				(fixture) =>
					fixture.writeRegistry("parent", [
						{
							type: "rlm_subagent",
							childId: "sub-ABCDEF12",
							sessionFile: fixture.first.getSessionFile(),
							status: "completed",
						},
					]),
			],
			[
				"record limit",
				(fixture) =>
					fixture.writeRegistry(
						"parent",
						Array.from({ length: 10_001 }, (_, index) => ({
							type: "rlm_subagent",
							childId: `sub-${index.toString(16).padStart(8, "0")}`,
							sessionFile: fixture.first.getSessionFile(),
							status: "completed",
						})),
					),
			],
		];
		for (const [label, mutate] of cases) {
			const fixture = makeFixture(`prime-catalog-family-${label.replace(/\s/g, "-")}-`);
			mutate(fixture);
			await expect(listCatalogFamilySessions(fixture.sessionDir), label).rejects.toThrow(
				"Invalid RLM artifact family topology",
			);
		}
		const symlink = makeFixture("prime-catalog-family-symlink-");
		const alias = join(symlink.root, "session-artifacts", "parent", "sub-77777777", "first.jsonl");
		mkdirSync(dirname(alias), { recursive: true });
		symlinkSync(symlink.first.getSessionFile()!, alias);
		symlink.writeRegistry("parent", [
			{ type: "rlm_subagent", childId: "sub-11111111", sessionFile: alias, status: "completed" },
		]);
		await expect(listCatalogFamilySessions(symlink.sessionDir)).rejects.toThrow(
			"Invalid RLM artifact family topology",
		);
	});

	it("rejects symlinked roots and deterministic intermediate/final replacement races", async () => {
		const make = (name: string) => {
			const root = mkdtempSync(join(tmpdir(), name));
			const sessionDir = join(root, "sessions");
			const parent = SessionManager.create(root, sessionDir);
			parent.newSession({ id: "parent", rlmDepth: 0 });
			parent.appendSessionInfo("parent");
			const childDir = join(root, "session-artifacts", "parent", "sub-44444444");
			const child = SessionManager.create(root, childDir);
			child.newSession({ id: "child", parentSession: parent.getSessionFile(), rlmDepth: 1 });
			child.appendSessionInfo("child");
			const registry = join(root, "session-artifacts", "parent", "rlm-subagents.jsonl");
			mkdirSync(dirname(registry), { recursive: true });
			writeFileSync(
				registry,
				JSON.stringify({
					type: "rlm_subagent",
					childId: "sub-44444444",
					sessionFile: child.getSessionFile(),
					status: "completed",
				}),
			);
			return { root, sessionDir, parent, child, childDir, registry };
		};

		const rootLink = make("prime-catalog-root-link-");
		const movedSessions = `${rootLink.sessionDir}-real`;
		renameSync(rootLink.sessionDir, movedSessions);
		symlinkSync(movedSessions, rootLink.sessionDir);
		await expect(listCatalogFamilySessions(rootLink.sessionDir)).rejects.toThrow(
			"Invalid RLM artifact family topology",
		);

		const intermediate = make("prime-catalog-intermediate-swap-");
		let swappedIntermediate = false;
		setCatalogBeforeTrustedOpenForTest((path) => {
			if (swappedIntermediate || path !== intermediate.child.getSessionFile()) return;
			swappedIntermediate = true;
			const moved = `${intermediate.childDir}-real`;
			renameSync(intermediate.childDir, moved);
			symlinkSync(moved, intermediate.childDir);
		});
		await expect(listCatalogFamilySessions(intermediate.sessionDir)).rejects.toThrow(
			"Invalid RLM artifact family topology",
		);

		const finalSwap = make("prime-catalog-final-swap-");
		let swappedFinal = false;
		setCatalogBeforeTrustedOpenForTest((path) => {
			if (swappedFinal || path !== finalSwap.child.getSessionFile()) return;
			swappedFinal = true;
			const moved = `${path}.real`;
			renameSync(path, moved);
			symlinkSync(moved, path);
		});
		await expect(listCatalogFamilySessions(finalSwap.sessionDir)).rejects.toThrow(
			"Invalid RLM artifact family topology",
		);
		setCatalogBeforeTrustedOpenForTest(undefined);
	});

	it("rejects a session replaced between listing and the descriptor-bound header read", async () => {
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
		// Topology claims come from the descriptor-bound header read, which opens
		// after the hook and must reject the replacement instead of authorizing
		// the stale listing.
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		setCatalogBeforeTrustedOpenForTest(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	it("closes authority descriptors after repeated hostile seed failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-fd-release-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const hostile = SessionManager.create(root, sessionDir);
		hostile.newSession({ id: "hostile", parentSession: join(root, "outside.jsonl"), rlmDepth: 1 });
		hostile.appendSessionInfo("hostile");
		const baseline = getOpenCatalogAuthorityFdCountForTest();
		for (let attempt = 0; attempt < 64; attempt++) {
			await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
			expect(getOpenCatalogAuthorityFdCountForTest()).toBe(baseline);
		}
	});

	it("treats forked flat-dir sessions as family roots for both fork header shapes", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-fork-roots-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		// Current fork writer: parentSession plus a copied numeric rlmDepth.
		const forkWithDepth = SessionManager.create(root, sessionDir);
		forkWithDepth.newSession({ id: "fork-depth", parentSession: parent.getSessionFile(), rlmDepth: 1 });
		forkWithDepth.appendSessionInfo("fork-depth");
		// Older fork writer: parentSession with no rlmDepth claim at all.
		const forkNoDepth = SessionManager.create(root, sessionDir);
		forkNoDepth.newSession({ id: "fork-nodepth", parentSession: parent.getSessionFile(), rlmDepth: 1 });
		forkNoDepth.appendSessionInfo("fork-nodepth");
		const forkNoDepthFile = forkNoDepth.getSessionFile()!;
		const [headerLine, ...rest] = readFileSync(forkNoDepthFile, "utf8").trimEnd().split(/\r?\n/);
		const header = JSON.parse(headerLine!) as Record<string, unknown>;
		delete header.rlmDepth;
		writeFileSync(forkNoDepthFile, `${[JSON.stringify(header), ...rest].join("\n")}\n`);

		const family = await listCatalogFamilySessions(sessionDir);
		expect(family).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "parent", rlmDepth: 0 }),
				expect.objectContaining({ id: "fork-depth", rlmDepth: 0 }),
				expect.objectContaining({ id: "fork-nodepth", rlmDepth: 0 }),
			]),
		);
		// Fork lineage is not rlm topology: it must not surface as a parent claim.
		for (const info of family) expect(info.parentSessionPath).toBeUndefined();
		// A fork root is its own sibling set, not a sibling of the source's rlm children.
		await expect(listSavedSessionSiblings(forkWithDepth.getSessionFile()!, sessionDir)).resolves.toEqual([
			expect.objectContaining({ id: "fork-depth" }),
		]);
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps strict topology invariants for registry-reached children", async () => {
		const make = (mutateHeader: (header: Record<string, unknown>) => void) => {
			const root = mkdtempSync(join(tmpdir(), "prime-catalog-strict-child-"));
			const sessionDir = join(root, "sessions");
			const parent = SessionManager.create(root, sessionDir);
			parent.newSession({ id: "parent", rlmDepth: 0 });
			parent.appendSessionInfo("parent");
			const child = SessionManager.create(root, join(root, "session-artifacts", "parent", "sub-44444444"));
			child.newSession({ id: "child", parentSession: parent.getSessionFile(), rlmDepth: 1 });
			child.appendSessionInfo("child");
			const childFile = child.getSessionFile()!;
			const [headerLine, ...rest] = readFileSync(childFile, "utf8").trimEnd().split(/\r?\n/);
			const header = JSON.parse(headerLine!) as Record<string, unknown>;
			mutateHeader(header);
			writeFileSync(childFile, `${[JSON.stringify(header), ...rest].join("\n")}\n`);
			const registry = join(root, "session-artifacts", "parent", "rlm-subagents.jsonl");
			mkdirSync(dirname(registry), { recursive: true });
			writeFileSync(
				registry,
				JSON.stringify({
					type: "rlm_subagent",
					childId: "sub-44444444",
					sessionFile: childFile,
					status: "completed",
				}),
			);
			return sessionDir;
		};
		// Old writers omitted child rlmDepth entirely: the edge supplies it.
		await expect(
			listCatalogFamilySessions(
				make((header) => {
					delete header.rlmDepth;
				}),
			),
		).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "child", rlmDepth: 1 })]));
		// A present-but-contradicting depth claim is still corruption.
		await expect(
			listCatalogFamilySessions(
				make((header) => {
					header.rlmDepth = 7;
				}),
			),
		).rejects.toThrow("child depth does not equal parent depth plus one");
		await expect(
			listCatalogFamilySessions(
				make((header) => {
					delete header.parentSession;
				}),
			),
		).rejects.toThrow("child lacks a persisted parent path");
		// Registry-reached children never use the root-only classifier: a large
		// apparent session header is strictly rejected rather than skipped.
		await expect(
			listCatalogFamilySessions(
				make((header) => {
					header.padding = "x".repeat(200 * 1024);
				}),
			),
		).rejects.toThrow("Invalid RLM artifact family topology");
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
	});

	it("rejects an unregistered parent-claiming seed and conflicting duplicate identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-orphan-seed-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const orphan = SessionManager.create(root, sessionDir);
		orphan.newSession({ id: "evil", parentSession: join(root, "outside.jsonl"), rlmDepth: 1 });
		orphan.appendSessionInfo("evil");
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("managed session seed claims a parent");

		const duplicateRoot = mkdtempSync(join(tmpdir(), "prime-catalog-duplicate-id-"));
		const duplicateDir = join(duplicateRoot, "sessions");
		const duplicate = SessionManager.create(duplicateRoot, duplicateDir);
		duplicate.newSession({ id: "duplicate", rlmDepth: 0 });
		duplicate.appendSessionInfo("one");
		writeFileSync(join(duplicateDir, "alias.jsonl"), readFileSync(duplicate.getSessionFile()!));
		await expect(listCatalogFamilySessions(duplicateDir)).rejects.toThrow("duplicate session id");
	});

	it("releases the session authority descriptor when the artifacts root open fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-artifacts-open-fail-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		// A symlinked artifacts root fails the O_NOFOLLOW open with a non-ENOENT error.
		const realArtifacts = join(root, "session-artifacts-real");
		mkdirSync(realArtifacts);
		symlinkSync(realArtifacts, join(root, "session-artifacts"));
		const baseline = getOpenCatalogAuthorityFdCountForTest();
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(baseline);
	});

	it("returns descriptor-bound metadata after a multi-megabyte entry without reopening the pathname", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-compact-metadata-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("initial name");
		const file = parent.getSessionFile()!;
		appendFileSync(
			file,
			`${[
				JSON.stringify({
					type: "message",
					id: "first-message",
					parentId: null,
					timestamp: "2026-01-02T03:04:05.000Z",
					message: {
						role: "user",
						content: "first searchable prompt",
						timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
					},
				}),
				JSON.stringify({ type: "custom_message", body: "x".repeat(3 * 1024 * 1024) }),
				JSON.stringify({ type: "session_info", name: "trailing name" }),
				JSON.stringify({ type: "session_state", state: { status: "archived" } }),
				JSON.stringify({
					type: "agent_status",
					status: { summary: "trailing recap", taskState: "completed", basedOnMessageCount: 1 },
				}),
			].join("\n")}\n`,
		);
		const [info] = await listCatalogFamilySessions(sessionDir);
		expect(info).toMatchObject({
			id: "parent",
			name: "trailing name",
			state: { status: "archived" },
			messageCount: 1,
			firstMessage: "first searchable prompt",
			allMessagesText: "first searchable prompt",
			agentStatus: { summary: "trailing recap", taskState: "completed", basedOnMessageCount: 1 },
		});
		expect(info?.modified.toISOString()).toBe("2026-01-02T03:04:05.000Z");
		rmSync(root, { recursive: true, force: true });
	});

	it("caps exact escaped metadata envelopes without changing request ids", async () => {
		// Keep each JSONL record below the parser's 1 MiB record bound while its
		// combined escaped metadata response still greatly exceeds 256 KiB.
		const payloads = [
			"a".repeat(500_000),
			"漢".repeat(100_000),
			"😀".repeat(75_000),
			'"\\\b\f\n\r\t\u0000'.repeat(25_000),
		];
		for (const [index, payload] of payloads.entries()) {
			const responses: Array<{ id: string; line: string }> = [];
			setCatalogAfterHelperResponseForTest((mode, id, line) => {
				if (mode === "metadata") responses.push({ id, line });
			});
			const root = mkdtempSync(join(tmpdir(), `prime-catalog-escaped-cap-${index}-`));
			const sessionDir = join(root, "sessions");
			const parent = SessionManager.create(root, sessionDir);
			parent.newSession({ id: `parent-${index}`, rlmDepth: 0 });
			parent.appendSessionInfo("compact");
			appendFileSync(
				parent.getSessionFile()!,
				`${[
					JSON.stringify({ type: "message", message: { role: "user", content: payload } }),
					JSON.stringify({ type: "session_info", name: payload }),
					JSON.stringify({ type: "session_state", state: { status: "archived" } }),
					JSON.stringify({
						type: "agent_status",
						status: { summary: payload, taskState: "completed", basedOnMessageCount: 1 },
					}),
				].join("\n")}\n`,
			);
			try {
				const family = await listCatalogFamilySessions(sessionDir);
				expect(family).toHaveLength(1);
				const [session] = family;
				expect(session).toEqual(
					expect.objectContaining({
						id: `parent-${index}`,
						firstMessage: expect.any(String),
						allMessagesText: expect.any(String),
						name: expect.any(String),
						agentStatus: expect.objectContaining({ summary: expect.any(String), basedOnMessageCount: 1 }),
					}),
				);
				expect(session?.state).toEqual({ status: "archived" });
				expect(session?.agentStatus?.taskState).toBe("completed");
				expect(responses).toHaveLength(1);
				const response = responses[0]!;
				const wire = JSON.parse(response.line) as {
					id: string;
					data: {
						valid: boolean;
						messageCount: number;
						state?: { status: string };
						agentStatus?: { taskState?: string };
					};
				};
				// Compaction may touch display strings only: the protocol UUID and
				// typed controls are byte-for-byte stable in the exact wire envelope.
				expect(wire.id).toBe(response.id);
				expect(wire.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
				expect(wire.data).toMatchObject({
					valid: true,
					messageCount: 1,
					state: { status: "archived" },
					agentStatus: { taskState: "completed" },
				});
				expect(Buffer.byteLength(response.line, "ascii")).toBeLessThanOrEqual(256 * 1024);
			} finally {
				setCatalogAfterHelperResponseForTest(undefined);
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
	it("retains only allowed typed agent task states", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-agent-status-schema-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		appendFileSync(
			parent.getSessionFile()!,
			`${[
				JSON.stringify({
					type: "agent_status",
					status: { summary: "valid", taskState: "completed", basedOnMessageCount: 1 },
				}),
			].join("\n")}\n`,
		);
		await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([
			expect.objectContaining({
				agentStatus: { summary: "valid", taskState: "completed", basedOnMessageCount: 1 },
			}),
		]);
		rmSync(root, { recursive: true, force: true });
	});

	it("skips junk root candidates but rejects identified malformed and duplicate roots", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-root-classification-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		writeFileSync(join(sessionDir, "blank.jsonl"), "\n");
		writeFileSync(join(sessionDir, "junk.jsonl"), "not json\n");
		writeFileSync(join(sessionDir, "event.jsonl"), '{"type":"message","id":"junk"}\n');
		writeFileSync(join(sessionDir, "session-no-id.jsonl"), '{"type":"session","cwd":"/tmp"}\n');
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("trustworthy topology claims");
		rmSync(join(sessionDir, "session-no-id.jsonl"));
		// An oversized root is skippable only when its bounded prefix is
		// demonstrably unrelated, including incomplete unrelated junk. A purported
		// session or identifier claim remains topology-relevant and fails closed.
		const classificationResponses: string[] = [];
		setCatalogAfterHelperResponseForTest((mode, _id, line) => {
			if (mode === "classify") classificationResponses.push(line);
		});
		writeFileSync(join(sessionDir, "oversized-junk.jsonl"), `not-json-${"x".repeat(200 * 1024)}`);
		await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([expect.objectContaining({ id: "parent" })]);
		expect(classificationResponses.every((line) => Buffer.byteLength(line, "ascii") <= 256 * 1024)).toBe(true);
		setCatalogAfterHelperResponseForTest(undefined);
		rmSync(join(sessionDir, "oversized-junk.jsonl"));
		writeFileSync(join(sessionDir, "oversized-event.jsonl"), `{"type":"message","body":"${"x".repeat(200 * 1024)}`);
		await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([expect.objectContaining({ id: "parent" })]);
		rmSync(join(sessionDir, "oversized-event.jsonl"));
		writeFileSync(
			join(sessionDir, "oversized-session.jsonl"),
			`{"type":"session","id":"claimed","padding":"${"x".repeat(200 * 1024)}`,
		);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(join(sessionDir, "oversized-session.jsonl"));
		writeFileSync(join(sessionDir, "oversized-id.jsonl"), `{"id":"claimed","padding":"${"x".repeat(200 * 1024)}`);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(join(sessionDir, "oversized-id.jsonl"));
		writeFileSync(join(sessionDir, "bad.jsonl"), '{"type":"session","id":"bad","rlmDepth":"oops"}\n');
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		rmSync(join(sessionDir, "bad.jsonl"));
		writeFileSync(join(sessionDir, "duplicate.jsonl"), readFileSync(parent.getSessionFile()!));
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("duplicate session id");
		rmSync(root, { recursive: true, force: true });
	});

	it("bounds stable root discovery before descriptor reads and admits the exact limit", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-root-discovery-bound-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		let trustedOpens = 0;
		setCatalogBeforeTrustedOpenForTest(() => {
			trustedOpens++;
		});
		try {
			// The per-call helper proves exact/over behavior without mutable global
			// security state or creating 10,001 filesystem entries.
			await expect(listCatalogFamilySessionsWithLimitForTest(sessionDir, 1)).resolves.toEqual([
				expect.objectContaining({ id: "parent" }),
			]);
			expect(trustedOpens).toBeGreaterThan(0);
			trustedOpens = 0;
			writeFileSync(join(sessionDir, "unrelated.jsonl"), "not json\n");
			await expect(listCatalogFamilySessionsWithLimitForTest(sessionDir, 1)).rejects.toThrow(
				"family node limit exhausted during root discovery",
			);
			// No candidate descriptor may be opened, classified, or metadata-scanned
			// after discovery proves the family is over the hard bound.
			expect(trustedOpens).toBe(0);
		} finally {
			setCatalogBeforeTrustedOpenForTest(undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("classifies escaped and boundary-truncated root claims with the real helper", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-escaped-root-classification-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");

		const escapedClaim = join(sessionDir, "escaped-claim.jsonl");
		writeFileSync(
			escapedClaim,
			`{"\\u0074ype":"\\u0073ession","\\u0069d":"claimed","padding":"${"x".repeat(200 * 1024)}"}\n`,
		);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(escapedClaim);

		const partialEscape = join(sessionDir, "partial-unicode-escape.jsonl");
		const partialClaim = '{"\\u0074ype":"\\u0073ess\\u006';
		writeFileSync(
			partialEscape,
			`${" ".repeat(64 * 1024 - Buffer.byteLength(partialClaim, "utf8"))}${partialClaim}9-padding-after-limit`,
		);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(partialEscape);

		// These cross the actual 64 KiB classifier read boundary. A fully decoded
		// outer type whose colon/value is still beyond that boundary, and a fully
		// decoded outer id with its delimiter/value beyond it, are topology claims.
		const boundaryType = join(sessionDir, "boundary-type-whitespace.jsonl");
		const typePrefix = `{"type"${" ".repeat(64 * 1024 - Buffer.byteLength('{"type"', "utf8"))}`;
		writeFileSync(boundaryType, `${typePrefix}:"session","id":"claimed","padding":"${"x".repeat(200 * 1024)}"}`);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(boundaryType);

		const boundaryId = join(sessionDir, "boundary-id-no-value.jsonl");
		const idPrefix = `{"junk":0,"id"${" ".repeat(64 * 1024 - Buffer.byteLength('{"junk":0,"id"', "utf8"))}`;
		writeFileSync(boundaryId, `${idPrefix}:"claimed","padding":"${"x".repeat(200 * 1024)}"}`);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(boundaryId);

		// A complete demonstrably non-string type value remains unrelated; the
		// following outer id is still scanned and cannot be hidden by that skip.
		const nonStringThenId = join(sessionDir, "non-string-type-then-id.jsonl");
		writeFileSync(nonStringThenId, `{"type":null,"id":"claimed","padding":"${"x".repeat(200 * 1024)}"}`);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(nonStringThenId);

		// Invalid escapes in a terminated unrelated value must not conceal later
		// outer claims in the bounded helper prefix.
		for (const [name, malformed] of [
			["invalid-simple-escape", "\\q"],
			["invalid-unicode-escape", "\\u12xz"],
		] as const) {
			const file = join(sessionDir, `${name}.jsonl`);
			writeFileSync(file, `{"junk":"${malformed}","\\u0069d":"claimed","padding":"${"x".repeat(200 * 1024)}"}`);
			await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
				"session header exceeds the trusted read limit",
			);
			rmSync(file);
		}

		const malformedUnicodeBeforeEscapedType = join(sessionDir, "invalid-unicode-before-escaped-type.jsonl");
		writeFileSync(
			malformedUnicodeBeforeEscapedType,
			`{"junk":"\\u12xz","\\u0074ype":"\\u0073ession","padding":"${"x".repeat(200 * 1024)}"}`,
		);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(malformedUnicodeBeforeEscapedType);

		const malformedNested = join(sessionDir, "malformed-nested-value.jsonl");
		writeFileSync(malformedNested, `{"junk":{"inner":"\\q"},"id":"claimed","padding":"${"x".repeat(200 * 1024)}"}`);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
			"session header exceeds the trusted read limit",
		);
		rmSync(malformedNested);

		for (const [name, typeValue, id] of [
			["null-type-before-id", "null", '"claimed"'],
			["object-type-before-escaped-id", '{"nested":"value"}', '"claimed"'],
			["array-type-before-id", '["value"]', '"claimed"'],
		] as const) {
			const file = join(sessionDir, `${name}.jsonl`);
			writeFileSync(file, `{"type":${typeValue},"\\u0069d":${id},"padding":"${"x".repeat(200 * 1024)}"}`);
			await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
				"session header exceeds the trusted read limit",
			);
			rmSync(file);
		}

		// Once the bounded scanner reaches the outer close without a claim, an
		// otherwise malformed unrelated record remains safely skippable.
		const malformedUnrelated = join(sessionDir, "malformed-unrelated-junk.jsonl");
		writeFileSync(malformedUnrelated, `{"junk":"\\q","padding":"${"x".repeat(200 * 1024)}"}`);
		await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([expect.objectContaining({ id: "parent" })]);
		rmSync(malformedUnrelated);

		writeFileSync(
			join(sessionDir, "escaped-unrelated-junk.jsonl"),
			`{"\\u006aunk":"\\u0073ession","padding":"${"x".repeat(200 * 1024)}"}\n`,
		);
		await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([expect.objectContaining({ id: "parent" })]);
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps registry-reached child headers strict when classification would truncate", async () => {
		const { root, sessionDir, first } = createCatalogFamilyFixture();
		try {
			const file = first.getSessionFile()!;
			const entries = readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
			const header = JSON.parse(entries[0]!) as Record<string, unknown>;
			header.padding = "x".repeat(200 * 1024);
			writeFileSync(file, `${[JSON.stringify(header), ...entries.slice(1)].join("\n")}\n`);
			await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads only the session header line even when the body is huge", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-header-only-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		// A body far beyond the old whole-file transfer budget must not slow or
		// break the walk: only the first line participates in the trust decision.
		appendFileSync(
			parent.getSessionFile()!,
			`${JSON.stringify({ type: "custom_message", body: "x".repeat(8 * 1024 * 1024) })}\n`,
		);
		await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([
			expect.objectContaining({ id: "parent", rlmDepth: 0 }),
		]);
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects a session whose header line exceeds the header budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-header-overflow-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const file = parent.getSessionFile()!;
		const entries = readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
		const header = JSON.parse(entries[0]!) as Record<string, unknown>;
		header.padding = "x".repeat(300 * 1024);
		writeFileSync(file, `${[JSON.stringify(header), ...entries.slice(1)].join("\n")}\n`);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		rmSync(root, { recursive: true, force: true });
	});

	it("still requires a registry child's claimed parent file to exist", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-absent-parent-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const child = SessionManager.create(root, join(root, "session-artifacts", "parent", "sub-44444444"));
		child.newSession({ id: "child", parentSession: join(sessionDir, "gone.jsonl"), rlmDepth: 1 });
		child.appendSessionInfo("child");
		const registry = join(root, "session-artifacts", "parent", "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			JSON.stringify({
				type: "rlm_subagent",
				childId: "sub-44444444",
				sessionFile: child.getSessionFile(),
				status: "completed",
			}),
		);
		await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		rmSync(root, { recursive: true, force: true });
	});

	it("serves an entire family walk from a single helper process", async () => {
		const { root, sessionDir } = createCatalogFamilyFixture();
		try {
			const spawnsBefore = getCatalogHelperSpawnCountForTest();
			await expect(listCatalogFamilySessions(sessionDir)).resolves.toHaveLength(3);
			expect(getCatalogHelperSpawnCountForTest()).toBe(spawnsBefore + 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
	});

	it("rejects promptly and releases authority FDs when the helper executable cannot spawn", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-helper-spawn-error-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const baseline = getOpenCatalogAuthorityFdCountForTest();
		setCatalogHelperLaunchForTest({ command: join(root, "does-not-exist"), args: [] });
		try {
			await expect(
				Promise.race([
					listCatalogFamilySessions(sessionDir),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("helper spawn hung")), 1_000)),
				]),
			).rejects.toThrow("Invalid RLM artifact family topology");
		} finally {
			setCatalogHelperLaunchForTest(undefined);
			rmSync(root, { recursive: true, force: true });
		}
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(baseline);
	});

	it("rejects the family when the helper writes delayed unsolicited stdout after its final response", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-helper-delayed-stdout-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const header = readFileSync(parent.getSessionFile()!, "utf8").split(/\r?\n/, 1)[0]!;
		const helper = String.raw`let input="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
 input += chunk;
 while (true) {
  const end=input.indexOf("\n"); if (end<0) break;
  const request=JSON.parse(input.slice(0,end)); input=input.slice(end+1);
  const payload=(request.mode === "header" || request.mode === "classify") ? { id:request.id, data:${JSON.stringify(Buffer.from(header).toString("base64"))}, mtimeMs:0, dev:"1", ino:"1" } : request.mode === "metadata" ? { id:request.id, data:{valid:true,messageCount:0,firstMessage:"(no messages)",allMessagesText:"",modifiedMs:0}, mtimeMs:0, dev:"1", ino:"1" } : { id:request.id, mtimeMs:0, dev:"1", ino:"1" };
  process.stdout.write(JSON.stringify(payload)+"\n");
  if (request.mode === "metadata") setTimeout(() => process.stdout.write("{\"unsolicited\":true}\n"), 25);
 }
});`;
		const baseline = getOpenCatalogAuthorityFdCountForTest();
		setCatalogHelperLaunchForTest({ command: process.execPath, args: ["-e", helper] });
		try {
			await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("Invalid RLM artifact family topology");
		} finally {
			setCatalogHelperLaunchForTest(undefined);
			rmSync(root, { recursive: true, force: true });
		}
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(baseline);
	});

	it("rejects a v2 header whose registry rekeys the child by session id", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-v2-rekey-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession({ id: "parent", rlmDepth: 0 });
		parent.appendSessionInfo("parent");
		const child = SessionManager.create(root, join(root, "session-artifacts", "parent", "sub-55555555"));
		child.newSession({ id: "child", parentSession: parent.getSessionFile(), rlmDepth: 1 });
		child.appendSessionInfo("child");
		const childFile = child.getSessionFile()!;
		const [header, ...entries] = readFileSync(childFile, "utf8").trimEnd().split(/\r?\n/);
		writeFileSync(childFile, `${JSON.stringify({ ...JSON.parse(header!), version: 2 })}\n${entries.join("\n")}\n`);
		const registry = join(root, "session-artifacts", "parent", "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			JSON.stringify({ type: "rlm_subagent", childId: "sub-66666666", sessionFile: childFile, status: "completed" }),
		);
		try {
			await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow("writer artifact layout");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("walks a realistic profile: fork seeds, sub-* registry ids, two nested levels", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-realistic-"));
		const sessionDir = join(root, "sessions");
		const write = (path: string, header: Record<string, unknown>) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				`${JSON.stringify({ type: "session", version: 10, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/p", ...header })}\n`,
			);
		};
		// The writer stores a session's child registry beside its session dir:
		// flat roots use the profile's top-level session-artifacts; artifact-resident
		// children get a nested session-artifacts dir beside their sub-* dir.
		const writeRegistry = (parentFile: string, parentId: string, entries: Array<Record<string, unknown>>) => {
			const path = join(dirname(dirname(parentFile)), "session-artifacts", parentId, "rlm-subagents.jsonl");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, entries.map((entry) => JSON.stringify({ type: "rlm_subagent", ...entry })).join("\n"));
		};
		// Flat roots: a plain session plus forks in both real-world header shapes.
		const rootFile = join(sessionDir, "root-uuid.jsonl");
		write(rootFile, { id: "root-uuid", rlmDepth: 0 });
		write(join(sessionDir, "fork-depth-uuid.jsonl"), { id: "fork-depth-uuid", parentSession: rootFile, rlmDepth: 0 });
		write(join(sessionDir, "fork-nodepth-uuid.jsonl"), { id: "fork-nodepth-uuid", parentSession: rootFile });
		// Depth-1 child in the root's artifact tree; its own registry lives at the
		// top-level artifacts dir under its session id, as the writer stores it.
		const childFile = join(root, "session-artifacts", "root-uuid", "sub-aaaa1111", "child-uuid.jsonl");
		write(childFile, { id: "child-uuid", parentSession: rootFile, rlmDepth: 1 });
		const grandFile = join(
			root,
			"session-artifacts",
			"root-uuid",
			"sub-aaaa1111",
			"sub-bbbb2222",
			"grand-uuid.jsonl",
		);
		write(grandFile, { id: "grand-uuid", parentSession: childFile, rlmDepth: 2 });
		writeRegistry(rootFile, "root-uuid", [{ childId: "sub-aaaa1111", sessionFile: childFile, status: "running" }]);
		writeRegistry(childFile, "child-uuid", [
			{ childId: "sub-bbbb2222", sessionFile: grandFile, status: "completed" },
		]);

		const family = await listCatalogFamilySessions(sessionDir);
		expect(family).toHaveLength(5);
		expect(family).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "root-uuid", rlmDepth: 0 }),
				expect.objectContaining({ id: "fork-depth-uuid", rlmDepth: 0 }),
				expect.objectContaining({ id: "fork-nodepth-uuid", rlmDepth: 0 }),
				expect.objectContaining({ id: "child-uuid", rlmDepth: 1 }),
				expect.objectContaining({ id: "grand-uuid", rlmDepth: 2 }),
			]),
		);
		// Fork ancestry must not surface as rlm parent edges on the seed rows.
		for (const fork of ["fork-depth-uuid", "fork-nodepth-uuid"]) {
			expect(family.find((info) => info.id === fork)?.parentSessionPath).toBeUndefined();
		}
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
		rmSync(root, { recursive: true, force: true });
	});

	it("binds registry child ids to direct writer directories and detects post-header replacement", async () => {
		const make = () => {
			const root = mkdtempSync(join(tmpdir(), "prime-catalog-identity-binding-"));
			const sessionDir = join(root, "sessions");
			const parent = SessionManager.create(root, sessionDir);
			parent.newSession({ id: "parent", rlmDepth: 0 });
			parent.appendSessionInfo("parent");
			const childDir = join(root, "session-artifacts", "parent", "sub-55555555");
			const child = SessionManager.create(root, childDir);
			child.newSession({ id: "child", parentSession: parent.getSessionFile(), rlmDepth: 1 });
			child.appendSessionInfo("child");
			const registry = join(root, "session-artifacts", "parent", "rlm-subagents.jsonl");
			mkdirSync(dirname(registry), { recursive: true });
			const writeRegistry = (childId: string, sessionFile = child.getSessionFile()!) =>
				writeFileSync(
					registry,
					JSON.stringify({ type: "rlm_subagent", childId, sessionFile, status: "completed" }),
				);
			writeRegistry("sub-55555555");
			return { root, sessionDir, child, childDir, writeRegistry };
		};
		const spoofed = make();
		spoofed.writeRegistry("sub-66666666");
		await expect(listCatalogFamilySessions(spoofed.sessionDir)).rejects.toThrow("writer artifact layout");
		rmSync(spoofed.root, { recursive: true, force: true });

		const nested = make();
		const nestedPath = join(nested.sessionDir, "sub-55555555", "child.jsonl");
		mkdirSync(dirname(nestedPath), { recursive: true });
		writeFileSync(nestedPath, readFileSync(nested.child.getSessionFile()!));
		nested.writeRegistry("sub-55555555", nestedPath);
		await expect(listCatalogFamilySessions(nested.sessionDir)).rejects.toThrow("writer artifact layout");
		rmSync(nested.root, { recursive: true, force: true });

		const replacement = make();
		let swapped = false;
		setCatalogAfterTrustedHeaderForTest((path) => {
			if (swapped || path !== replacement.child.getSessionFile()) return;
			swapped = true;
			const moved = `${path}.old`;
			renameSync(path, moved);
			writeFileSync(path, `${readFileSync(moved, "utf8").split(/\r?\n/, 1)[0]}\n${"x".repeat(2 * 1024 * 1024)}\n`);
		});
		await expect(listCatalogFamilySessions(replacement.sessionDir)).rejects.toThrow(
			"session changed after its trusted header read",
		);
		setCatalogAfterTrustedHeaderForTest(undefined);
		rmSync(replacement.root, { recursive: true, force: true });
		expect(getOpenCatalogAuthorityFdCountForTest()).toBe(0);
	});

	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});
});
