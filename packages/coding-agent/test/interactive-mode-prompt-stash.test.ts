import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it, type Mock, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { ClientPromptStashStore, type PromptStashState } from "../src/modes/interactive/prompt-stash-state.js";

type FakePasteSnapshot = {
	pastes: readonly (readonly [number, string])[];
	pasteCounter: number;
};

type PromptStash = {
	text: string;
	expandedText?: string;
	pasteSnapshot?: FakePasteSnapshot;
	images?: readonly (readonly [number, ImageContent])[];
};

type FakeEditor = {
	text: string;
	expandedText: string;
	history: string[];
	pasteSnapshot?: FakePasteSnapshot;
	restoredPasteSnapshot?: FakePasteSnapshot;
	onSubmit?: (text: string) => void | Promise<void>;
	clearHistory?: Mock;
	getText: () => string;
	getExpandedText: () => string;
	getPasteSnapshot: () => FakePasteSnapshot | undefined;
	restorePasteSnapshot?: (snapshot: FakePasteSnapshot) => void;
	setText: (text: string) => void;
	addToHistory: Mock;
	getHistory: () => readonly string[];
};

type PromptStashHarness = {
	promptStash?: PromptStash;
	editor: FakeEditor;
	showStatus: Mock;
	clearShortcutGuide: Mock;
};

type PromptStashLiveMarkerHarness = PromptStashHarness & {
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	connectionQueue: { steering: string[]; followUp: string[] };
};

type SharedPromptStashHarness = PromptStashHarness & {
	promptStashStore: ClientPromptStashStore;
	promptStashSessionId: string;
	promptStashState: PromptStashState;
	pastedImages: Map<number, ImageContent>;
	nextImageMarkerId: number;
};

type ResetHarness = PromptStashLiveMarkerHarness & {
	chatContainer: { clear: Mock };
	shortcutGuideContainer: { clear: Mock };
	pendingMessagesContainer: { clear: Mock };
	queuedMessagesContainer: { clear: Mock };
	defaultEditor: FakeEditor;
	pastedImages: Map<number, unknown>;
	streamingComponent?: unknown;
	streamingMessage?: unknown;
	activeBashComponent?: { setComplete: Mock };
	pendingBashComponents: unknown[];
	activityTracker: { reset: Mock };
	contextUsageTokenBaseline: number;
	agentRunFileChanges: Map<string, unknown>;
	recapContainer: { clear: Mock };
	ui: { requestRender: Mock };
	ipythonToolComponents: Map<string, unknown>;
	lateIpythonSentAgentMessages: Map<string, unknown>;
	resetPendingToolState: Mock;
	resetChildAgentInspector: Mock;
	setGoalAnnouncementBaseline: Mock;
	getGoalState: Mock<() => unknown>;
	syncGoalTray: Mock;
};

type SubmitHarness = PromptStashHarness & {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	sideQuestionContainer: { clear: Mock };
	isAgentCompacting: () => boolean;
	isAgentStreaming: () => boolean;
	flushPendingBashComponents: Mock;
	onInputCallback: Mock;
};

type PromptStashMethods = {
	bindPromptStashSession: (this: SharedPromptStashHarness, sessionId: string) => void;
	handleFollowUp: (this: SubmitHarness) => Promise<void>;
	handlePromptStash: (this: PromptStashHarness) => void;
	hydratePromptStash: (this: SharedPromptStashHarness) => void;
	resetCurrentSessionRenderState: (this: ResetHarness, options?: { clearPromptStash?: boolean }) => void;
	restorePromptStashIfEditorEmpty: (this: PromptStashHarness, stash?: PromptStash) => boolean;
	liveImageMarkerIds: (this: PromptStashLiveMarkerHarness) => Set<number>;
	setupEditorSubmitHandler: (this: SubmitHarness) => void;
};

const interactiveModeMethods = InteractiveMode.prototype as unknown as PromptStashMethods;

function createEditor(
	options: { text?: string; expandedText?: string; history?: string[]; pasteSnapshot?: FakePasteSnapshot } = {},
): FakeEditor {
	const editor: FakeEditor = {
		text: options.text ?? "",
		expandedText: options.expandedText ?? options.text ?? "",
		history: options.history ?? [],
		pasteSnapshot: options.pasteSnapshot,
		getText() {
			return this.text;
		},
		getExpandedText() {
			return this.expandedText;
		},
		getPasteSnapshot() {
			return this.pasteSnapshot;
		},
		restorePasteSnapshot(snapshot: FakePasteSnapshot) {
			this.restoredPasteSnapshot = snapshot;
			this.pasteSnapshot = snapshot;
		},
		setText(nextText: string) {
			this.text = nextText;
			this.expandedText = nextText;
		},
		addToHistory: vi.fn(),
		getHistory() {
			return this.history;
		},
		clearHistory: vi.fn(function (this: FakeEditor) {
			this.history = [];
		}),
	};
	return editor;
}

