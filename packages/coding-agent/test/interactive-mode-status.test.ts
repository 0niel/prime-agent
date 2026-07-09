import { homedir } from "node:os";
import * as path from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	Container,
	resetCapabilitiesCache,
	setCapabilities,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { formatNoModelsAvailableMessage } from "../src/core/auth-guidance.js";
import type { AuthStatus } from "../src/core/auth-storage.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.js";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import type {
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
	AgentConnectionModel,
	AgentConnectionResourceDiagnostic,
	AgentConnectionResourceSnapshot,
	AgentConnectionSessionEvent,
	AgentConnectionSourceInfo,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { formatSplashCwd, InteractiveMode, truncatePathMiddle } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function createConnectionState(overrides: Partial<AgentConnectionState> = {}): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/tmp/project",
		thinkingLevel: "medium",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session-1",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		compactionCount: 0,
		goal: emptyGoalState(),
		scopedModels: [],
		activeToolNames: ["ipython"],
		contextUsage: undefined,
		...overrides,
	};
}

describe("InteractiveMode update notifications", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows the slash update command in one compact line", () => {
		const chatContainer = new Container();
		const fakeThis = {
			chatContainer,
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveMode;

		InteractiveMode.prototype.showNewVersionNotification.call(fakeThis, "1.2.3");

		const output = normalizeRenderedOutput(chatContainer);
		expect(chatContainer.children).toHaveLength(1);
		expect(output.split("\n")).toHaveLength(1);
		expect(output).toContain("Update available:");
		expect(output).toContain("v1.2.3");
		expect(output).toContain("/update");
		expect(output).not.toContain("prime-agent update");
		expect(output).not.toContain("pi update");
		expect(output).not.toContain("Changelog:");
	});

	test("shows package updates in one compact line", () => {
		const chatContainer = new Container();
		const fakeThis = {
			chatContainer,
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveMode;

		InteractiveMode.prototype.showPackageUpdateNotification.call(fakeThis, ["npm:@foo/bar"]);

		const output = normalizeRenderedOutput(chatContainer);
		expect(chatContainer.children).toHaveLength(1);
		expect(output.split("\n")).toHaveLength(1);
		expect(output).toContain("Package updates available:");
		expect(output).toContain("npm:@foo/bar");
		expect(output).toContain("/update --extensions");
		expect(output).not.toContain("prime-agent update");
		expect(output).not.toContain("pi update");
	});
});

type ExtensionFixture = {
	path: string;
	sourceInfo?: AgentConnectionSourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.renderSessionContext", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders historical tool result images as fallbacks instead of replaying inline payloads", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const chatContainer = new Container();
			const fakeThis: any = {
				pendingTools: new Map(),
				toolOutputExpanded: false,
				chatContainer,
				footer: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				resetPendingToolState: vi.fn(),
				preloadToolDefinitions: vi.fn(async () => {}),
				settingsManager: {
					getShowImages: () => true,
					getImageWidthCells: () => 60,
				},
				getCachedToolDefinition: () => undefined,
				getCurrentCwd: () => process.cwd(),
				getRetryAttempt: () => 0,
				ui: { requestRender: vi.fn() },
				addMessageToChat: vi.fn(() => {
					chatContainer.addChild({ render: () => ["assistant"], invalidate: () => {} });
				}),
			};

			await (InteractiveMode as any).prototype.renderSessionContext.call(fakeThis, {
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", name: "custom_tool", id: "tool-1", arguments: {} }],
					},
					{
						role: "toolResult",
						toolCallId: "tool-1",
						content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
						isError: false,
					},
				],
				thinkingLevel: "medium",
				model: null,
			});

			const rendered = renderAll(chatContainer);
			expect(rendered).not.toContain("\x1b_G");
			expect(normalizeRenderedOutput(chatContainer)).toContain("[Image: [image/png]]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("keeps pending history tool calls eligible for live inline image updates", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const chatContainer = new Container();
			const pendingTools = new Map<string, ToolExecutionComponent>();
			const fakeThis: any = {
				pendingTools,
				toolOutputExpanded: false,
				chatContainer,
				footer: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				resetPendingToolState: vi.fn(),
				preloadToolDefinitions: vi.fn(async () => {}),
				settingsManager: {
					getShowImages: () => true,
					getImageWidthCells: () => 60,
				},
				getCachedToolDefinition: () => undefined,
				getCurrentCwd: () => process.cwd(),
				getRetryAttempt: () => 0,
				ui: { requestRender: vi.fn() },
				addMessageToChat: vi.fn(() => {
					chatContainer.addChild({ render: () => ["assistant"], invalidate: () => {} });
				}),
			};

			await (InteractiveMode as any).prototype.renderSessionContext.call(fakeThis, {
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", name: "custom_tool", id: "tool-1", arguments: {} }],
					},
				],
				thinkingLevel: "medium",
				model: null,
			});

			const component = pendingTools.get("tool-1");
			expect(component).toBeDefined();
			component!.updateResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });

			expect(component!.render(120).join("\n")).toContain("\x1b_G");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

type SubmitHandlerHarness = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { setText: (text: string) => void; addToHistory?: (text: string) => void };
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	isBashRunning: () => boolean;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	agentConnection: {
		prompt: (message: string) => Promise<void>;
		executeBash: (command: string, options?: { excludeFromContext?: boolean }) => Promise<void>;
		getState: () => Promise<{ isBashRunning: boolean }>;
	};
};

function createSubmitHandlerHarness(overrides: Partial<SubmitHandlerHarness> = {}): SubmitHandlerHarness {
	const fakeThis: SubmitHandlerHarness = {
		defaultEditor: {},
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		showWarning: vi.fn(),
		showError: vi.fn(),
		isBashRunning: () => false,
		patchConnectionState: vi.fn(),
		agentConnection: {
			prompt: vi.fn(async () => {}),
			executeBash: vi.fn(async () => {}),
			getState: vi.fn(async () => ({ isBashRunning: false })),
		},
		...overrides,
	};
	(
		InteractiveMode.prototype as unknown as {
			setupEditorSubmitHandler(this: SubmitHandlerHarness): void;
		}
	).setupEditorSubmitHandler.call(fakeThis);
	return fakeThis;
}

