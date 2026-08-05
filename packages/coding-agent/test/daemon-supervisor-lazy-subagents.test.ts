import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageAgentSummary } from "../src/core/agent-messages.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	refreshWorkerSummaries(worker: WorkerFixture): Promise<void>;
	syncAgentPeers(): Promise<void>;
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
				rlmChildId: "passive-child",
			}),
		);
	});
});
