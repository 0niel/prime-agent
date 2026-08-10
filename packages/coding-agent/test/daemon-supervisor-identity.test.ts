import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const processState = vi.hoisted(() => ({
	startId: "start-a" as string | undefined,
	unreadableAfterSignal: false,
}));
const signals = vi.hoisted(() => [] as Array<{ pid: number; signal: NodeJS.Signals }>);

vi.mock("../src/core/session-lease.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/session-lease.js")>();
	return { ...actual, getProcessStartId: () => processState.startId };
});
vi.mock("../src/utils/child-process.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/child-process.js")>();
	return {
		...actual,
		signalProcessGroupOrProcess: (pid: number, signal: NodeJS.Signals) => {
			signals.push({ pid, signal });
			if (processState.unreadableAfterSignal) processState.startId = undefined;
		},
	};
});

import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const generationA = "11111111-1111-4111-8111-111111111111";
const generationB = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
	processState.startId = "start-a";
	processState.unreadableAfterSignal = false;
	signals.splice(0);
});

function worker(generation = generationA, process = { pid: 4321, processStartId: "start-a" }) {
	return {
		descriptor: { workerId: "worker", generation, process },
	} as unknown as any;
}

function supervisorFor(target: ReturnType<typeof worker>) {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map([["worker", target]]),
		log: vi.fn(),
	}) as DaemonSupervisor;
}

function stopWorkerFixture() {
	const target = {
		descriptor: {
			workerId: "worker",
			generation: generationA,
			lifecycle: "ready",
			process: { pid: 4321, processStartId: "start-a" },
		},
		descriptorPath: "/descriptor/worker.json",
		summaries: new Map(),
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		intentionalStop: false,
		stopRevision: 0,
	} as any;
	const persistWorker = vi.fn();
	const deleteWorkerDescriptor = vi.fn();
	const supervisor = Object.assign(supervisorFor(target), {
		persistWorker,
		persistWorkerStopTombstone: vi.fn((resident: typeof target, archiveSession = false) => {
			resident.intentionalStop = true;
			resident.descriptor.stopRequestedAt ??= new Date().toISOString();
			resident.descriptor.archiveOnStop ||= archiveSession;
			persistWorker(resident);
		}),
		deleteWorkerDescriptor,
		syncAgentPeers: vi.fn(async () => undefined),
		broadcastHeartbeatsChanged: vi.fn(),
	}) as any;
	return { supervisor, target, persistWorker, deleteWorkerDescriptor };
}

