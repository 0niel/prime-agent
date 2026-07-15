import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonAttachResult } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

interface SupervisorMonitorHarness {
	options: { worker: object };
	clients: Set<{ authenticated: boolean }>;
	shuttingDown: boolean;
	supervisorMonitorTimer?: ReturnType<typeof setTimeout>;
	canConnectToSupervisor: (socketPath: string) => Promise<boolean>;
	launchReplacementSupervisor: (socketPath: string) => Promise<void>;
	scheduleSupervisorAvailabilityCheck: (socketPath: string, delayMs: number) => void;
}

function createHarness(canConnect: () => Promise<boolean>): SupervisorMonitorHarness {
	return Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {} },
		clients: new Set<{ authenticated: boolean }>(),
		shuttingDown: false,
		canConnectToSupervisor: vi.fn(canConnect),
		launchReplacementSupervisor: vi.fn(async () => undefined),
	}) as SupervisorMonitorHarness;
}

describe("daemon worker supervisor monitoring", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("attempts every shutdown cleanup step before exiting", async () => {
		const cleanupSocket = vi.fn(() => {
			throw new Error("daemon socket cleanup failed");
		});
		const leaseRelease = vi.fn(async () => {
			throw new Error("lease cleanup failed");
		});
		const ownershipRelease = vi.fn(async () => undefined);
		const log = vi.fn();
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		type ShutdownHarness = {
			socketLease?: { release(): Promise<void> };
			ownership?: { release(): Promise<void> };
			shutdown(exitCode: number, stopWorkers: boolean, relaunch?: boolean, forceWorkers?: boolean): Promise<never>;
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			signalCleanupHandlers: [],
			workers: new Map(),
			clients: new Set(),
			catalog: { stop: vi.fn(async () => undefined) },
			cleanupSocket,
			snapshotCacheRoot: "\0",
			socketLease: { release: leaseRelease },
			ownership: { release: ownershipRelease },
			log,
		}) as ShutdownHarness;

		try {
			await expect(supervisor.shutdown(42, false)).rejects.toThrow("exit 42");
			expect(cleanupSocket).toHaveBeenCalledOnce();
			expect(leaseRelease).toHaveBeenCalledOnce();
			expect(ownershipRelease).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon socket"));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("supervisor cache"));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon socket lock"));
			expect(supervisor.socketLease).toBeUndefined();
			expect(supervisor.ownership).toBeUndefined();
			expect(exit).toHaveBeenCalledWith(42);
		} finally {
			exit.mockRestore();
		}
	});

	it("does not poll a healthy supervisor after the startup check", async () => {
		vi.useFakeTimers();
		const daemon = createHarness(async () => true);

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 1500);
		await vi.advanceTimersByTimeAsync(1500);
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
		expect(daemon.supervisorMonitorTimer).toBeUndefined();
	});

	it("skips socket probes while an authenticated supervisor connection is active", async () => {
		vi.useFakeTimers();
		const daemon = createHarness(async () => true);
		daemon.clients.add({ authenticated: true });

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.runAllTimersAsync();

		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
	});

	it("cancels an in-flight recovery after an intentional stop tombstone", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				stopRequestedAt?: string;
			};
			intentionalStop: boolean;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: { workerId: "worker-1", pid: process.pid, rootActiveSessionId: "active-1" },
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		worker.intentionalStop = true;
		worker.descriptor.stopRequestedAt = new Date().toISOString();
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(worker.recovery).toBeUndefined();
	});

	it("relaunches a worker instead of reconnecting to a reused pid", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				processStartId: string;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-reused-pid",
				pid: process.pid,
				processStartId: "different-process-start",
				rootActiveSessionId: "active-1",
				createCommand: { type: "create" },
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(supervisor.connectWorker).not.toHaveBeenCalled();
		expect(supervisor.recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker, false);
		expect(supervisor.launchWorker).toHaveBeenCalledWith(worker.descriptor.createCommand, worker);
	});

	it("does not relaunch a live worker whose process identity is unknown", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
				lifecycle?: string;
				consecutiveFailures: number;
				lastFailureAt?: string;
				lastError?: string;
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
			client?: { close(): void };
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			persistWorker: ReturnType<typeof vi.fn>;
			syncAgentPeers: ReturnType<typeof vi.fn>;
			log: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-unknown-identity",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				createCommand: { type: "create" },
				consecutiveFailures: 0,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(async () => {
				throw new Error("worker socket unavailable");
			}),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
			persistWorker: vi.fn(),
			syncAgentPeers: vi.fn(async () => {}),
			log: vi.fn(),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.runAllTimersAsync();
		await recovery;

		expect(supervisor.connectWorker).toHaveBeenCalledTimes(3);
		expect(supervisor.recoverUncertainWorkerOperations).not.toHaveBeenCalled();
		expect(supervisor.launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("failed");
	});

	it("keeps a recovered worker ready when peer synchronization fails", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				processStartId?: string;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
				lifecycle?: string;
				consecutiveFailures: number;
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			subscribeWorker: ReturnType<typeof vi.fn>;
			refreshWorkerSummaries: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			persistWorker: ReturnType<typeof vi.fn>;
			syncAgentPeers: ReturnType<typeof vi.fn>;
			log: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-peer-sync-failure",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				createCommand: { type: "create" },
				consecutiveFailures: 1,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(async () => ({})),
			subscribeWorker: vi.fn(async () => {}),
			refreshWorkerSummaries: vi.fn(async () => {}),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
			persistWorker: vi.fn(),
			syncAgentPeers: vi.fn(async () => {
				throw new Error("peer unavailable");
			}),
			log: vi.fn(),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(supervisor.connectWorker).toHaveBeenCalledOnce();
		expect(supervisor.recoverUncertainWorkerOperations).not.toHaveBeenCalled();
		expect(supervisor.launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(worker.descriptor.consecutiveFailures).toBe(0);
	});

	it("ignores malformed persisted worker descriptors", () => {
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-descriptor-test-"));
		try {
			writeFileSync(
				join(descriptorDir, "malformed.json"),
				`${JSON.stringify({
					version: 1,
					supervisorSocketPath: "/tmp/supervisor.sock",
					workerId: "worker-1",
					rootActiveSessionId: "active-1",
				})}\n`,
			);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers: new Map(),
				log: vi.fn(),
			}) as {
				workers: Map<string, unknown>;
				loadWorkerDescriptors(): void;
			};

			supervisor.loadWorkerDescriptors();

			expect(supervisor.workers.size).toBe(0);
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("seeds compact attach streaming from the in-flight assistant message", async () => {
		const assistant = (text: string): AgentMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		const activeSessionId = "active-1";
		const finalizedMessage = assistant("finalized");
		const streamingMessage = assistant("in flight");
		const summary: SessionSummary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "working",
			sessionId: "session-1",
			cwd: "/tmp/project",
			isStreaming: true,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 1,
			pendingMessageCount: 0,
			streamingMessage,
		};
		const result = {
			activeSessionId,
			snapshot: { summary, messages: [finalizedMessage] },
		} as unknown as DaemonAttachResult;
		const worker = {
			descriptor: { workerId: "worker-1", lifecycle: "ready", pid: 1234 },
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, result]]),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const seed = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed },
			syncWorkerExtensionUi: vi.fn(async () => {}),
		}) as {
			attachClient(
				client: {
					id: string;
					capabilities: Set<string>;
					supportsExtensionUi: boolean;
					attachedActiveSessionIds: Set<string>;
				},
				command: { type: "attach"; activeSessionId: string },
			): Promise<unknown>;
		};

		await supervisor.attachClient(client, { type: "attach", activeSessionId });

		expect(seed).toHaveBeenCalledWith(activeSessionId, streamingMessage);
	});

	it("subscribes to worker updates with chunked snapshots", async () => {
		type SubscriptionWorker = {
			client: { requestWorker: (command: unknown) => Promise<{ success: boolean }> };
		};
		const requestWorker = vi.fn(async () => ({ success: true }));
		const worker: SubscriptionWorker = { client: { requestWorker } };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set(),
		}) as {
			subscribeWorker(worker: SubscriptionWorker, activeSessionId: string): Promise<void>;
		};

		await supervisor.subscribeWorker(worker, "active-1");

		expect(requestWorker).toHaveBeenCalledWith({
			type: "worker_subscribe",
			activeSessionId: "active-1",
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			supportsExtensionUi: false,
		});
	});

	it("does not retain an attachment when snapshot loading fails", async () => {
		type AttachClient = {
			id: string;
			capabilities: Set<string>;
			supportsExtensionUi: boolean;
			attachedActiveSessionIds: Set<string>;
		};
		const activeSessionId = "active-failed-attach";
		const summary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			sessionId: "session-failed-attach",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			pendingMessageCount: 0,
		} satisfies SessionSummary;
		const worker = {
			descriptor: { workerId: "worker-1", lifecycle: "ready", pid: 1234 },
			client: {
				request: vi.fn(async () => {
					throw new Error("snapshot failed");
				}),
			},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
		};
		const client: AttachClient = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
		}) as {
			attachClient(client: AttachClient, command: { type: "attach"; activeSessionId: string }): Promise<unknown>;
		};

		await expect(supervisor.attachClient(client, { type: "attach", activeSessionId })).rejects.toThrow(
			"snapshot failed",
		);
		expect(client.attachedActiveSessionIds).toEqual(new Set());
	});

	it("marks each busy worker session interrupted independently", async () => {
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				recoveryJournalPath: string;
				orphanProcessJournalPath: string;
			};
		};
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-recovery-test-"));
		const journalPath = join(root, "worker.recovery.jsonl");
		const orphanJournalPath = join(root, "worker.orphans.jsonl");
		writeFileSync(
			orphanJournalPath,
			`${JSON.stringify({
				version: 1,
				pid: 987_654,
				ownerPid: process.pid,
				processStartId: "reused-process",
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: "/tmp/root.jsonl",
			busy: true,
			operation: "model_stream",
		});
		journal.record({
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionFile: "/tmp/child.jsonl",
			busy: true,
			operation: "tool_execution",
		});
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-1",
				pid: process.pid,
				rootActiveSessionId: "root-active",
				recoveryJournalPath: journalPath,
				orphanProcessJournalPath: orphanJournalPath,
			},
		};
		const markInterrupted = vi.fn(async () => undefined);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			catalog: { markInterrupted },
			log: vi.fn(),
		}) as {
			recoverUncertainWorkerOperations(worker: RecoveryWorker, killWorkerProcess: boolean): Promise<void>;
		};

		try {
			await supervisor.recoverUncertainWorkerOperations(worker, false);
			expect(kill).not.toHaveBeenCalled();
			expect(markInterrupted).toHaveBeenCalledTimes(2);
			expect(markInterrupted).toHaveBeenCalledWith("/tmp/root.jsonl", "root-active", ["model_stream"]);
			expect(markInterrupted).toHaveBeenCalledWith("/tmp/child.jsonl", "child-active", ["tool_execution"]);
		} finally {
			kill.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