describe("InteractiveMode submit handling", () => {
	test("routes ! shortcuts to executeBash on the agent connection", async () => {
		const fakeThis = createSubmitHandlerHarness();

		await fakeThis.defaultEditor.onSubmit?.("!pwd");

		expect(fakeThis.agentConnection.executeBash).toHaveBeenCalledWith("pwd", { excludeFromContext: false });
		expect(fakeThis.editor.addToHistory).toHaveBeenCalledWith("!pwd");
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
		expect(fakeThis.agentConnection.prompt).not.toHaveBeenCalled();
	});

	test("routes !! shortcuts to executeBash with excludeFromContext", async () => {
		const fakeThis = createSubmitHandlerHarness();

		await fakeThis.defaultEditor.onSubmit?.("!!git status");

		expect(fakeThis.agentConnection.executeBash).toHaveBeenCalledWith("git status", { excludeFromContext: true });
		expect(fakeThis.agentConnection.prompt).not.toHaveBeenCalled();
	});

	test("ignores bare ! and !! input instead of prompting the agent", async () => {
		const fakeThis = createSubmitHandlerHarness();

		await fakeThis.defaultEditor.onSubmit?.("!");
		await fakeThis.defaultEditor.onSubmit?.("!!");

		expect(fakeThis.agentConnection.executeBash).not.toHaveBeenCalled();
		expect(fakeThis.agentConnection.prompt).not.toHaveBeenCalled();
	});

	test("warns instead of executing when a bash command is already running", async () => {
		const fakeThis = createSubmitHandlerHarness({ isBashRunning: () => true });

		await fakeThis.defaultEditor.onSubmit?.("!pwd");

		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining("A bash command is already running"));
		expect(fakeThis.agentConnection.executeBash).not.toHaveBeenCalled();
		expect(fakeThis.editor.setText).not.toHaveBeenCalled();
	});

	test("surfaces executeBash transport failures via showError", async () => {
		const fakeThis = createSubmitHandlerHarness({
			agentConnection: {
				prompt: vi.fn(async () => {}),
				executeBash: vi.fn(async () => {
					throw new Error("the daemon is running an older build; restart the daemon and try again");
				}),
				getState: vi.fn(async () => ({ isBashRunning: false })),
			},
		});

		await fakeThis.defaultEditor.onSubmit?.("!pwd");

		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("older build"));
		expect(fakeThis.patchConnectionState).toHaveBeenLastCalledWith({ isBashRunning: false });
	});

	test("re-syncs the bash flag from connection state when executeBash is rejected", async () => {
		const fakeThis = createSubmitHandlerHarness({
			agentConnection: {
				prompt: vi.fn(async () => {}),
				executeBash: vi.fn(async () => {
					throw new Error("A bash command is already running");
				}),
				// Another attached client holds the bash slot
				getState: vi.fn(async () => ({ isBashRunning: true })),
			},
		});

		await fakeThis.defaultEditor.onSubmit?.("!pwd");

		expect(fakeThis.patchConnectionState).toHaveBeenLastCalledWith({ isBashRunning: true });
	});
});

