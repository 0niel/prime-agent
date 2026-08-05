import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageAgentSummary } from "../src/core/agent-messages.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	refreshWorkerSummaries(worker: WorkerFixture): Promise<void>;
	syncAgentPeers(): Promise<void>;
	findSummaryInWorker(worker: WorkerFixture, selector: string): SessionSummary | undefined;
	createOrReuseWorker(clientId: string, command: { type: "create"; name: string }): Promise<WorkerFixture>;
	assertSupervisorSavedSessionNameAvailable(sessionPath: string, name: string): Promise<void>;
}

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "ready";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
	};
	client: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
	return {
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function worker(workerId: string, summaries: SessionSummary[] = []): WorkerFixture {
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: `${workerId}-root-active`,
			rootSessionId: `${workerId}-root-session`,
			pid: 1,
		},
		client: {
			request: vi.fn(),
			requestWorker: vi.fn(async () => ({ type: "response", command: "worker_sync_agent_peers", success: true })),
		},
		summaries: new Map(summaries.map((entry) => [entry.activeSessionId ?? entry.id, entry])),
	};
}

describe("daemon supervisor passive subagent topology", () => {
	it("finds a child summary by its displayed session ID suffix", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-child-suffix-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const child = summary({
			id: "bbbb6666777788889999cccc",
			activeSessionId: "bbbb6666777788889999cccc",
			sessionId: "aaaa6666777788889999dddd",
		});
		const resident = worker("first", [child]);

		expect(supervisor.findSummaryInWorker(resident, "88889999cccc")).toBe(child);
	});

	it("rejects an explicit root name that collides with a saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "duplicate-root" }),
		).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("rejects a forked root name that collides with another saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-forked-root-name-"));
		tempDirs.push(directory);
		const sourceManager = SessionManager.create(directory, join(directory, "sessions"));
		sourceManager.newSession({ rlmDepth: 0 });
		sourceManager.flushNow();
		const sourcePath = sourceManager.getSessionFile();
		if (!sourcePath) throw new Error("Missing source session path");
		const forkedManager = SessionManager.forkFrom(sourcePath, directory, join(directory, "sessions"));
		const forkedPath = forkedManager.getSessionFile();
		if (!forkedPath) throw new Error("Missing forked session path");
		const forkedInfo = await readSessionInfo(forkedPath);
		if (!forkedInfo) throw new Error("Missing forked session info");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			catalog: {
				siblings: vi.fn(async () => [forkedInfo]),
				list: vi.fn(async () => [
					{
						id: "other-root",
						name: "duplicate-root",
						path: join(directory, "other.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
						rlmDepth: 0,
					},
				]),
			},
		});

		await expect(supervisor.assertSupervisorSavedSessionNameAvailable(forkedPath, "duplicate-root")).rejects.toThrow(
			"an agent of that name already exists at depth 0 under this parent",
		);
	});

	it("normalizes explicit root names before supervisor validation and launch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-normalized-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "  duplicate-root  " }),
		).rejects.toThrow('Agent name "duplicate-root" is unavailable');
		await expect(supervisor.createOrReuseWorker("client", { type: "create", name: "   " })).rejects.toThrow(
			"Session name cannot be empty",
		);
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("retains passive worker summaries and sends them to cross-worker agent peer maps", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-peers-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;

		const passive = summary({
			id: "passive-session",
			sessionId: "passive-session",
			sessionFile: join(directory, "passive.jsonl"),
			sessionName: "passive-worker",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const first = worker("first");
		first.client.request.mockResolvedValue(success(undefined, "list", { sessions: [passive] }));
		const secondRoot = summary({
			id: "second-root-active",
			activeSessionId: "second-root-active",
			sessionId: "second-root-session",
		});
		const second = worker("second", [secondRoot]);
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);

		await supervisor.refreshWorkerSummaries(first);
		expect(first.client.request).toHaveBeenCalledWith({ type: "list" }, 5000);
		expect(first.summaries.get("passive-session")).toMatchObject({
			sessionFile: passive.sessionFile,
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});

		await supervisor.syncAgentPeers();
		const secondPeerCommand = second.client.requestWorker.mock.calls[0]?.[0] as
			| { peers: AgentSessionMessageAgentSummary[] }
			| undefined;
		expect(secondPeerCommand?.peers).toContainEqual(
			expect.objectContaining({
				activeSessionId: "passive-session",
				sessionId: "passive-session",
				sessionName: "passive-worker",
				runtimeKind: "subagent",
				status: "inactive",
				rlmChildId: "passive-child",
			}),
		);
	});
});
