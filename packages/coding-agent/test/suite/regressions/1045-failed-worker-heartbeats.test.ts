import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, success } from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor, isWorkerDescriptorProcessAlive } from "../../../src/modes/daemon/daemon-supervisor.js";

const processIdentityState = vi.hoisted(() => ({
	pid: 424_242,
	observedStartId: "replacement-process" as string | undefined,
}));

interface SessionLeaseModule {
	getProcessStartId(pid: number): string | undefined;
}

vi.mock("../../../src/core/session-lease.js", async (importOriginal) => {
	const actual = await importOriginal<SessionLeaseModule>();
	return {
		...actual,
		getProcessStartId(pid: number): string | undefined {
			return pid === processIdentityState.pid ? processIdentityState.observedStartId : actual.getProcessStartId(pid);
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
	it("treats a reused or inaccessible pid as exited when its start identity changed", () => {
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
		expect(isWorkerDescriptorProcessAlive(descriptor)).toBe(false);

		processIdentityState.observedStartId = undefined;
		expect(isWorkerDescriptorProcessAlive(descriptor)).toBe(true);
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
});