describe("InteractiveMode pending bash components", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const bashComponent = () => ({ render: () => [], invalidate: () => {} });

	test("keeps pending bash components visible across queue refreshes", () => {
		const pendingMessagesContainer = new Container();
		const component = bashComponent();
		const fakeThis = {
			pendingMessagesContainer,
			queuedMessagesContainer: new Container(),
			pendingBashComponents: [component],
			getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveMode;

		(
			InteractiveMode.prototype as unknown as { updatePendingMessagesDisplay(this: unknown): void }
		).updatePendingMessagesDisplay.call(fakeThis);

		expect(pendingMessagesContainer.children).toContain(component);
	});

	test("does not double-prefix labeled injected queue previews", () => {
		const queuedMessagesContainer = new Container();
		const fakeThis = {
			pendingMessagesContainer: new Container(),
			queuedMessagesContainer,
			pendingBashComponents: [],
			getAllQueuedMessages: () => ({
				steering: ["Heartbeat prompt: check steering", "Goal context: steer goal", "plain steering"],
				followUp: ["Heartbeat prompt: check status", "Goal context: continue goal", "plain follow-up"],
			}),
			getAppKeyDisplay: () => "Ctrl+Q",
		} as unknown as InteractiveMode;

		(
			InteractiveMode.prototype as unknown as { updatePendingMessagesDisplay(this: unknown): void }
		).updatePendingMessagesDisplay.call(fakeThis);

		const rendered = normalizeRenderedOutput(queuedMessagesContainer);
		expect(rendered).toContain("Heartbeat prompt: check steering");
		expect(rendered).not.toContain("Steering: Heartbeat prompt");
		expect(rendered).toContain("Goal context: steer goal");
		expect(rendered).not.toContain("Steering: Goal context");
		expect(rendered).toContain("Steering: plain steering");
		expect(rendered).toContain("Heartbeat prompt: check status");
		expect(rendered).not.toContain("Follow-up: Heartbeat prompt");
		expect(rendered).toContain("Goal context: continue goal");
		expect(rendered).not.toContain("Follow-up: Goal context");
		expect(rendered).toContain("Follow-up: plain follow-up");
	});

	test("flushes pending bash components from the pending area to chat", () => {
		const pendingMessagesContainer = new Container();
		const chatContainer = new Container();
		const component = bashComponent();
		pendingMessagesContainer.addChild(component);
		const fakeThis = {
			pendingMessagesContainer,
			chatContainer,
			pendingBashComponents: [component],
		} as unknown as InteractiveMode;

		(
			InteractiveMode.prototype as unknown as { flushPendingBashComponents(this: unknown): void }
		).flushPendingBashComponents.call(fakeThis);

		expect(pendingMessagesContainer.children).not.toContain(component);
		expect(chatContainer.children).toContain(component);
		expect((fakeThis as unknown as { pendingBashComponents: unknown[] }).pendingBashComponents).toHaveLength(0);
	});

	test("handles session events in emission order even when a handler suspends", async () => {
		type ConnectionListener = (event: { type: string; event: { type: string } }) => Promise<void>;
		let listener: ConnectionListener | undefined;
		const order: string[] = [];
		const fakeThis = {
			agentConnection: {
				subscribe: (l: ConnectionListener) => {
					listener = l;
					return () => {};
				},
			},
			sessionEventQueue: Promise.resolve(),
			showError: vi.fn(),
			handleEvent: async (event: { type: string }) => {
				order.push(`start:${event.type}`);
				if (event.type === "bash_start") {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				order.push(`end:${event.type}`);
			},
		} as unknown as InteractiveMode;

		(InteractiveMode.prototype as unknown as { subscribeToAgent(this: unknown): void }).subscribeToAgent.call(
			fakeThis,
		);

		const first = listener?.({ type: "session_event", event: { type: "bash_start" } });
		const second = listener?.({ type: "session_event", event: { type: "bash_end" } });
		await Promise.all([first, second]);

		expect(order).toEqual(["start:bash_start", "end:bash_start", "start:bash_end", "end:bash_end"]);
	});

	test("stops an orphaned bash loader when session render state resets", () => {
		const tuiStub = {
			terminal: { columns: 120, rows: 24 },
			requestRender: () => {},
		} as unknown as ConstructorParameters<typeof BashExecutionComponent>[1];
		const component = new BashExecutionComponent("sleep 99", tuiStub);
		const loader = (component as unknown as { loader: { intervalId: unknown } }).loader;
		expect(loader.intervalId).not.toBeNull();

		const editorStub = { clearHistory: vi.fn(), setText: vi.fn() };
		const fakeThis = {
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			queuedMessagesContainer: new Container(),
			compactionQueuedMessages: [],
			pastedImages: new Map(),
			liveImageMarkerIds: () => new Set(),
			defaultEditor: editorStub,
			editor: editorStub,
			streamingComponent: undefined,
			streamingMessage: undefined,
			activeBashComponent: component,
			pendingBashComponents: [component],
			activityTracker: { reset: vi.fn() },
			resetPendingToolState: vi.fn(),
			resetChildAgentInspector: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			syncGoalTray: vi.fn(),
			getGoalState: () => emptyGoalState(),
		} as unknown as InteractiveMode;

		(
			InteractiveMode.prototype as unknown as { resetCurrentSessionRenderState(this: unknown): void }
		).resetCurrentSessionRenderState.call(fakeThis);

		expect(loader.intervalId).toBeNull();
		expect((fakeThis as unknown as { activeBashComponent: unknown }).activeBashComponent).toBeUndefined();
	});
});

describe("InteractiveMode connection events", () => {
	test("clears extension UI when a connection-backed session is replaced", async () => {
		type SessionReplacedEvent = { type: "session_replaced"; state: AgentConnectionState; messages: [] };
		let listener: ((event: SessionReplacedEvent) => Promise<void> | void) | undefined;
		const fakeThis = {
			agentConnection: {
				subscribe: vi.fn((callback) => {
					listener = callback;
					return vi.fn();
				}),
			},
			resetExtensionUI: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			resetCurrentSessionRenderState: vi.fn(),
			rebindCurrentSession: vi.fn(async () => {}),
			renderInitialMessages: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
			handleEvent: vi.fn(),
			handleConnectionExtensionUiRequest: vi.fn(),
			showError: vi.fn(),
		};

		(InteractiveMode.prototype as unknown as { subscribeToAgent(this: typeof fakeThis): void }).subscribeToAgent.call(
			fakeThis,
		);

		const state = createConnectionState();
		await listener?.({ type: "session_replaced", state, messages: [] });

		const resetOrder = fakeThis.resetExtensionUI.mock.invocationCallOrder[0];
		const applySnapshotOrder = fakeThis.applyConnectionStateSnapshot.mock.invocationCallOrder[0];
		const resetRenderOrder = fakeThis.resetCurrentSessionRenderState.mock.invocationCallOrder[0];
		const rebindOrder = fakeThis.rebindCurrentSession.mock.invocationCallOrder[0];
		const renderMessagesOrder = fakeThis.renderInitialMessages.mock.invocationCallOrder[0];
		expect(resetOrder).toBeLessThan(applySnapshotOrder);
		expect(applySnapshotOrder).toBeLessThan(resetRenderOrder);
		expect(resetRenderOrder).toBeLessThan(rebindOrder);
		expect(rebindOrder).toBeLessThan(renderMessagesOrder);
		expect(fakeThis.applyConnectionStateSnapshot).toHaveBeenCalledWith(state);
		expect(fakeThis.rebindCurrentSession).toHaveBeenCalledWith();
		expect(fakeThis.renderInitialMessages).toHaveBeenCalledWith();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledWith();
	});
});

describe("InteractiveMode connection extension UI", () => {
	type ActiveConnectionExtensionUiRequest = { cancelLocal(): void };

	type ConnectionExtensionUiCancelHarness = {
		activeConnectionExtensionUiRequests: Map<string, ActiveConnectionExtensionUiRequest>;
		agentConnection: {
			respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void>;
		};
		showError(message: string): void;
		cancelActiveConnectionExtensionUiRequests(): void;
	};

	type ConnectionExtensionUiHandlerHarness = ConnectionExtensionUiCancelHarness & {
		resolveConnectionExtensionUiRequest(
			request: AgentConnectionExtensionUiRequest,
		): Promise<AgentConnectionExtensionUiResponse | undefined>;
		handleConnectionExtensionUiRequest(request: AgentConnectionExtensionUiRequest): Promise<void>;
	};

	const prototype = InteractiveMode.prototype as unknown as ConnectionExtensionUiHandlerHarness;

	test("reset cancellation responds to active connection UI requests", async () => {
		const cancelLocal = vi.fn();
		const fakeThis = Object.create(InteractiveMode.prototype) as ConnectionExtensionUiCancelHarness;
		fakeThis.activeConnectionExtensionUiRequests = new Map([["request-1", { cancelLocal }]]);
		fakeThis.agentConnection = {
			respondToExtensionUiRequest: vi.fn(async () => {}),
		};
		fakeThis.showError = vi.fn();

		prototype.cancelActiveConnectionExtensionUiRequests.call(fakeThis);
		await Promise.resolve();

		expect(fakeThis.activeConnectionExtensionUiRequests.size).toBe(0);
		expect(cancelLocal).toHaveBeenCalledTimes(1);
		expect(fakeThis.agentConnection.respondToExtensionUiRequest).toHaveBeenCalledWith("request-1", {
			cancelled: true,
		});
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("connection UI handler does not double respond after reset cancellation", async () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as ConnectionExtensionUiHandlerHarness;
		fakeThis.activeConnectionExtensionUiRequests = new Map();
		fakeThis.agentConnection = {
			respondToExtensionUiRequest: vi.fn(async () => {}),
		};
		fakeThis.showError = vi.fn();
		fakeThis.resolveConnectionExtensionUiRequest = vi.fn(
			() =>
				new Promise<AgentConnectionExtensionUiResponse | undefined>(() => {
					// Intentionally left pending until cancellation wins the race.
				}),
		);

		const request: AgentConnectionExtensionUiRequest = {
			id: "request-1",
			method: "select",
			payload: {},
		};
		const handling = prototype.handleConnectionExtensionUiRequest.call(fakeThis, request);
		expect(fakeThis.activeConnectionExtensionUiRequests.size).toBe(1);

		prototype.cancelActiveConnectionExtensionUiRequests.call(fakeThis);
		await handling;

		expect(fakeThis.agentConnection.respondToExtensionUiRequest).toHaveBeenCalledTimes(1);
		expect(fakeThis.agentConnection.respondToExtensionUiRequest).toHaveBeenCalledWith("request-1", {
			cancelled: true,
		});
		expect(fakeThis.activeConnectionExtensionUiRequests.size).toBe(0);
	});
});

describe("InteractiveMode key handlers", () => {
	type KeyHandlerHarness = {
		defaultEditor: {
			onEscape?: () => void;
			onCtrlD?: () => void;
			onMoveBelowPrompt?: () => void;
			onChange?: () => void;
			onPasteImage?: () => void;
			onAction(action: string, handler: () => void): void;
		};
		editor: { setText: ReturnType<typeof vi.fn> };
		ui: { onDebug?: () => void; requestRender: ReturnType<typeof vi.fn> };
		clearCtrlCExitHint(options?: { render?: boolean }): void;
		setupKeyHandlers(): void;
	};

	test("escape clears the input bar without aborting streaming", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as KeyHandlerHarness;
		fakeThis.defaultEditor = {
			onAction: vi.fn(),
		};
		fakeThis.editor = { setText: vi.fn() };
		fakeThis.ui = { requestRender: vi.fn() };
		fakeThis.clearCtrlCExitHint = vi.fn();

		fakeThis.setupKeyHandlers();
		fakeThis.defaultEditor.onEscape?.();

		expect(fakeThis.clearCtrlCExitHint).toHaveBeenCalledWith({ render: false });
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode tool event rendering", () => {
	test("reserves streaming tool call ids before loading tool definitions", async () => {
		let resolveDefinition!: () => void;
		const definitionPromise = new Promise<undefined>((resolve) => {
			resolveDefinition = () => resolve(undefined);
		});
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			init: vi.fn(async () => {}),
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: new AgentActivityTracker(),
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: undefined,
			chatContainer: new Container(),
			pendingTools: new Map<string, ToolExecutionComponent>(),
			pendingToolCreations: new Set<string>(),
			startedToolCalls: new Set<string>(),
			loadToolDefinition: vi.fn(() => definitionPromise),
			uiServices: {
				settingsManager: {
					getShowImages: () => true,
					getImageWidthCells: () => 60,
				},
			},
			toolOutputExpanded: false,
			ui: { requestRender: vi.fn() },
			getCurrentCwd: () => "/tmp/project",
		});
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool-1",
					name: "ipython",
					arguments: { code: "print(1)" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
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
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const event = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
		} as unknown as AgentConnectionSessionEvent;
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeThis, event: AgentConnectionSessionEvent): Promise<void>;
			}
		).handleEvent;

		const firstUpdate = handleEvent.call(fakeThis, event);
		const secondUpdate = handleEvent.call(fakeThis, event);
		await Promise.resolve();
		expect(fakeThis.loadToolDefinition).toHaveBeenCalledTimes(1);

		resolveDefinition();
		await Promise.all([firstUpdate, secondUpdate]);

		expect(fakeThis.pendingTools.size).toBe(1);
		expect(fakeThis.chatContainer.children).toHaveLength(1);
	});
});

