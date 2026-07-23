import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createCompactionOutcomeMessage } from "../src/core/messages.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("InteractiveMode compaction events", () => {
	beforeAll(() => initTheme("dark"));
	test("shows an automatic compaction loader for the full operation", async () => {
		const statusContainer = new Container();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: new AgentActivityTracker(),
			updateWorkingLoaderMessage: vi.fn(),
			autoCompactionLoader: undefined,
			retryLoader: undefined,
			workingVisible: true,
			stopWorkingLoader: vi.fn(),
			syncWorkingLoader: vi.fn(),
			statusContainer,
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event:
				| { type: "compaction_start"; reason: "threshold"; customInstructions?: string }
				| {
						type: "compaction_end";
						reason: "threshold";
						result: undefined;
						aborted: true;
						willRetry: false;
				  },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "threshold" });

		expect(stripAnsi(statusContainer.render(80).join("\n"))).toContain("Auto-compacting");
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
		expect(statusContainer.children).toHaveLength(0);
	});

	test("rebuilds successful compaction from its single persisted summary", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: new AgentActivityTracker(),
			updateWorkingLoaderMessage: vi.fn(),
			autoCompactionLoader: undefined,
			retryLoader: undefined,
			syncWorkingLoader: vi.fn(),
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn().mockResolvedValue(undefined),
			addMessageToChat: vi.fn(),
			refreshConnectionContextUsage: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "requested" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
				errorSeverity?: "warning" | "error";
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "requested",
			result: { tokensBefore: 123, summary: "summary" },
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledOnce();
		expect(fakeThis.chatContainer.clear).toHaveBeenCalledOnce();
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
	});

	test("clears stale chat and reports a failed post-compaction refresh", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: new AgentActivityTracker(),
			updateWorkingLoaderMessage: vi.fn(),
			autoCompactionLoader: undefined,
			retryLoader: undefined,
			syncWorkingLoader: vi.fn(),
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn().mockRejectedValue(new Error("context unavailable")),
			refreshConnectionContextUsage: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			showWarning: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "requested";
				result: { tokensBefore: number; summary: string };
				aborted: false;
				willRetry: false;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "requested",
			result: { tokensBefore: 123, summary: "summary" },
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledOnce();
		expect(fakeThis.showError).toHaveBeenCalledWith(
			"Compaction succeeded, but the transcript could not be refreshed: context unavailable",
		);
	});

	test("renders valid and malformed compaction outcomes during live delivery", () => {
		const chatContainer = new Container();
		const fakeThis = {
			chatContainer,
			toolOutputExpanded: false,
			bindLocalSessionExtensions: false,
			getMarkdownThemeWithSettings: () => undefined,
		};
		Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof fakeThis,
			message: AgentMessage,
		) => void;

		addMessageToChat.call(
			fakeThis,
			createCompactionOutcomeMessage("Requested compaction failed", {
				reason: "requested",
				outcome: "failed",
			}),
		);
		addMessageToChat.call(fakeThis, {
			role: "custom",
			customType: "compaction_outcome",
			content: "untrusted malformed text",
			display: true,
			details: { reason: "manual", outcome: "failed" },
			timestamp: 123,
		});

		const output = stripAnsi(chatContainer.render(100).join("\n"));
		expect(output).toContain("Requested compaction failed");
		expect(output).toContain("[Malformed compaction outcome message]");
		expect(output).not.toContain("untrusted malformed text");
	});

	test("renders the persisted summary at its exact retained-message boundary", () => {
		const retained = { role: "user", content: [], timestamp: 2 } as AgentMessage;
		const summary = {
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 123,
			retainedMessageCount: 1,
			timestamp: 2,
		} as AgentMessage;
		const later = { role: "user", content: [], timestamp: 2 } as AgentMessage;
		const order = Reflect.get(InteractiveMode.prototype, "orderMessagesForTranscript") as (
			this: InteractiveMode,
			messages: AgentMessage[],
		) => AgentMessage[];

		expect(order.call({} as InteractiveMode, [summary, retained, later])).toEqual([retained, summary, later]);
	});

	test("falls back to timestamps for legacy compaction summaries", () => {
		const retained = { role: "user", content: [], timestamp: 1 } as AgentMessage;
		const summary = {
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 123,
			timestamp: 2,
		} as AgentMessage;
		const later = { role: "user", content: [], timestamp: 3 } as AgentMessage;
		const order = Reflect.get(InteractiveMode.prototype, "orderMessagesForTranscript") as (
			this: InteractiveMode,
			messages: AgentMessage[],
		) => AgentMessage[];

		expect(order.call({} as InteractiveMode, [summary, retained, later])).toEqual([retained, summary, later]);
	});
});
