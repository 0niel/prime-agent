import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const workerSpawn = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("unexpected worker spawn");
	}),
);

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal()),
	spawn: workerSpawn,
}));

import { SessionManager } from "../src/core/session-manager.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { DAEMON_UPDATE_RESTART_FORMAT_VERSION } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type AttachClientFixture = Pick<
	DaemonSocketClient,
	"id" | "attachedActiveSessionIds" | "capabilities" | "supportsExtensionUi"
>;

interface WorkerFixture {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	summaries: Map<string, unknown>;
	client?: object;
	wake?: Promise<void>;
	stopFinalizations?: Set<Promise<void>>;
	archiveFinalization?: Promise<void>;
	stopFinalized?: boolean;
	stopFailure?: Error;
	quarantined?: true;
}

interface PassivatedWorkerFixture extends WorkerFixture {
	snapshotCache: Map<string, unknown>;
	transcriptCaches: Map<string, unknown>;
	snapshotGenerations: Map<string, Map<string, unknown>>;
	snapshotLoads: Map<string, Promise<unknown>>;
	intentionalStop: boolean;
	stopRevision: number;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	loadWorkerDescriptors(): Promise<void>;
	persistWorker(worker: WorkerFixture): void;
	wakePassivatedWorker(worker: WorkerFixture): Promise<void>;
	forwardToWorker(worker: WorkerFixture, command: object): Promise<unknown>;
	stopWorker(
		worker: WorkerFixture,
		removeDescriptor: boolean,
		force?: boolean,
		archiveSession?: boolean,
		recoveryCleanup?: boolean,
		directChild?: unknown,
	): Promise<void>;
	stopWorkerOnce: ReturnType<typeof vi.fn>;
	recoverWorker: ReturnType<typeof vi.fn>;
	passivatedSummaryForDescriptor(descriptor: DaemonWorkerDescriptor): Promise<unknown>;
	assertRecoveryAllowed(): Promise<void>;
	catalog: { archive(sessionFile: string, sessionId: string): Promise<void> };
}

function fixtureRoot(): {
	root: string;
	agentDir: string;
	sessionDir: string;
	descriptorDir: string;
	socketPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "prime-restart-passivation-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const sessionDir = join(agentDir, "sessions");
	const descriptorDir = join(agentDir, "workers");
	mkdirSync(descriptorDir, { recursive: true });
	return { root, agentDir, sessionDir, descriptorDir, socketPath: join(root, "daemon.sock") };
}

function persistSession(sessionDir: string, cwd: string, taskState: "completed" | "needs_input") {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: taskState, timestamp: 1 });
	manager.appendAgentStatus({ summary: taskState, taskState, basedOnMessageCount: 1 });
	manager.flushNow();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("fixture did not persist a session file");
	return { id: manager.getSessionId(), sessionFile };
}

function descriptor(
	fixture: ReturnType<typeof fixtureRoot>,
	workerId: string,
	session: { id: string; sessionFile: string },
): DaemonWorkerDescriptor {
	return {
		version: 1,
		workerId,
		pid: 999_999_999,
		generation: "11111111-1111-4111-8111-111111111111",
		socketPath: join(fixture.root, `${workerId}.sock`),
		recoveryJournalPath: join(fixture.descriptorDir, `${workerId}.recovery.jsonl`),
		supervisorSocketPath: fixture.socketPath,
		authenticationToken: "test-token",
		rootActiveSessionId: `active-${workerId}`,
		rootSessionId: session.id,
		sessionFile: session.sessionFile,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		lifecycle: "ready",
		createCommand: { type: "create", sessionPath: session.sessionFile, config: { cwd: fixture.root } },
		consecutiveFailures: 0,
	};
}

