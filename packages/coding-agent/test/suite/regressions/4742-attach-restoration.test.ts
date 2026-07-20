import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentConnectionSessionContext } from "../../../src/modes/agent-connection/index.js";
import {
	ToolExecutionComponent,
	type ToolExecutionDefinition,
} from "../../../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";

const TOOL_NAME = "remote_tool";
const TOOL_CALL_ID = "tool-4742";

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

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	ipythonToolComponents: Map<string, ToolExecutionComponent>;
	lateIpythonSentAgentMessages: Map<string, unknown[]>;
	pendingToolCreations: Set<string>;
	startedToolCalls: Set<string>;
	pendingToolGeneration: number;
	toolDefinitionCache: Map<string, ToolExecutionDefinition | undefined>;
	resetPendingToolState(): void;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: { getShowImages(): boolean };
	toolOutputExpanded: boolean;
	updateEditorBorderColor(): void;
	getCurrentCwd(): string;
	getRetryAttempt(): number;
	getCachedToolDefinition(toolName: string): ToolExecutionDefinition | undefined;
	loadToolDefinition(toolName: string): Promise<ToolExecutionDefinition | undefined>;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
};

type RenderSessionContext = (
	this: RenderSessionContextThis,
	sessionContext: AgentConnectionSessionContext,
	options?: { updateFooter?: boolean; populateHistory?: boolean; clearChat?: boolean },
) => Promise<void>;

type RestoreInitialSessionThis = {
	ui: TUI;
	statusContainer: Container;
	rebindCurrentSession(options?: { syncWorkingLoader?: boolean }): Promise<void>;
	renderInitialMessages(): Promise<void>;
	syncWorkingLoader(): void;
};

type RestoreInitialSession = (this: RestoreInitialSessionThis) => Promise<void>;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { value: 42 } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text: "RESTORED_RESULT" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionContext(): AgentConnectionSessionContext {
	return {
		messages: [createAssistantToolCallMessage(), createToolResultMessage()],
		thinkingLevel: "off",
		serviceTier: "default",
		model: null,
	};
}

