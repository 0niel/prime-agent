import { describe, expect, test, vi } from "vitest";
import { AgentsViewMode } from "../../../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";

function summary(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `session-${id}`,
		lifecycle: "live",
		activity: "idle",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		pendingMessageCount: 0,
	};
}

describe("#502 unified session view regressions", () => {
	test("an older overlapping live poll cannot overwrite the newer response", async () => {
		let resolveOld: ((value: unknown) => void) | undefined;
		const oldResponse = new Promise((resolve) => {
			resolveOld = resolve;
		});
		const newer = summary("new");
		const client = {
			isConnected: true,
			request: vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce({
				success: true,
				data: { sessions: [newer] },
			}),
		};
		const applySessionList = vi.fn();
		const harness = {
			reconnectPromise: undefined,
			daemonShutdownReceived: false,
			options: {},
			liveCatalogGeneration: 0,
			requireClient: () => client,
			applySessionList,
			setStatusMessage: vi.fn(),
		};
		const refresh = Reflect.get(AgentsViewMode.prototype, "refreshSessions") as (
			this: typeof harness,
		) => Promise<boolean>;

		const oldPoll = refresh.call(harness);
		await refresh.call(harness);
		resolveOld?.({ success: true, data: { sessions: [summary("old")] } });
		await oldPoll;

		expect(applySessionList).toHaveBeenCalledOnce();
		expect(applySessionList).toHaveBeenCalledWith([newer]);
	});
});
