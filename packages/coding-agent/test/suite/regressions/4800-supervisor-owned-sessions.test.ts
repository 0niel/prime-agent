import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import type { DaemonCommand, DaemonOutbound, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import {
	DAEMON_EPHEMERAL_WORKER_DISCONNECT_GRACE_MS,
	DaemonSupervisor,
} from "../../../src/modes/daemon/daemon-supervisor.js";
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

	it("retires an ephemeral worker only after its last client detaches", async () => {
		vi.useFakeTimers();
		try {
			const summary = createSummary();
			const worker = {
				descriptor: { workerId: "worker-1" },
				ephemeral: true,
				pendingAttachments: 0,
				summaries: new Map([[activeSessionId, summary]]),
			};
			const firstClient = {
				attachedActiveSessionIds: new Set([activeSessionId]),
				catchupActiveSessionIds: new Set<string>(),
				catchupPurposes: new Map(),
			};
			const secondClient = {
				attachedActiveSessionIds: new Set([activeSessionId]),
				catchupActiveSessionIds: new Set<string>(),
				catchupPurposes: new Map(),
			};
			const stopWorker = vi.fn(async () => undefined);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				clients: new Set([firstClient, secondClient]),
				workers: new Map([["worker-1", worker]]),
				matchWorkers: vi.fn(() => [{ worker, summary }]),
				syncWorkerExtensionUi: vi.fn(async () => undefined),
				stopWorker,
				write: vi.fn(() => true),
				log: vi.fn(),
			}) as {
				detachClient(client: typeof firstClient, activeSessionId: string): void;
			};

			supervisor.detachClient(firstClient, activeSessionId);
			await vi.advanceTimersByTimeAsync(DAEMON_EPHEMERAL_WORKER_DISCONNECT_GRACE_MS);
			expect(stopWorker).not.toHaveBeenCalled();

			supervisor.detachClient(secondClient, activeSessionId);
			await vi.advanceTimersByTimeAsync(DAEMON_EPHEMERAL_WORKER_DISCONNECT_GRACE_MS);
			expect(stopWorker).toHaveBeenCalledWith(worker, true);
		} finally {
			vi.useRealTimers();
		}
	});
});
