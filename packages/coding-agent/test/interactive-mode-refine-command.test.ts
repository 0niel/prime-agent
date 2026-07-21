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
		expect(context.agentConnection.refine).toHaveBeenCalledWith({ rollbackId: "refine_123", global: false });
	});

	test("parses --global after rollback id", async () => {
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

		await handleRefineCommand.call(context, "rollback refine_123 --global");

		expect(context.agentConnection.getSessionStats).not.toHaveBeenCalled();
		expect(context.agentConnection.refine).toHaveBeenCalledWith({ rollbackId: "refine_123", global: true });
	});

	test("parses --global before refinement instructions", async () => {
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 2 }),
				refine: vi.fn().mockResolvedValue({ appliedEdits: [], harnessStatePath: "/tmp/harness_state.json" }),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "--global focus on validation");

		expect(context.showStatus).toHaveBeenCalledWith("Refining global continual harness state...");
		expect(context.agentConnection.refine).toHaveBeenCalledWith({
			instructions: "focus on validation",
			global: true,
		});
	});

	test("preserves trailing --global in ordinary refinement instructions", async () => {
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 2 }),
				refine: vi.fn().mockResolvedValue({ appliedEdits: [], harnessStatePath: "/tmp/harness_state.json" }),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "update docs to explain --global");

		expect(context.showStatus).toHaveBeenCalledWith("Refining local continual harness state...");
		expect(context.agentConnection.refine).toHaveBeenCalledWith({
			instructions: "update docs to explain --global",
			global: false,
		});
	});

	test("shows local scope in status for default refinement", async () => {
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 2 }),
				refine: vi.fn().mockResolvedValue({ appliedEdits: [], harnessStatePath: "/tmp/harness_state.json" }),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "focus on validation");

		expect(context.showStatus).toHaveBeenCalledWith("Refining local continual harness state...");
		expect(context.agentConnection.refine).toHaveBeenCalledWith({
			instructions: "focus on validation",
			global: false,
		});
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

	test("shows success status after refine resolves without blocking the caller", async () => {
		let resolveRefine: ((value: unknown) => void) | undefined;
		const refinePromise = new Promise((resolve) => {
			resolveRefine = resolve;
		});
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 2 }),
				refine: vi.fn().mockReturnValue(refinePromise),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "focus on validation");

		// The "Refining..." status is shown synchronously.
		expect(context.showStatus).toHaveBeenCalledWith("Refining local continual harness state...");
		// The success status is NOT shown yet because refine has not resolved.
		expect(context.showStatus).not.toHaveBeenCalledWith("Refined continual harness state: 2 edits applied, 1 failed");

		// Resolve the refine promise and let the microtask queue drain.
		resolveRefine?.({
			appliedEdits: [{ applied: true }, { applied: true }, { applied: false, error: "entry not found" }],
			harnessStatePath: "/tmp/harness_state.json",
		});
		await vi.waitFor(() => {
			expect(context.showStatus).toHaveBeenCalledWith("Refined continual harness state: 2 edits applied, 1 failed");
		});
		expect(context.showStatus).toHaveBeenCalledWith("Harness state: /tmp/harness_state.json");
	});

	test("shows error status after refine rejects without blocking the caller", async () => {
		let rejectRefine: ((error: Error) => void) | undefined;
		const refinePromise = new Promise<never>((_, reject) => {
			rejectRefine = reject;
		});
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 2 }),
				refine: vi.fn().mockReturnValue(refinePromise),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "focus on validation");

		// The "Refining..." status is shown synchronously.
		expect(context.showStatus).toHaveBeenCalledWith("Refining local continual harness state...");
		// The error is NOT shown yet because refine has not rejected.
		expect(context.showError).not.toHaveBeenCalled();

		rejectRefine?.(new Error("LLM timed out"));
		await vi.waitFor(() => {
			expect(context.showError).toHaveBeenCalledWith("Refinement failed: LLM timed out");
		});
	});
});
