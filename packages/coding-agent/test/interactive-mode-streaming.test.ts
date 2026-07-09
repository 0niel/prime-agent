import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type HandleEventThis = {
	isInitialized: boolean;
	settingsManager: { getShowTerminalProgress(): boolean };
	footer: { invalidate(): void };
	ui: TUI;
	chatContainer: Container;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	updateConnectionStateFromEvent(event: AgentConnectionSessionEvent): void;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getOrCreatePendingToolComponent(): Promise<ToolExecutionComponent | undefined>;
	getRetryAttempt(): number;
	stopWorkingLoader(): void;
	resetPendingToolState(): void;
	checkShutdownRequested(): Promise<void>;
};

type HandleEvent = (this: HandleEventThis, event: AgentConnectionSessionEvent) => Promise<void>;
type GetUserInput = (this: {
	returnToAgentsViewRequested: boolean;
	onInputCallback?: (text: string | undefined) => void;
}) => Promise<string | undefined>;
type HandleSubagentSummaryChatAction = (
	this: {
		keybindings: { matches(data: string, action: string): boolean };
		editor: { handleInput(data: string): void };
		focusEditor(): void;
		toggleToolOutputExpansion(): void;
		toggleThinkingBlockVisibility(): void;
	},
	data: string,
) => void;

function createFakeInteractiveModeThis(): HandleEventThis {
	const fakeThis = {
		isInitialized: true,
		settingsManager: { getShowTerminalProgress: () => false },
		footer: { invalidate: vi.fn() },
		activityTracker: new AgentActivityTracker(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
		chatContainer: new Container(),
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingTools: new Map<string, ToolExecutionComponent>(),
		updateConnectionStateFromEvent: vi.fn(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getOrCreatePendingToolComponent: vi.fn(async () => undefined),
		getRetryAttempt: () => 0,
		stopWorkingLoader: vi.fn(),
		resetPendingToolState: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode streaming events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders assistant updates when attaching after message_start", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("renders assistant end events when attaching after all updates", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("keeps attached partial assistant text when agent_end arrives without message_end", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("resolves input immediately after return to agents view was requested", async () => {
		const getUserInput = (InteractiveMode.prototype as unknown as { getUserInput: GetUserInput }).getUserInput;

		await expect(getUserInput.call({ returnToAgentsViewRequested: true })).resolves.toBeUndefined();
	});

	test("forwards typed keys from focused subagent summary back to the editor", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn(() => false) },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "x");

		expect(fakeThis.focusEditor).toHaveBeenCalledOnce();
		expect(fakeThis.editor.handleInput).toHaveBeenCalledWith("x");
		expect(fakeThis.toggleToolOutputExpansion).not.toHaveBeenCalled();
		expect(fakeThis.toggleThinkingBlockVisibility).not.toHaveBeenCalled();
	});

	test("keeps focused subagent summary shortcuts in the chat surface", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn((_data: string, action: string) => action === "app.tools.expand") },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "\x0f");

		expect(fakeThis.toggleToolOutputExpansion).toHaveBeenCalledOnce();
		expect(fakeThis.focusEditor).not.toHaveBeenCalled();
		expect(fakeThis.editor.handleInput).not.toHaveBeenCalled();
	});
});
