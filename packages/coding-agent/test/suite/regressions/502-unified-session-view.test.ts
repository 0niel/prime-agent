import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";
import { AgentsViewMode } from "../../../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";

function summary(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `session-${id}`,
		lifecycle: "live",
		activity: "idle",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		pendingMessageCount: 0,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function refreshHarness() {
	const applySessionList = vi.fn();
	const reconcileCatalogs = vi.fn();
	const persistentState: {
		savedSessions?: unknown[];
		lastSuccessfulSavedSessions?: unknown[];
		heartbeats?: unknown[];
		savedCatalogGeneration?: number;
	} = {};
	return {
		reconnectPromise: undefined,
		daemonShutdownReceived: false,
		options: {},
		liveCatalogGeneration: 0,
		savedCatalogGeneration: 0,
		heartbeatCatalogGeneration: 0,
		liveCatalogRefreshPending: false,
		savedCatalogRefreshPending: false,
		heartbeats: [] as unknown[],
		persistentState,
		applySessionList,
		reconcileCatalogs,
		resolveMissingSelectionAnchor: vi.fn(),
		setStatusMessage: vi.fn(),
		startClientReconnect: vi.fn(),
	};
}

function privateMethod<T>(name: string): T {
	return Reflect.get(AgentsViewMode.prototype, name) as T;
}

describe("#502 unified session view regressions", () => {
	test.each(["live", "heartbeat"] as const)(
		"an older overlapping %s poll cannot overwrite the newer response",
		async (kind) => {
			const old = deferred<unknown>();
			const newer = kind === "live" ? summary("new") : { job: { id: "new" } };
			const client = {
				isConnected: true,
				hello: { protocol: { version: 3 } },
				supportsServerCapability: () => true,
				request: vi
					.fn()
					.mockReturnValueOnce(old.promise)
					.mockResolvedValueOnce({
						success: true,
						data: kind === "live" ? { sessions: [newer] } : { heartbeats: [newer] },
					}),
			};
			const harness = { ...refreshHarness(), requireClient: () => client };
			const refresh = privateMethod<(this: typeof harness) => Promise<unknown>>(
				kind === "live" ? "refreshSessions" : "refreshHeartbeats",
			);

			const oldPoll = refresh.call(harness);
			await refresh.call(harness);
			old.resolve({
				success: true,
				data: kind === "live" ? { sessions: [summary("old")] } : { heartbeats: [{ job: { id: "old" } }] },
			});
			await oldPoll;

			if (kind === "live") expect(harness.applySessionList).toHaveBeenCalledWith([newer]);
			else expect(harness.heartbeats).toEqual([newer]);
			expect(kind === "live" ? harness.applySessionList : harness.reconcileCatalogs).toHaveBeenCalledOnce();
		},
	);

	test("overlapping saved scans retain the last complete catalog after the newest scan fails", async () => {
		const previous = [{ path: "/tmp/previous.jsonl", id: "previous" }];
		const older = deferred<typeof previous>();
		const streamed = { path: "/tmp/streamed.jsonl", id: "streamed" };
		const harness = {
			...refreshHarness(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
		};
		harness.persistentState.savedSessions = previous;
		harness.options = {
			adapter: {
				loadSavedSessions: vi
					.fn()
					.mockReturnValueOnce(older.promise)
					.mockImplementationOnce(async ({ onSession }: { onSession: (session: typeof streamed) => void }) => {
						onSession(streamed);
						throw new Error("scan failed");
					}),
			},
		};
		const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

		const oldScan = refresh.call(harness);
		await Promise.resolve();
		expect(await refresh.call(harness)).toBe(false);
		older.resolve([{ path: "/tmp/stale.jsonl", id: "stale" }]);
		expect(await oldScan).toBe(false);

		expect([harness.savedSessions, harness.persistentState.savedSessions]).toEqual([previous, previous]);
		expect(harness.savedCatalogRefreshPending).toBe(false);
	});

	test("reconnect retries the saved catalog and fences a stale startup scan", async () => {
		const previous = [{ path: "/tmp/previous.jsonl", id: "previous" }];
		const startup = deferred<typeof previous>();
		const retried = deferred<typeof previous>();
		const replacement = [{ path: "/tmp/retried.jsonl", id: "retried" }];
		const harness = {
			...refreshHarness(),
			reconnectPromise: undefined as Promise<void> | undefined,
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
		};
		harness.persistentState.savedSessions = previous;
		harness.options = {
			adapter: {
				loadSavedSessions: vi.fn().mockReturnValueOnce(startup.promise).mockReturnValueOnce(retried.promise),
			},
		};
		const refresh =
			privateMethod<
				(
					this: typeof harness,
					options?: { duringReconnect?: boolean; preserveStatusOnError?: boolean },
				) => Promise<boolean>
			>("refreshSavedSessions");

		harness.reconnectPromise = undefined;
		const startupScan = refresh.call(harness);
		harness.reconnectPromise = Promise.resolve();
		const retry = refresh.call(harness, { duringReconnect: true, preserveStatusOnError: true });
		expect(harness.savedCatalogGeneration).toBe(2);
		expect(harness.persistentState.savedCatalogGeneration).toBe(2);

		retried.resolve(replacement);
		expect(await retry).toBe(true);
		startup.resolve([{ path: "/tmp/stale.jsonl", id: "stale" }]);
		expect(await startupScan).toBe(false);
		expect(harness.savedSessions).toEqual(replacement);
	});

	test("failed saved retry during reconnect preserves status and complete catalog", async () => {
		const previous = [{ path: "/tmp/previous.jsonl", id: "previous" }];
		const streamed = { path: "/tmp/partial.jsonl", id: "partial" };
		const harness = {
			...refreshHarness(),
			reconnectPromise: Promise.resolve(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
		};
		harness.persistentState.savedSessions = previous;
		harness.options = {
			adapter: {
				loadSavedSessions: async ({ onSession }: { onSession: (session: typeof streamed) => void }) => {
					onSession(streamed);
					throw new Error("retry failed");
				},
			},
		};

		const refreshed = await privateMethod<
			(
				this: typeof harness,
				options: { duringReconnect: boolean; preserveStatusOnError: boolean },
			) => Promise<boolean>
		>("refreshSavedSessions").call(harness, { duringReconnect: true, preserveStatusOnError: false });

		expect(refreshed).toBe(false);
		expect(harness.savedSessions).toEqual(previous);
		expect(harness.persistentState.savedSessions).toEqual(previous);
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});

	test("a pending saved scan cannot overwrite daemon shutdown status", async () => {
		const scan = deferred<void>();
		const harness = {
			...refreshHarness(),
			savedSessions: [],
			lastSuccessfulSavedSessions: [],
			options: {
				adapter: {
					loadSavedSessions: async () => {
						await scan.promise;
						throw new Error("scan failed");
					},
				},
			},
		};

		const pending = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions").call(harness);
		harness.daemonShutdownReceived = true;
		scan.resolve();
		expect(await pending).toBe(false);
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});

	test("a missing selection anchor blocks open only until both catalogs settle", () => {
		const finish = vi.fn();
		const syncSelectedRowState = vi.fn();
		const harness = {
			selectionAnchorPending: true,
			liveCatalogRefreshPending: false,
			savedCatalogRefreshPending: true,
			selectedIndex: 0,
			rows: [{ selectable: true, kind: "agent", summary: summary("fallback") }],
			isPendingDeleteRow: () => false,
			setStatusMessage: vi.fn(),
			finish,
			syncSelectedRowState,
		};

		privateMethod<(this: typeof harness) => void>("openSelected").call(harness);
		expect(finish).not.toHaveBeenCalled();
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		expect(syncSelectedRowState).not.toHaveBeenCalled();
		harness.savedCatalogRefreshPending = false;
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		expect(syncSelectedRowState).toHaveBeenCalledOnce();
	});
	test("adapter rename uses the captured row after refresh removes it", async () => {
		const captured = summary("captured");
		const rename = vi.fn(async () => {});
		const requireClient = vi.fn(() => {
			throw new Error("daemon client must not be used");
		});
		const harness = {
			renameTarget: { activeSessionId: captured.activeSessionId, summary: captured },
			rows: [],
			options: { adapter: { rename } },
			exitRenameMode: vi.fn(),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			refreshSavedSessions: vi.fn(async () => true),
			requireClient,
		};

		await privateMethod<(this: typeof harness, value: string) => Promise<void>>("confirmRename").call(
			harness,
			"Renamed",
		);

		expect(rename).toHaveBeenCalledWith(captured, "Renamed");
		expect(requireClient).not.toHaveBeenCalled();
	});

	test("saved-only delete confirmation remains in the inactive catalog", () => {
		const savedOnly = { ...summary("saved"), lifecycle: "archived" as const, activeSessionId: undefined };
		const harness = {
			pendingDeleteAgent: { identity: "saved", summary: savedOnly, stopped: false },
			isDeleteConfirmationVisible: () => true,
		};

		expect(
			privateMethod<(this: typeof harness, sessions: SessionSummary[]) => SessionSummary[]>(
				"withPendingDeleteSession",
			).call(harness, []),
		).toEqual([]);
	});

	test("slow live polls are coalesced instead of repeatedly superseded", async () => {
		const slow = deferred<boolean>();
		const refreshSessions = vi.fn(() => slow.promise);
		const harness = { liveCatalogPollPromise: undefined, refreshSessions };
		const poll = privateMethod<(this: typeof harness) => void>("pollSessions");

		poll.call(harness);
		poll.call(harness);
		expect(refreshSessions).toHaveBeenCalledOnce();
		slow.resolve(true);
		await slow.promise;
		await Promise.resolve();
		poll.call(harness);
		expect(refreshSessions).toHaveBeenCalledTimes(2);
	});

	test.each([
		{ mode: "search", prompt: ["prompt top", "prompt input", "prompt bottom"] },
		{ mode: "reply", prompt: ["prompt top", "reply header", "reply gap", "prompt input", "prompt bottom"] },
	])("short content reserves the $mode editor and a session row ahead of startup chrome", ({ prompt }) => {
		const renderSessionRows = vi.fn(() => ["session row"]);
		const harness = {
			splash: { render: () => Array.from({ length: 8 }, () => "splash") },
			renderStartupNotices: () => Array.from({ length: 8 }, () => "notice"),
			renderPrompt: () => prompt,
			renderSessionRows,
		};
		const height = prompt.length + 2;

		const lines = privateMethod<(this: typeof harness, width: number, height: number) => string[]>(
			"renderContent",
		).call(harness, 80, height);

		expect(lines).toHaveLength(height);
		expect(lines).toEqual(expect.arrayContaining([...prompt, "session row"]));
		expect(renderSessionRows).toHaveBeenCalledWith(80, 1);
	});

	test.each(["reply", "rename"] as const)("%s refresh keeps the captured search filter", (mode) => {
		const harness = {
			replyActiveSessionId: mode === "reply" ? "active" : undefined,
			renameTarget: mode === "rename" ? { identity: "target" } : undefined,
			actionModeSearchQuery: "needle",
			editor: { getText: () => "action editor text" },
			unifiedRecords: [
				{ identity: "match", identityAliases: [], section: "idle", searchableText: "needle session" },
				{ identity: "other", identityAliases: [], section: "idle", searchableText: "other session" },
			],
		};

		const filtered =
			privateMethod<(this: typeof harness) => Array<{ identity: string }>>("getFilteredRecords").call(harness);
		expect(filtered.map((record) => record.identity)).toEqual(["match"]);
	});

	test("inactive rows give message count and age their full responsive cell", () => {
		const inactive = {
			kind: "agent" as const,
			section: "inactive" as const,
			summary: {
				...summary("archived"),
				activeSessionId: undefined,
				lifecycle: "archived" as const,
				messageCount: 123456,
				modified: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			},
			title: "archived",
			subtitle: "",
			statusLabel: "inactive",
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			identity: "archived",
		};
		const harness = {
			rows: [inactive],
			selectedIndex: 0,
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "x",
			formatRowIcon: (_section: string, icon: string) => icon,
		};

		const rendered = stripAnsi(
			privateMethod<(this: typeof harness, row: typeof inactive, width: number) => string>("renderRow").call(
				harness,
				inactive,
				50,
			),
		);
		expect(rendered).toMatch(/123456 · 2h\s*$/);
	});
});
