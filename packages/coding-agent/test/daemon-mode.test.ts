import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { AgentCronJob, AgentCronJobStore } from "../src/core/cron-jobs.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	AgentDaemon,
	cancelPendingExtensionUiRequests,
	detachClientFromActiveSession,
	getChildActiveSessionStates,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";

describe("daemon mode helpers", () => {
	it("finds only direct child active sessions", () => {
		const parent = makeState("parent");
		const child = makeState("child", "parent");
		const grandchild = makeState("grandchild", "child");
		const sibling = makeState("sibling");
		const selfLinked = makeState("self-linked", "self-linked");
		const sessions = new Map<string, ActiveSessionState>(
			[parent, child, grandchild, sibling, selfLinked].map((state) => [state.activeSessionId, state]),
		);

		expect(getChildActiveSessionStates(sessions, parent).map((state) => state.activeSessionId)).toEqual(["child"]);
	});

	it("cancels pending extension UI requests when the last client detaches", () => {
		const firstClient = makeClient("client-1", "active");
		const secondClient = makeClient("client-2", "active");
		const firstResolve = vi.fn();
		const secondResolve = vi.fn();
		const state = {
			...makeState("active"),
			clients: new Set<DaemonSocketClient>([firstClient, secondClient]),
			extensionUiRequests: new Map([
				["request-1", { resolve: firstResolve }],
				["request-2", { resolve: secondResolve }],
			]),
		};

		detachClientFromActiveSession(firstClient, state);

		expect(state.extensionUiRequests.size).toBe(2);
		expect(firstResolve).not.toHaveBeenCalled();
		expect(firstClient.attachedActiveSessionIds.has("active")).toBe(false);

		detachClientFromActiveSession(secondClient, state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(firstResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondClient.attachedActiveSessionIds.has("active")).toBe(false);
	});

	it("cancels pending extension UI requests directly", () => {
		const resolve = vi.fn();
		const state = {
			...makeState("active"),
			extensionUiRequests: new Map([["request-1", { resolve }]]),
		};

		cancelPendingExtensionUiRequests(state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(resolve).toHaveBeenCalledWith({ cancelled: true });
	});

	it("sends dialog extension UI requests only to UI-capable clients", () => {
		const lineClient = makeClient("line-client", "active", false);
		const uiClient = makeClient("ui-client", "active", true);
		const dialogRequest = {
			type: "extension_ui_request",
			activeSessionId: "active",
			id: "request-1",
			method: "confirm",
			payload: {},
		} as const;

		expect(shouldSendDaemonOutboundToClient(lineClient, dialogRequest)).toBe(false);
		expect(shouldSendDaemonOutboundToClient(uiClient, dialogRequest)).toBe(true);
		expect(
			shouldSendDaemonOutboundToClient(lineClient, {
				...dialogRequest,
				method: "notify",
			}),
		).toBe(true);
	});

	it("deduplicates concurrent creates for the same session file", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-race-"));
		try {
			const sessionPath = join(tempDir, "session.jsonl");
			let releaseCreate: () => void = () => {};
			const createBarrier = new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				await createBarrier;
				return {
					session: makeRuntimeSession(options.sessionManager),
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: {
					agentDir: tempDir,
					cwd: tempDir,
					sessionDir: tempDir,
				},
				createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			const first = create({ type: "create", sessionPath });
			const second = create({ type: "create", sessionPath });
			for (let attempt = 0; attempt < 20 && createRuntime.mock.calls.length === 0; attempt++) {
				await Promise.resolve();
			}

			expect(createRuntime).toHaveBeenCalledTimes(1);
			releaseCreate();
			const [firstState, secondState] = await Promise.all([first, second]);

			expect(secondState).toBe(firstState);
			expect(createRuntime).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("includes paused jobs in the default cron list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-cron-list-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: {
					agentDir: tempDir,
					cwd: tempDir,
				},
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			internals.cronStore.pauseHeartbeat("active-1", new Date("2026-01-01T12:01:00.000Z"));

			const response = (await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "cron_list",
			})) as { data: { jobs: AgentCronJob[] } };

			expect(response.data.jobs).toEqual([expect.objectContaining({ id: heartbeat.id, status: "paused" })]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves omitted global scope on daemon refine commands", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: {
				agentDir: "/tmp/prime-agent-test-agent",
				cwd: "/tmp",
			},
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const refine = vi.fn(async () => ({
			id: "refine_daemon",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		}));
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					refine: typeof refine;
				};
			};
		};
		state.runtime.session = { refine } as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "refine",
			activeSessionId: state.activeSessionId,
			instructions: "record local lesson",
		});

		expect(refine).toHaveBeenCalledWith({
			instructions: "record local lesson",
			rollbackId: undefined,
			global: undefined,
		});
	});

	it("defers busy heartbeat cron jobs instead of queueing a follow-up", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: {
				agentDir: "/tmp/prime-agent-test-agent",
				cwd: "/tmp",
			},
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isBashRunning: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: true,
			isBashRunning: false,
			pendingMessageCount: 0,
			prompt,
			followUp,
		} as never;
		(
			daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
			}
		).sessions.set(state.activeSessionId, state);
		const runCronJob = (
			daemon as unknown as {
				runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
			}
		).runCronJob.bind(daemon);

		const result = await runCronJob(
			makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }),
		);

		expect(result).toBe("skipped");
		expect(followUp).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("defers separate RLM heartbeat cron jobs while the session is busy", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: {
				agentDir: "/tmp/prime-agent-test-agent",
				cwd: "/tmp",
			},
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isBashRunning: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: true,
			isBashRunning: false,
			pendingMessageCount: 0,
			prompt,
			followUp,
		} as never;
		(
			daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
			}
		).sessions.set(state.activeSessionId, state);
		const runCronJob = (
			daemon as unknown as {
				runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
			}
		).runCronJob.bind(daemon);

		const first = await runCronJob(
			makeCronJob({ id: "rlm-1", source: "rlm_heartbeat", activeSessionId: state.activeSessionId }),
		);
		const second = await runCronJob(
			makeCronJob({ id: "rlm-2", source: "rlm_heartbeat", activeSessionId: state.activeSessionId }),
		);

		expect(first).toBe("skipped");
		expect(second).toBe("skipped");
		expect(followUp).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("does not enqueue another heartbeat when one is already pending", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isBashRunning: boolean;
					pendingMessageCount: number;
					prompt: ReturnType<typeof vi.fn>;
					followUp: ReturnType<typeof vi.fn>;
				};
			};
		};
		const followUp = vi.fn(async () => false);
		const removeQueuedFollowUp = vi.fn(() => true);
		state.runtime.session = {
			isStreaming: true,
			isBashRunning: false,
			pendingMessageCount: 1,
			prompt: vi.fn(),
			followUp,
			removeQueuedFollowUp,
		} as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);
		const result = await (
			daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }
		).runCronJob(makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }));

		expect(result).toBe("skipped");
		expect(followUp).not.toHaveBeenCalled();
		expect(removeQueuedFollowUp).not.toHaveBeenCalled();
	});

	it("queues generic cron jobs behind pending messages", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = { isStreaming: false, pendingMessageCount: 1, prompt, followUp } as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);

		await (daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }).runCronJob(
			makeCronJob({ id: "cron-1", source: "cron", activeSessionId: state.activeSessionId }),
		);

		expect(followUp).toHaveBeenCalledWith("heartbeat prompt");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("prompts idle sessions with a followUp streaming behavior to survive a mid-call stream start", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isBashRunning: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			isBashRunning: false,
			pendingMessageCount: 0,
			prompt,
			followUp,
		} as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);

		await (daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }).runCronJob(
			makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }),
		);

		expect(prompt).toHaveBeenCalledWith("heartbeat prompt", {
			streamingBehavior: "followUp",
			followUpQueueKey: "heartbeat:heartbeat-1",
			source: "rpc",
		});
		expect(followUp).not.toHaveBeenCalled();
	});

	it("prompts idle generic cron jobs without a heartbeat coalescing key", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isBashRunning: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			isBashRunning: false,
			pendingMessageCount: 0,
			prompt,
			followUp,
		} as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);

		await (daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }).runCronJob(
			makeCronJob({ id: "cron-1", source: "cron", activeSessionId: state.activeSessionId }),
		);

		expect(prompt).toHaveBeenCalledWith("heartbeat prompt", {
			streamingBehavior: "followUp",
			followUpQueueKey: undefined,
			source: "rpc",
		});
		expect(followUp).not.toHaveBeenCalled();
	});

	it("removes queued heartbeat follow-ups when a heartbeat is cleared", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-clear-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const removeQueuedFollowUp = vi.fn(() => true);
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: ActiveSessionState["runtime"]["session"] & {
						removeQueuedFollowUp: typeof removeQueuedFollowUp;
					};
				};
			};
			state.runtime.session = { removeQueuedFollowUp } as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "heartbeat_update",
				activeSessionId: state.activeSessionId,
				action: "clear",
			});

			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${heartbeat.id}`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("validates active sessions before reading a heartbeat", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: {
				agentDir: "/tmp/prime-agent-test-agent",
				cwd: "/tmp",
			},
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const handleCommand = (
			daemon as unknown as {
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			}
		).handleCommand.bind(daemon);

		await expect(
			handleCommand(makeClient("client-1", "missing"), {
				id: "command-1",
				type: "heartbeat_get",
				activeSessionId: "missing",
			}),
		).rejects.toThrow("Unknown active session: missing");
	});
});

function makeCronJob(input: { id: string; source: AgentCronJob["source"]; activeSessionId: string }): AgentCronJob {
	return {
		id: input.id,
		status: "active",
		source: input.source,
		activeSessionId: input.activeSessionId,
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "heartbeat prompt",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T12:00:00.000Z",
		updatedAt: "2026-01-01T12:00:00.000Z",
		nextRunAt: "2026-01-01T12:05:00.000Z",
		runCount: 0,
	};
}

function makeRuntimeSession(
	sessionManager: Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionManager"],
): Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"] {
	return {
		sessionManager,
		sessionFile: sessionManager.getSessionFile(),
		sessionId: sessionManager.getSessionId(),
		setSubagentRuntimeHost: vi.fn(),
		subscribe: vi.fn(() => vi.fn()),
		bindExtensions: vi.fn(async () => {}),
		setSessionName: vi.fn(),
		dispose: vi.fn(),
		abort: vi.fn(async () => {}),
	} as unknown as Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"];
}

function makeState(activeSessionId: string, parentActiveSessionId?: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		lastEventSequence: 0,
		runtime: {
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId,
			},
		},
	} as unknown as ActiveSessionState;
}

function makeClient(id: string, activeSessionId: string, supportsExtensionUi = false): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi,
		capabilities: new Set(supportsExtensionUi ? ["extension_ui"] : []),
	};
}