describe("daemon supervisor restart passivation", () => {
	it("keeps 160 dead terminal roots metadata-only, while preserving scheduled and unjudged recovery", async () => {
		const fixture = fixtureRoot();
		const terminalRoots = (
			[
				["completed", "completed"],
				["needs-input", "needs_input"],
			] as const
		).flatMap(([prefix, taskState]) =>
			Array.from({ length: 80 }, (_, index) => {
				const session = persistSession(fixture.sessionDir, fixture.root, taskState);
				return descriptor(fixture, `${prefix}-${index}`, session);
			}),
		);
		const scheduled = persistSession(fixture.sessionDir, fixture.root, "completed");
		const unjudged = SessionManager.create(fixture.root, fixture.sessionDir);
		unjudged.appendMessage({ role: "user", content: "in progress", timestamp: 1 });
		unjudged.flushNow();
		const unjudgedFile = unjudged.getSessionFile();
		if (!unjudgedFile) throw new Error("fixture did not persist unjudged session");
		const scheduledEntry = descriptor(fixture, "scheduled", scheduled);
		const unjudgedEntry = descriptor(fixture, "unjudged", {
			id: unjudged.getSessionId(),
			sessionFile: unjudgedFile,
		});
		const scheduledArtifact = join(fixture.agentDir, "session-artifacts", scheduled.id);
		mkdirSync(scheduledArtifact, { recursive: true });
		writeFileSync(
			join(scheduledArtifact, "scheduled-jobs.json"),
			JSON.stringify({
				jobs: [
					{
						id: "job",
						status: "active",
						source: "cron",
						activeSessionId: "active-scheduled",
						sessionId: scheduled.id,
						sessionFile: scheduled.sessionFile,
						cwd: fixture.root,
						prompt: "scheduled",
						schedule: { kind: "interval", expression: "every 1m", intervalMs: 60_000 },
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
						nextRunAt: new Date(Date.now() + 60_000).toISOString(),
						runCount: 0,
					},
				],
				dispatches: [],
			}),
		);
		const entries = [...terminalRoots, scheduledEntry, unjudgedEntry];
		for (const entry of entries)
			writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		supervisor.recoverWorker = vi.fn();
		await supervisor.loadWorkerDescriptors();

		const passivated = [...supervisor.workers.values()].filter(
			(worker) => worker.descriptor.lifecycle === "passivated",
		);
		expect(passivated).toHaveLength(160);
		expect(supervisor.workers).toHaveLength(162);
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
		for (const entry of terminalRoots) {
			const worker = supervisor.workers.get(entry.workerId);
			expect(worker?.descriptor.lifecycle).toBe("passivated");
			expect(worker?.client).toBeUndefined();
			expect(worker?.summaries.size).toBe(1);
			const persisted = JSON.parse(readFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), "utf8"));
			expect(persisted.lifecycle).toBe("passivated");
			expect(persisted).not.toHaveProperty("pid");
			expect(persisted).not.toHaveProperty("processStartId");
		}
		expect(supervisor.workers.get("scheduled")?.descriptor.lifecycle).toBe("recovering");
		expect(supervisor.workers.get("unjudged")?.descriptor.lifecycle).toBe("recovering");
	});

	it("recovers terminal roots with paused or unreadable heartbeat artifacts", async () => {
		const fixture = fixtureRoot();
		const paused = persistSession(fixture.sessionDir, fixture.root, "completed");
		const unreadable = persistSession(fixture.sessionDir, fixture.root, "completed");
		const pausedCron = persistSession(fixture.sessionDir, fixture.root, "completed");
		const pausedEntry = descriptor(fixture, "paused-heartbeat", paused);
		const unreadableEntry = descriptor(fixture, "unreadable-heartbeat", unreadable);
		const pausedCronEntry = descriptor(fixture, "paused-cron", pausedCron);
		const pausedArtifact = join(fixture.agentDir, "session-artifacts", paused.id);
		const unreadableArtifact = join(fixture.agentDir, "session-artifacts", unreadable.id);
		const pausedCronArtifact = join(fixture.agentDir, "session-artifacts", pausedCron.id);
		mkdirSync(pausedArtifact, { recursive: true });
		mkdirSync(unreadableArtifact, { recursive: true });
		writeFileSync(
			join(pausedArtifact, "scheduled-jobs.json"),
			JSON.stringify({
				jobs: [
					{
						id: "paused-heartbeat",
						status: "paused",
						source: "heartbeat",
						activeSessionId: pausedEntry.rootActiveSessionId,
						sessionId: paused.id,
						sessionFile: paused.sessionFile,
						cwd: fixture.root,
						prompt: "wait for an explicit resume",
						schedule: { kind: "interval", expression: "every 1m", intervalMs: 60_000 },
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
						runCount: 0,
					},
				],
				dispatches: [],
			}),
		);
		// A malformed artifact is not a proof of an empty heartbeat catalog.
		writeFileSync(join(unreadableArtifact, "scheduled-jobs.json"), "{");
		mkdirSync(pausedCronArtifact, { recursive: true });
		writeFileSync(
			join(pausedCronArtifact, "scheduled-jobs.json"),
			JSON.stringify({
				jobs: [
					{
						id: "paused-cron",
						status: "paused",
						source: "cron",
						activeSessionId: pausedCronEntry.rootActiveSessionId,
						sessionId: pausedCron.id,
						sessionFile: pausedCron.sessionFile,
						cwd: fixture.root,
						prompt: "preserve passive scheduled behavior",
						schedule: { kind: "interval", expression: "every 1m", intervalMs: 60_000 },
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
						runCount: 0,
					},
				],
				dispatches: [],
			}),
		);
		for (const entry of [pausedEntry, unreadableEntry, pausedCronEntry]) {
			writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));
		}

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		await supervisor.loadWorkerDescriptors();

		expect(supervisor.workers.get(pausedEntry.workerId)?.descriptor.lifecycle).toBe("recovering");
		expect(supervisor.workers.get(unreadableEntry.workerId)?.descriptor.lifecycle).toBe("recovering");
		// A paused non-heartbeat schedule has never required a runtime snapshot.
		expect(supervisor.workers.get(pausedCronEntry.workerId)?.descriptor.lifecycle).toBe("passivated");
	});

	it("prepares only ready residents and retains processless roots for the replacement supervisor", async () => {
		const fixture = fixtureRoot();
		const passiveSession = persistSession(fixture.sessionDir, fixture.root, "completed");
		const passiveDescriptor = { ...descriptor(fixture, "passive", passiveSession), lifecycle: "passivated" as const };
		delete passiveDescriptor.pid;
		delete passiveDescriptor.processStartId;
		writeFileSync(join(fixture.descriptorDir, "passive.json"), JSON.stringify(passiveDescriptor));

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals & {
			prepareUpdateRestartFenced(deadline: number): Promise<{ sessions: Array<{ activeSessionId: string }> }>;
			validateAndPersistUpdateManifest: ReturnType<typeof vi.fn>;
			stopWorker: ReturnType<typeof vi.fn>;
		};
		supervisor.recoverWorker = vi.fn();
		await supervisor.loadWorkerDescriptors();
		const passive = supervisor.workers.get("passive");
		if (!passive) throw new Error("passive fixture was not loaded");
		const passiveSummary = passive.summaries.get(passiveDescriptor.rootActiveSessionId);
		const readySession = persistSession(fixture.sessionDir, fixture.root, "completed");
		const readyClient = {
			requestWorker: vi.fn(async ({ type }: { type: string }) =>
				type === "worker_prepare_update"
					? {
							success: true,
							data: {
								formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
								createdAt: "now",
								sessions: [{ activeSessionId: "active-ready", sessionFile: readySession.sessionFile }],
							},
						}
					: { success: true },
			),
		};
		const ready = {
			descriptor: { ...descriptor(fixture, "ready", readySession), rootActiveSessionId: "active-ready" },
			descriptorPath: join(fixture.descriptorDir, "ready.json"),
			client: readyClient,
			summaries: new Map(),
		};
		supervisor.workers.set("ready", ready);
		supervisor.validateAndPersistUpdateManifest = vi.fn();
		supervisor.stopWorker = vi.fn(async () => undefined);

		await expect(supervisor.prepareUpdateRestartFenced(Date.now() + 10_000)).resolves.toMatchObject({
			sessions: [{ activeSessionId: "active-ready" }],
		});
		expect(readyClient.requestWorker).toHaveBeenCalledTimes(2);
		expect(readyClient.requestWorker).toHaveBeenNthCalledWith(
			1,
			{ type: "worker_prepare_update" },
			expect.any(Number),
		);
		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(ready, false);
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
		expect(passive.descriptor).toMatchObject({ lifecycle: "passivated" });
		expect(passive.descriptor).not.toHaveProperty("pid");
		expect(passive.client).toBeUndefined();
		expect(passive.summaries.get(passiveDescriptor.rootActiveSessionId)).toEqual(passiveSummary);

		const replacement = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		replacement.recoverWorker = vi.fn();
		await replacement.loadWorkerDescriptors();
		const reloadedPassive = replacement.workers.get("passive");
		expect(reloadedPassive?.descriptor.lifecycle).toBe("passivated");
		expect(reloadedPassive?.descriptor).not.toHaveProperty("pid");
		expect(reloadedPassive?.client).toBeUndefined();
		expect(reloadedPassive?.summaries.get(passiveDescriptor.rootActiveSessionId)).toEqual(passiveSummary);
		expect(replacement.recoverWorker).not.toHaveBeenCalled();
	});

	it("single-flights an explicit wake and does not revive passivated records by itself", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker: WorkerFixture = {
			descriptor: { ...descriptor(fixture, "wake", session), lifecycle: "passivated" },
			descriptorPath: join(fixture.descriptorDir, "wake.json"),
			summaries: new Map(),
		};
		supervisor.workers.set("wake", worker);
		supervisor.recoverWorker = vi.fn(async () => {
			await Promise.resolve();
			worker.descriptor.lifecycle = "ready";
			worker.client = {};
		});

		await Promise.all([supervisor.wakePassivatedWorker(worker), supervisor.wakePassivatedWorker(worker)]);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
		expect(worker.descriptor.lifecycle).toBe("ready");
	});

	it("passivates an explicit wake spawn failure without persisting recovery intent", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const {
			pid: _pid,
			processStartId: _processStartId,
			...passive
		} = descriptor(fixture, "wake-spawn-failure", session);
		const worker: WorkerFixture = {
			descriptor: { ...passive, lifecycle: "passivated" },
			descriptorPath: join(fixture.descriptorDir, "wake-spawn-failure.json"),
			summaries: new Map(),
		};
		writeFileSync(worker.descriptorPath, `${JSON.stringify(worker.descriptor, null, 2)}\n`);
		supervisor.workers.set(worker.descriptor.workerId, worker);
		supervisor.assertRecoveryAllowed = vi.fn(async () => undefined);
		workerSpawn.mockImplementation(() => {
			throw new Error("deterministic spawn failure");
		});
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
		try {
			// Register the rejection handler before advancing timers: wake intentionally
			// reports its failed operation, but must not leak an unhandled rejection.
			const wakeResult = supervisor.wakePassivatedWorker(worker).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.runAllTimersAsync();
			expect(await wakeResult).toBeInstanceOf(Error);

			const diskBytes = readFileSync(worker.descriptorPath, "utf8");
			const persisted = JSON.parse(diskBytes);
			expect(persisted).toMatchObject({
				lifecycle: "passivated",
				lastError: "deterministic spawn failure",
			});
			expect(persisted).not.toHaveProperty("process");
			expect(persisted).not.toHaveProperty("pid");
			expect(persisted).not.toHaveProperty("processStartId");
			expect(diskBytes).not.toContain('"lifecycle": "recovering"');
			expect(diskBytes).not.toContain('"lifecycle": "failed"');
			// The writer output is exactly the canonical in-memory descriptor, rather
			// than an older processless recovery/failed serialization.
			expect(diskBytes).toBe(`${JSON.stringify(worker.descriptor, null, 2)}\n`);
		} finally {
			vi.useRealTimers();
			workerSpawn.mockImplementation(() => {
				throw new Error("unexpected worker spawn");
			});
		}
	});

	it("rejects an incompatible telemetry attach before waking a passivated root", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals & {
			attachClient(
				client: object,
				command: { type: "attach"; activeSessionId: string; telemetryDisabled: true },
			): Promise<unknown>;
		};
		const worker: WorkerFixture = {
			descriptor: { ...descriptor(fixture, "telemetry", session), lifecycle: "passivated" },
			descriptorPath: join(fixture.descriptorDir, "telemetry.json"),
			summaries: new Map([
				[
					"active-telemetry",
					{ id: "active-telemetry", activeSessionId: "active-telemetry", sessionId: session.id },
				],
			]),
		};
		supervisor.workers.set("telemetry", worker);
		supervisor.recoverWorker = vi.fn();

		await expect(
			supervisor.attachClient(
				{ id: "attach-client" },
				{
					type: "attach",
					activeSessionId: "active-telemetry",
					telemetryDisabled: true,
				},
			),
		).rejects.toThrow("Cannot attach to this active agent while telemetry is disabled");
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("passivated");
	});

	it("does not revive a passivated root for metadata reads, but wakes it for one explicit operation", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker: WorkerFixture = {
			descriptor: { ...descriptor(fixture, "read", session), lifecycle: "passivated" },
			descriptorPath: join(fixture.descriptorDir, "read.json"),
			summaries: new Map(),
		};
		supervisor.workers.set(worker.descriptor.workerId, worker);
		const request = vi.fn().mockResolvedValue({ type: "response", command: "prompt", success: true });
		supervisor.recoverWorker = vi.fn(async () => {
			// Launch publishes a fresh incarnation on this same resident object.
			worker.descriptor.generation = "woken-generation";
			worker.descriptor.lifecycle = "ready";
			worker.client = { request };
		});

		for (const command of [
			{ type: "get_state", activeSessionId: "active-read" },
			{ type: "get_messages", activeSessionId: "active-read" },
			{ type: "get_session_context", activeSessionId: "active-read" },
		] as const) {
			await expect(supervisor.forwardToWorker(worker, command)).rejects.toThrow("passivated");
		}
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();

		await supervisor.forwardToWorker(worker, {
			type: "prompt",
			activeSessionId: "active-read",
			message: "resume",
		});
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "prompt", activeSessionId: "active-read" }),
			expect.any(Number),
		);
	});

	it.each([
		{ type: "abort", activeSessionId: "active-read" },
		{ type: "cancel_prompt_admission", activeSessionId: "active-read", admissionId: "admission-id" },
		{ type: "abort_compaction", activeSessionId: "active-read" },
		{ type: "abort_branch_summary", activeSessionId: "active-read" },
		{ type: "abort_retry", activeSessionId: "active-read" },
		{ type: "agent_messages_pause", activeSessionId: "active-read" },
		{ type: "agent_messages_resume", activeSessionId: "active-read" },
	])("wakes a passivated root for state-changing $type commands", async (command) => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker: WorkerFixture = {
			descriptor: { ...descriptor(fixture, "wake-command", session), lifecycle: "passivated" },
			descriptorPath: join(fixture.descriptorDir, "wake-command.json"),
			summaries: new Map(),
		};
		supervisor.workers.set(worker.descriptor.workerId, worker);
		supervisor.recoverWorker = vi.fn(async () => {
			worker.descriptor.lifecycle = "ready";
			worker.client = { request: vi.fn() };
		});

		await supervisor.forwardToWorker(worker, command);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("does not passivate a dead completed root with recoverable work", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const entry = descriptor(fixture, "busy", session);
		writeFileSync(
			entry.recoveryJournalPath,
			`${JSON.stringify({
				version: 1,
				activeSessionId: entry.rootActiveSessionId,
				sessionId: session.id,
				sessionFile: session.sessionFile,
				busy: true,
				operation: "prompt",
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		await supervisor.loadWorkerDescriptors();
		expect(supervisor.workers.get("busy")?.descriptor.lifecycle).toBe("recovering");
	});

	it("recovers orphan and completed-recurring cron dispatches but passivates a matched completed one-shot", async () => {
		const fixture = fixtureRoot();
		const orphan = persistSession(fixture.sessionDir, fixture.root, "completed");
		const completed = persistSession(fixture.sessionDir, fixture.root, "completed");
		const completedRecurring = persistSession(fixture.sessionDir, fixture.root, "completed");
		const orphanEntry = descriptor(fixture, "orphan-dispatch", orphan);
		const completedEntry = descriptor(fixture, "completed-dispatch", completed);
		const completedRecurringEntry = descriptor(fixture, "completed-recurring-dispatch", completedRecurring);
		const artifact = (session: { id: string }) => join(fixture.agentDir, "session-artifacts", session.id);
		mkdirSync(artifact(orphan), { recursive: true });
		mkdirSync(artifact(completed), { recursive: true });
		mkdirSync(artifact(completedRecurring), { recursive: true });
		writeFileSync(
			join(artifact(orphan), "scheduled-jobs.json"),
			JSON.stringify({
				jobs: [],
				dispatches: [
					{
						id: "orphan",
						jobId: "missing",
						claimedAt: new Date(0).toISOString(),
						scheduledFor: new Date(0).toISOString(),
					},
				],
			}),
		);
		writeFileSync(
			join(artifact(completed), "scheduled-jobs.json"),
			JSON.stringify({
				jobs: [
					{
						id: "done",
						status: "completed",
						source: "cron",
						activeSessionId: completedEntry.rootActiveSessionId,
						sessionId: completed.id,
						sessionFile: completed.sessionFile,
						cwd: fixture.root,
						prompt: "done",
						schedule: { kind: "once", expression: "once" },
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
						runCount: 1,
					},
				],
				dispatches: [
					{
						id: "matched",
						jobId: "done",
						claimedAt: new Date(0).toISOString(),
						scheduledFor: new Date(0).toISOString(),
					},
				],
			}),
		);
		writeFileSync(
			join(artifact(completedRecurring), "scheduled-jobs.json"),
			JSON.stringify({
				jobs: [
					{
						id: "completed-recurring",
						status: "completed",
						source: "cron",
						activeSessionId: completedRecurringEntry.rootActiveSessionId,
						sessionId: completedRecurring.id,
						sessionFile: completedRecurring.sessionFile,
						cwd: fixture.root,
						prompt: "interrupted recurring schedule",
						schedule: { kind: "interval", expression: "every 1m", intervalMs: 60_000 },
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
						runCount: 1,
					},
				],
				dispatches: [
					{
						id: "completed-recurring-dispatch",
						jobId: "completed-recurring",
						claimedAt: new Date(0).toISOString(),
						scheduledFor: new Date(0).toISOString(),
					},
				],
			}),
		);
		for (const entry of [orphanEntry, completedEntry, completedRecurringEntry])
			writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		await supervisor.loadWorkerDescriptors();
		expect(supervisor.workers.get(orphanEntry.workerId)?.descriptor.lifecycle).toBe("recovering");
		expect(supervisor.workers.get(completedEntry.workerId)?.descriptor.lifecycle).toBe("passivated");
		expect(supervisor.workers.get(completedRecurringEntry.workerId)?.descriptor.lifecycle).toBe("recovering");
	});

	it("does not recover a saved processless client-owned passive root until its owner attaches with env", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const entry = {
			...descriptor(fixture, "client-owned", session),
			ownerClientId: "owner-client",
			lifecycle: "passivated" as const,
		};
		delete entry.pid;
		writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals & {
			attachClient(
				client: AttachClientFixture,
				command: { type: "attach"; activeSessionId: string; launchEnv?: Record<string, string> },
			): Promise<unknown>;
		};
		supervisor.recoverWorker = vi.fn(async () => {
			const worker = supervisor.workers.get(entry.workerId);
			if (!worker) throw new Error("missing worker");
			worker.descriptor.lifecycle = "ready";
			worker.client = {
				request: vi.fn(async () => ({
					success: true,
					data: {
						activeSessionId: entry.rootActiveSessionId,
						snapshot: { summary: {}, messages: [] },
						client: {},
					},
				})),
			};
		});
		workerSpawn.mockClear();
		await supervisor.loadWorkerDescriptors();

		const passive = supervisor.workers.get(entry.workerId);
		expect(passive?.descriptor.lifecycle).toBe("passivated");
		expect(passive?.client).toBeUndefined();
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
		expect(workerSpawn).not.toHaveBeenCalled();
		const persisted = readFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), "utf8");
		expect(JSON.parse(persisted)).toMatchObject({ lifecycle: "passivated", ownerClientId: "owner-client" });
		expect(persisted).not.toContain("launchEnv");

		await supervisor.attachClient(
			{
				id: "owner-client",
				attachedActiveSessionIds: new Set(),
				capabilities: new Set(),
				supportsExtensionUi: false,
			},
			{ type: "attach", activeSessionId: entry.rootActiveSessionId, launchEnv: { HERDR_PANE_ID: "pane" } },
		);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("lets only the owner replace launch env before reusing a passive client-owned root", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const entry = {
			...descriptor(fixture, "client-owned-reuse", session),
			ownerClientId: "owner-client",
			lifecycle: "passivated" as const,
		};
		delete entry.pid;
		writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals & {
			createOrReuseWorker(
				clientId: string,
				command: {
					type: "create";
					sessionPath: string;
					lifecycle?: "client_owned";
					launchEnv?: Record<string, string>;
				},
			): Promise<WorkerFixture & { launchEnv?: Record<string, string> }>;
		};
		await supervisor.loadWorkerDescriptors();
		const passive = supervisor.workers.get(entry.workerId);
		if (!passive) throw new Error("passive owner worker was not loaded");
		supervisor.recoverWorker = vi.fn(async () => {
			passive.descriptor.lifecycle = "ready";
			passive.client = {};
		});

		await expect(
			supervisor.createOrReuseWorker("other-client", {
				type: "create",
				sessionPath: session.sessionFile,
				lifecycle: "client_owned",
				launchEnv: { HERDR_PANE_ID: "injected" },
			}),
		).rejects.toThrow("already active");
		expect((passive as { launchEnv?: Record<string, string> }).launchEnv).toBeUndefined();
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();

		const reused = await supervisor.createOrReuseWorker("owner-client", {
			type: "create",
			sessionPath: session.sessionFile,
			lifecycle: "client_owned",
			launchEnv: { HERDR_PANE_ID: "owner-pane" },
		});
		expect(reused).toBe(passive);
		expect(reused.launchEnv).toEqual({ HERDR_PANE_ID: "owner-pane" });
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);

		// Reuse by the active-session selector takes the other matching path and
		// must update the authorized owner's environment without another wake.
		await supervisor.createOrReuseWorker("owner-client", {
			type: "create",
			sessionPath: entry.rootActiveSessionId,
			lifecycle: "client_owned",
			launchEnv: { HERDR_PANE_ID: "owner-pane-after-restart" },
		});
		expect(reused.launchEnv).toEqual({ HERDR_PANE_ID: "owner-pane-after-restart" });
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("clears stale process identity before persisting an owner-owned no-env passive worker", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const entry = {
			...descriptor(fixture, "owner-no-env", session),
			ownerClientId: "owner-client",
			lifecycle: "ready" as const,
		};
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: { ...entry, generation: "11111111-1111-4111-8111-111111111111" },
			descriptorPath: join(fixture.descriptorDir, "owner-no-env.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(entry));
		supervisor.workers.set(entry.workerId, worker);
		await (
			supervisor as unknown as { recoverWorker(worker: { descriptor: DaemonWorkerDescriptor }): Promise<void> }
		).recoverWorker(worker);
		expect(worker.descriptor).toMatchObject({ lifecycle: "passivated", ownerClientId: "owner-client" });
		expect(worker.descriptor).not.toHaveProperty("pid");
		expect(worker.descriptor).not.toHaveProperty("processStartId");
		const persisted = JSON.parse(readFileSync(worker.descriptorPath, "utf8"));
		expect(persisted).not.toHaveProperty("pid");
		expect(persisted).not.toHaveProperty("processStartId");
	});

	it("stops a passivated descriptor without probing or signaling its stale pid", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: (() => {
				const { pid: _pid, processStartId: _processStartId, ...passivated } = descriptor(fixture, "stop", session);
				return { ...passivated, lifecycle: "passivated" as const };
			})(),
			descriptorPath: join(fixture.descriptorDir, "stop.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set("stop", worker);
		const kill = vi.spyOn(process, "kill");
		try {
			await supervisor.stopWorker(worker, true);
			expect(kill).not.toHaveBeenCalled();
			expect(supervisor.workers.has("stop")).toBe(false);
		} finally {
			kill.mockRestore();
		}
	});
	it("fences a concurrent explicit wake until passive stop archive/delete finalizes", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: (() => {
				const {
					pid: _pid,
					processStartId: _processStartId,
					...passivated
				} = descriptor(fixture, "stop-wake-race", session);
				return { ...passivated, lifecycle: "passivated" as const };
			})(),
			descriptorPath: join(fixture.descriptorDir, "stop-wake-race.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set("stop-wake-race", worker);
		let finishArchive: () => void = () => undefined;
		const archiveStarted = new Promise<void>((resolve) => {
			supervisor.catalog.archive = vi.fn(async () => {
				resolve();
				await new Promise<void>((finish) => {
					finishArchive = finish;
				});
			});
		});
		supervisor.recoverWorker = vi.fn();

		const stopping = supervisor.stopWorker(worker, true, false, true);
		await archiveStarted;
		const concurrentStop = supervisor.stopWorker(worker, true, false, true);
		let wakeSettled = false;
		const waking = supervisor.wakePassivatedWorker(worker).finally(() => {
			wakeSettled = true;
		});
		await Promise.resolve();
		expect(wakeSettled).toBe(false);
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
		expect(supervisor.catalog.archive).toHaveBeenCalledTimes(1);

		finishArchive();
		await Promise.all([stopping, concurrentStop]);
		await expect(waking).rejects.toThrow("was stopped");
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.has("stop-wake-race")).toBe(false);
		expect(() => readFileSync(worker.descriptorPath)).toThrow();
	});

	it("keeps concurrent stop options independent while sharing only archive finalization", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: { ...descriptor(fixture, "options", session), lifecycle: "passivated" as const },
			descriptorPath: join(fixture.descriptorDir, "options.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		supervisor.workers.set("options", worker);
		const calls: unknown[][] = [];
		supervisor.stopWorkerOnce = vi.fn(async (...args: unknown[]) => {
			calls.push(args);
		});

		await Promise.all([
			supervisor.stopWorker(worker, false, false, false),
			supervisor.stopWorker(worker, true, true, true),
		]);

		expect(calls).toHaveLength(2);
		expect(calls.map((args) => args.slice(1, 4))).toEqual([
			[false, false, false],
			[true, true, true],
		]);
	});

	it("honors a concurrent force/archive/remove stop while an update stop is still graceful", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: { ...descriptor(fixture, "force", session), lifecycle: "ready" as const },
			descriptorPath: join(fixture.descriptorDir, "force.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set("force", worker);
		supervisor.catalog.archive = vi.fn(async () => undefined);
		let signalTerm: () => void = () => undefined;
		const termSignaled = new Promise<void>((resolve) => {
			signalTerm = resolve;
		});
		const signals: string[] = [];
		const child = {
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(signal: NodeJS.Signals) {
				signals.push(signal);
				if (signal === "SIGTERM") signalTerm();
				if (signal === "SIGKILL") this.signalCode = signal;
				return true;
			},
		};
		const directChild = { child, closed: Promise.resolve() };
		const graceful = supervisor.stopWorker(worker, false, false, false, false, directChild);
		await termSignaled;
		const destructive = supervisor.stopWorker(worker, true, true, true, false, directChild);
		await Promise.all([graceful, destructive]);

		expect(signals).toContain("SIGKILL");
		expect(supervisor.catalog.archive).toHaveBeenCalledTimes(1);
		expect(supervisor.workers.has("force")).toBe(false);
		expect(() => readFileSync(worker.descriptorPath)).toThrow();
	});

	it("does not let a recovery-cleanup direct child suppress a concurrent deleting archive", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: { ...descriptor(fixture, "recovery-collision", session), lifecycle: "ready" as const },
			descriptorPath: join(fixture.descriptorDir, "recovery-collision.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set("recovery-collision", worker);
		supervisor.catalog.archive = vi.fn(async () => undefined);
		let releaseChild: () => void = () => undefined;
		const childClosed = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const child = { exitCode: 0, signalCode: null, kill: vi.fn(() => true) };
		const recoveryCleanup = supervisor.stopWorker(worker, false, true, false, true, { child, closed: childClosed });
		await Promise.resolve();
		const deletingArchive = supervisor.stopWorker(worker, true, false, true);
		releaseChild();
		await Promise.all([recoveryCleanup, deletingArchive]);

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(supervisor.workers.has("recovery-collision")).toBe(false);
		expect(() => readFileSync(worker.descriptorPath)).toThrow();
	});

	it("removes a stopped update resident while retaining its descriptor for replacement recovery", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: (() => {
				const { pid: _pid, processStartId: _start, ...passive } = descriptor(fixture, "update-stop", session);
				return { ...passive, lifecycle: "passivated" as const };
			})(),
			descriptorPath: join(fixture.descriptorDir, "update-stop.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set("update-stop", worker);

		await supervisor.stopWorker(worker, false);
		expect(supervisor.workers.has("update-stop")).toBe(false);
		expect(JSON.parse(readFileSync(worker.descriptorPath, "utf8"))).toMatchObject({ lifecycle: "passivated" });
	});

	it("late archive deletion removes a retained recovering descriptor before restart", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: (() => {
				const {
					pid: _pid,
					processStartId: _processStartId,
					...passivated
				} = descriptor(fixture, "late-archive-delete", session);
				return { ...passivated, lifecycle: "passivated" as const };
			})(),
			descriptorPath: join(fixture.descriptorDir, "late-archive-delete.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopFinalized: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set("late-archive-delete", worker);
		supervisor.catalog.archive = vi.fn(async () => undefined);

		await supervisor.stopWorker(worker, false);
		expect(JSON.parse(readFileSync(worker.descriptorPath, "utf8"))).toMatchObject({ lifecycle: "passivated" });
		await supervisor.stopWorker(worker, true, false, true);

		expect(supervisor.catalog.archive).toHaveBeenCalledTimes(1);
		expect(worker.stopFinalized).toBe(true);
		expect(supervisor.workers.has("late-archive-delete")).toBe(false);
		expect(() => readFileSync(worker.descriptorPath)).toThrow();

		const restarted = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		await restarted.loadWorkerDescriptors();
		expect(restarted.workers.has("late-archive-delete")).toBe(false);
	});

	it("does not recreate a deleted descriptor when a later stop requests archive", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: (() => {
				const { pid: _pid, processStartId: _start, ...passive } = descriptor(fixture, "already-deleted", session);
				return { ...passive, lifecycle: "passivated" as const };
			})(),
			descriptorPath: join(fixture.descriptorDir, "already-deleted.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopFinalized: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set(worker.descriptor.workerId, worker);
		await supervisor.stopWorker(worker, true);
		expect(() => readFileSync(worker.descriptorPath)).toThrow();
		supervisor.catalog.archive = vi.fn(async () => {
			// This is the crash-window boundary: an old implementation persisted a
			// fresh tombstone immediately before this archive call.
			expect(() => readFileSync(worker.descriptorPath)).toThrow();
		});
		await supervisor.stopWorker(worker, true, false, true);
		expect(supervisor.catalog.archive).toHaveBeenCalledOnce();
		expect(() => readFileSync(worker.descriptorPath)).toThrow();
	});

	it("retries a rejected archive finalization on a later explicit archive stop", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker = {
			descriptor: (() => {
				const {
					pid: _pid,
					processStartId: _processStartId,
					...passivated
				} = descriptor(fixture, "archive-retry", session);
				return { ...passivated, lifecycle: "passivated" as const };
			})(),
			descriptorPath: join(fixture.descriptorDir, "archive-retry.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopFinalized: false,
			stopRevision: 0,
		};
		writeFileSync(worker.descriptorPath, JSON.stringify(worker.descriptor));
		supervisor.workers.set("archive-retry", worker);
		supervisor.catalog.archive = vi
			.fn<SupervisorInternals["catalog"]["archive"]>()
			.mockRejectedValueOnce(new Error("archive failed"))
			.mockResolvedValueOnce(undefined);

		await expect(supervisor.stopWorker(worker, true, false, true)).rejects.toThrow("archive failed");
		await expect(supervisor.stopWorker(worker, true, false, true)).resolves.toBeUndefined();

		expect(supervisor.catalog.archive).toHaveBeenCalledTimes(2);
		expect(worker.stopFinalized).toBe(true);
		expect(supervisor.workers.has("archive-retry")).toBe(false);
		expect(() => readFileSync(worker.descriptorPath)).toThrow();
	});

	it("blocks ordinary wake after a failed stop until explicit retry resets its tombstone", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const worker: PassivatedWorkerFixture = {
			descriptor: (() => {
				const { pid: _pid, processStartId: _start, ...passive } = descriptor(fixture, "failed-stop", session);
				return { ...passive, lifecycle: "passivated" as const };
			})(),
			descriptorPath: join(fixture.descriptorDir, "failed-stop.json"),
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		supervisor.workers.set("failed-stop", worker);
		supervisor.recoverWorker = vi.fn();
		supervisor.catalog.archive = vi.fn(async () => {
			throw new Error("archive failed");
		});
		await expect(supervisor.stopWorker(worker, true, false, true)).rejects.toThrow("archive failed");
		await expect(supervisor.wakePassivatedWorker(worker)).rejects.toThrow("was stopped");
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
		// Direct retry is the explicit reset route; its recovery is mocked only to
		// prove it is admitted after the persisted failure fence.
		supervisor.recoverWorker = vi.fn(async () => {
			worker.descriptor.lifecycle = "ready";
			worker.client = {};
		});
		const retried = (
			supervisor as unknown as { handleCommand(client: object, command: object): Promise<unknown> }
		).handleCommand(
			{ id: "client" },
			{ id: "retry", type: "retry_worker", activeSessionId: worker.descriptor.rootActiveSessionId },
		);
		await expect(retried).resolves.toBeDefined();
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("writes one canonical passive migration for a safely classifiable stale nested legacy identity", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const entry = descriptor(fixture, "nested-legacy", session);
		delete entry.pid;
		entry.process = { pid: 999_999_999, processStartId: "stale-start" };
		delete entry.generation;
		writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const persist = vi.spyOn(supervisor, "persistWorker");
		await supervisor.loadWorkerDescriptors();

		const loaded = supervisor.workers.get(entry.workerId);
		expect(loaded?.descriptor.generation).toMatch(/^[0-9a-f-]+$/);
		expect(loaded?.descriptor.lifecycle).toBe("passivated");
		const persisted = JSON.parse(readFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), "utf8"));
		expect(persisted).toMatchObject({ generation: loaded?.descriptor.generation, lifecycle: "passivated" });
		expect(persisted).not.toHaveProperty("pid");
		expect(persisted).not.toHaveProperty("processStartId");
		expect(persist).toHaveBeenCalledOnce();
	});

	it("keeps malformed lifecycle descriptors visible as raw quarantined evidence across successive reloads", async () => {
		const fixture = fixtureRoot();
		const missing = persistSession(fixture.sessionDir, fixture.root, "completed");
		const unknown = persistSession(fixture.sessionDir, fixture.root, "completed");
		const missingDescriptor = descriptor(fixture, "missing-lifecycle", missing);
		const unknownDescriptor = { ...descriptor(fixture, "unknown-lifecycle", unknown), lifecycle: "future_state" };
		delete (missingDescriptor as Partial<DaemonWorkerDescriptor>).lifecycle;
		delete (missingDescriptor as Partial<DaemonWorkerDescriptor>).generation;
		delete (unknownDescriptor as Partial<DaemonWorkerDescriptor>).generation;
		const raw = new Map([
			["missing-lifecycle", JSON.stringify(missingDescriptor)],
			["unknown-lifecycle", JSON.stringify(unknownDescriptor)],
		]);
		for (const [workerId, contents] of raw) {
			writeFileSync(join(fixture.descriptorDir, `${workerId}.json`), contents);
		}

		// Unknown lifecycle input remains available to diagnostics, but its disk
		// bytes are not C01 state. It must never be normalized into a writable,
		// processless recovering row on either reload.
		const first = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		first.recoverWorker = vi.fn();
		const firstWrite = vi.spyOn(first, "persistWorker");
		workerSpawn.mockClear();
		const kill = vi.spyOn(process, "kill");
		try {
			await first.loadWorkerDescriptors();
			expect(first.workers).toHaveLength(2);
			for (const workerId of raw.keys()) {
				const worker = first.workers.get(workerId);
				expect(worker).toMatchObject({ quarantined: true, descriptor: { lifecycle: "recovering" } });
				expect(worker?.descriptor.process).toBeUndefined();
				expect(worker?.descriptor.pid).toBeUndefined();
				await expect(first.wakePassivatedWorker(worker!)).rejects.toThrow("quarantined");
				expect(readFileSync(join(fixture.descriptorDir, `${workerId}.json`), "utf8")).toBe(raw.get(workerId));
			}

			const second = new DaemonSupervisor(fixture.socketPath, {
				defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
				descriptorDir: fixture.descriptorDir,
			}) as unknown as SupervisorInternals;
			second.recoverWorker = vi.fn();
			await second.loadWorkerDescriptors();
			expect(second.workers).toHaveLength(2);
			for (const workerId of raw.keys()) {
				const worker = second.workers.get(workerId);
				expect(worker).toMatchObject({ quarantined: true, descriptor: { lifecycle: "recovering" } });
				expect(worker?.client).toBeUndefined();
				expect(worker?.summaries).toHaveLength(0);
				expect(readFileSync(join(fixture.descriptorDir, `${workerId}.json`), "utf8")).toBe(raw.get(workerId));
			}
			expect(first.recoverWorker).not.toHaveBeenCalled();
			expect(firstWrite).not.toHaveBeenCalled();
			expect(second.recoverWorker).not.toHaveBeenCalled();
			expect(workerSpawn).not.toHaveBeenCalled();
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	it("ignores malformed recovering process identities without probing, waking, or passivating them", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const malformed = [
			["pid-only", { pid: 999_999_999 }],
			["start-only", { processStartId: "start-only" }],
			["object-pid", { pid: { value: 999_999_999 }, processStartId: "object-pid" }],
			["object-start", { pid: 999_999_999, processStartId: { value: "object-start" } }],
			["empty-start", { pid: 999_999_999, processStartId: "" }],
		] as const;
		for (const [workerId, processIdentity] of malformed) {
			const entry = {
				...descriptor(fixture, workerId, session),
				pid: undefined,
				processStartId: undefined,
				...processIdentity,
				lifecycle: "recovering",
			};
			writeFileSync(join(fixture.descriptorDir, `${workerId}.json`), JSON.stringify(entry));
		}
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		supervisor.recoverWorker = vi.fn();
		const passivatedSummary = vi.spyOn(supervisor, "passivatedSummaryForDescriptor");
		workerSpawn.mockClear();
		const kill = vi.spyOn(process, "kill");
		try {
			await supervisor.loadWorkerDescriptors();
			expect(supervisor.workers).toHaveLength(0);
			expect(supervisor.recoverWorker).not.toHaveBeenCalled();
			expect(workerSpawn).not.toHaveBeenCalled();
			expect(kill).not.toHaveBeenCalled();
			expect(passivatedSummary).not.toHaveBeenCalled();
			for (const [workerId] of malformed) {
				const persisted = JSON.parse(readFileSync(join(fixture.descriptorDir, `${workerId}.json`), "utf8"));
				expect(persisted.lifecycle).toBe("recovering");
			}
		} finally {
			kill.mockRestore();
			passivatedSummary.mockRestore();
		}
	});

	it("normalizes a legacy passivated descriptor before process inspection", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const entry = {
			...descriptor(fixture, "legacy-passivated", session),
			lifecycle: "passivated",
			pid: { stale: 999_999_999 },
			processStartId: { stale: "legacy" },
		};
		writeFileSync(join(fixture.descriptorDir, "legacy-passivated.json"), JSON.stringify(entry));
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const kill = vi.spyOn(process, "kill");
		try {
			await supervisor.loadWorkerDescriptors();
			const worker = supervisor.workers.get("legacy-passivated");
			expect(worker?.descriptor.lifecycle).toBe("passivated");
			expect(worker?.descriptor).not.toHaveProperty("pid");
			expect(worker?.descriptor).not.toHaveProperty("processStartId");
			expect(worker?.summaries.has(worker?.descriptor.rootActiveSessionId ?? "")).toBe(true);
			expect(kill).not.toHaveBeenCalled();
			const persisted = JSON.parse(readFileSync(join(fixture.descriptorDir, "legacy-passivated.json"), "utf8"));
			expect(persisted).not.toHaveProperty("pid");
			expect(persisted).not.toHaveProperty("processStartId");
		} finally {
			kill.mockRestore();
		}
	});

	it.each(["flat", "nested"] as const)(
		"quarantines unknown-start legacy %s identity with recoverable work without rewriting raw evidence",
		async (shape) => {
			const fixture = fixtureRoot();
			const session = persistSession(fixture.sessionDir, fixture.root, "completed");
			const entry = descriptor(fixture, `unknown-start-busy-${shape}`, session);
			delete entry.generation;
			if (shape === "nested") {
				delete entry.pid;
				entry.process = { pid: 999_999_999, processStartId: "unobservable-start" };
			}
			// The impossible PID makes either legacy identity unobservable; the busy
			// journal independently rejects passive classification. This exact
			// combination must retain raw evidence rather than write processless
			// `recovering` C01 state that could later be restarted.
			writeFileSync(
				entry.recoveryJournalPath,
				`${JSON.stringify({
					version: 1,
					activeSessionId: entry.rootActiveSessionId,
					sessionId: session.id,
					sessionFile: session.sessionFile,
					busy: true,
					operation: "legacy-work",
					recordedAt: new Date(0).toISOString(),
				})}\n`,
			);
			const descriptorPath = join(fixture.descriptorDir, `${entry.workerId}.json`);
			const raw = JSON.stringify(entry);
			writeFileSync(descriptorPath, raw);
			const supervisor = new DaemonSupervisor(fixture.socketPath, {
				defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
				descriptorDir: fixture.descriptorDir,
			}) as unknown as SupervisorInternals;
			supervisor.recoverWorker = vi.fn();
			const persist = vi.spyOn(supervisor, "persistWorker");
			const kill = vi.spyOn(process, "kill");
			try {
				await supervisor.loadWorkerDescriptors();
				const worker = supervisor.workers.get(entry.workerId);
				expect(worker).toMatchObject({ quarantined: true, descriptor: { lifecycle: "recovering" } });
				expect(worker?.descriptor.process).toBeUndefined();
				expect(worker?.descriptor.pid).toBeUndefined();
				expect(worker?.summaries).toHaveLength(0);
				expect(readFileSync(descriptorPath, "utf8")).toBe(raw);
				expect(persist).not.toHaveBeenCalled();
				expect(supervisor.recoverWorker).not.toHaveBeenCalled();
				await expect(supervisor.wakePassivatedWorker(worker!)).rejects.toThrow("quarantined");
				expect(kill).not.toHaveBeenCalled();
			} finally {
				kill.mockRestore();
			}
		},
	);

	it("writes only canonical C01 descriptor shapes", () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const { pid: _pid, processStartId: _startId, ...passive } = descriptor(fixture, "writer-shape", session);
		const worker: WorkerFixture = {
			descriptor: { ...passive, lifecycle: "passivated" },
			descriptorPath: join(fixture.descriptorDir, "writer-shape.json"),
			summaries: new Map(),
		};

		supervisor.persistWorker(worker);
		const persisted = JSON.parse(readFileSync(worker.descriptorPath, "utf8"));
		expect(persisted).toMatchObject({ generation: "11111111-1111-4111-8111-111111111111", lifecycle: "passivated" });
		expect(persisted).not.toHaveProperty("pid");
		expect(persisted).not.toHaveProperty("processStartId");
		expect(persisted).not.toHaveProperty("process");

		worker.descriptor.generation = "legacy-generation";
		expect(() => supervisor.persistWorker(worker)).toThrow("canonical generation");
		worker.descriptor.generation = "11111111-1111-4111-8111-111111111111";
		for (const lifecycle of ["starting", "recovering", "failed"] as const) {
			worker.descriptor.lifecycle = lifecycle;
			expect(() => supervisor.persistWorker(worker)).toThrow("without a process identity");
		}
		worker.descriptor.lifecycle = "passivated";
		worker.descriptor.process = { pid: process.pid, processStartId: "not-authoritative" };
		expect(() => supervisor.persistWorker(worker)).toThrow("passivated worker");
	});

	it("quarantines malformed or stale durable task verdicts without rewriting legacy selectors", async () => {
		const fixture = fixtureRoot();
		const malformed = persistSession(fixture.sessionDir, fixture.root, "completed");
		const stale = persistSession(fixture.sessionDir, fixture.root, "completed");
		const invalidLifecycle = persistSession(fixture.sessionDir, fixture.root, "completed");
		const truncatedLifecycle = persistSession(fixture.sessionDir, fixture.root, "completed");
		const oversizedVerdict = persistSession(fixture.sessionDir, fixture.root, "completed");
		const corruptArrayArtifact = persistSession(fixture.sessionDir, fixture.root, "completed");
		mkdirSync(join(fixture.agentDir, "session-artifacts", corruptArrayArtifact.id), { recursive: true });
		writeFileSync(join(fixture.agentDir, "session-artifacts", corruptArrayArtifact.id, "scheduled-jobs.json"), "[]");
		for (const [workerId, session, status] of [
			["malformed", malformed, { summary: "bad", taskState: "arbitrary_untrusted_value", basedOnMessageCount: 1 }],
			["stale", stale, { summary: "stale", taskState: "completed", basedOnMessageCount: 0 }],
		] as const) {
			writeFileSync(
				session.sessionFile,
				`${JSON.stringify({ type: "agent_status", id: `${workerId}-status`, parentId: "root", timestamp: new Date().toISOString(), status })}
`,
				{ flag: "a" },
			);
			writeFileSync(
				join(fixture.descriptorDir, `${workerId}.json`),
				JSON.stringify(descriptor(fixture, workerId, session)),
			);
		}
		writeFileSync(
			invalidLifecycle.sessionFile,
			`${JSON.stringify({ type: "session_state", id: "invalid-lifecycle", parentId: "root", timestamp: new Date().toISOString(), state: { status: "untrusted_lifecycle" } })}
`,
			{ flag: "a" },
		);
		writeFileSync(
			join(fixture.descriptorDir, "invalid-lifecycle.json"),
			JSON.stringify(descriptor(fixture, "invalid-lifecycle", invalidLifecycle)),
		);
		writeFileSync(truncatedLifecycle.sessionFile, '{"type":"session_state"', { flag: "a" });
		writeFileSync(
			oversizedVerdict.sessionFile,
			`
{"type":"agent_status","padding":"${"x".repeat(2 * 1024 * 1024)}"}
`,
			{ flag: "a" },
		);
		for (const [workerId, session] of [
			["truncated-lifecycle", truncatedLifecycle],
			["oversized-verdict", oversizedVerdict],
			["corrupt-array-artifact", corruptArrayArtifact],
		] as const) {
			writeFileSync(
				join(fixture.descriptorDir, `${workerId}.json`),
				JSON.stringify(descriptor(fixture, workerId, session)),
			);
		}
		const raw = new Map(
			[
				"malformed",
				"stale",
				"invalid-lifecycle",
				"truncated-lifecycle",
				"oversized-verdict",
				"corrupt-array-artifact",
			].map((workerId) => [workerId, readFileSync(join(fixture.descriptorDir, `${workerId}.json`), "utf8")]),
		);
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		const persist = vi.spyOn(supervisor, "persistWorker");
		await supervisor.loadWorkerDescriptors();
		for (const [workerId, contents] of raw) {
			const worker = supervisor.workers.get(workerId);
			expect(worker).toMatchObject({ quarantined: true, descriptor: { lifecycle: "recovering" } });
			expect(worker?.descriptor.process).toBeUndefined();
			expect(readFileSync(join(fixture.descriptorDir, `${workerId}.json`), "utf8")).toBe(contents);
		}
		expect(persist).not.toHaveBeenCalled();
	});
});
