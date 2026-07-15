import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonAttachResult } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DAEMON_WORKER_STARTUP_GATE_COMMIT } from "../src/modes/daemon/daemon-worker-protocol.js";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

const workerLaunchTestState = vi.hoisted(() => ({
	capture: false,
	forceMissingProcessStartId: false,
	fixtureMode: "worker" as "worker" | "close-gate" | "rollback-gate" | "successful-gate",
	gateMarkerPath: "",
	tsxCliPath: "",
	cliEntrypoint: "",
	spawned: [] as Array<{ child: ChildProcess; args: readonly string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
	};
	return {
		...actual,
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
			const child = actual.spawn(command, args, options);
			if (workerLaunchTestState.capture) {
				workerLaunchTestState.spawned.push({ child, args });
			}
			return child;
		},
	};
});

vi.mock("../src/cli/subprocess-launch.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createCliSubprocessLaunchSpec(args: readonly string[]) {
			if (!workerLaunchTestState.capture) {
				return (actual.createCliSubprocessLaunchSpec as (args: readonly string[]) => unknown)(args);
			}
			if (workerLaunchTestState.fixtureMode === "rollback-gate") {
				const markerPath = JSON.stringify(workerLaunchTestState.gateMarkerPath);
				const commitMarker = JSON.stringify(DAEMON_WORKER_STARTUP_GATE_COMMIT);
				return {
					command: process.execPath,
					args: [
						"--eval",
						`const fs = require("node:fs"); const marker = fs.readFileSync(3, "utf8"); if (marker === ${commitMarker}) { fs.writeFileSync(${markerPath}, marker); setInterval(() => {}, 1000); }`,
						"--",
						...args,
					],
				};
			}
			if (workerLaunchTestState.fixtureMode === "close-gate") {
				return {
					command: process.execPath,
					args: ["--eval", 'require("node:fs").closeSync(3)'],
				};
			}
			if (workerLaunchTestState.fixtureMode === "successful-gate") {
				const markerPath = JSON.stringify(workerLaunchTestState.gateMarkerPath);
				return {
					command: process.execPath,
					args: [
						"--eval",
						`const fs = require("node:fs"); const marker = fs.readFileSync(3, "utf8"); fs.writeFileSync(${markerPath}, marker); setInterval(() => {}, 1000);`,
					],
				};
			}
			return {
				command: process.execPath,
				args: [workerLaunchTestState.tsxCliPath, workerLaunchTestState.cliEntrypoint, ...args],
			};
		},
	};
});

vi.mock("../src/core/session-lease.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		getProcessStartId(pid: number): string | undefined;
	};
	return {
		...actual,
		getProcessStartId(pid: number): string | undefined {
			return workerLaunchTestState.forceMissingProcessStartId ? undefined : actual.getProcessStartId(pid);
		},
	};
});

const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousSupervisorRegistryDir = process.env[supervisorRegistryDirEnv];
const supervisorRegistryDirs = new Set<string>();

interface SupervisorMonitorHarness {
	options: { worker: object };
	clients: Set<{ authenticated: boolean }>;
	supervisorClaims: Map<object, object>;
	shuttingDown: boolean;
	supervisorMonitorTimer?: ReturnType<typeof setTimeout>;
	canConnectToSupervisor: (socketPath: string) => Promise<boolean>;
	launchReplacementSupervisor: (socketPath: string) => Promise<void>;
	scheduleSupervisorAvailabilityCheck: (socketPath: string, delayMs: number) => void;
}

interface DeferredRecoveryWorker {
	descriptor: {
		workerId: string;
		pid: number;
		rootActiveSessionId: string;
		lifecycle: "ready" | "recovering";
		lastError?: string;
		stopRequestedAt?: string;
	};
	client?: object;
	snapshotCache: Map<string, DaemonAttachResult>;
	incomingTranscriptActiveSessionIds: Set<string>;
	transcriptCaches: Map<string, { markFailed(error: Error): void }>;
	duplicateIncomingTranscriptChunkIndexes: Map<string, number>;
	snapshotTransferFrames: Map<string, never>;
	recovery?: Promise<void>;
	deferredRecovery?: Promise<void>;
	intentionalStop: boolean;
	stopRevision: number;
}

