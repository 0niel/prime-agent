import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ENV_AGENT_DIR,
	getDaemonUpdateRestartManifestPath,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
} from "../src/config.js";
import type { AgentSessionRuntimeMetadata } from "../src/core/agent-session-runtime.js";
import type * as DaemonSocketModule from "../src/modes/daemon/daemon-socket.js";
import { handlePackageCommand, prepareDaemonUpdateRestart } from "../src/package-manager-cli.js";

interface MockSessionSummary {
	id: string;
	activeSessionId?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	pendingMessageCount: number;
}

type MockRunningDaemonProbe = { reachable: false } | { reachable: true; activeSessions?: MockSessionSummary[] };

interface MockCustomMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}

interface MockQueuedMessage {
	message: string;
	content?: Array<{ type: "text"; text: string }>;
	agentMessageId?: string;
	queueKey?: string;
	customMessage?: MockCustomMessage;
	prefixMessages?: MockCustomMessage[];
}

interface MockUpdateRestartSession {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	config: Record<string, unknown>;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
	queue: {
		steering: MockQueuedMessage[];
		followUp: MockQueuedMessage[];
		nextTurn: MockCustomMessage[];
		acceptedPrompt?: MockQueuedMessage & { nextTurn: MockCustomMessage[] };
	};
	shouldResume: boolean;
	wasStreaming: boolean;
	wasCompacting: boolean;
	wasBashRunning: boolean;
	hadRunningRlmChildren: boolean;
	wasRetrying: boolean;
	hadAcceptedPromptInFlight: boolean;
}

interface MockUpdateRestartManifest {
	createdAt: string;
	sessions: MockUpdateRestartSession[];
}

interface MockDaemonRequest {
	type: string;
	activeSessionId?: string;
	message?: string;
	agentMessageId?: string;
	customMessage?: MockCustomMessage;
	prefixMessages?: MockCustomMessage[];
	content?: unknown;
	messages?: MockCustomMessage[];
	queueKey?: string;
	sessionPath?: string;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
}

type MockDaemonResponse = { success: true; data?: unknown } | { success: false; error: string };

const mockState = vi.hoisted(() => ({
	calls: [] as string[],
	createActiveSessionIds: [] as string[],
	createThrowSessionPaths: [] as string[],
	daemonProbe: { reachable: true, activeSessions: [] } as MockRunningDaemonProbe,
	globalPackageRoot: "",
	hello: { protocol: { version: 2 } } as {
		protocol: { version: number };
		supervisorGeneration?: string;
		supervisorOwnerToken?: string;
		supervisorPid?: number;
		supervisorProcessStartId?: string;
		supervisorSocketPath?: string;
	},
	listResponse: undefined as MockDaemonResponse | undefined,
	prepareManifest: { createdAt: "2026-07-07T00:00:00.000Z", sessions: [] } as MockUpdateRestartManifest,
	prepareResponse: undefined as MockDaemonResponse | undefined,
	promptFailures: 0,
	requestThrowTypes: [] as string[],
	requestPayloads: [] as MockDaemonRequest[],
	helloWaitFailures: 0,
	restoreNextTurnFailures: 0,
	socketPath: "",
	spawnExitCodes: [] as number[],
	shutdownResult: true,
}));

function useFixedOwnerHello(): void {
	mockState.hello = {
		protocol: { version: 2 },
		supervisorGeneration: "fixed-owner",
		supervisorOwnerToken: "owner-token",
		supervisorPid: process.pid,
		supervisorProcessStartId: "process-start",
		supervisorSocketPath: mockState.socketPath,
	};
}

vi.mock("child_process", () => ({
	spawn: vi.fn((command: string, args: string[]) => {
		mockState.calls.push(`spawn:${command} ${args.join(" ")}`);
		const exitCode = mockState.spawnExitCodes.shift() ?? 0;
		const child = {
			on(event: string, listener: unknown) {
				if (event === "close") {
					queueMicrotask(() => {
						(listener as (code: number | null, signal: string | null) => void)(exitCode, null);
					});
				}
				return child;
			},
		};
		return child;
	}),
	spawnSync: vi.fn(() => ({
		status: 0,
		stdout: `${mockState.globalPackageRoot}\n`,
		stderr: "",
	})),
}));

vi.mock("../src/modes/daemon/daemon-socket.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonSocketModule>()),
	defaultDaemonSocketPath: () => mockState.socketPath,
}));

