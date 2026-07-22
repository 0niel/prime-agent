import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import type { DaemonCommand, DaemonOutbound, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonCreateCommand } from "../../../src/modes/daemon/daemon-worker-protocol.js";

const activeSessionId = "active-target";

function createSummary(): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		sessionId: "session-target",
		sessionFile: "/tmp/session-target.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: 1,
		pendingMessageCount: 0,
	};
}

describe("ENG-4800 supervisor-owned sessions", () => {
	it("reuses an active worker when a legacy client requests ownership", async () => {
		const worker = { descriptor: { rootActiveSessionId: activeSessionId } };
		const summary = createSummary();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			matchWorkers: vi.fn(() => [{ worker, summary }]),
		}) as {
			createOrReuseWorker(clientId: string, command: DaemonCreateCommand): Promise<typeof worker>;
		};

		await expect(
			supervisor.createOrReuseWorker("legacy-client", {
				type: "create",
				sessionPath: summary.sessionFile,
				lifecycle: "client_owned",
			}),
		).resolves.toBe(worker);
	});

	it("treats legacy owned-session completion as detach", async () => {
		const client = {
			id: "legacy-client",
			socket: { destroyed: false } as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set([activeSessionId]),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(["attach_snapshot", "event_sequence"] as const),
		} satisfies DaemonSocketClient;
		const summary = createSummary();
		const worker = {};
		const stopWorker = vi.fn();
		const write = vi.fn((_client: DaemonSocketClient, _message: DaemonOutbound) => true);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			matchWorkers: vi.fn(() => [{ worker, summary }]),
			syncWorkerExtensionUi: vi.fn(async () => undefined),
			stopWorker,
			write,
		}) as {
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
		};

		await expect(
			supervisor.handleCommand(client, { type: "complete_owned_session", activeSessionId }),
		).resolves.toMatchObject({ success: true });
		expect(client.attachedActiveSessionIds).toEqual(new Set());
		expect(stopWorker).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledWith(client, { type: "session_detached", activeSessionId });
	});
});
