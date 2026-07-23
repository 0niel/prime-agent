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
		const worker = {
			descriptor: { rootActiveSessionId: activeSessionId, lifecycle: "ready" },
			intentionalStop: false,
		};
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

	it("rejects create reuse when the existing worker is not ready", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-1",
				rootActiveSessionId: activeSessionId,
				lifecycle: "failed",
			},
			intentionalStop: false,
		};
		const summary = createSummary();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			matchWorkers: vi.fn(() => [{ worker, summary }]),
			scheduleEphemeralWorkerCleanup: vi.fn(),
		}) as {
			createOrReuseWorker(clientId: string, command: DaemonCreateCommand): Promise<typeof worker>;
		};

		await expect(
			supervisor.createOrReuseWorker("client-1", {
				type: "create",
				sessionPath: summary.sessionFile,
			}),
		).rejects.toThrow("Session worker is failed");
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

	it("rejects an attach after ephemeral cleanup commits the worker stop", async () => {
		const summary = createSummary();
		const worker = {
			descriptor: {
				workerId: "worker-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			matchWorkers: vi.fn(() => [{ worker, summary }]),
		}) as {
			attachClient(
				client: DaemonSocketClient,
				command: Extract<DaemonCommand, { type: "attach" }>,
			): Promise<unknown>;
		};

		await expect(
			supervisor.attachClient({} as DaemonSocketClient, {
				type: "attach",
				activeSessionId,
			}),
		).rejects.toThrow("worker-1 is stopping");
	});

	it("waits for in-flight worker recovery before attaching", async () => {
		const summary = createSummary();
		let finishRecovery!: () => void;
		const worker = {
			descriptor: {
				workerId: "worker-1",
				lifecycle: "recovering",
			},
			intentionalStop: false,
			pendingAttachments: 0,
			client: undefined as object | undefined,
		};
		const recovery = new Promise<void>((resolve) => {
			finishRecovery = () => {
				worker.client = {};
				worker.descriptor.lifecycle = "ready";
				resolve();
			};
		});
		const attachClientToWorker = vi.fn(async () => ({ attached: true }));
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			findWorker: vi.fn(async () => ({ worker, summary })),
			recoverWorker: vi.fn(async () => recovery),
			attachClientToWorker,
			cancelEphemeralWorkerCleanup: vi.fn(),
			scheduleEphemeralWorkerCleanup: vi.fn(),
		}) as {
			attachClient(
				client: DaemonSocketClient,
				command: Extract<DaemonCommand, { type: "attach" }>,
			): Promise<unknown>;
		};

		const attaching = supervisor.attachClient({} as DaemonSocketClient, {
			type: "attach",
			activeSessionId,
		});
		await Promise.resolve();
		expect(attachClientToWorker).not.toHaveBeenCalled();

		finishRecovery();
		await expect(attaching).resolves.toEqual({ attached: true });
		expect(attachClientToWorker).toHaveBeenCalledOnce();
	});

	it("refreshes ephemeral cleanup when create reuses a worker", async () => {
		vi.useFakeTimers();
		try {
			const summary = createSummary();
			const worker = {
				descriptor: {
					workerId: "worker-1",
					rootActiveSessionId: activeSessionId,
					lifecycle: "ready",
				},
				intentionalStop: false,
				ephemeral: true,
				pendingAttachments: 0,
				summaries: new Map([[activeSessionId, summary]]),
				cleanupTimer: undefined as NodeJS.Timeout | undefined,
			};
			const stopWorker = vi.fn(async () => undefined);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				clients: new Set(),
				workers: new Map([["worker-1", worker]]),
				matchWorkers: vi.fn(() => [{ worker, summary }]),
				stopWorker,
				log: vi.fn(),
			}) as {
				createOrReuseWorker(clientId: string, command: DaemonCreateCommand): Promise<typeof worker>;
				scheduleEphemeralWorkerCleanup(worker: unknown): void;
			};

			supervisor.scheduleEphemeralWorkerCleanup(worker);
			await vi.advanceTimersByTimeAsync(DAEMON_EPHEMERAL_WORKER_DISCONNECT_GRACE_MS - 1);
			await supervisor.createOrReuseWorker("client-1", {
				type: "create",
				sessionPath: summary.sessionFile,
			});
			await vi.advanceTimersByTimeAsync(1);

			expect(stopWorker).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(DAEMON_EPHEMERAL_WORKER_DISCONNECT_GRACE_MS - 1);
			expect(stopWorker).toHaveBeenCalledWith(worker, true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reschedules ephemeral cleanup after reconnecting a live worker", async () => {
		vi.useFakeTimers();
		try {
			const worker = {
				descriptor: {
					workerId: "worker-1",
					pid: process.pid,
					rootActiveSessionId: activeSessionId,
					lifecycle: "recovering",
					consecutiveFailures: 1,
				},
				intentionalStop: false,
				ephemeral: true,
			};
			const scheduleEphemeralWorkerCleanup = vi.fn();
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				workers: new Map([["worker-1", worker]]),
				assertRecoveryAllowed: vi.fn(async () => undefined),
				connectWorker: vi.fn(async () => undefined),
				subscribeWorker: vi.fn(async () => undefined),
				refreshWorkerSummaries: vi.fn(async () => undefined),
				persistWorker: vi.fn(),
				syncAgentPeers: vi.fn(async () => undefined),
				broadcastHeartbeatsChanged: vi.fn(),
				scheduleEphemeralWorkerCleanup,
			}) as {
				recoverWorker(worker: unknown): Promise<void>;
			};

			const recovery = supervisor.recoverWorker(worker);
			await vi.advanceTimersByTimeAsync(250);
			await recovery;

			expect(scheduleEphemeralWorkerCleanup).toHaveBeenCalledWith(worker);
			expect(worker.descriptor.lifecycle).toBe("ready");
		} finally {
			vi.useRealTimers();
		}
	});

	it("schedules ephemeral cleanup after recovery is exhausted", async () => {
		vi.useFakeTimers();
		try {
			const worker = {
				descriptor: {
					workerId: "worker-1",
					pid: process.pid,
					rootActiveSessionId: activeSessionId,
					lifecycle: "recovering",
					consecutiveFailures: 0,
				},
				intentionalStop: false,
				ephemeral: true,
			};
			const scheduleEphemeralWorkerCleanup = vi.fn();
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				workers: new Map([["worker-1", worker]]),
				assertRecoveryAllowed: vi.fn(async () => undefined),
				connectWorker: vi.fn(async () => {
					throw new Error("worker unavailable");
				}),
				persistWorker: vi.fn(),
				syncAgentPeers: vi.fn(async () => undefined),
				scheduleEphemeralWorkerCleanup,
				log: vi.fn(),
			}) as {
				recoverWorker(worker: unknown): Promise<void>;
			};

			const recovery = supervisor.recoverWorker(worker);
			await vi.runAllTimersAsync();
			await recovery;

			expect(worker.descriptor.lifecycle).toBe("failed");
			expect(scheduleEphemeralWorkerCleanup).toHaveBeenCalledWith(worker);
		} finally {
			vi.useRealTimers();
		}
	});
});
