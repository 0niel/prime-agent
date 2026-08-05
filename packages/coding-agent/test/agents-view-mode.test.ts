import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import {
	AgentsViewMode,
	type AgentsViewPersistentState,
	combineAgentsViewStartupNotices,
	createInitialAgentsViewPersistentState,
	runAgentsViewMode,
} from "../src/modes/agents-view/agents-view-mode.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "root-active",
		activeSessionId: "root-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: true,
		runtimeKind: "top-level",
		sessionId: "root-session",
		cwd: process.cwd(),
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function createUiServices(): InteractiveModeUiServices {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...args: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

afterEach(() => {
	vi.restoreAllMocks();
	stopThemeWatcher();
});

describe("AgentsViewMode search selection", () => {
	it("keeps the selection chosen by row rebuilding when the query changes", () => {
		const self = {
			editor: { getText: () => "matching query" },
			persistentState: { query: "" },
			selectedIndex: 4,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		(AgentsViewMode.prototype as unknown as { queryChanged(this: typeof self): void }).queryChanged.call(self);

		expect(self.persistentState.query).toBe("matching query");
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(self.selectedIndex).toBe(4);
	});
});

describe("AgentsViewMode persistent catalog state", () => {
	it("keeps an initial handoff scope when the first live poll fails after both catalogs settle", async () => {
		const root = summary();
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		const persistentState = createInitialAgentsViewPersistentState({
			initialScopeKey: scope,
			initialSession: root,
		});
		persistentState.lastSuccessfulSavedSessions = [];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(Reflect.get(view, "liveCatalogReady")).toBe(true);
			expect(Reflect.get(view, "savedCatalogReady")).toBe(true);
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: root }]);
			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([root]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope after a fresh instance's first live poll fails", async () => {
		const root = summary();
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(persistentState.scopeFrames).toEqual([
				{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } },
			]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope through reconnect timeout and settles it on the next successful list", async () => {
		vi.useFakeTimers();
		const root = summary();
		const frame = { scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } };
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [frame],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode(
			{ config: {}, uiServices: createUiServices(), reconnectTimeoutMs: 0 },
			persistentState,
		);
		const client = { isConnected: false, reconnect: vi.fn() };
		Reflect.set(view, "client", client);
		Reflect.set(view, "liveCatalogReady", true);
		Reflect.set(view, "savedCatalogReady", true);

		try {
			await expect(invoke("reconnectClient", view, client, new Error("disconnected"))).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([frame]);
			expect(Reflect.get(view, "lastListedSummaries")).toEqual([root]);

			Reflect.set(view, "client", {
				isConnected: true,
				request: vi.fn(async () => ({ success: true, data: { sessions: [] } })),
			});
			await expect(invoke("refreshSessions", view)).resolves.toBe(true);
			expect(persistentState.scopeFrames).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a newly pushed scope and the existing live cache when its first poll fails", async () => {
		const root = summary();
		const other = summary({ id: "other-active", activeSessionId: "other-active", sessionId: "other-session" });
		const returnedRoot = { ...root, sessionName: "Updated root" };
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			const persistentState = Reflect.get(this, "persistentState") as AgentsViewPersistentState;
			if (runs === 1) {
				persistentState.lastSuccessfulLiveSummaries = [other];
				persistentState.lastSuccessfulSavedSessions = [];
				return { type: "open", summary: root, hasChildren: false };
			}

			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([other, returnedRoot]);
			Reflect.set(this, "client", {
				isConnected: true,
				request: vi.fn(async () => {
					throw new Error("transient list failure");
				}),
			});
			await expect(invoke("refreshSessions", this, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: returnedRoot }]);
			return { type: "exit" };
		});
		vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue();
		vi.spyOn(DaemonAgentConnection, "attach").mockResolvedValue({
			dispose: vi.fn(async () => {}),
			onBeforeSessionInvalidate: vi.fn(),
		} as unknown as DaemonAgentConnection);
		vi.spyOn(InteractiveMode.prototype, "run").mockResolvedValue({
			type: "scoped_agents_view",
			source: {
				activeSessionId: root.activeSessionId!,
				sessionId: root.sessionId,
				sessionName: returnedRoot.sessionName,
				cwd: root.cwd,
			},
		});

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});
});

describe("agents view startup notices", () => {
	it("combines the open fallback and cwd fallback without dropping either notice", () => {
		expect(combineAgentsViewStartupNotices("Child unavailable", "Original directory is missing")).toBe(
			"Child unavailable · Original directory is missing",
		);
		expect(combineAgentsViewStartupNotices("Child unavailable", undefined)).toBe("Child unavailable");
		expect(combineAgentsViewStartupNotices(undefined, "Original directory is missing")).toBe(
			"Original directory is missing",
		);
	});

	it("persists the combined open and cwd fallback notices after returning to agents view", async () => {
		const root = summary({
			activeSessionId: undefined,
			cwd: "/definitely/not/a/real/dir/for/this/test",
			lifecycle: "archived",
			sessionFile: "/tmp/root.jsonl",
		});
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			if (runs === 1) {
				return {
					type: "open",
					summary: root,
					hasChildren: false,
					statusMessage: "Child unavailable",
				};
			}
			expect(Reflect.get(this, "persistentState")).toMatchObject({
				statusMessage: `Child unavailable · Original directory is missing (${root.cwd}); opened in ${process.cwd()} instead.`,
			});
			return { type: "exit" };
		});
		vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue();
		vi.spyOn(DaemonClient.prototype, "request").mockResolvedValue({
			type: "response",
			command: "create",
			success: true,
			data: { ...root, cwd: process.cwd(), activeSessionId: "resumed-active", lifecycle: "live" },
		});
		vi.spyOn(DaemonAgentConnection, "attach").mockResolvedValue({
			dispose: vi.fn(async () => {}),
			onBeforeSessionInvalidate: vi.fn(),
		} as unknown as DaemonAgentConnection);
		vi.spyOn(InteractiveMode.prototype, "run").mockResolvedValue({
			type: "agents_view",
			source: {
				activeSessionId: "resumed-active",
				sessionId: root.sessionId,
				cwd: process.cwd(),
			},
		});

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});
});
