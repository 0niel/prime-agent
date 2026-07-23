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
	const persistentState: { savedSessions?: unknown[]; heartbeats?: unknown[] } = {};
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
});
