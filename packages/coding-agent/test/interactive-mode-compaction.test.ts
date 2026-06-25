import { describe, expect, test, vi } from "vitest";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
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
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			refreshConnectionContextUsage: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
				errorSeverity?: "warning" | "error";
				customInstructions?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 456,
				summary: "focused summary",
			},
			aborted: false,
			willRetry: false,
			customInstructions: "focus on xyz",
		});

		expect(fakeThis.addMessageToChat).toHaveBeenLastCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 456,
				summary: "focused summary",
				customInstructions: "focus on xyz",
			}),
		);

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Session is too short to compact — try again once it grows",
			errorSeverity: "warning",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledWith("Session is too short to compact — try again once it grows");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
