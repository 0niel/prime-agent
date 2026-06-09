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
		retryAttempt: number;
	};
	agentConnection: {
		abortRetry: Mock;
		abortCompaction: Mock;
		abortBranchSummary: Mock;
	};
	childAgentSummary: { invalidate: Mock };
	ui: { requestRender: Mock; onDebug?: () => void };
	restoreQueuedMessagesToEditor: Mock;
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
			retryAttempt: options.retryAttempt ?? 0,
		},
		agentConnection: {
			abortRetry: vi.fn(),
			abortCompaction: vi.fn(),
			abortBranchSummary: vi.fn(),
		},
		childAgentSummary: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		restoreQueuedMessagesToEditor: vi.fn().mockResolvedValue(0),
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
		expect(mode.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
	});
});
