import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const handleRefineCommand = Reflect.get(InteractiveMode.prototype, "handleRefineCommand") as (
	this: {
		agentConnection: {
			getSessionStats: ReturnType<typeof vi.fn>;
			refine: ReturnType<typeof vi.fn>;
		};
		stopWorkingLoader: ReturnType<typeof vi.fn>;
		showStatus: ReturnType<typeof vi.fn>;
		showWarning: ReturnType<typeof vi.fn>;
		showError: ReturnType<typeof vi.fn>;
	},
	args?: string,
) => Promise<void>;

describe("InteractiveMode.handleRefineCommand", () => {
	test("requires a refinement id for rollback", async () => {
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 2 }),
				refine: vi.fn(),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "rollback");

		expect(context.showWarning).toHaveBeenCalledWith("Usage: /refine rollback <refinement-id>");
		expect(context.agentConnection.refine).not.toHaveBeenCalled();
		expect(context.stopWorkingLoader).not.toHaveBeenCalled();
	});

	test("rolls back even when the session has no trajectory yet", async () => {
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 0 }),
				refine: vi.fn().mockResolvedValue({ appliedEdits: [], harnessStatePath: "/tmp/harness_state.json" }),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "rollback refine_123");

		// Rollback uses global history, so the empty-trajectory guard must not block it.
		expect(context.agentConnection.getSessionStats).not.toHaveBeenCalled();
		expect(context.showWarning).not.toHaveBeenCalled();
		expect(context.agentConnection.refine).toHaveBeenCalledWith({ rollbackId: "refine_123" });
	});

	test("blocks plain refinement when there is no trajectory", async () => {
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 1 }),
				refine: vi.fn(),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "focus on validation");

		expect(context.showWarning).toHaveBeenCalledWith("Nothing to refine (no trajectory yet)");
		expect(context.agentConnection.refine).not.toHaveBeenCalled();
	});
});