describe("InteractiveMode transcript rebuild", () => {
	test("keeps existing chat visible when session context reload fails", async () => {
		type RebuildHarness = {
			chatContainer: Container;
			agentConnection: { getSessionContext(): Promise<never> };
			renderSessionContext(): Promise<void>;
			rebuildChatFromMessages(): Promise<void>;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as RebuildHarness;
		fakeThis.chatContainer = new Container();
		fakeThis.chatContainer.addChild(new Container());
		fakeThis.agentConnection = {
			getSessionContext: vi.fn(async () => {
				throw new Error("context unavailable");
			}),
		};
		fakeThis.renderSessionContext = vi.fn(async () => {});

		await expect(fakeThis.rebuildChatFromMessages()).rejects.toThrow("context unavailable");

		expect(fakeThis.chatContainer.children).toHaveLength(1);
		expect(fakeThis.renderSessionContext).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode startup onboarding warnings", () => {
	type StartupWarningHarness = {
		shouldRunOnboarding(): boolean;
		getCurrentModel(): AgentConnectionModel | undefined;
		getModelFallbackWarningAction(
			modelFallbackMessage: string | undefined,
			startupNeededOnboarding: boolean,
		): "show" | "suppress" | "wait";
	};

	const getModelFallbackWarningAction = (InteractiveMode.prototype as unknown as StartupWarningHarness)
		.getModelFallbackWarningAction;

	const createHarness = (options: {
		shouldRunOnboarding?: boolean;
		currentModel?: AgentConnectionModel;
	}): StartupWarningHarness => ({
		shouldRunOnboarding: vi.fn(() => options.shouldRunOnboarding ?? false),
		getCurrentModel: vi.fn(() => options.currentModel),
		getModelFallbackWarningAction,
	});

	const liveModel = { id: "gpt-5.5", provider: "prime-inference" } as AgentConnectionModel;

	test("suppresses the stale no-model warning after onboarding selects a model", () => {
		const fakeThis = createHarness({ shouldRunOnboarding: false });

		expect(getModelFallbackWarningAction.call(fakeThis, formatNoModelsAvailableMessage(), true)).toBe("suppress");
		expect(fakeThis.shouldRunOnboarding).toHaveBeenCalledTimes(1);
	});

	test("waits to suppress the stale no-model warning while onboarding is still needed", () => {
		const fakeThis = createHarness({ shouldRunOnboarding: true });

		expect(getModelFallbackWarningAction.call(fakeThis, formatNoModelsAvailableMessage(), true)).toBe("wait");
		expect(fakeThis.shouldRunOnboarding).toHaveBeenCalledTimes(1);
	});

	test("suppresses the no-model warning when the live session has a model", () => {
		const fakeThis = createHarness({ currentModel: liveModel });

		expect(getModelFallbackWarningAction.call(fakeThis, formatNoModelsAvailableMessage(), false)).toBe("suppress");
	});

	test("shows the no-model warning when the live session has no model", () => {
		const fakeThis = createHarness({});

		expect(getModelFallbackWarningAction.call(fakeThis, formatNoModelsAvailableMessage(), false)).toBe("show");
	});

	test("keeps real model restore fallback warnings after onboarding", () => {
		const fakeThis = createHarness({ shouldRunOnboarding: false, currentModel: liveModel });

		expect(
			getModelFallbackWarningAction.call(
				fakeThis,
				"Could not restore model anthropic/claude-old. Using prime-inference/openai/gpt-5.5.",
				true,
			),
		).toBe("show");
		expect(fakeThis.shouldRunOnboarding).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode model candidates", () => {
	type ModelCandidatesHarness = {
		agentConnection: { getAvailableModels: () => Promise<AgentConnectionModel[]> };
		connectionModels: AgentConnectionModel[];
		getScopedModelState(): AgentConnectionState["scopedModels"];
		getConnectionAvailableModels(): Promise<AgentConnectionModel[]>;
		getModelCandidates(): Promise<AgentConnectionModel[]>;
		getScopedModelsFromModelIds(
			enabledIds: readonly string[],
			allModels: readonly AgentConnectionModel[],
		): AgentConnectionState["scopedModels"];
	};
	const prototype = InteractiveMode.prototype as unknown as ModelCandidatesHarness;

	const createModel = (provider: string, id: string): AgentConnectionModel =>
		({
			provider,
			id,
			name: id,
		}) as AgentConnectionModel;

	test("loads unscoped model candidates through AgentConnection", async () => {
		const model = createModel("openai", "gpt-5.5");
		const getAvailableModels = vi.fn(async () => [model]);
		const fakeThis: ModelCandidatesHarness = {
			agentConnection: { getAvailableModels },
			connectionModels: [],
			getScopedModelState: () => [],
			getConnectionAvailableModels: prototype.getConnectionAvailableModels,
			getModelCandidates: prototype.getModelCandidates,
			getScopedModelsFromModelIds: prototype.getScopedModelsFromModelIds,
		};

		const result = await prototype.getModelCandidates.call(fakeThis);

		expect(result).toEqual([model]);
		expect(getAvailableModels).toHaveBeenCalledTimes(1);
		expect(fakeThis.connectionModels).toEqual([model]);
	});

	test("uses connection state for scoped model candidates", async () => {
		const model = createModel("anthropic", "claude-opus-4-5");
		const getAvailableModels = vi.fn(async () => [createModel("openai", "gpt-5.5")]);
		const fakeThis: ModelCandidatesHarness = {
			agentConnection: { getAvailableModels },
			connectionModels: [],
			getScopedModelState: () => [{ model, thinkingLevel: "medium" }],
			getConnectionAvailableModels: prototype.getConnectionAvailableModels,
			getModelCandidates: prototype.getModelCandidates,
			getScopedModelsFromModelIds: prototype.getScopedModelsFromModelIds,
		};

		const result = await prototype.getModelCandidates.call(fakeThis);

		expect(result).toEqual([model]);
		expect(getAvailableModels).not.toHaveBeenCalled();
	});

	test("maps selected scoped model IDs from connection candidates", () => {
		const anthropicModel = createModel("anthropic", "claude-opus-4-5");
		const openaiModel = createModel("openai", "gpt-5.5");

		const result = prototype.getScopedModelsFromModelIds(
			["missing/model", "anthropic/claude-opus-4-5", "anthropic/claude-opus-4-5", "openai/gpt-5.5"],
			[openaiModel, anthropicModel],
		);

		expect(result).toEqual([{ model: anthropicModel }, { model: openaiModel }]);
	});
});

describe("InteractiveMode model selection persistence", () => {
	type ModelSelectionHarness = {
		agentConnection: { setModel(provider: string, modelId: string): Promise<void> };
		uiServices: {
			settingsManager: { setDefaultModelAndProvider(provider: string, modelId: string): void };
		};
		footer: { invalidate(): void };
		patchConnectionState(patch: Partial<AgentConnectionState>): void;
		updateEditorBorderColor(): void;
		showStatus(message: string): void;
		showError(message: string): void;
		findExactModelMatch(searchTerm: string): Promise<AgentConnectionModel | undefined>;
		maybeWarnAboutAnthropicSubscriptionAuth(model: AgentConnectionModel): Promise<void>;
		checkDaxnutsEasterEgg(model: AgentConnectionModel): void;
		applySelectedModel(model: AgentConnectionModel): Promise<void>;
		handleModelCommand(searchTerm?: string): Promise<void>;
		completeOnboardingIfCurrentModelReady(): void;
		setupAutocompleteProvider(): void;
	};

	const createModel = (provider: string, id: string): AgentConnectionModel =>
		({
			provider,
			id,
			name: id,
		}) as AgentConnectionModel;

	test("persists local default only after the connection accepts the model", async () => {
		const order: string[] = [];
		const model = createModel("openai", "gpt-5.5");
		const fakeThis = Object.create(InteractiveMode.prototype) as ModelSelectionHarness;
		fakeThis.agentConnection = {
			setModel: vi.fn(async () => {
				order.push("connection");
			}),
		};
		fakeThis.uiServices = {
			settingsManager: {
				setDefaultModelAndProvider: vi.fn(() => {
					order.push("settings");
				}),
			},
		};
		fakeThis.footer = { invalidate: vi.fn() };
		fakeThis.patchConnectionState = vi.fn();
		fakeThis.updateEditorBorderColor = vi.fn();
		fakeThis.setupAutocompleteProvider = vi.fn();

		await fakeThis.applySelectedModel(model);

		expect(fakeThis.agentConnection.setModel).toHaveBeenCalledWith("openai", "gpt-5.5");
		expect(fakeThis.uiServices.settingsManager.setDefaultModelAndProvider).toHaveBeenCalledWith("openai", "gpt-5.5");
		expect(order).toEqual(["connection", "settings"]);
		expect(fakeThis.patchConnectionState).toHaveBeenCalledWith({ model, availableThinkingLevels: ["off"] });
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	test("does not persist local default when the connection rejects the model", async () => {
		const model = createModel("openai", "missing-model");
		const fakeThis = Object.create(InteractiveMode.prototype) as ModelSelectionHarness;
		fakeThis.agentConnection = {
			setModel: vi.fn(async () => {
				throw new Error("model unavailable");
			}),
		};
		fakeThis.uiServices = {
			settingsManager: {
				setDefaultModelAndProvider: vi.fn(),
			},
		};
		fakeThis.footer = { invalidate: vi.fn() };
		fakeThis.patchConnectionState = vi.fn();
		fakeThis.updateEditorBorderColor = vi.fn();

		await expect(fakeThis.applySelectedModel(model)).rejects.toThrow("model unavailable");

		expect(fakeThis.uiServices.settingsManager.setDefaultModelAndProvider).not.toHaveBeenCalled();
		expect(fakeThis.patchConnectionState).not.toHaveBeenCalled();
		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
		expect(fakeThis.updateEditorBorderColor).not.toHaveBeenCalled();
	});

	test("persists exact /model command selections after the connection accepts them", async () => {
		const model = createModel("openai", "gpt-5.5");
		const fakeThis = Object.create(InteractiveMode.prototype) as ModelSelectionHarness;
		fakeThis.agentConnection = { setModel: vi.fn(async () => {}) };
		fakeThis.uiServices = {
			settingsManager: {
				setDefaultModelAndProvider: vi.fn(),
			},
		};
		fakeThis.footer = { invalidate: vi.fn() };
		fakeThis.patchConnectionState = vi.fn();
		fakeThis.updateEditorBorderColor = vi.fn();
		fakeThis.showStatus = vi.fn();
		fakeThis.showError = vi.fn();
		fakeThis.findExactModelMatch = vi.fn(async () => model);
		fakeThis.maybeWarnAboutAnthropicSubscriptionAuth = vi.fn(async () => {});
		fakeThis.checkDaxnutsEasterEgg = vi.fn();
		fakeThis.completeOnboardingIfCurrentModelReady = vi.fn();
		fakeThis.setupAutocompleteProvider = vi.fn();

		await fakeThis.handleModelCommand("gpt-5.5");

		expect(fakeThis.agentConnection.setModel).toHaveBeenCalledWith("openai", "gpt-5.5");
		expect(fakeThis.uiServices.settingsManager.setDefaultModelAndProvider).toHaveBeenCalledWith("openai", "gpt-5.5");
		expect(fakeThis.patchConnectionState).toHaveBeenCalledWith({ model, availableThinkingLevels: ["off"] });
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Model: gpt-5.5");
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.completeOnboardingIfCurrentModelReady).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode Prime CLI onboarding", () => {
	type OnboardingHarness = {
		shouldRunOnboarding(): boolean;
		completeOnboarding(): void;
		handleModelCommand(searchTerm?: string): Promise<void>;
		runOnboardingFlow(): Promise<boolean>;
		applySelectedModel(model: AgentConnectionModel): Promise<void>;
		setupAutocompleteProvider(): void;
	};
	type OnboardingFake = OnboardingHarness & {
		connectionState: AgentConnectionState;
		connectionModels: AgentConnectionModel[];
		agentConnection: {
			getAvailableModels?: () => Promise<AgentConnectionModel[]>;
			setModel?: (provider: string, modelId: string) => Promise<void>;
		};
		uiServices: {
			modelRegistry: {
				refresh: () => void;
				hasConfiguredAuth: (model: unknown) => boolean;
				getProviderAuthStatus: (provider: string) => AuthStatus;
			};
			settingsManager: {
				getOnboardingCompleted: () => boolean;
				setOnboardingCompleted: (completed: boolean) => void;
				setDefaultModelAndProvider: (provider: string, modelId: string) => void;
			};
		};
		footer?: { invalidate: () => void };
		updateEditorBorderColor?: () => void;
		showStatus?: (message: string) => void;
		showError?: (message: string) => void;
		patchConnectionState?: (patch: Partial<AgentConnectionState>) => void;
		maybeWarnAboutAnthropicSubscriptionAuth?: (model?: AgentConnectionModel) => void;
		checkDaxnutsEasterEgg?: (model: { provider: string; id: string }) => void;
		findExactModelMatch?: (searchTerm: string) => Promise<AgentConnectionModel | undefined>;
		showOnboardingModelSelectionSplash?: () => Promise<boolean>;
		promptForModelSelection?: (options?: { allowProviderSetup?: boolean }) => Promise<boolean>;
		completeOnboardingIfCurrentModelReady?: () => void;
		getModelCandidates?: () => Promise<AgentConnectionModel[]>;
	};
	const shouldRunOnboarding = (InteractiveMode.prototype as unknown as OnboardingHarness).shouldRunOnboarding;
	const completeOnboarding = (InteractiveMode.prototype as unknown as OnboardingHarness).completeOnboarding;
	const handleModelCommand = (InteractiveMode.prototype as unknown as OnboardingHarness).handleModelCommand;
	const runOnboardingFlow = (InteractiveMode.prototype as unknown as OnboardingHarness).runOnboardingFlow;
	const applySelectedModel = (InteractiveMode.prototype as unknown as OnboardingHarness).applySelectedModel;

	const primeModel: AgentConnectionModel = {
		id: "openai/gpt-5.5",
		name: "GPT-5.5",
		api: "openai-completions",
		provider: PRIME_INFERENCE_PROVIDER_ID,
		baseUrl: "https://api.pinference.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	} as AgentConnectionModel;

	function createPrimeCliHarness(completed: boolean): OnboardingFake {
		const fakeThis = Object.create(InteractiveMode.prototype) as OnboardingFake;
		fakeThis.connectionState = createConnectionState({ model: primeModel });
		fakeThis.connectionModels = [primeModel];
		fakeThis.agentConnection = {
			getAvailableModels: vi.fn(async () => [primeModel]),
		};
		fakeThis.uiServices = {
			modelRegistry: {
				refresh: vi.fn(),
				hasConfiguredAuth: vi.fn(() => true),
				getProviderAuthStatus: vi.fn(
					(): AuthStatus => ({
						configured: false,
						source: "prime_cli",
					}),
				),
			},
			settingsManager: {
				getOnboardingCompleted: vi.fn(() => completed),
				setOnboardingCompleted: vi.fn(),
				setDefaultModelAndProvider: vi.fn(),
			},
		};
		fakeThis.getModelCandidates = vi.fn(async () => [primeModel]);
		return fakeThis;
	}

	test("shows onboarding when the selected Prime model is backed by Prime CLI auth", () => {
		const fakeThis = createPrimeCliHarness(false);

		expect(shouldRunOnboarding.call(fakeThis)).toBe(true);
		expect(fakeThis.uiServices.modelRegistry.refresh).toHaveBeenCalledTimes(1);
	});

	test("skips Prime CLI onboarding after it has been completed", () => {
		const fakeThis = createPrimeCliHarness(true);

		expect(shouldRunOnboarding.call(fakeThis)).toBe(false);
	});

	test("persists onboarding completion once", () => {
		const fakeThis = createPrimeCliHarness(false);

		completeOnboarding.call(fakeThis);

		expect(fakeThis.uiServices.settingsManager.setOnboardingCompleted).toHaveBeenCalledWith(true);
	});

	test("manual exact model selection completes Prime CLI onboarding", async () => {
		let completed = false;
		const fakeThis = createPrimeCliHarness(false);
		fakeThis.connectionState = createConnectionState({ model: undefined });
		fakeThis.uiServices.settingsManager.getOnboardingCompleted = vi.fn(() => completed);
		fakeThis.uiServices.settingsManager.setOnboardingCompleted = vi.fn((nextCompleted: boolean) => {
			completed = nextCompleted;
		});
		fakeThis.agentConnection.setModel = vi.fn(async (_provider: string, _modelId: string) => {
			fakeThis.connectionState = { ...fakeThis.connectionState, model: primeModel };
		});
		fakeThis.findExactModelMatch = vi.fn(async () => primeModel);
		fakeThis.footer = { invalidate: vi.fn() };
		fakeThis.updateEditorBorderColor = vi.fn();
		fakeThis.patchConnectionState = vi.fn((patch: Partial<AgentConnectionState>) => {
			fakeThis.connectionState = { ...fakeThis.connectionState, ...patch };
		});
		fakeThis.showStatus = vi.fn();
		fakeThis.showError = vi.fn();
		fakeThis.maybeWarnAboutAnthropicSubscriptionAuth = vi.fn();
		fakeThis.checkDaxnutsEasterEgg = vi.fn();
		fakeThis.applySelectedModel = applySelectedModel;
		fakeThis.setupAutocompleteProvider = vi.fn();

		await handleModelCommand.call(fakeThis, "prime-inference/openai/gpt-5.5");

		expect(fakeThis.agentConnection.setModel).toHaveBeenCalledWith(PRIME_INFERENCE_PROVIDER_ID, "openai/gpt-5.5");
		expect(fakeThis.uiServices.settingsManager.setOnboardingCompleted).toHaveBeenCalledWith(true);
		expect(shouldRunOnboarding.call(fakeThis)).toBe(false);
	});

	test("cancelled model picker does not complete Prime CLI onboarding", async () => {
		const fakeThis = createPrimeCliHarness(false);
		fakeThis.showOnboardingModelSelectionSplash = vi.fn(async () => true);
		fakeThis.promptForModelSelection = vi.fn(async () => false);
		fakeThis.showStatus = vi.fn();

		await expect(runOnboardingFlow.call(fakeThis)).resolves.toBe(false);

		expect(fakeThis.promptForModelSelection).toHaveBeenCalledWith({ allowProviderSetup: true });
		expect(fakeThis.uiServices.settingsManager.setOnboardingCompleted).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Model selection required. Use /model to continue.");
	});

	test("cancelled model picker continues when current model is ready outside Prime CLI onboarding", async () => {
		const fakeThis = createPrimeCliHarness(false);
		fakeThis.uiServices.modelRegistry.getProviderAuthStatus = vi.fn(
			(): AuthStatus => ({
				configured: true,
				source: "stored",
			}),
		);
		fakeThis.promptForModelSelection = vi.fn(async () => false);
		fakeThis.showStatus = vi.fn();

		await expect(runOnboardingFlow.call(fakeThis)).resolves.toBe(true);

		expect(fakeThis.promptForModelSelection).toHaveBeenCalledWith({ allowProviderSetup: true });
		expect(fakeThis.uiServices.settingsManager.setOnboardingCompleted).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode splash cwd display", () => {
	test("formats home-relative cwd paths", () => {
		expect(formatSplashCwd(homedir())).toBe("~");
		expect(formatSplashCwd(path.join(homedir(), "pi", "prime-agent"))).toBe("~/pi/prime-agent");
	});

	test("keeps worktree paths as cwd paths instead of repo branch labels", () => {
		expect(formatSplashCwd(path.join(homedir(), "pi", "prime-agent", ".worktrees", "improve-onboarding"))).toBe(
			"~/pi/prime-agent/.worktrees/improve-onboarding",
		);
	});
});

describe("InteractiveMode goal status announcements", () => {
	test("does not announce active goal usage-only updates", () => {
		type GoalAnnouncementHarness = {
			lastGoalAnnouncement?: unknown;
			setGoalAnnouncementBaseline(goal: GoalState): void;
			shouldAnnounceGoalUpdate(goal: GoalState): boolean;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as GoalAnnouncementHarness;
		const activeGoal: GoalState = {
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: "ship the feature",
			tokensUsed: 10,
			timeUsedSeconds: 5,
			continuationsUsed: 1,
		};

		fakeThis.setGoalAnnouncementBaseline(emptyGoalState());
		expect(fakeThis.shouldAnnounceGoalUpdate(activeGoal)).toBe(true);
		expect(
			fakeThis.shouldAnnounceGoalUpdate({
				...activeGoal,
				tokensUsed: 20,
				timeUsedSeconds: 15,
				continuationsUsed: 2,
			}),
		).toBe(false);
		expect(
			fakeThis.shouldAnnounceGoalUpdate({
				...activeGoal,
				objective: "ship the feature and update docs",
			}),
		).toBe(false);
	});

	test("announces a transition back to idle when a goal is cleared", () => {
		type GoalAnnouncementHarness = {
			setGoalAnnouncementBaseline(goal: GoalState): void;
			shouldAnnounceGoalUpdate(goal: GoalState): boolean;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as GoalAnnouncementHarness;
		fakeThis.setGoalAnnouncementBaseline({
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: "ship the feature",
			tokensUsed: 10,
			timeUsedSeconds: 5,
			continuationsUsed: 1,
		});

		expect(fakeThis.shouldAnnounceGoalUpdate(emptyGoalState())).toBe(true);
		expect(fakeThis.shouldAnnounceGoalUpdate(emptyGoalState())).toBe(false);
	});
});

describe("InteractiveMode tray goal label", () => {
	type TrayUsage = { contextWindow: number; tokens: number | null; percent: number | null };
	type TrayLabelHarness = {
		connectionState: {
			goal: GoalState;
			heartbeat?: AgentCronJob | null;
			contextUsage: TrayUsage | undefined;
		};
		uiServices: { getContextUsage(): TrayUsage | undefined };
		getTrayContextLabel(): string | undefined;
	};
	const getTrayContextLabel = (InteractiveMode.prototype as unknown as TrayLabelHarness).getTrayContextLabel;

	function createHeartbeat(status: AgentCronJob["status"]): AgentCronJob {
		return {
			id: "heartbeat-1",
			status,
			source: "heartbeat",
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			prompt: "check whether there is follow-up work",
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			nextRunAt: "2026-01-01T00:05:00.000Z",
			runCount: 0,
		};
	}

	test("shows active goals in the lower tray without an objective", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "a long objective that should not render in the tray",
				tokensUsed: 0,
				timeUsedSeconds: 65,
				continuationsUsed: 1,
			} satisfies GoalState,
			contextUsage: undefined,
		};
		fakeThis.uiServices = { getContextUsage: () => undefined };

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s)");
	});

	test("combines active goals with token/context usage in one lower-tray label", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "finish the task",
				tokensUsed: 0,
				timeUsedSeconds: 65,
				continuationsUsed: 1,
			} satisfies GoalState,
			contextUsage: { contextWindow: 100_000, tokens: 75_000, percent: 75 },
		};
		fakeThis.uiServices = { getContextUsage: () => undefined };

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s) · 75k (75%)");
	});

	test("combines active goals, active heartbeats, and context usage in one lower-tray label", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "finish the task",
				tokensUsed: 0,
				timeUsedSeconds: 65,
				continuationsUsed: 1,
			} satisfies GoalState,
			heartbeat: createHeartbeat("active"),
			contextUsage: { contextWindow: 100_000, tokens: 75_000, percent: 75 },
		};
		fakeThis.uiServices = { getContextUsage: () => undefined };

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s) · Heartbeat active (5m) · 75k (75%)");
	});

	test("omits the usage segment when token count is unknown", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "finish the task",
				tokensUsed: 0,
				timeUsedSeconds: 65,
				continuationsUsed: 1,
			} satisfies GoalState,
			contextUsage: { contextWindow: 100_000, tokens: null, percent: null },
		};
		fakeThis.uiServices = { getContextUsage: () => undefined };

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s)");
	});
});

