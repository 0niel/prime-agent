import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessQueryOptions, getWindowsProcessStartId, runProcessQuery } from "../../../src/core/session-lease.js";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, success } from "../../../src/modes/daemon/daemon-protocol.js";
import { createWorkerProcessIdentityProbe, DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";

const processIdentityState = vi.hoisted(() => ({
	pid: 424_242,
	observedStartId: "replacement-process" as string | undefined,
	startIdProbeCount: 0,
}));

interface SessionLeaseModule {
	getProcessStartId(pid: number): string | undefined;
}

vi.mock("../../../src/core/session-lease.js", async (importOriginal) => {
	const actual = await importOriginal<SessionLeaseModule>();
	return {
		...actual,
		getProcessStartId(pid: number): string | undefined {
			if (pid === processIdentityState.pid) {
				processIdentityState.startIdProbeCount++;
				return processIdentityState.observedStartId;
			}
			return actual.getProcessStartId(pid);
		},
	};
});

interface SupervisorHarness {
	workers: Map<string, unknown>;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	processIdentityState.observedStartId = "replacement-process";
	processIdentityState.startIdProbeCount = 0;
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-regression-1045-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

describe("#1045 failed worker isolation", () => {
	it("force-kills a SIGTERM-ignoring process query within the hard bound", () => {
		const startedAt = performance.now();
		const processStartId = getWindowsProcessStartId(42, () =>
			runProcessQuery(process.execPath, [
				"--eval",
				'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 3000)',
			]),
		);
		const elapsedMs = performance.now() - startedAt;

		expect(processStartId).toBeUndefined();
		expect(elapsedMs).toBeLessThan(1500);
	});

	it("allows a bounded cold PowerShell window while keeping ps probes short", () => {
		expect(getProcessQueryOptions("win32")).toEqual({
			timeout: 1000,
			maxBuffer: 64 * 1024,
			killSignal: "SIGKILL",
		});
		expect(getProcessQueryOptions("darwin")).toEqual({
			timeout: 250,
			maxBuffer: 64 * 1024,
			killSignal: "SIGKILL",
		});
	});
	it("classifies mismatched and unknown process identities without authorizing a signal", () => {
		vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (pid === processIdentityState.pid && signal === 0) {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			}
			throw new Error(`Unexpected process probe ${pid}`);
		}) as typeof process.kill);
		const descriptor = {
			pid: processIdentityState.pid,
			processStartId: "exited-worker",
		};

		expect(createWorkerProcessIdentityProbe(descriptor).status(true)).toBe("mismatch");
		processIdentityState.observedStartId = undefined;
		expect(createWorkerProcessIdentityProbe(descriptor).status(true)).toBe("unknown");
	});

	it.each([
		{ caseName: "reused", observedStartId: "replacement-process" as string | undefined },
		{ caseName: "unverifiable", observedStartId: undefined },
	])("does not pre-kill a tombstoned worker with a $caseName pid identity", async ({ observedStartId }) => {
		processIdentityState.observedStartId = observedStartId;
		const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (pid === processIdentityState.pid && signal === 0) {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			}
			return true;
		}) as typeof process.kill);
		const stopWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(worker: unknown): Promise<void>;
		};
		const worker = {
			descriptor: {
				workerId: "reused-worker",
				pid: processIdentityState.pid,
				processStartId: "exited-worker",
				rootActiveSessionId: "active-reused-worker",
				lifecycle: "recovering",
				stopRequestedAt: new Date().toISOString(),
			},
		};

		await supervisor.adoptOrRecoverWorker(worker);

		expect(stopWorker).toHaveBeenCalledOnce();
		expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
	});

	it("bounds synchronous process start-id probes during stop polling", () => {
		vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (pid === processIdentityState.pid && signal === 0) {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			}
			throw new Error(`Unexpected process probe ${pid}`);
		}) as typeof process.kill);
		processIdentityState.observedStartId = "worker-start";
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const probe = createWorkerProcessIdentityProbe({
			pid: processIdentityState.pid,
			processStartId: "worker-start",
		});

		for (let index = 0; index < 80; index++) {
			expect(probe.isAlive()).toBe(true);
			now += 25;
		}
		expect(processIdentityState.startIdProbeCount).toBe(2);
		expect(probe.isAlive()).toBe(true);
		expect(processIdentityState.startIdProbeCount).toBe(3);
		expect(probe.status(true)).toBe("match");
		expect(processIdentityState.startIdProbeCount).toBe(4);
	});

	it("omits a failed worker without poisoning healthy global heartbeat results", async () => {
		const supervisor = createSupervisorHarness();
		const healthy = {
			descriptor: { lifecycle: "ready" },
			client: {},
		};
		const failed = {
			descriptor: { lifecycle: "failed" },
		};
		supervisor.workers.set("healthy", healthy);
		supervisor.workers.set("failed", failed);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "healthy-heartbeat" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "global-list",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "healthy-heartbeat" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			healthy,
			expect.objectContaining({ type: "heartbeats_list" }),
			5000,
		);
	});
	it("preserves a complete cached heartbeat snapshot from a failed worker", async () => {
		const supervisor = createSupervisorHarness();
		const healthy = {
			descriptor: { lifecycle: "ready" },
			client: {},
		};
		const failed = {
			descriptor: { lifecycle: "failed" },
			heartbeatSnapshot: [{ job: { id: "failed-worker-heartbeat" } }],
			heartbeatSnapshotStale: false,
		};
		supervisor.workers.set("healthy", healthy);
		supervisor.workers.set("failed", failed);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "healthy-heartbeat" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "global-list-with-cache",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: true,
			data: {
				heartbeats: [{ job: { id: "healthy-heartbeat" } }, { job: { id: "failed-worker-heartbeat" } }],
			},
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});
});
