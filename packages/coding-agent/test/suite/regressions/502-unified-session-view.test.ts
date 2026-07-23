import { describe, expect, test, vi } from "vitest";
import { AgentsViewMode } from "../../../src/modes/agents-view/agents-view-mode.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const RENAME = "\x12";
const DELETE = "\x18";
const PROGRAM = "\x0f";

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

function inputHarness(query = "abc", cursorCol = query.length) {
	const text = query;
	let col = cursorCol;
	const openSelected = vi.fn();
	const editorHandleInput = vi.fn((data: string) => {
		if (data === LEFT) col = Math.max(0, col - 1);
		if (data === RIGHT) col = Math.min(text.length, col + 1);
	});
	const keyFor = new Map([
		[LEFT, "app.agents.back"],
		[RIGHT, "app.agents.open"],
		[RENAME, "app.agents.rename"],
		[DELETE, "app.agents.delete"],
		[PROGRAM, "app.agents.program"],
	]);
	const harness = {
		editor: {
			getText: () => text,
			getLines: () => [text],
			getCursor: () => ({ line: 0, col }),
			handleInput: editorHandleInput,
		},
		keybindings: { matches: (data: string, action: string) => keyFor.get(data) === action },
		options: { adapter: {} },
		replyActiveSessionId: undefined,
		renameTarget: undefined,
		clearStickyStatusMessage: vi.fn(),
		clearCtrlCExitHint: vi.fn(),
		clearDeleteConfirmation: vi.fn(),
		handleListNavigation: vi.fn(() => false),
		queryChanged: vi.fn(),
		isSearchCursorAtEnd: () => col === text.length,
		openSelected,
		enterRenameMode: vi.fn(),
		handleDeleteSelected: vi.fn(),
		cycleProgramForSelected: vi.fn(),
	};
	return { harness, editorHandleInput, openSelected, cursor: () => col, text: () => text };
}

function handleInput(harness: object, data: string): void {
	AgentsViewMode.prototype.handleInput.call(harness as AgentsViewMode, data);
}

describe("#502 unified session view regressions", () => {
	test("Right edits search until the cursor reaches the end, then opens", () => {
		const { harness, editorHandleInput, openSelected, cursor } = inputHarness("abc", 1);

		handleInput(harness, RIGHT);
		expect(cursor()).toBe(2);
		expect(openSelected).not.toHaveBeenCalled();
		handleInput(harness, RIGHT);
		expect(cursor()).toBe(3);
		expect(openSelected).not.toHaveBeenCalled();
		handleInput(harness, RIGHT);

		expect(openSelected).toHaveBeenCalledOnce();
		expect(editorHandleInput).toHaveBeenCalledTimes(2);
	});

	test("Left edits a nonempty search instead of clearing it or going back", () => {
		const { harness, cursor, text } = inputHarness("abc", 2);

		handleInput(harness, LEFT);

		expect(cursor()).toBe(1);
		expect(text()).toBe("abc");
	});

	test.each([
		[RENAME, "enterRenameMode"],
		[DELETE, "handleDeleteSelected"],
		[PROGRAM, "cycleProgramForSelected"],
	] as const)("passes %s to search rather than running %s", (key, action) => {
		const { harness, editorHandleInput } = inputHarness();

		handleInput(harness, key);

		expect(editorHandleInput).toHaveBeenCalledWith(key);
		expect(harness[action]).not.toHaveBeenCalled();
	});

	test("a slow saved-session scan does not delay live polling", async () => {
		vi.useFakeTimers();
		try {
			const refreshSessions = vi.fn(async () => true);
			const harness = {
				options: { adapter: undefined },
				client: undefined,
				requireSocketPath: () => "/tmp/unused.sock",
				subscribeToClientClose: vi.fn(),
				ui: {
					addChild: vi.fn(),
					setFocus: vi.fn(),
					start: vi.fn(),
					enterFullscreen: vi.fn(),
					requestRender: vi.fn(),
					invalidate: vi.fn(),
				},
				fullscreenDock: {},
				persistentState: {},
				refreshSessions,
				refreshSavedSessions: vi.fn(() => new Promise<boolean>(() => {})),
				refreshHeartbeats: vi.fn(async () => {}),
				loadStartupNotices: vi.fn(),
				rows: [],
				workingIconFrame: 0,
			};
			const connect = vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue();
			try {
				void AgentsViewMode.prototype.run.call(harness as unknown as AgentsViewMode);
				await vi.advanceTimersByTimeAsync(1000);
				expect(refreshSessions).toHaveBeenCalledTimes(2);
			} finally {
				connect.mockRestore();
				clearInterval((harness as { pollTimer?: NodeJS.Timeout }).pollTimer);
				clearInterval((harness as { heartbeatPollTimer?: NodeJS.Timeout }).heartbeatPollTimer);
				clearInterval((harness as { animationTimer?: NodeJS.Timeout }).animationTimer);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test("an older overlapping live poll cannot overwrite the newer response", async () => {
		let resolveOld: ((value: unknown) => void) | undefined;
		const oldResponse = new Promise((resolve) => {
			resolveOld = resolve;
		});
		const newer = summary("new");
		const older = summary("old");
		const client = {
			isConnected: true,
			request: vi
				.fn()
				.mockReturnValueOnce(oldResponse)
				.mockResolvedValueOnce({ success: true, data: { sessions: [newer] } }),
		};
		const applySessionList = vi.fn();
		const harness = {
			reconnectPromise: undefined,
			daemonShutdownReceived: false,
			options: {},
			liveCatalogGeneration: 0,
			requireClient: () => client,
			applySessionList,
			setStatusMessage: vi.fn(),
		};
		const refresh = Reflect.get(AgentsViewMode.prototype, "refreshSessions") as (
			this: typeof harness,
		) => Promise<boolean>;

		const oldPoll = refresh.call(harness);
		await refresh.call(harness);
		resolveOld?.({ success: true, data: { sessions: [older] } });
		await oldPoll;

		expect(applySessionList).toHaveBeenCalledOnce();
		expect(applySessionList).toHaveBeenCalledWith([newer]);
	});
});
