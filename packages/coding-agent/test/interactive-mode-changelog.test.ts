import { describe, expect, it, vi } from "vitest";
import { emptyGoalState } from "../src/core/goals.js";
import type { AgentConnectionState } from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ChangelogContext = {
	connectionState?: AgentConnectionState;
	agentConnection: {
		getState: () => Promise<AgentConnectionState>;
	};
	applyConnectionStateSnapshot: (state: AgentConnectionState) => void;
};

type InteractiveModePrototype = {
	getChangelogForDisplay(this: ChangelogContext): Promise<string | undefined>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createState(messageCount: number): AgentConnectionState {
	return {
		cwd: "/tmp/project",
		model: undefined,
		thinkingLevel: "medium",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId: "session-1",
		leafId: "leaf-1",
		autoCompactionEnabled: true,
		messageCount,
		pendingMessageCount: 0,
		compactionCount: 0,
		goal: emptyGoalState(),
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
	};
}

describe("InteractiveMode startup changelog gating", () => {
	it("uses AgentConnection state to detect restored sessions", async () => {
		const state = createState(1);
		const context: ChangelogContext = {
			agentConnection: { getState: vi.fn(async () => state) },
			applyConnectionStateSnapshot: vi.fn(),
		};

		await expect(interactiveModePrototype.getChangelogForDisplay.call(context)).resolves.toBeUndefined();

		expect(context.agentConnection.getState).toHaveBeenCalledWith();
		expect(context.applyConnectionStateSnapshot).toHaveBeenCalledWith(state);
	});

	it("does not fall back to local UI session state when connection state fails", async () => {
		const context: ChangelogContext = {
			agentConnection: {
				getState: vi.fn(async () => {
					throw new Error("connection unavailable");
				}),
			},
			applyConnectionStateSnapshot: vi.fn(),
		};

		await expect(interactiveModePrototype.getChangelogForDisplay.call(context)).rejects.toThrow(
			"connection unavailable",
		);
		expect(context.applyConnectionStateSnapshot).not.toHaveBeenCalled();
	});
});
