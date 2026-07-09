import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type FakeEditor = {
	text: string;
	getText: () => string;
	getExpandedText: () => string;
	setText: (text: string) => void;
};

type FakeInteractiveMode = {
	ctrlCExitHintExpiresAt: number;
	ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined;
	isShuttingDown: boolean;
	editor: FakeEditor;
	connectionState: {
		isStreaming: boolean;
		isCompacting: boolean;
		isBashRunning: boolean;
		retryAttempt: number;
	};
	connectionQueue: { steering: string[]; followUp: string[] };
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	agentConnection: {
		abort: Mock;
		clearQueue: Mock;
		abortAndClearQueue: Mock;
		abortRetry: Mock;
		abortCompaction: Mock;
		abortBranchSummary: Mock;
		abortBash: Mock;
	};
	childAgentSummary: { invalidate: Mock };
	ui: { requestRender: Mock; onDebug?: () => void };
	restoreQueuedMessagesToEditor: Mock;
	updatePendingMessagesDisplay: Mock;
	shutdown: Mock;
	updateEditorBorderColor: Mock;
	defaultEditor?: {
		onAction: Mock;
		onEscape?: () => void;
		onCtrlD?: () => void;
		onPasteImage?: () => void;
		onMoveBelowPrompt?: () => boolean;
		onChange?: (text: string) => void;
	};
	keybindings?: KeybindingsManager;
	handleDebugCommand?: Mock;
};

function createEditor(text = ""): FakeEditor {
	const editor: FakeEditor = {
		text,
		getText() {
			return this.text;
		},
		getExpandedText() {
			return this.text;
		},
		setText(nextText: string) {
			this.text = nextText;
		},
	};
	return editor;
}

function createInteractiveFake(options: {
	editorText?: string;
	streaming?: boolean;
	compacting?: boolean;
	bashRunning?: boolean;
	retryAttempt?: number;
}): FakeInteractiveMode {
	const editor = createEditor(options.editorText ?? "");
	const fake: FakeInteractiveMode = {
		ctrlCExitHintExpiresAt: 0,
		ctrlCExitHintTimer: undefined,
		isShuttingDown: false,
		editor,
		connectionState: {
			isStreaming: options.streaming ?? false,
			isCompacting: options.compacting ?? false,
			isBashRunning: options.bashRunning ?? false,
			retryAttempt: options.retryAttempt ?? 0,
		},
		connectionQueue: { steering: [], followUp: [] },
		compactionQueuedMessages: [],
		agentConnection: {
			abort: vi.fn().mockResolvedValue(undefined),
			clearQueue: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
			abortAndClearQueue: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
			abortRetry: vi.fn(),
			abortCompaction: vi.fn(),
			abortBranchSummary: vi.fn(),
			abortBash: vi.fn(),
		},
		childAgentSummary: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		restoreQueuedMessagesToEditor: vi.fn().mockResolvedValue(0),
		updatePendingMessagesDisplay: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		updateEditorBorderColor: vi.fn(),
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

describe("InteractiveMode Ctrl+C flow", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-08T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("interrupts streaming and shows the exit hint on first Ctrl+C", () => {
		const mode = createInteractiveFake({ streaming: true });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.restoreQueuedMessagesToEditor).toHaveBeenCalledWith({ abort: true });
		expect(mode.shutdown).not.toHaveBeenCalled();
		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBe(
			"Press Ctrl+C again to exit",
		);
	});

	it("interrupts bash and streaming on the same Ctrl+C", () => {
		const mode = createInteractiveFake({ streaming: true, bashRunning: true });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.agentConnection.abortBash).toHaveBeenCalledTimes(1);
		expect(mode.restoreQueuedMessagesToEditor).toHaveBeenCalledWith({ abort: true });
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("restores queued messages through the atomic abort-and-clear path", async () => {
		const mode = createInteractiveFake({ editorText: "draft" });
		mode.agentConnection.abortAndClearQueue.mockResolvedValue({
			steering: ["steer"],
			followUp: ["follow"],
		});

		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor");
		const restored = await restoreQueuedMessagesToEditor.call(mode, { abort: true });

		expect(restored).toBe(2);
		expect(mode.agentConnection.abortAndClearQueue).toHaveBeenCalledTimes(1);
		expect(mode.agentConnection.clearQueue).not.toHaveBeenCalled();
		expect(mode.agentConnection.abort).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("steer\n\nfollow\n\ndraft");
	});

	it("exits on the second Ctrl+C while the hint is visible", () => {
		const mode = createInteractiveFake({ streaming: true });
		const handleCtrlC = Reflect.get(InteractiveMode.prototype, "handleCtrlC");

		handleCtrlC.call(mode);
		handleCtrlC.call(mode);

		expect(mode.restoreQueuedMessagesToEditor).toHaveBeenCalledTimes(1);
		expect(mode.shutdown).toHaveBeenCalledTimes(1);
	});

	it("clears the exit hint after two seconds", async () => {
		const mode = createInteractiveFake({ editorText: "draft" });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);
		expect(mode.editor.getText()).toBe("draft");
		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBe(
			"Press Ctrl+C again to exit",
		);

		await vi.advanceTimersByTimeAsync(2000);

		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBeUndefined();
		expect(mode.childAgentSummary.invalidate).toHaveBeenCalled();
		expect(mode.ui.requestRender).toHaveBeenCalled();
	});

	it("preserves idle draft input on first Ctrl+C", () => {
		const mode = createInteractiveFake({ editorText: "draft" });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.editor.getText()).toBe("draft");
		expect(mode.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("makes Escape clear input without aborting the agent", () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({ editorText: "draft", streaming: true });
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		expect(defaultEditor.onEscape).toBeDefined();
		defaultEditor.onEscape?.();

		expect(mode.editor.getText()).toBe("");
		expect(mode.agentConnection.abortRetry).not.toHaveBeenCalled();
		expect(mode.agentConnection.abortCompaction).not.toHaveBeenCalled();
		expect(mode.agentConnection.abortBranchSummary).not.toHaveBeenCalled();
		expect(mode.agentConnection.abortBash).not.toHaveBeenCalled();
		expect(mode.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
	});
});