vi.mock("../src/modes/daemon/daemon-supervisor-ownership.js", () => ({
	persistDaemonStartupFenceFromOwner: vi.fn(async () => {
		mockState.calls.push("persist-daemon-startup-fence");
	}),
}));

vi.mock("../src/cli/daemon-launch.js", () => ({
	ensureInteractiveDaemonRunning: vi.fn(async () => {
		mockState.calls.push("ensure-daemon");
	}),
	isDaemonSessionSummary: (value: unknown) => {
		if (!value || typeof value !== "object") {
			return false;
		}
		const summary = value as { activeSessionId?: unknown; id?: unknown };
		return typeof summary.activeSessionId === "string" || typeof summary.id === "string";
	},
	isSessionBusy: (summary: MockSessionSummary) =>
		summary.isStreaming ||
		summary.isCompacting ||
		summary.isBashRunning === true ||
		summary.hasRunningRlmChildren === true ||
		summary.pendingMessageCount > 0,
	probeRunningDaemonSessions: vi.fn(async () => {
		mockState.calls.push("probe-daemon");
		return mockState.daemonProbe;
	}),
	shutdownDaemonAndWait: vi.fn(async () => {
		mockState.calls.push("shutdown-daemon");
		return mockState.shutdownResult;
	}),
}));

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: class {
		private observedHello: typeof mockState.hello | undefined;

		constructor(readonly socketPath: string) {}

		get hello(): typeof mockState.hello | undefined {
			return this.observedHello;
		}

		async connect(): Promise<void> {
			mockState.calls.push(`daemon-connect:${this.socketPath}`);
		}

		async waitForHello(): Promise<typeof mockState.hello> {
			if (mockState.helloWaitFailures > 0) {
				mockState.helloWaitFailures--;
				throw new Error("hello timed out");
			}
			this.observedHello = mockState.hello;
			return mockState.hello;
		}

		async request(request: MockDaemonRequest): Promise<MockDaemonResponse> {
			this.observedHello ??= mockState.hello;
			mockState.calls.push(`daemon-request:${request.type}`);
			mockState.requestPayloads.push(request);
			if (mockState.requestThrowTypes.includes(request.type)) {
				throw new Error(`${request.type} failed`);
			}
			if (request.type === "list" && mockState.listResponse) {
				return mockState.listResponse;
			}
			if (request.type === "prepare_update_restart") {
				return mockState.prepareResponse ?? { success: true, data: mockState.prepareManifest };
			}
			if (request.type === "create") {
				if (request.sessionPath && mockState.createThrowSessionPaths.includes(request.sessionPath)) {
					throw new Error("create failed");
				}
				const activeSessionId = mockState.createActiveSessionIds.shift() ?? "restored-active";
				return { success: true, data: { id: activeSessionId, activeSessionId } };
			}
			if (request.type === "restore_next_turn" && mockState.restoreNextTurnFailures > 0) {
				mockState.restoreNextTurnFailures--;
				return { success: false, error: "restore failed" };
			}
			if (request.type === "prompt" && mockState.promptFailures > 0) {
				mockState.promptFailures--;
				return { success: false, error: "prompt failed" };
			}
			return { success: true };
		}

		close(): void {}
	},
}));