interface DeferredRecoveryHarness {
	workers: Map<string, DeferredRecoveryWorker>;
	shuttingDown: boolean;
	assertRecoveryAllowed: ReturnType<typeof vi.fn>;
	persistWorker: ReturnType<typeof vi.fn>;
	syncAgentPeers: ReturnType<typeof vi.fn>;
	recoverWorker: ReturnType<typeof vi.fn>;
	handleWorkerClose(worker: DeferredRecoveryWorker, client: object, error: Error): Promise<void>;
	deferWorkerRecovery(worker: DeferredRecoveryWorker, error: Error): void;
}

function recoveryDeniedError(code: "supervisor_recovery_cancelled" | "supervisor_generation_stale"): Error {
	return Object.assign(new Error(code), { code });
}

async function waitForCapturedChildClose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

function createExistingLaunchWorker(root: string, descriptorDir: string) {
	const workerId = "existing-worker";
	const now = new Date().toISOString();
	return {
		descriptor: {
			version: 1 as const,
			workerId,
			pid: 999_999,
			socketPath: join(root, `${workerId}.sock`),
			recoveryJournalPath: join(descriptorDir, `${workerId}.recovery.jsonl`),
			orphanProcessJournalPath: join(descriptorDir, `${workerId}.orphans.jsonl`),
			supervisorSocketPath: join(root, "supervisor.sock"),
			authenticationToken: "existing-worker-token",
			rootActiveSessionId: "existing-root-session",
			createdAt: now,
			updatedAt: now,
			lifecycle: "recovering" as const,
			stopRequestedAt: undefined as string | undefined,
			createCommand: { type: "create" as const, config: { cwd: root, agentDir: root } },
			consecutiveFailures: 0,
		},
		descriptorPath: join(descriptorDir, `${workerId}.json`),
		summaries: new Map<string, SessionSummary>(),
		snapshotCache: new Map<string, DaemonAttachResult>(),
		transcriptCaches: new Map<string, never>(),
		incomingTranscriptActiveSessionIds: new Set<string>(),
		duplicateIncomingTranscriptChunkIndexes: new Map<string, number>(),
		snapshotTransferFrames: new Map<string, never>(),
		snapshotLoads: new Map<string, Promise<DaemonAttachResult>>(),
		intentionalStop: false,
		stopRevision: 0,
	};
}

function createSupervisorSnapshotState() {
	return {
		clients: new Set<object>(),
		pendingReplacementSnapshots: new WeakMap<object, Map<string, unknown>>(),
	};
}

const recoveryEligibilityInvalidations: Array<{
	name: string;
	invalidate(supervisor: DeferredRecoveryHarness, worker: DeferredRecoveryWorker): void;
}> = [
	{
		name: "the worker reconnects",
		invalidate: (_supervisor, worker) => {
			worker.client = {};
		},
	},
	{
		name: "the worker is stopped",
		invalidate: (_supervisor, worker) => {
			worker.intentionalStop = true;
			worker.descriptor.stopRequestedAt = new Date().toISOString();
		},
	},
	{
		name: "the worker is replaced",
		invalidate: (supervisor, worker) => supervisor.workers.set(worker.descriptor.workerId, { ...worker }),
	},
	{
		name: "supervisor cleanup begins",
		invalidate: (supervisor) => {
			supervisor.shuttingDown = true;
		},
	},
	{
		name: "another recovery begins",
		invalidate: (_supervisor, worker) => {
			worker.recovery = Promise.resolve();
		},
	},
];

function createHarness(canConnect: () => Promise<boolean>): SupervisorMonitorHarness {
	const registryDir = mkdtempSync(join(tmpdir(), "prime-supervisor-registry-test-"));
	supervisorRegistryDirs.add(registryDir);
	process.env[supervisorRegistryDirEnv] = registryDir;
	return Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {} },
		clients: new Set<{ authenticated: boolean }>(),
		supervisorClaims: new Map<object, object>(),
		shuttingDown: false,
		canConnectToSupervisor: vi.fn(canConnect),
		launchReplacementSupervisor: vi.fn(async () => undefined),
	}) as SupervisorMonitorHarness;
}