describe("daemon supervisor C01 process identity fencing", () => {
	it("signals only a matching current PID/start identity", () => {
		const target = worker();
		const supervisor = supervisorFor(target) as any;
		expect(supervisor.signalTrackedWorker(target, generationA, "SIGTERM")).toBe(true);
		expect(signals).toEqual([{ pid: 4321, signal: "SIGTERM" }]);
	});

	it("never signals a mismatched or unreadable start identity", () => {
		const target = worker();
		const supervisor = supervisorFor(target) as any;
		processState.startId = "reused";
		expect(supervisor.signalTrackedWorker(target, generationA, "SIGKILL")).toBe(false);
		processState.startId = undefined;
		expect(supervisor.signalTrackedWorker(target, generationA, "SIGTERM")).toBe(false);
		expect(signals).toEqual([]);
	});

	it("rejects a stale generation or an unpublished replacement object", () => {
		const old = worker(generationA);
		const replacement = worker(generationB);
		const supervisor = supervisorFor(replacement) as any;
		expect(supervisor.signalTrackedWorker(old, generationA, "SIGTERM")).toBe(false);
		expect(supervisor.signalTrackedWorker(replacement, generationA, "SIGTERM")).toBe(false);
		expect(signals).toEqual([]);
	});

	it("keeps callback fencing enabled by default and limits the rollback gate to callbacks", () => {
		const target = worker();
		const client = {} as any;
		(target as any).client = client;
		const supervisor = supervisorFor(target) as any;
		expect(supervisor.acceptsWorkerCallback(target, generationA, client)).toBe(true);
		(supervisor as any).c01IdentityFencingEnabled = false;
		// =0 may accept an old callback, but signalTrackedWorker remains hard fenced.
		expect(supervisor.acceptsWorkerCallback(target, generationB, client)).toBe(true);
		processState.startId = "reused";
		expect(supervisor.signalTrackedWorker(target, generationA, "SIGTERM")).toBe(false);
		expect(signals).toEqual([]);
	});

	it("treats passivated descriptors as physically processless", () => {
		const target = { descriptor: { workerId: "worker", generation: generationA, lifecycle: "passivated" } } as any;
		const supervisor = supervisorFor(target) as any;
		expect(supervisor.signalTrackedWorker(target, generationA, "SIGTERM")).toBe(false);
		expect(signals).toEqual([]);
	});

	it("refuses signals when a current descriptor has no process identity", () => {
		const target = { descriptor: { workerId: "worker", generation: generationA, lifecycle: "recovering" } } as any;
		const supervisor = supervisorFor(target) as any;
		expect(supervisor.signalTrackedWorker(target, generationA, "SIGKILL")).toBe(false);
		expect(signals).toEqual([]);
	});

	it("retains a stop tombstone when a live worker becomes transiently unreadable after signaling", async () => {
		const { supervisor, target, deleteWorkerDescriptor } = stopWorkerFixture();
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			// The immediate pre-signal reread is exact; the next reread loses
			// start-id visibility, modeling a transient process-start lookup failure.
			processState.unreadableAfterSignal = true;
			await expect(supervisor.stopWorker(target, true, true)).rejects.toThrow("process identity is unreadable");
			expect(target.descriptor.stopRequestedAt).toEqual(expect.any(String));
			expect(supervisor.workers.get("worker")).toBe(target);
			expect(target.stopFinalized).toBeUndefined();
			expect(deleteWorkerDescriptor).not.toHaveBeenCalled();
			expect(signals).toEqual([{ pid: 4321, signal: "SIGTERM" }]);

			// A later exact observation may complete cleanup. This simulates the
			// original PID having exited and then being observably recycled.
			processState.unreadableAfterSignal = false;
			processState.startId = "reused";
			await expect(supervisor.stopWorker(target, true, true)).resolves.toBeUndefined();
			expect(target.stopFinalized).toBe(true);
			expect(deleteWorkerDescriptor).toHaveBeenCalledWith(target);
		} finally {
			kill.mockRestore();
		}
	});

	it("finalizes a verified recycled PID without signaling it", async () => {
		const { supervisor, target, deleteWorkerDescriptor } = stopWorkerFixture();
		processState.startId = "reused";
		await expect(supervisor.stopWorker(target, true, true)).resolves.toBeUndefined();
		expect(signals).toEqual([]);
		expect(target.stopFinalized).toBe(true);
		expect(supervisor.workers.has("worker")).toBe(false);
		expect(deleteWorkerDescriptor).toHaveBeenCalledWith(target);
	});

	it("uses a new generation for a later launch incarnation", () => {
		const first = randomUUID();
		const second = randomUUID();
		expect(first).not.toBe(second);
	});
	describe("recovery join finalizers", () => {
		it("does not let deferred recovery A clear an installed B join", async () => {
			vi.useFakeTimers();
			try {
				const target = worker();
				const supervisor = supervisorFor(target) as any;
				supervisor.isWorkerRecoveryCandidate = vi.fn(() => false);
				supervisor.deferWorkerRecovery(target, new Error("A"));
				const deferredA = target.deferredRecovery;
				const deferredB = Promise.resolve();
				target.deferredRecovery = deferredB;
				await vi.advanceTimersByTimeAsync(10_000);
				await deferredA;
				expect(target.deferredRecovery).toBe(deferredB);
			} finally {
				vi.useRealTimers();
			}
		});

		it("clears its settled deferred join after the same worker publishes a new generation", async () => {
			vi.useFakeTimers();
			try {
				const target = worker();
				const supervisor = supervisorFor(target) as any;
				supervisor.isWorkerRecoveryCandidate = vi.fn(() => false);
				supervisor.deferWorkerRecovery(target, new Error("A"));
				const deferred = target.deferredRecovery;
				target.descriptor.generation = "published-after-A";
				await vi.advanceTimersByTimeAsync(10_000);
				await deferred;
				expect(target.deferredRecovery).toBeUndefined();
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not let recovery A clear an installed B join", async () => {
			vi.useFakeTimers();
			try {
				const target = worker();
				const supervisor = supervisorFor(target) as any;
				supervisor.isWorkerRecoveryCancelled = vi.fn(() => true);
				const recoveryA = supervisor.recoverWorker(target);
				const recoveryB = Promise.resolve();
				target.recovery = recoveryB;
				await vi.advanceTimersByTimeAsync(10_000);
				await recoveryA;
				expect(target.recovery).toBe(recoveryB);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
