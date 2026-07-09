import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/index.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme, preloadCodeHighlighter } from "../src/modes/interactive/theme/theme.js";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(
	overrides: Partial<AgentConnectionSavedSessionInfo> & { id: string },
): AgentConnectionSavedSessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function createSymlinkedSessionPaths(): {
	baseDir: string;
	parentAliasA: string;
	parentAliasB: string;
	childAliasB: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-session-selector-"));
	const realDir = join(baseDir, "real");
	const aliasADir = join(baseDir, "alias-a");
	const aliasBDir = join(baseDir, "alias-b");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(aliasADir, { recursive: true });
	mkdirSync(aliasBDir, { recursive: true });

	const sharedDir = join(realDir, "sessions");
	mkdirSync(sharedDir, { recursive: true });
	const aliasASessions = join(aliasADir, "sessions");
	const aliasBSessions = join(aliasBDir, "sessions");
	symlinkSync(sharedDir, aliasASessions);
	symlinkSync(sharedDir, aliasBSessions);

	const parentRealPath = join(sharedDir, "parent.jsonl");
	const childRealPath = join(sharedDir, "child.jsonl");
	writeFileSync(parentRealPath, "parent\n");
	writeFileSync(childRealPath, "child\n");

	return {
		baseDir,
		parentAliasA: join(aliasASessions, "parent.jsonl"),
		parentAliasB: join(aliasBSessions, "parent.jsonl"),
		childAliasB: join(aliasBSessions, "child.jsonl"),
	};
}

const CTRL_X = "\x18";
const CTRL_BACKSPACE = "\x1b[127;5u";

describe("session selector path/delete interactions", () => {
	const keybindings = new KeybindingsManager();
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(async () => {
		// session selector uses the global theme instance
		initTheme("dark");
		await preloadCodeHighlighter();
	});
	it("does not treat Ctrl+Backspace as delete when search query is non-empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enters confirmation mode on Ctrl+X even with a non-empty search query", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_X);

		expect(confirmationChanges).toEqual([sessions[0]!.path]);
	});

	it("enters confirmation mode on Ctrl+Backspace when search query is empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		let deletedPath: string | null = null;
		list.onDeleteSession = async (sessionPath) => {
			deletedPath = sessionPath;
		};

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([sessions[0]!.path]);

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([sessions[0]!.path, null]);
		expect(deletedPath).toBe(sessions[0]!.path);
	});

	it("delegates confirmed deletion to the injected delete handler", async () => {
		const sessions = [makeSession({ id: "a" })];
		const deleteSession = vi.fn(async () => ({ ok: true as const, method: "unlink" as const }));

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, deleteSession },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput(CTRL_X);
		list.handleInput(CTRL_X);
		await flushPromises();

		expect(deleteSession).toHaveBeenCalledTimes(1);
		expect(deleteSession).toHaveBeenCalledWith(sessions[0]!.path);
	});

	it("shows an error when the injected delete handler rejects", async () => {
		const sessions = [makeSession({ id: "a" })];
		const deleteSession = vi.fn(async () => {
			throw new Error("Cannot delete the currently active session");
		});

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, deleteSession },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput(CTRL_X);
		list.handleInput(CTRL_X);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(deleteSession).toHaveBeenCalledTimes(1);
		expect(output).toContain("Failed to delete: Cannot delete the currently active session");
	});

	it("keeps delete success visible when refresh after deletion fails", async () => {
		const sessions = [makeSession({ id: "a" })];
		const deleteSession = vi.fn(async () => ({ ok: true as const, method: "unlink" as const }));
		let loadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => {
				loadCalls++;
				if (loadCalls > 1) {
					throw new Error("refresh unavailable");
				}
				return sessions;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, deleteSession },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput(CTRL_X);
		list.handleInput(CTRL_X);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(deleteSession).toHaveBeenCalledTimes(1);
		expect(output).toContain("Session deleted");
		expect(output).not.toContain("Failed to delete");
	});

	it("renders streamed sessions before the initial load completes", async () => {
		const streamedSession = makeSession({ id: "streamed", name: "Streamed session" });
		const sessionsDeferred = createDeferred<AgentConnectionSavedSessionInfo[]>();

		const selector = new SessionSelectorComponent(
			async (callbacks) => {
				callbacks?.onProgress?.(1, 2);
				callbacks?.onSession?.(streamedSession);
				return sessionsDeferred.promise;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const loadingOutput = stripAnsi(selector.render(120).join("\n"));
		expect(loadingOutput).toContain("loading 1/2");
		expect(loadingOutput).toContain("Streamed session");

		sessionsDeferred.resolve([streamedSession]);
		await flushPromises();

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("current folder");
	});

	it("keeps streamed threaded sessions flat until loading completes", async () => {
		const parent = makeSession({ id: "parent", name: "Parent" });
		const child = makeSession({ id: "child", name: "Child", parentSessionPath: parent.path });
		const sessionsDeferred = createDeferred<AgentConnectionSavedSessionInfo[]>();
		const onSelect = vi.fn();

		const selector = new SessionSelectorComponent(
			async (callbacks) => {
				callbacks?.onSession?.(child);
				callbacks?.onSession?.(parent);
				return sessionsDeferred.promise;
			},
			async () => [],
			onSelect,
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("└─");

		sessionsDeferred.resolve([parent, child]);
		await flushPromises();

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("└─ ✓ Child");
		list.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(child.path);
	});

	it("keeps other streamed rows visible when deleting before loading completes", async () => {
		const first = makeSession({ id: "first", name: "First streamed session" });
		const second = makeSession({ id: "second", name: "Second streamed session" });
		const initialLoad = createDeferred<AgentConnectionSavedSessionInfo[]>();
		const refreshLoad = createDeferred<AgentConnectionSavedSessionInfo[]>();
		const deleteSession = vi.fn(async () => ({ ok: true as const, method: "unlink" as const }));
		let loadCalls = 0;

		const selector = new SessionSelectorComponent(
			async (callbacks) => {
				loadCalls++;
				if (loadCalls === 1) {
					callbacks?.onSession?.(first);
					callbacks?.onSession?.(second);
					return initialLoad.promise;
				}
				return refreshLoad.promise;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, deleteSession },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput(CTRL_X);
		list.handleInput(CTRL_X);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(deleteSession).toHaveBeenCalledWith(first.path);
		expect(output).not.toContain("First streamed session");
		expect(output).toContain("Second streamed session");

		refreshLoad.resolve([second]);
		initialLoad.resolve([first, second]);
		await flushPromises();
	});

	it("does not switch scope back to All when All load resolves after toggling back to Current", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<AgentConnectionSavedSessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();

		expect(allLoadCalls).toBe(1);
		const output = selector.render(120).join("\n");
		expect(output).toContain("current folder");
		expect(output).not.toContain("all projects");
	});

	it("does not start redundant All loads when toggling scopes while All is already loading", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<AgentConnectionSavedSessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current
		list.handleInput("\t"); // current -> all again while load pending

		expect(allLoadCalls).toBe(1);

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();
	});

	it("threads sessions when parent and child paths use different symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [
			makeSession({
				id: "parent",
				path: paths.parentAliasB,
				name: "Parent",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "child",
				path: paths.childAliasB,
				parentSessionPath: paths.parentAliasA,
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ ✓ Child");
	});

	it("treats the current session as active across symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [makeSession({ id: "parent", path: paths.parentAliasB, name: "Parent" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			paths.parentAliasA,
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_X);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});
});