describe("daemon worker supervisor monitoring", () => {
	afterEach(async () => {
		for (const { child } of workerLaunchTestState.spawned) {
			if (child.exitCode === null && child.signalCode === null) {
				const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
				child.kill("SIGKILL");
				await closed;
			}
		}
		workerLaunchTestState.capture = false;
		workerLaunchTestState.forceMissingProcessStartId = false;
		workerLaunchTestState.fixtureMode = "worker";
		workerLaunchTestState.gateMarkerPath = "";
		workerLaunchTestState.tsxCliPath = "";
		workerLaunchTestState.cliEntrypoint = "";
		workerLaunchTestState.spawned.length = 0;
		vi.useRealTimers();
		for (const registryDir of supervisorRegistryDirs) {
			rmSync(registryDir, { recursive: true, force: true });
		}
		supervisorRegistryDirs.clear();
		if (previousSupervisorRegistryDir === undefined) {
			delete process.env[supervisorRegistryDirEnv];
		} else {
			process.env[supervisorRegistryDirEnv] = previousSupervisorRegistryDir;
		}
	});

	it.each([
		{
			name: "first post-spawn ownership check",
			assertionCall: 3,
			error: recoveryDeniedError("supervisor_generation_stale"),
		},
		{
			name: "pre-publication ownership check",
			assertionCall: 4,
			error: recoveryDeniedError("supervisor_generation_stale"),
		},
		{ name: "descriptor persistence", persistFailure: true, error: new Error("descriptor persistence failed") },
	] as const)("keeps unidentifiable workers gated after $name fails", async (scenario) => {
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "rollback-gate";
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-launch-gate-test-"));
		const gateMarkerPath = join(root, "committed-gate");
		workerLaunchTestState.gateMarkerPath = gateMarkerPath;
		const descriptorDir = join(root, "descriptors");
		const registryDir = join(root, "registry");
		mkdirSync(descriptorDir, { recursive: true });
		mkdirSync(registryDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		process.env[supervisorRegistryDirEnv] = registryDir;
		let assertionCount = 0;
		const workers = new Map<string, unknown>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			assertRecoveryAllowed: vi.fn(async () => {
				assertionCount++;
				if ("assertionCall" in scenario && assertionCount === scenario.assertionCall) {
					throw scenario.error;
				}
			}),
			...("persistFailure" in scenario
				? {
						persistWorker: vi.fn(() => {
							throw scenario.error;
						}),
					}
				: {}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			scenario.error,
		);

		expect(assertionCount).toBe("assertionCall" in scenario ? scenario.assertionCall : 4);
		expect(workerLaunchTestState.spawned).toHaveLength(1);
		const { child, args } = workerLaunchTestState.spawned[0]!;
		const socketFlagIndex = args.indexOf("--daemon-socket");
		expect(socketFlagIndex).toBeGreaterThanOrEqual(0);
		const workerSocketPath = args[socketFlagIndex + 1];
		expect(workerSocketPath).toBeDefined();

		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(existsSync(gateMarkerPath)).toBe(false);
		expect(existsSync(workerSocketPath!)).toBe(false);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		expect(readdirSync(registryDir)).toEqual([]);
		expect(workers.size).toBe(0);
	});

	it("rolls back promptly when the child closes its startup gate before commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-closed-gate-test-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "close-gate";
		let assertionCount = 0;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => {
				assertionCount++;
				if (assertionCount === 3) {
					const child = workerLaunchTestState.spawned.at(-1)?.child;
					if (!child) {
						throw new Error("Worker child was not captured");
					}
					await waitForCapturedChildClose(child);
				}
			}),
			connectWorker,
			syncAgentPeers: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		const timeoutError = new Error("startup gate rejection timed out");
		const result = await Promise.race([
			supervisor
				.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })
				.then(() => ({ value: "resolved" as const, error: undefined }))
				.catch((error: unknown) => ({ value: "rejected" as const, error })),
			new Promise<{ value: "timed-out"; error: Error }>((resolveTimeout) =>
				setTimeout(() => resolveTimeout({ value: "timed-out", error: timeoutError }), 1000),
			),
		]);

		expect(result.value).toBe("rejected");
		expect(result.error).not.toBe(timeoutError);
		expect(result.error).toBeInstanceOf(Error);
		expect(connectWorker).not.toHaveBeenCalled();
		expect(workers.size).toBe(0);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("commits the startup marker after durable worker publication", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-committed-gate-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn(async (worker: { descriptor: { rootActiveSessionId: string } }) => {
			await waitForFile(markerPath);
			return {
				request: vi.fn(async () => ({
					success: true,
					data: {
						id: worker.descriptor.rootActiveSessionId,
						activeSessionId: worker.descriptor.rootActiveSessionId,
						sessionId: "session-committed-gate",
						cwd: root,
					},
				})),
			};
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			subscribeWorker: vi.fn(async () => undefined),
			refreshWorkerSummaries: vi.fn(async () => undefined),
			syncAgentPeers: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			launchWorker(command: {
				type: "create";
				config: { cwd: string; agentDir: string };
			}): Promise<{ descriptor: { lifecycle: string } }>;
		};

		const worker = await supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } });

		expect(readFileSync(markerPath, "utf8")).toBe("start\n");
		expect(connectWorker).toHaveBeenCalledOnce();
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(workers.size).toBe(1);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		if (!child) {
			throw new Error("Worker child was not captured");
		}
		const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
		child.kill("SIGKILL");
		await closed;
	});

	it("rolls back a published worker when shutdown admission and rollback persistence fail", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-cancelled-launch-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const rollbackPersistenceError = new Error("rollback persistence failed");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") {
			throw new Error("Could not access worker persistence");
		}
		let persistenceCalls = 0;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			persistWorker: vi.fn(function (this: object, worker: object) {
				persistenceCalls++;
				if (persistenceCalls === 2) {
					throw rollbackPersistenceError;
				}
				Reflect.apply(persistWorker, this, [worker]);
			}),
			syncAgentPeers: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			cancellation,
		);

		expect(readFileSync(markerPath, "utf8")).toBe("start\n");
		expect(connectWorker).toHaveBeenCalledOnce();
		expect(persistenceCalls).toBe(2);
		expect(workers.size).toBe(0);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("defers an eligible existing recovery when descriptor restoration fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-existing-restore-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const restorationError = new Error("descriptor restoration failed");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") {
			throw new Error("Could not access worker persistence");
		}
		let persistenceCalls = 0;
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const previousDescriptor = existing.descriptor;
		const workers = new Map<string, object>([[existing.descriptor.workerId, existing]]);
		const deferWorkerRecovery = vi.fn();
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			persistWorker: vi.fn(function (this: object, worker: object) {
				persistenceCalls++;
				if (persistenceCalls === 3) {
					throw restorationError;
				}
				Reflect.apply(persistWorker, this, [worker]);
			}),
			deferWorkerRecovery,
			syncAgentPeers: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			launchWorker(
				command: { type: "create"; config: { cwd: string; agentDir: string } },
				existing: object,
			): Promise<unknown>;
		};

		await expect(
			supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing),
		).rejects.toBe(cancellation);

		expect(persistenceCalls).toBe(3);
		expect(existing.descriptor).toBe(previousDescriptor);
		expect(workers.get(existing.descriptor.workerId)).toBe(existing);
		expect(deferWorkerRecovery).toHaveBeenCalledOnce();
		expect(deferWorkerRecovery).toHaveBeenCalledWith(existing, cancellation);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("does not restore an existing recovery invalidated during rollback", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-existing-stop-race-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const workers = new Map<string, object>([[existing.descriptor.workerId, existing]]);
		const deferWorkerRecovery = vi.fn();
		const stopWorker = Reflect.get(DaemonSupervisor.prototype, "stopWorker");
		if (typeof stopWorker !== "function") {
			throw new Error("Could not access worker shutdown");
		}
		let markRollbackStarted = () => {};
		const rollbackStarted = new Promise<void>((resolveStarted) => {
			markRollbackStarted = resolveStarted;
		});
		let releaseRollback = () => {};
		const rollbackRelease = new Promise<void>((resolveRelease) => {
			releaseRollback = resolveRelease;
		});
		const controlledStopWorker = vi.fn(async function (
			this: object,
			worker: object,
			removeDescriptor: boolean,
			force = false,
			archiveSession = false,
			recoveryCleanup = false,
			directChild?: object,
		) {
			if (recoveryCleanup) {
				markRollbackStarted();
				await rollbackRelease;
				return;
			}
			await Reflect.apply(stopWorker, this, [
				worker,
				removeDescriptor,
				force,
				archiveSession,
				recoveryCleanup,
				directChild,
			]);
		});
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			stopWorker: controlledStopWorker,
			deferWorkerRecovery,
			syncAgentPeers: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			shuttingDown: boolean;
			launchWorker(
				command: { type: "create"; config: { cwd: string; agentDir: string } },
				existing: object,
			): Promise<unknown>;
			stopWorker(worker: object, removeDescriptor: boolean, force: boolean): Promise<void>;
		};

		const launchResult = supervisor
			.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await rollbackStarted;
		supervisor.shuttingDown = true;
		await supervisor.stopWorker(existing, true, true);
		releaseRollback();

		expect(await launchResult).toBe(cancellation);
		expect(existing.stopRevision).toBe(1);
		expect(existing.descriptor.stopRequestedAt).toBeDefined();
		expect(workers.size).toBe(0);
		expect(existsSync(existing.descriptorPath)).toBe(false);
		expect(deferWorkerRecovery).not.toHaveBeenCalled();
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
		let resolveProbe: () => void = () => undefined;
		const probeCompleted = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const daemon = createHarness(async () => {
			resolveProbe();
			return true;
		});

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 1500);
		await vi.advanceTimersByTimeAsync(1500);
		await probeCompleted;
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
		expect(daemon.supervisorMonitorTimer).toBeUndefined();
	});

	it("skips socket probes while an authenticated supervisor connection is active", async () => {
		vi.useFakeTimers();
		const daemon = createHarness(async () => true);
		daemon.clients.add({ authenticated: true });
		daemon.supervisorClaims.set({}, {});

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.runAllTimersAsync();

		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
	});

	it("retries when shutdown admission lookup fails", async () => {
		vi.useFakeTimers();
		let resolveProbe: () => void = () => undefined;
		const probeCompleted = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const daemon = createHarness(async () => {
			resolveProbe();
			return true;
		});
		const registryDir = process.env[supervisorRegistryDirEnv];
		if (!registryDir) throw new Error("Supervisor registry test directory was not set");
		rmSync(registryDir, { recursive: true, force: true });
		writeFileSync(registryDir, "not a directory");

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.advanceTimersByTimeAsync(0);
		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
		expect(daemon.supervisorMonitorTimer).toBeDefined();

		rmSync(registryDir, { force: true });
		mkdirSync(registryDir, { recursive: true });
		await vi.advanceTimersByTimeAsync(5000);
		await probeCompleted;
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
	});

	it("recovers exactly once after shutdown admission clears", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-deferred-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-deferred-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let admissionActive = true;
		const assertRecoveryAllowed = vi.fn(async () => {
			if (admissionActive) {
				throw recoveryDeniedError("supervisor_recovery_cancelled");
			}
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			syncAgentPeers: vi.fn(async () => undefined),
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		supervisor.deferWorkerRecovery(worker, new Error("duplicate close"));
		expect(worker.deferredRecovery).toBe(deferredRecovery);
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();

		admissionActive = false;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(worker.descriptor.lifecycle).toBe("recovering");
		expect(worker.descriptor.lastError).toBe("worker disconnected");
		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledOnce();
		expect(worker.deferredRecovery).toBeUndefined();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(recoverWorker).toHaveBeenCalledOnce();
	});

	it("resumes deferred recovery after a concurrent recovery is denied", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-concurrent-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-concurrent-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let admissionActive = true;
		const assertRecoveryAllowed = vi.fn(async () => {
			if (admissionActive) {
				throw recoveryDeniedError("supervisor_recovery_cancelled");
			}
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			syncAgentPeers: vi.fn(async () => undefined),
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		let startConcurrentRecovery: () => void = () => undefined;
		const concurrentRecoveryBarrier = new Promise<void>((resolve) => {
			startConcurrentRecovery = resolve;
		});
		const concurrentRecovery = (async () => {
			await concurrentRecoveryBarrier;
			await expect(assertRecoveryAllowed()).rejects.toMatchObject({ code: "supervisor_recovery_cancelled" });
		})().finally(() => {
			worker.recovery = undefined;
		});
		worker.recovery = concurrentRecovery;

		await vi.advanceTimersByTimeAsync(5000);
		expect(worker.deferredRecovery).toBe(deferredRecovery);
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();

		startConcurrentRecovery();
		await concurrentRecovery;
		expect(worker.recovery).toBeUndefined();
		admissionActive = false;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(assertRecoveryAllowed).toHaveBeenCalledTimes(3);
		expect(worker.descriptor.lifecycle).toBe("recovering");
		expect(worker.descriptor.lastError).toBe("worker disconnected");
		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledOnce();
		expect(worker.deferredRecovery).toBeUndefined();
	});

	it("cancels deferred recovery permanently after ownership loss", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-stale-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-stale-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let stale = false;
		const assertRecoveryAllowed = vi.fn(async () => {
			throw recoveryDeniedError(stale ? "supervisor_generation_stale" : "supervisor_recovery_cancelled");
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			syncAgentPeers: vi.fn(async () => undefined),
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		stale = true;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(worker.descriptor.lastError).toBeUndefined();
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();
		expect(worker.deferredRecovery).toBeUndefined();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(recoverWorker).not.toHaveBeenCalled();
	});

	it.each(recoveryEligibilityInvalidations)(
		"does not recover when $name during the ownership assertion",
		async ({ invalidate }) => {
			const client = {};
			const worker: DeferredRecoveryWorker = {
				descriptor: {
					workerId: "worker-eligibility-race",
					pid: process.pid,
					rootActiveSessionId: "active-eligibility-race",
					lifecycle: "ready",
				},
				client,
				snapshotCache: new Map(),
				incomingTranscriptActiveSessionIds: new Set(),
				transcriptCaches: new Map(),
				duplicateIncomingTranscriptChunkIndexes: new Map(),
				snapshotTransferFrames: new Map<string, never>(),
				intentionalStop: false,
				stopRevision: 0,
			};
			let resolveAssertion: () => void = () => undefined;
			const assertion = new Promise<void>((resolve) => {
				resolveAssertion = resolve;
			});
			const persistWorker = vi.fn();
			const syncAgentPeers = vi.fn(async () => undefined);
			const recoverWorker = vi.fn(async () => undefined);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				...createSupervisorSnapshotState(),
				workers: new Map([[worker.descriptor.workerId, worker]]),
				shuttingDown: false,
				assertRecoveryAllowed: vi.fn(() => assertion),
				persistWorker,
				syncAgentPeers,
				recoverWorker,
			}) as DeferredRecoveryHarness;

			const handling = supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
			invalidate(supervisor, worker);
			resolveAssertion();
			await handling;

			expect(worker.descriptor.lifecycle).toBe("ready");
			expect(worker.descriptor.lastError).toBeUndefined();
			expect(persistWorker).not.toHaveBeenCalled();
			expect(syncAgentPeers).not.toHaveBeenCalled();
			expect(recoverWorker).not.toHaveBeenCalled();
		},
	);

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
			assertRecoveryAllowed: ReturnType<typeof vi.fn>;
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
			assertRecoveryAllowed: vi.fn(async () => {}),
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
			assertRecoveryAllowed: ReturnType<typeof vi.fn>;
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
			assertRecoveryAllowed: vi.fn(async () => {}),
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
			assertRecoveryAllowed: ReturnType<typeof vi.fn>;
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
			assertRecoveryAllowed: vi.fn(async () => {}),
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
			assertRecoveryAllowed: vi.fn(async () => {}),
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