function createPromptStashHarness(
	options: { text?: string; expandedText?: string; stash?: string; pasteSnapshot?: FakePasteSnapshot } = {},
) {
	const harness: PromptStashHarness = {
		promptStash: options.stash ? { text: options.stash, pasteSnapshot: options.pasteSnapshot } : undefined,
		editor: createEditor({
			text: options.text,
			expandedText: options.expandedText,
			pasteSnapshot: options.pasteSnapshot,
		}),
		showStatus: vi.fn(),
		clearShortcutGuide: vi.fn(),
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

function createSharedPromptStashHarness(
	store: ClientPromptStashStore,
	sessionId: string,
	options: {
		text?: string;
		expandedText?: string;
		pasteSnapshot?: FakePasteSnapshot;
		pastedImages?: readonly (readonly [number, ImageContent])[];
	} = {},
): SharedPromptStashHarness {
	const harness = {
		promptStashStore: store,
		promptStashSessionId: sessionId,
		promptStashState: store.forSession(sessionId),
		editor: createEditor(options),
		showStatus: vi.fn(),
		clearShortcutGuide: vi.fn(),
		pastedImages: new Map(options.pastedImages),
		nextImageMarkerId: 1,
	} as SharedPromptStashHarness;
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

describe("InteractiveMode prompt stash", () => {
	it("uses Ctrl+S as the default configurable stash keybinding", () => {
		const keybindings = new KeybindingsManager();

		expect(keybindings.getKeys("app.prompt.stash")).toEqual(["ctrl+s"]);
	});

	it("isolates stashes for separate TUI clients attached to the same session", () => {
		const firstClient = new ClientPromptStashStore();
		const secondClient = new ClientPromptStashStore();
		const firstState = firstClient.forSession("shared-session");
		firstState.stash = { text: "first client draft" };

		expect(firstClient.forSession("shared-session")).toBe(firstState);
		expect(secondClient.forSession("shared-session").stash).toBeUndefined();

		const emptyState = firstClient.forSession("empty-session");
		firstClient.release("empty-session", emptyState);
		expect(firstClient.forSession("empty-session")).not.toBe(emptyState);
	});

	it("restores a session stash after recreating its interactive mode", () => {
		const store = new ClientPromptStashStore();
		const pasteSnapshot: FakePasteSnapshot = {
			pastes: [[1, "line one\nline two"]],
			pasteCounter: 1,
		};
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const firstMode = createSharedPromptStashHarness(store, "session-a", {
			text: "draft [image #7] [paste #1 +2 lines]",
			expandedText: "draft [image #7] line one\nline two",
			pasteSnapshot,
			pastedImages: [[7, image]],
		});

		interactiveModeMethods.handlePromptStash.call(firstMode);

		const reopenedMode = createSharedPromptStashHarness(store, "session-a");
		interactiveModeMethods.hydratePromptStash.call(reopenedMode);

		expect(reopenedMode.promptStash?.text).toBe("draft [image #7] [paste #1 +2 lines]");
		expect(reopenedMode.pastedImages.get(7)).toBe(image);
		expect(reopenedMode.nextImageMarkerId).toBe(8);

		interactiveModeMethods.restorePromptStashIfEditorEmpty.call(reopenedMode);

		expect(reopenedMode.editor.getText()).toBe("draft [image #7] [paste #1 +2 lines]");
		expect(reopenedMode.editor.restoredPasteSnapshot).toBe(pasteSnapshot);
		expect(reopenedMode.promptStashState.stash).toBeUndefined();
	});

	it("rebinds prompt stash state when the connected session changes", () => {
		const store = new ClientPromptStashStore();
		const firstState = store.forSession("session-a");
		const secondState = store.forSession("session-b");
		firstState.stash = { text: "session a draft" };
		secondState.stash = { text: "session b draft" };
		const mode = createSharedPromptStashHarness(store, "session-a");

		interactiveModeMethods.bindPromptStashSession.call(mode, "session-b");

		expect(mode.promptStash?.text).toBe("session b draft");
		expect(firstState.stash?.text).toBe("session a draft");
	});

	it("stashes editor text without expanding paste markers", () => {
		const pasteSnapshot: FakePasteSnapshot = {
			pastes: [[1, "line one\nline two"]],
			pasteCounter: 1,
		};
		const mode = createPromptStashHarness({
			text: "[paste #1 +12 lines]",
			expandedText: "line one\nline two",
			pasteSnapshot,
		});

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash).toEqual({
			text: "[paste #1 +12 lines]",
			expandedText: "line one\nline two",
			pasteSnapshot,
		});
		expect(mode.editor.getText()).toBe("");
		expect(mode.showStatus).toHaveBeenCalledWith("Stashed prompt");

		interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode);

		expect(mode.editor.getText()).toBe("[paste #1 +12 lines]");
		expect(mode.editor.restoredPasteSnapshot).toBe(pasteSnapshot);
	});

	it("restores expanded paste text when paste snapshots are unsupported", () => {
		const pasteSnapshot: FakePasteSnapshot = {
			pastes: [[1, "line one\nline two"]],
			pasteCounter: 1,
		};
		const mode = createPromptStashHarness({
			text: "[paste #1 +12 lines]",
			expandedText: "line one\nline two",
			pasteSnapshot,
		});

		interactiveModeMethods.handlePromptStash.call(mode);
		mode.editor.restorePasteSnapshot = undefined;

		const restored = interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode);

		expect(restored).toBe(true);
		expect(mode.editor.getText()).toBe("line one\nline two");
		expect(mode.editor.restoredPasteSnapshot).toBeUndefined();
	});

	it("restores a stashed prompt when the editor is empty", () => {
		const mode = createPromptStashHarness({ stash: "half-written draft" });

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
		expect(mode.showStatus).toHaveBeenCalledWith("Restored stashed prompt");
	});

	it("does not restore an older captured stash after a newer stash is created", () => {
		const mode = createPromptStashHarness({ stash: "older draft" });
		const olderStash = mode.promptStash;
		const newerStash = { text: "newer draft" };
		mode.promptStash = newerStash;

		const restored = interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode, olderStash);

		expect(restored).toBe(false);
		expect(mode.promptStash).toBe(newerStash);
		expect(mode.editor.getText()).toBe("");
		expect(mode.showStatus).not.toHaveBeenCalledWith("Restored stashed prompt");
	});

	it("does not overwrite an existing stash", () => {
		const mode = createPromptStashHarness({ text: "second draft", stash: "first draft" });

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash?.text).toBe("first draft");
		expect(mode.editor.getText()).toBe("second draft");
		expect(mode.showStatus).toHaveBeenCalledWith("Prompt stash already has a draft");
	});

	it("restores a stashed prompt after normal message submission clears the editor", async () => {
		const mode: SubmitHarness = {
			...createPromptStashHarness({ stash: "half-written draft" }),
			defaultEditor: {},
			sideQuestionContainer: { clear: vi.fn() },
			isAgentCompacting: () => false,
			isAgentStreaming: () => false,
			flushPendingBashComponents: vi.fn(),
			onInputCallback: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		interactiveModeMethods.setupEditorSubmitHandler.call(mode);

		await mode.defaultEditor.onSubmit?.("temporary prompt");

		expect(mode.onInputCallback).toHaveBeenCalledWith("temporary prompt");
		expect(mode.editor.addToHistory).toHaveBeenCalledWith("temporary prompt");
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("restores a stashed prompt after a session reset clears prompt state", async () => {
		let mode: SubmitHarness & { handleClearCommand: Mock<() => Promise<void>> };
		mode = {
			...createPromptStashHarness({ stash: "half-written draft" }),
			defaultEditor: {},
			sideQuestionContainer: { clear: vi.fn() },
			isAgentCompacting: () => false,
			isAgentStreaming: () => false,
			flushPendingBashComponents: vi.fn(),
			onInputCallback: vi.fn(),
			handleClearCommand: vi.fn(async () => {
				mode.editor.setText("");
			}),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		interactiveModeMethods.setupEditorSubmitHandler.call(mode);

		await mode.defaultEditor.onSubmit?.("/new");

		expect(mode.handleClearCommand).toHaveBeenCalled();
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("waits for async session selectors before restoring a stashed prompt", async () => {
		let resolveSelector: () => void = () => {};
		const selectorDone = new Promise<void>((resolve) => {
			resolveSelector = resolve;
		});
		let mode: SubmitHarness & { showUserMessageSelector: Mock<() => Promise<void>> };
		mode = {
			...createPromptStashHarness({ stash: "half-written draft" }),
			defaultEditor: {},
			sideQuestionContainer: { clear: vi.fn() },
			isAgentCompacting: () => false,
			isAgentStreaming: () => false,
			flushPendingBashComponents: vi.fn(),
			onInputCallback: vi.fn(),
			showUserMessageSelector: vi.fn(async () => {
				await selectorDone;
				mode.editor.setText("");
			}),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		interactiveModeMethods.setupEditorSubmitHandler.call(mode);

		const submit = mode.defaultEditor.onSubmit?.("/fork");
		await Promise.resolve();
		resolveSelector();
		await submit;

		expect(mode.showUserMessageSelector).toHaveBeenCalled();
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("restores a stashed prompt after idle follow-up slash commands clear the editor", async () => {
		let resolveSettings: () => void = () => {};
		const settingsDone = new Promise<void>((resolve) => {
			resolveSettings = resolve;
		});
		const mode: SubmitHarness & { showSettingsSelector: Mock<() => Promise<void>> } = {
			...createPromptStashHarness({ text: "/settings", stash: "half-written draft" }),
			defaultEditor: {},
			sideQuestionContainer: { clear: vi.fn() },
			isAgentCompacting: () => false,
			isAgentStreaming: () => false,
			flushPendingBashComponents: vi.fn(),
			onInputCallback: vi.fn(),
			showSettingsSelector: vi.fn(() => settingsDone),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		interactiveModeMethods.setupEditorSubmitHandler.call(mode);
		mode.editor.onSubmit = mode.defaultEditor.onSubmit;

		const followUp = interactiveModeMethods.handleFollowUp.call(mode);
		await Promise.resolve();
		resolveSettings();
		await followUp;

		expect(mode.showSettingsSelector).toHaveBeenCalled();
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("drops queued image references from old sessions while keeping stashed images", () => {
		const base = createPromptStashHarness({ stash: "keep [image #1]" });
		const mode: ResetHarness = {
			...base,
			defaultEditor: base.editor,
			compactionQueuedMessages: [],
			connectionQueue: { steering: ["old [image #2]"], followUp: [] },
			chatContainer: { clear: vi.fn() },
			shortcutGuideContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			queuedMessagesContainer: { clear: vi.fn() },
			pastedImages: new Map<number, unknown>([
				[1, {}],
				[2, {}],
			]),
			pendingBashComponents: [],
			activityTracker: { reset: vi.fn() },
			contextUsageTokenBaseline: 1,
			agentRunFileChanges: new Map(),
			recapContainer: { clear: vi.fn() },
			ui: { requestRender: vi.fn() },
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			resetPendingToolState: vi.fn(),
			resetChildAgentInspector: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(() => undefined),
			syncGoalTray: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		interactiveModeMethods.resetCurrentSessionRenderState.call(mode);

		expect(mode.connectionQueue).toEqual({ steering: [], followUp: [] });
		expect(mode.promptStash?.text).toBe("keep [image #1]");
		expect(mode.pastedImages.has(1)).toBe(true);
		expect(mode.pastedImages.has(2)).toBe(false);
	});

	it("clears stashed prompt state when explicitly requested", () => {
		const base = createPromptStashHarness({ stash: "drop [image #1]" });
		const mode: ResetHarness = {
			...base,
			defaultEditor: base.editor,
			compactionQueuedMessages: [],
			connectionQueue: { steering: [], followUp: [] },
			chatContainer: { clear: vi.fn() },
			shortcutGuideContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			queuedMessagesContainer: { clear: vi.fn() },
			pastedImages: new Map<number, unknown>([[1, {}]]),
			pendingBashComponents: [],
			activityTracker: { reset: vi.fn() },
			contextUsageTokenBaseline: 1,
			agentRunFileChanges: new Map(),
			recapContainer: { clear: vi.fn() },
			ui: { requestRender: vi.fn() },
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			resetPendingToolState: vi.fn(),
			resetChildAgentInspector: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(() => undefined),
			syncGoalTray: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		interactiveModeMethods.resetCurrentSessionRenderState.call(mode, { clearPromptStash: true });

		expect(mode.promptStash).toBeUndefined();
		expect(mode.pastedImages.has(1)).toBe(false);
	});

	it("restores failed follow-up text without dropping the stashed prompt", async () => {
		const error = new Error("send failed");
		const mode: SubmitHarness & {
			agentConnection: { prompt: Mock<() => Promise<void>> };
			collectImagesFor: Mock;
			updatePendingMessagesDisplay: Mock;
			ui: { requestRender: Mock };
		} = {
			...createPromptStashHarness({ text: "quick follow-up", stash: "half-written draft" }),
			defaultEditor: {},
			sideQuestionContainer: { clear: vi.fn() },
			isAgentCompacting: () => false,
			isAgentStreaming: () => true,
			flushPendingBashComponents: vi.fn(),
			onInputCallback: vi.fn(),
			agentConnection: {
				prompt: vi.fn(async () => {
					throw error;
				}),
			},
			collectImagesFor: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		await expect(interactiveModeMethods.handleFollowUp.call(mode)).rejects.toThrow(error);

		expect(mode.editor.getText()).toBe("quick follow-up");
		expect(mode.promptStash?.text).toBe("half-written draft");
	});

	it("keeps image markers in a stashed prompt live", () => {
		const mode: PromptStashLiveMarkerHarness = {
			...createPromptStashHarness({ stash: "look at [image #7]" }),
			compactionQueuedMessages: [],
			connectionQueue: { steering: [], followUp: [] },
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		expect(interactiveModeMethods.liveImageMarkerIds.call(mode)).toEqual(new Set([7]));
	});
});