describe("InteractiveMode live context usage", () => {
	type LiveContextHarness = {
		connectionState: Pick<AgentConnectionState, "contextUsage"> | undefined;
		activityTracker: { getStatus(): { tokens: number } };
		isAgentStreaming(): boolean;
		contextUsageTokenBaseline: number;
		getConnectionContextUsage(): AgentConnectionState["contextUsage"];
	};
	const prototype = InteractiveMode.prototype as unknown as LiveContextHarness;

	function createHarness(
		opts: { streaming?: boolean; inFlight?: number; baseline?: number } = {},
	): LiveContextHarness {
		const fakeThis = Object.create(InteractiveMode.prototype) as LiveContextHarness;
		fakeThis.connectionState = { contextUsage: undefined };
		fakeThis.activityTracker = { getStatus: () => ({ tokens: opts.inFlight ?? 0 }) };
		fakeThis.isAgentStreaming = () => opts.streaming ?? false;
		fakeThis.contextUsageTokenBaseline = opts.baseline ?? 0;
		return fakeThis;
	}

	test("returns the snapshot verbatim when idle", () => {
		const fakeThis = createHarness();
		fakeThis.connectionState = { contextUsage: { contextWindow: 100_000, tokens: 42_000, percent: 42 } };

		expect(prototype.getConnectionContextUsage.call(fakeThis)).toEqual({
			contextWindow: 100_000,
			tokens: 42_000,
			percent: 42,
		});
	});

	test("adds in-flight streaming output to the snapshot baseline while streaming", () => {
		const fakeThis = createHarness({ streaming: true, inFlight: 3_000 });
		fakeThis.connectionState = { contextUsage: { contextWindow: 100_000, tokens: 42_000, percent: 42 } };

		// 42k baseline + 3k in-flight = 45k; ticks up live as the model writes.
		expect(prototype.getConnectionContextUsage.call(fakeThis)).toMatchObject({ tokens: 45_000, percent: 45 });
	});

	test("only adds output beyond the refresh baseline (auto-retry does not double count)", () => {
		// Tracker holds 5k from a failed attempt (baseline), now 6k after 1k of the retry.
		const fakeThis = createHarness({ streaming: true, inFlight: 6_000, baseline: 5_000 });
		fakeThis.connectionState = { contextUsage: { contextWindow: 100_000, tokens: 42_000, percent: 42 } };

		// Only the 1k generated since the refresh is in-flight, not the failed attempt's 5k.
		expect(prototype.getConnectionContextUsage.call(fakeThis)).toMatchObject({ tokens: 43_000 });
	});

	test("does not add in-flight output when not streaming", () => {
		const fakeThis = createHarness({ streaming: false, inFlight: 3_000 });
		fakeThis.connectionState = { contextUsage: { contextWindow: 100_000, tokens: 42_000, percent: 42 } };

		expect(prototype.getConnectionContextUsage.call(fakeThis)).toMatchObject({ tokens: 42_000 });
	});

	test("passes through an unknown (post-compaction) snapshot without inflating it", () => {
		const fakeThis = createHarness({ streaming: true, inFlight: 3_000 });
		fakeThis.connectionState = { contextUsage: { contextWindow: 100_000, tokens: null, percent: null } };

		expect(prototype.getConnectionContextUsage.call(fakeThis)).toMatchObject({ tokens: null, percent: null });
	});

	test("returns undefined when there is no snapshot yet", () => {
		const fakeThis = createHarness({ streaming: true, inFlight: 3_000 });
		fakeThis.connectionState = { contextUsage: undefined };

		expect(prototype.getConnectionContextUsage.call(fakeThis)).toBeUndefined();
	});

	test("refreshConnectionContextUsage drops stale stats after a session switch", async () => {
		type RefreshHarness = {
			agentConnection: { getSessionStats(): Promise<{ contextUsage: unknown }> };
			connectionState: { sessionId?: string; contextUsage?: unknown };
			activityTracker: { getStatus(): { tokens: number } };
			contextUsageTokenBaseline: number;
			patchConnectionState(patch: Record<string, unknown>): void;
			refreshConnectionContextUsage(): Promise<void>;
		};
		const refresh = (InteractiveMode.prototype as unknown as RefreshHarness).refreshConnectionContextUsage;
		const fakeThis = Object.create(InteractiveMode.prototype) as RefreshHarness;
		const patched: Record<string, unknown>[] = [];
		fakeThis.activityTracker = { getStatus: () => ({ tokens: 0 }) };
		fakeThis.contextUsageTokenBaseline = 0;
		fakeThis.connectionState = { sessionId: "session-A", contextUsage: undefined };
		fakeThis.patchConnectionState = (p) => patched.push(p);
		fakeThis.agentConnection = {
			getSessionStats: async () => {
				// User switches sessions while the stats call is in flight.
				fakeThis.connectionState = { sessionId: "session-B", contextUsage: undefined };
				return { contextUsage: { contextWindow: 100_000, tokens: 50_000, percent: 50 } };
			},
		};

		await refresh.call(fakeThis);

		// Stats belonged to session-A; must not overwrite session-B.
		expect(patched).toHaveLength(0);
	});
});

