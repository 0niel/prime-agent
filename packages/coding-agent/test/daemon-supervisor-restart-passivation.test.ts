import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface WorkerFixture {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	summaries: Map<string, unknown>;
	client?: object;
	wake?: Promise<void>;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	loadWorkerDescriptors(): Promise<void>;
	wakePassivatedWorker(worker: WorkerFixture): Promise<void>;
	forwardToWorker(worker: WorkerFixture, command: object): Promise<unknown>;
	stopWorker(worker: WorkerFixture, removeDescriptor: boolean): Promise<void>;
	recoverWorker: ReturnType<typeof vi.fn>;
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
		supervisor.recoverWorker = vi.fn(async () => {
			worker.descriptor.lifecycle = "ready";
			worker.client = { request: vi.fn() };
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
	});

	it.each([
		{ type: "abort", activeSessionId: "active-read" },
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

	it("keeps a dead client-owned root recoverable without persisting its launch environment", async () => {
		const fixture = fixtureRoot();
		const session = persistSession(fixture.sessionDir, fixture.root, "completed");
		const entry = { ...descriptor(fixture, "client-owned", session), ownerClientId: "owner-client" };
		writeFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), JSON.stringify(entry));

		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		await supervisor.loadWorkerDescriptors();

		expect(supervisor.workers.get(entry.workerId)?.descriptor.lifecycle).toBe("recovering");
		const persisted = readFileSync(join(fixture.descriptorDir, `${entry.workerId}.json`), "utf8");
		expect(persisted).not.toContain("launchEnv");
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
	it("recovers rather than passivating malformed or stale durable task verdicts", async () => {
		const fixture = fixtureRoot();
		const malformed = persistSession(fixture.sessionDir, fixture.root, "completed");
		const stale = persistSession(fixture.sessionDir, fixture.root, "completed");
		const invalidLifecycle = persistSession(fixture.sessionDir, fixture.root, "completed");
		const truncatedLifecycle = persistSession(fixture.sessionDir, fixture.root, "completed");
		const oversizedVerdict = persistSession(fixture.sessionDir, fixture.root, "completed");
		for (const [workerId, session, status] of [
			["malformed", malformed, { summary: "bad", taskState: "arbitrary_untrusted_value", basedOnMessageCount: 1 }],
			["stale", stale, { summary: "stale", taskState: "completed", basedOnMessageCount: 0 }],
		] as const) {
			writeFileSync(
				session.sessionFile,
				`${JSON.stringify({
					type: "agent_status",
					id: `${workerId}-status`,
					parentId: "root",
					timestamp: new Date().toISOString(),
					status,
				})}\n`,
				{ flag: "a" },
			);
			writeFileSync(
				join(fixture.descriptorDir, `${workerId}.json`),
				JSON.stringify(descriptor(fixture, workerId, session)),
			);
		}
		writeFileSync(
			invalidLifecycle.sessionFile,
			`${JSON.stringify({
				type: "session_state",
				id: "invalid-lifecycle",
				parentId: "root",
				timestamp: new Date().toISOString(),
				state: { status: "untrusted_lifecycle" },
			})}\n`,
			{ flag: "a" },
		);
		writeFileSync(
			join(fixture.descriptorDir, "invalid-lifecycle.json"),
			JSON.stringify(descriptor(fixture, "invalid-lifecycle", invalidLifecycle)),
		);
		writeFileSync(truncatedLifecycle.sessionFile, '{"type":"session_state"', { flag: "a" });
		writeFileSync(
			oversizedVerdict.sessionFile,
			`\n{"type":"agent_status","padding":"${"x".repeat(2 * 1024 * 1024)}"}\n`,
			{
				flag: "a",
			},
		);
		for (const [workerId, session] of [
			["truncated-lifecycle", truncatedLifecycle],
			["oversized-verdict", oversizedVerdict],
		] as const) {
			writeFileSync(
				join(fixture.descriptorDir, `${workerId}.json`),
				JSON.stringify(descriptor(fixture, workerId, session)),
			);
		}
		const supervisor = new DaemonSupervisor(fixture.socketPath, {
			defaultSessionConfig: { agentDir: fixture.agentDir, cwd: fixture.root, sessionDir: fixture.sessionDir },
			descriptorDir: fixture.descriptorDir,
		}) as unknown as SupervisorInternals;
		await supervisor.loadWorkerDescriptors();
		expect(supervisor.workers.get("malformed")?.descriptor.lifecycle).toBe("recovering");
		expect(supervisor.workers.get("stale")?.descriptor.lifecycle).toBe("recovering");
		expect(supervisor.workers.get("invalid-lifecycle")?.descriptor.lifecycle).toBe("recovering");
		expect(supervisor.workers.get("truncated-lifecycle")?.descriptor.lifecycle).toBe("recovering");
		expect(supervisor.workers.get("oversized-verdict")?.descriptor.lifecycle).toBe("recovering");
		for (const workerId of ["malformed", "stale", "invalid-lifecycle", "truncated-lifecycle", "oversized-verdict"]) {
			const persisted = JSON.parse(readFileSync(join(fixture.descriptorDir, `${workerId}.json`), "utf8"));
			expect(persisted.pid).toBe(999_999_999);
		}
	});
});