describe("self-update daemon restart", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalCwd: string;
	let originalExecPath: string;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-self-update-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "global-prefix", "lib", "node_modules", PACKAGE_NAME);
		mockState.globalPackageRoot = join(tempDir, "global-prefix", "lib", "node_modules");
		mockState.hello = { protocol: { version: 2 } };
		mockState.listResponse = undefined;
		mockState.socketPath = join(tempDir, "daemon.sock");
		mockState.calls = [];
		mockState.createActiveSessionIds = [];
		mockState.createThrowSessionPaths = [];
		mockState.daemonProbe = { reachable: true, activeSessions: [] };
		mockState.prepareManifest = { createdAt: "2026-07-07T00:00:00.000Z", sessions: [] };
		mockState.prepareResponse = undefined;
		mockState.helloWaitFailures = 0;
		mockState.promptFailures = 0;
		mockState.requestThrowTypes = [];
		mockState.requestPayloads = [];
		mockState.restoreNextTurnFailures = 0;
		mockState.spawnExitCodes = [];
		mockState.shutdownResult = true;
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalCwd = process.cwd();
		originalExecPath = process.execPath;
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PI_PACKAGE_DIR = packageDir;
		process.chdir(projectDir);
		Object.defineProperty(process, "execPath", {
			value: join(packageDir, "dist", "cli.js"),
			configurable: true,
		});
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["npm"] }, null, 2));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "999.0.0" })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		delete process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses the interactive no-change sentinel only when self-update is unchanged", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "0.2.6" })),
		);

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
		expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
	});

	it("does not use the no-change sentinel when interactive self-update is cancelled", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		mockState.daemonProbe = {
			reachable: true,
			activeSessions: [
				{
					id: "busy",
					activeSessionId: "busy",
					isStreaming: true,
					isCompacting: false,
					pendingMessageCount: 0,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("does not prepare or stop the daemon when the package update fails", async () => {
		mockState.spawnExitCodes = [23];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls).toContain("probe-daemon");
			expect(mockState.calls.some((call) => call === "daemon-request:prepare_update_restart")).toBe(false);
			expect(mockState.calls.some((call) => call === "shutdown-daemon")).toBe(false);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("restarts the daemon only after the package update succeeds", async () => {
		useFixedOwnerHello();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBeUndefined();
			const spawnIndex = mockState.calls.findIndex((call) => call.startsWith("spawn:npm "));
			const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
			const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
			const shutdownIndex = mockState.calls.indexOf("shutdown-daemon");
			const ensureIndex = mockState.calls.indexOf("ensure-daemon");
			expect(spawnIndex).toBeGreaterThanOrEqual(0);
			expect(prepareIndex).toBeGreaterThan(spawnIndex);
			expect(fenceIndex).toBeGreaterThan(prepareIndex);
			expect(shutdownIndex).toBeGreaterThan(fenceIndex);
			expect(ensureIndex).toBeGreaterThan(shutdownIndex);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not persist a predecessor fence when restart preparation fails", async () => {
		useFixedOwnerHello();

		for (const prepareResponse of [
			{ success: false, error: "prepare failed" } as const,
			{ success: true, data: { createdAt: "2026-07-07T00:00:00.000Z", sessions: "invalid" } } as const,
		]) {
			mockState.calls = [];
			mockState.prepareResponse = prepareResponse;
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow();
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
			expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
		}
	});

	it("persists a fixed predecessor fence when the hello arrives after the initial probe", async () => {
		useFixedOwnerHello();
		mockState.helloWaitFailures = 1;

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(
			mockState.prepareManifest,
		);

		const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
		const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
		expect(prepareIndex).toBeGreaterThanOrEqual(0);
		expect(fenceIndex).toBeGreaterThan(prepareIndex);
	});

	it("fences a pending prepared restart only after verifying the live daemon is empty", async () => {
		useFixedOwnerHello();
		const pendingManifest: MockUpdateRestartManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "pending-active",
					sessionId: "pending-session",
					sessionFile: join(projectDir, "pending.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		writeFileSync(getDaemonUpdateRestartManifestPath(agentDir), JSON.stringify(pendingManifest));
		mockState.requestThrowTypes = ["list"];

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow("list failed");
		expect(mockState.calls).not.toContain("persist-daemon-startup-fence");

		mockState.calls = [];
		mockState.requestThrowTypes = [];
		mockState.listResponse = { success: true, data: { sessions: [] } };
		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(pendingManifest);
		const listIndex = mockState.calls.indexOf("daemon-request:list");
		const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
		expect(listIndex).toBeGreaterThanOrEqual(0);
		expect(fenceIndex).toBeGreaterThan(listIndex);
		expect(mockState.calls).not.toContain("daemon-request:prepare_update_restart");
	});

	it("skips predecessor fencing when the daemon hello has no fixed-owner identity", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("still resumes accepted prompts when accepted context restore fails", async () => {
		mockState.restoreNextTurnFailures = 1;
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						steering: [],
						followUp: [],
						nextTurn: [
							{
								role: "custom",
								customType: "prime-agent.test",
								content: "subsequent turn context",
								display: false,
								timestamp: Date.now(),
							},
						],
						acceptedPrompt: {
							message: "accepted work",
							content: [{ type: "text", text: "accepted work" }],
							agentMessageId: "agentmsg_accepted",
							nextTurn: [
								{
									role: "custom",
									customType: "prime-agent.test",
									content: "accepted prompt context",
									display: false,
									timestamp: Date.now(),
								},
							],
						},
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			const promptRequests = mockState.requestPayloads.filter((request) => request.type === "prompt");
			expect(promptRequests).toEqual([
				expect.objectContaining({
					activeSessionId: "restored-active",
					message: "accepted work",
					agentMessageId: "agentmsg_accepted",
				}),
			]);
			const promptIndex = mockState.requestPayloads.findIndex((request) => request.type === "prompt");
			const subsequentNextTurnIndex = mockState.requestPayloads.findIndex(
				(request) =>
					request.type === "restore_next_turn" &&
					request.messages?.some((message) => message.content === "subsequent turn context") === true,
			);
			expect(promptIndex).toBeGreaterThanOrEqual(0);
			expect(subsequentNextTurnIndex).toBeGreaterThan(promptIndex);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("continues restoring later sessions when one session restore throws", async () => {
		const failedSessionFile = join(projectDir, "failed.jsonl");
		const restoredSessionFile = join(projectDir, "restored.jsonl");
		mockState.createThrowSessionPaths = [failedSessionFile];
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "failed-active",
					sessionId: "failed-session",
					sessionFile: failedSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "restored-active",
					sessionId: "restored-session",
					sessionFile: restoredSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(
				mockState.requestPayloads
					.filter((request) => request.type === "create")
					.map((request) => request.sessionPath),
			).toEqual([failedSessionFile, restoredSessionFile]);
			expect(
				mockState.requestPayloads.some(
					(request) => request.type === "prompt" && request.activeSessionId === "restored-active",
				),
			).toBe(true);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("restores subagent runtime metadata under the recreated parent session", async () => {
		const parentSessionFile = join(projectDir, "parent.jsonl");
		const childSessionFile = join(projectDir, "child.jsonl");
		mockState.createActiveSessionIds = ["new-parent", "new-child"];
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-parent",
					sessionId: "parent-session",
					sessionFile: parentSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: { kind: "top-level", createdAt: 1 },
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "old-child",
					sessionId: "child-session",
					sessionFile: childSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: {
						kind: "subagent",
						createdAt: 2,
						parentActiveSessionId: "old-parent",
						parentSessionId: "parent-session",
						parentSessionFile,
						rlmChildId: "child-1",
						prompt: "child task",
					},
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			const createRequests = mockState.requestPayloads.filter((request) => request.type === "create");
			expect(createRequests).toHaveLength(2);
			expect(createRequests[0]).toMatchObject({
				sessionPath: parentSessionFile,
				runtimeMetadata: { kind: "top-level", createdAt: 1 },
			});
			expect(createRequests[1]).toMatchObject({
				sessionPath: childSessionFile,
				runtimeMetadata: {
					kind: "subagent",
					createdAt: 2,
					parentActiveSessionId: "new-parent",
					parentSessionId: "parent-session",
					parentSessionFile,
					rlmChildId: "child-1",
					prompt: "child task",
				},
			});
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("preserves queued custom messages and prefixes when restoring update restart queues", async () => {
		const customMessage: MockCustomMessage = {
			role: "custom",
			customType: "heartbeat_prompt",
			content: "heartbeat body",
			display: true,
			timestamp: Date.now(),
		};
		const prefixMessage: MockCustomMessage = {
			role: "custom",
			customType: "ipython_state_restored",
			content: "restore context",
			display: true,
			timestamp: Date.now(),
		};
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						steering: [],
						followUp: [
							{
								message: "heartbeat body",
								queueKey: "heartbeat:job-1",
								agentMessageId: "agentmsg_followup",
								customMessage,
								prefixMessages: [prefixMessage],
							},
						],
						nextTurn: [],
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(mockState.requestPayloads).toContainEqual(
				expect.objectContaining({
					type: "follow_up",
					activeSessionId: "restored-active",
					message: "heartbeat body",
					queueKey: "heartbeat:job-1",
					agentMessageId: "agentmsg_followup",
					customMessage,
					prefixMessages: [prefixMessage],
				}),
			);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not resume queued work when accepted prompt replay fails", async () => {
		mockState.promptFailures = 1;
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						steering: [],
						followUp: [{ message: "queued follow-up", agentMessageId: "agentmsg_followup" }],
						nextTurn: [],
						acceptedPrompt: {
							message: "accepted work",
							agentMessageId: "agentmsg_accepted",
							nextTurn: [],
						},
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(mockState.requestPayloads.some((request) => request.type === "follow_up")).toBe(true);
			expect(mockState.requestPayloads.some((request) => request.type === "resume_queue")).toBe(false);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