describe("InteractiveMode.handleGoalStatusCommand", () => {
	test("prints current goal details without queuing through the agent", () => {
		type GoalStatusCommandHarness = {
			connectionState: { goal: GoalState };
			chatContainer: Container;
			ui: { requestRender(): void };
			handleGoalStatusCommand(): void;
			formatGoalElapsed(seconds: number): string;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as GoalStatusCommandHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "ship the feature",
				tokenBudget: 1000,
				tokensUsed: 125,
				timeUsedSeconds: 65,
				continuationsUsed: 2,
			},
		};
		fakeThis.chatContainer = new Container();
		fakeThis.ui = { requestRender: vi.fn() };

		fakeThis.handleGoalStatusCommand();

		const rendered = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(rendered).toContain("Goal");
		expect(rendered).toContain("Status: active");
		expect(rendered).toContain("Objective: ship the feature");
		expect(rendered).toContain("Time: 1m 05s");
		expect(rendered).toContain("Tokens: 125 / 1,000");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("truncatePathMiddle", () => {
	test("does not duplicate the home prefix for short tilde paths", () => {
		const value = truncatePathMiddle("~/myproject", 8);

		expect(value).toMatch(/^~\//);
		expect(value).not.toContain("/~/");
		expect(visibleWidth(value)).toBeLessThanOrEqual(8);
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header, chat entries, and child agent detail", () => {
		const header = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const childAgentDetail = { setToolsExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			chatContainer: { children: [chatChild] },
			childAgentDetail,
			ui: {
				requestRender: vi.fn(),
				requestRenderPreservingViewport: vi.fn(),
				isFullscreen: vi.fn().mockReturnValue(false),
			},
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(childAgentDetail.setToolsExpanded).toHaveBeenCalledWith(true);
		// Expansion keeps the user anchored, so it uses the viewport-preserving path.
		expect(fakeThis.ui.requestRenderPreservingViewport).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: AgentConnectionResourceDiagnostic[];
		useRealScopeGroups?: boolean;
		useRealDiagnostics?: boolean;
	}) {
		const connectionResourceSnapshot: AgentConnectionResourceSnapshot = {
			contextFiles: (options.contextFiles ?? []).map((contextFile) => ({ path: contextFile.path })),
			skills: options.skills ?? [],
			prompts: [],
			extensions: options.extensions ?? [],
			themes: [],
			diagnostics: {
				skills: options.skillDiagnostics ?? [],
				prompts: [],
				extensions: [],
				themes: [],
			},
		};
		const extensionRunner = {
			getCommandDiagnostics: () => [],
			getShortcutDiagnostics: () => [],
		};
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			connectionResourceSnapshot,
			extensionRunner,
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getCurrentCwd: () => options.cwd ?? "/tmp/project",
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealDiagnostics) {
			fakeThis.formatDiagnostics = (
				diagnostics: readonly AgentConnectionResourceDiagnostic[],
				sourceInfos: Map<string, AgentConnectionSourceInfo>,
			) => (InteractiveMode as any).prototype.formatDiagnostics.call(fakeThis, diagnostics, sourceInfos);
		}

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): AgentConnectionSourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.pi/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("does not show resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("shows a compact resource listing when forced", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("commit");
		expect(output).not.toContain("resource-list");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, webfetch.ts"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  pi-markdown-preview"`);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  project
    /tmp/project/.pi/extensions/answer.ts
    /tmp/project/.pi/extensions/local-index
    git:github.com/HazAT/pi-interactive-subagents
      extensions
      extensions/subagents
    npm:@scope/pi-scoped
      extensions
    npm:pi-markdown-preview
      extensions
  user
    /tmp/agent/extensions/user-index
  path
    /tmp/temp/cli-extension.ts"`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md");
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		expect(output).not.toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill warning]");
		expect(output).not.toContain("[Skills]");
	});

	test("formats a multi-line skill warning without path noise", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skillDiagnostics: [
				{
					type: "warning",
					message: "first line of the warning.\nsecond line with guidance.\n\n  indented detail",
				},
			],
			useRealDiagnostics: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer, 100);
		expect(output).toMatchInlineSnapshot(`
"[Skill warning]
  first line of the warning.
  second line with guidance.

    indented detail"
`);
		expect(output).not.toContain("[Skill conflicts]");
	});
});