function render(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

function createRenderThis(
	loadToolDefinition: (toolName: string) => Promise<ToolExecutionDefinition | undefined>,
): RenderSessionContextThis {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const pendingToolCreations = new Set<string>();
	const startedToolCalls = new Set<string>();
	const chatContainer = new Container();
	const fakeThis: RenderSessionContextThis = {
		pendingTools,
		ipythonToolComponents: new Map(),
		lateIpythonSentAgentMessages: new Map(),
		pendingToolCreations,
		startedToolCalls,
		pendingToolGeneration: 0,
		toolDefinitionCache: new Map(),
		resetPendingToolState() {
			this.pendingToolGeneration++;
			pendingTools.clear();
			pendingToolCreations.clear();
			startedToolCalls.clear();
		},
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: { getShowImages: () => false },
		toolOutputExpanded: false,
		updateEditorBorderColor: vi.fn(),
		getCurrentCwd: () => process.cwd(),
		getRetryAttempt: () => 0,
		getCachedToolDefinition: (toolName) => fakeThis.toolDefinitionCache.get(toolName),
		loadToolDefinition,
		addMessageToChat(message) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis;
}

describe("ENG-4742 attach restoration", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("hydrates a restored transcript after unrelated live tool state changes", async () => {
		const definition = deferred<ToolExecutionDefinition | undefined>();
		const fakeThis = createRenderThis(() => definition.promise);
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		await renderSessionContext.call(fakeThis, createSessionContext());

		expect(render(fakeThis.chatContainer)).toContain("RESTORED_RESULT");
		expect(render(fakeThis.chatContainer)).toContain(TOOL_NAME);
		fakeThis.resetPendingToolState();

		definition.resolve({
			name: TOOL_NAME,
			label: "Hydrated Tool",
			description: "Remote definition",
			parameters: { type: "object" },
		});
		await vi.waitFor(() => expect(render(fakeThis.chatContainer)).toContain("Hydrated Tool"));
		expect(render(fakeThis.chatContainer).match(/RESTORED_RESULT/g)).toHaveLength(1);
	});

	it("keeps fallback rendering when a tool definition is unavailable", async () => {
		const fakeThis = createRenderThis(async () => {
			throw new Error("daemon disconnected");
		});
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		await expect(renderSessionContext.call(fakeThis, createSessionContext())).resolves.toBeUndefined();
		await vi.waitFor(() => expect(render(fakeThis.chatContainer)).toContain("RESTORED_RESULT"));
		expect(render(fakeThis.chatContainer)).toContain(TOOL_NAME);
	});

	it("invalidates in-flight tool definitions when resources reload", async () => {
		const staleDefinition = deferred<ToolExecutionDefinition | undefined>();
		const getToolDefinition = vi
			.fn<() => Promise<ToolExecutionDefinition | undefined>>()
			.mockReturnValueOnce(staleDefinition.promise)
			.mockResolvedValueOnce({
				name: TOOL_NAME,
				label: "Fresh Tool",
				description: "Reloaded definition",
				parameters: { type: "object" },
			});
		const fakeThis = {
			toolDefinitionGeneration: 0,
			toolDefinitionCache: new Map<string, ToolExecutionDefinition | undefined>(),
			toolDefinitionLoads: new Map<string, Promise<ToolExecutionDefinition | undefined>>(),
			agentConnection: { getToolDefinition },
			localSessionHost: undefined,
		};
		Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
		const prototype = InteractiveMode.prototype as unknown as {
			invalidateToolDefinitions(this: typeof fakeThis): void;
			loadToolDefinition(this: typeof fakeThis, toolName: string): Promise<ToolExecutionDefinition | undefined>;
		};

		const staleLoad = prototype.loadToolDefinition.call(fakeThis, TOOL_NAME);
		prototype.invalidateToolDefinitions.call(fakeThis);
		const freshLoad = prototype.loadToolDefinition.call(fakeThis, TOOL_NAME);
		staleDefinition.resolve({
			name: TOOL_NAME,
			label: "Stale Tool",
			description: "Pre-reload definition",
			parameters: { type: "object" },
		});

		await expect(freshLoad).resolves.toMatchObject({ label: "Fresh Tool" });
		await staleLoad;
		expect(getToolDefinition).toHaveBeenCalledTimes(2);
		expect(fakeThis.toolDefinitionCache.get(TOOL_NAME)).toMatchObject({ label: "Fresh Tool" });
	});

	it("does not hydrate transcript components after they are removed", async () => {
		const definition = deferred<ToolExecutionDefinition | undefined>();
		const fakeThis = createRenderThis(() => definition.promise);
		const setToolDefinition = vi.spyOn(ToolExecutionComponent.prototype, "setToolDefinition");
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		await renderSessionContext.call(fakeThis, createSessionContext());
		fakeThis.chatContainer.clear();
		definition.resolve({
			name: TOOL_NAME,
			label: "Hydrated Tool",
			description: "Remote definition",
			parameters: { type: "object" },
		});
		await definition.promise;
		await Promise.resolve();

		expect(setToolDefinition).not.toHaveBeenCalled();
		setToolDefinition.mockRestore();
	});

	it("shows restoration progress until initial messages are available", async () => {
		const rebind = deferred<void>();
		const statusContainer = new Container();
		const rebindCurrentSession = vi.fn((options?: { syncWorkingLoader?: boolean }) => {
			if (options?.syncWorkingLoader !== false) {
				statusContainer.clear();
			}
			return rebind.promise;
		});
		const fakeThis: RestoreInitialSessionThis = {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			statusContainer,
			rebindCurrentSession,
			renderInitialMessages: vi.fn(async () => undefined),
			syncWorkingLoader: vi.fn(),
		};
		const restoreInitialSession = (
			InteractiveMode.prototype as unknown as { restoreInitialSession: RestoreInitialSession }
		).restoreInitialSession;

		const restoration = restoreInitialSession.call(fakeThis);
		expect(rebindCurrentSession).toHaveBeenCalledWith({ syncWorkingLoader: false });
		expect(render(statusContainer)).toContain("Restoring transcript…");

		rebind.resolve(undefined);
		await restoration;

		expect(render(statusContainer)).not.toContain("Restoring transcript…");
		expect(fakeThis.renderInitialMessages).toHaveBeenCalledOnce();
	});
});
