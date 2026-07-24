import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { AgentCronJob, AgentCronJobStore } from "../src/core/cron-jobs.js";
import { type CreateRlmSubagentRuntimeOptions, createDefaultRlmSubagentSessionName } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	AgentDaemon,
	cancelPendingExtensionUiRequests,
	detachClientFromActiveSession,
	finishClientSnapshotStreaming,
	getChildActiveSessionStates,
	markClientSnapshotStreaming,
	setDaemonClientSessionCapabilities,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import type { DaemonAttachResult, DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";

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

	it("acknowledges agent messages after target prompt preflight succeeds", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					sessionId: string;
					sessionName: string;
					isStreaming: boolean;
					pendingMessageCount: number;
					acceptAgentMessagePrompt: ReturnType<typeof vi.fn>;
				};
			};
		};
		let resolvePrompt: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			},
		);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
			},
		} as never;
		fromState.runtime = {
			...fromState.runtime,
			session: {
				sessionId: "session-source",
				sessionName: "Source",
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "please continue",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		resolvePrompt();
		await expect(send).resolves.toMatchObject({
			deliveryStatus: "delivered",
			target: { activeSessionId: targetState.activeSessionId },
		});
	});

	it("lists and sends agent messages to completed retained subagents", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const parentState = makeState("parent");
		parentState.runtime = {
			...parentState.runtime,
			cwd: "/tmp",
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: "session-parent",
				sessionName: "Parent",
				isStreaming: false,
				pendingMessageCount: 0,
			},
		} as never;
		const defaultSubagentName = createDefaultRlmSubagentSessionName("retained worker", "child-1");
		const subagentState = makeState("child", "parent") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					sessionId: string;
					sessionName: string;
					isStreaming: boolean;
					pendingMessageCount: number;
					acceptAgentMessagePrompt: ReturnType<typeof vi.fn>;
				};
			};
		};
		const acceptAgentMessagePrompt = vi.fn(
			(message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return Promise.resolve(message);
			},
		);
		subagentState.runtime = {
			...subagentState.runtime,
			cwd: "/tmp",
			metadata: {
				...subagentState.runtime.metadata,
				rlmChildId: "child-1",
			},
			session: {
				sessionId: "session-child",
				sessionName: defaultSubagentName,
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageController(
				getCurrentState: () => ActiveSessionState | undefined,
			): AgentSessionMessageController;
		};
		internals.sessions.set(parentState.activeSessionId, parentState);
		// A successfully completed RLM child remains idle in this daemon registry.
		internals.sessions.set(subagentState.activeSessionId, subagentState);

		const controller = internals.createAgentMessageController(() => parentState);
		const subagentSummary = controller
			.listAgents()
			.agents.find((agent) => agent.activeSessionId === subagentState.activeSessionId);
		expect(subagentSummary).toMatchObject({
			sessionName: defaultSubagentName,
			runtimeKind: "subagent",
			parentActiveSessionId: parentState.activeSessionId,
			rlmChildId: "child-1",
		});
		if (!subagentSummary?.sessionName) {
			throw new Error("Missing default subagent session name");
		}

		await expect(
			controller.sendAgentMessage({
				target: subagentSummary.sessionName,
				message: "report current progress",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "delivered",
			target: { activeSessionId: subagentState.activeSessionId, runtimeKind: "subagent" },
		});
		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[0]).toContain(`To: ${defaultSubagentName}, active child`);
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[0]).toContain("report current progress");
	});

	it("keeps RLM heartbeats active when a successful subagent is retained", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-retained-heartbeat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}
			const childSessionDir = join(parentArtifactDir, "child-1");
			const childManager = SessionManager.create(tempDir, childSessionDir);
			childManager.newSession({ parentSession: parentSessionFile });
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}

			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const parentState = makeState("parent");
			const parentSession = makeRuntimeSession(parentManager);
			parentState.runtime = {
				...parentState.runtime,
				metadata: { kind: "top-level", createdAt: 1 },
				session: parentSession,
			} as unknown as ActiveSessionState["runtime"];
			const childState = makeState("child", parentState.activeSessionId);
			childState.extensionUiRequests = new Map();
			const childSession = makeRuntimeSession(childManager);
			const promptHeartbeat = vi.fn(
				async (_job: AgentCronJob, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
					options?.preflightResult?.(true);
				},
			);
			Object.assign(childSession, {
				isStreaming: false,
				isCompacting: false,
				isRetrying: false,
				isBashRunning: false,
				hasAcceptedPromptInFlight: false,
				pendingMessageCount: 0,
				promptHeartbeat,
				model: { provider: "current-provider", id: "current-model" },
			});
			childState.runtime = {
				...childState.runtime,
				metadata: {
					kind: "subagent",
					createdAt: 2,
					parentActiveSessionId: parentState.activeSessionId,
					parentSessionId: parentSession.sessionId,
					parentSessionFile,
					rlmChildId: "child-1",
					rlmParentNodeId: "child-1",
					sessionDir: childSessionDir,
				},
				cwd: tempDir,
				session: childSession,
				dispose: vi.fn(async () => {}),
			} as unknown as ActiveSessionState["runtime"];
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				cronScheduler: { runDue(now: Date): Promise<number> };
				sessions: Map<string, ActiveSessionState>;
				findRuntimeState: ReturnType<typeof vi.fn>;
				closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void>;
				createSubagentRuntimeHost(parent: ActiveSessionState): {
					releaseRlmSubagentRuntime(
						runtime: ActiveSessionState["runtime"],
						options: CreateRlmSubagentRuntimeOptions,
						status: "done" | "error" | "cancelled",
					): Promise<void>;
				};
			};
			internals.findRuntimeState = vi.fn(() => childState);
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: childState.activeSessionId,
				sessionId: childSession.sessionId,
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			const releaseOptions = {
				parentSession,
				id: "child-1",
				prompt: "initialize a heartbeat",
				sessionName: "heartbeat-child",
				sessionDir: childSessionDir,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmParentNodeId: "child-1",
				model: { provider: "spawn-provider", id: "spawn-model" },
			} as unknown as CreateRlmSubagentRuntimeOptions;

			internals.sessions.set(childState.activeSessionId, childState);
			await internals
				.createSubagentRuntimeHost(parentState)
				.releaseRlmSubagentRuntime(childState.runtime, releaseOptions, "done");

			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 0,
			});
			expect(parentSession.retainFinishedRlmChildSession).toHaveBeenCalledWith("child-1", childSession);
			const registryLines = readFileSync(join(parentArtifactDir, "rlm-subagents.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { model?: { provider: string; modelId: string } });
			expect(registryLines.at(-1)?.model).toEqual({ provider: "current-provider", modelId: "current-model" });
			const dueRuns = await internals.cronScheduler.runDue(new Date("2026-07-16T00:00:00.000Z"));
			expect(dueRuns).toBe(1);
			expect(promptHeartbeat).toHaveBeenCalledOnce();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 1,
			});

			await internals.closeSession(childState, "shutdown");
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("defers RLM heartbeats while a subagent is binding", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-binding-heartbeat-"));
		let releaseChildBinding: (() => void) | undefined;
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentSessionFile = parentManager.getSessionFile();
			if (!parentSessionFile) {
				throw new Error("Missing parent session file");
			}
			const childSessionDir = join(parentManager.getSessionArtifactDir() ?? tempDir, "child-1");
			let markChildBindingStarted: (() => void) | undefined;
			const childBindingStarted = new Promise<void>((resolve) => {
				markChildBindingStarted = resolve;
			});
			const childBindingGate = new Promise<void>((resolve) => {
				releaseChildBinding = resolve;
			});
			const promptHeartbeat = vi.fn(
				async (_job: AgentCronJob, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
					options?.preflightResult?.(true);
				},
			);
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				Object.assign(session, {
					isStreaming: false,
					isCompacting: false,
					isRetrying: false,
					isBashRunning: false,
					hasAcceptedPromptInFlight: false,
					pendingMessageCount: 0,
					promptHeartbeat,
				});
				if (options.sessionOptions?.rlmSessionDir === childSessionDir) {
					session.bindExtensions = vi.fn(async () => {
						markChildBindingStarted?.();
						await childBindingGate;
					});
				}
				return {
					session,
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				cronScheduler: { runDue(now: Date): Promise<number> };
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<ActiveSessionState["runtime"]>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentSessionFile });
			const childRuntimePromise = internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "initialize a heartbeat",
				sessionName: "heartbeat-child",
				sessionDir: childSessionDir,
				model: {} as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmParentNodeId: "child-1",
			});
			await childBindingStarted;
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === "child-1",
			);
			const childSessionFile = childState?.runtime.session.sessionFile;
			if (!childState || !childSessionFile) {
				throw new Error("Missing binding child session");
			}
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: childState.activeSessionId,
				sessionId: childState.runtime.session.sessionId,
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			expect(await internals.cronScheduler.runDue(new Date("2026-07-16T00:00:00.000Z"))).toBe(0);
			expect(promptHeartbeat).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 0,
			});

			if (!releaseChildBinding) {
				throw new Error("Missing child binding release");
			}
			releaseChildBinding();
			releaseChildBinding = undefined;
			await childRuntimePromise;
			expect(await internals.cronScheduler.runDue(new Date("2027-01-01T00:00:00.000Z"))).toBe(1);
			expect(promptHeartbeat).toHaveBeenCalledOnce();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 1,
			});
		} finally {
			releaseChildBinding?.();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("closes the exact parent-scoped daemon runtime when a retained subagent is deleted", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const parentState = makeState("parent");
		parentState.runtime = {
			...parentState.runtime,
			session: {
				sessionManager: { getSessionArtifactDir: () => undefined },
			},
		} as ActiveSessionState["runtime"];
		const childState = makeState("child", parentState.activeSessionId);
		const foreignChildState = makeState("foreign-child", "other-parent");
		const childSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		const foreignSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		childState.runtime = {
			...childState.runtime,
			metadata: { ...childState.runtime.metadata, rlmChildId: "child-1" },
			session: childSession,
		} as ActiveSessionState["runtime"];
		foreignChildState.runtime = {
			...foreignChildState.runtime,
			metadata: { ...foreignChildState.runtime.metadata, rlmChildId: "child-1" },
			session: foreignSession,
		} as ActiveSessionState["runtime"];
		const closeSession = vi.fn(async () => {});
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			closeSession: typeof closeSession;
			createSubagentRuntimeHost(parent: ActiveSessionState): {
				deleteRlmSubagentRuntime(childId: string, session: ActiveSessionState["runtime"]["session"]): Promise<void>;
			};
		};
		internals.sessions.set(childState.activeSessionId, childState);
		internals.sessions.set(foreignChildState.activeSessionId, foreignChildState);
		internals.closeSession = closeSession;

		const staleParentReference = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		const host = internals.createSubagentRuntimeHost(parentState);
		await host.deleteRlmSubagentRuntime("child-1", staleParentReference);

		expect(closeSession).toHaveBeenCalledOnce();
		expect(closeSession).toHaveBeenCalledWith(childState, "killed", false);
		expect(closeSession).not.toHaveBeenCalledWith(foreignChildState, expect.anything());
		expect(childSession.disposeAsync).not.toHaveBeenCalled();
		expect(staleParentReference.disposeAsync).toHaveBeenCalledOnce();

		const missingSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		await host.deleteRlmSubagentRuntime("missing-child", missingSession);
		expect(missingSession.disposeAsync).toHaveBeenCalledOnce();
	});

	it("keeps a child live when its durable deletion boundary cannot be read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-registry-failure-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentArtifactDir) {
				throw new Error("Missing parent artifact directory");
			}
			mkdirSync(join(parentArtifactDir, "rlm-subagents.jsonl"), { recursive: true });

			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const parentState = makeState("parent");
			parentState.runtime = {
				...parentState.runtime,
				session: makeRuntimeSession(parentManager),
			} as ActiveSessionState["runtime"];
			const childState = makeState("child", parentState.activeSessionId);
			childState.runtime = {
				...childState.runtime,
				metadata: { ...childState.runtime.metadata, rlmChildId: "child-1" },
				session: { disposeAsync: vi.fn(async () => {}) },
			} as unknown as ActiveSessionState["runtime"];
			const closeSession = vi.fn(async () => {});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				closeSession: typeof closeSession;
				createSubagentRuntimeHost(parent: ActiveSessionState): {
					deleteRlmSubagentRuntime(
						childId: string,
						session: ActiveSessionState["runtime"]["session"],
					): Promise<void>;
				};
			};
			internals.sessions.set(childState.activeSessionId, childState);
			internals.closeSession = closeSession;

			await expect(
				internals
					.createSubagentRuntimeHost(parentState)
					.deleteRlmSubagentRuntime("child-1", childState.runtime.session),
			).rejects.toThrow();
			expect(closeSession).not.toHaveBeenCalled();
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("hides daemon sessions from messaging and observation while they are closing", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const parentState = makeState("parent");
		const childState = makeState("child", parentState.activeSessionId);
		const sessionPrompt = vi.fn(async () => {});
		for (const [state, sessionId] of [
			[parentState, "session-parent"],
			[childState, "session-child"],
		] as const) {
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				session: {
					sessionId,
					sessionName: sessionId,
					prompt: sessionPrompt,
					isStreaming: false,
					pendingMessageCount: 0,
				},
			} as unknown as ActiveSessionState["runtime"];
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			closingSessions: Map<string, Promise<void>>;
			createAgentMessageController(
				getCurrentState: () => ActiveSessionState | undefined,
			): AgentSessionMessageController;
			getBoundSessionState(id: string): ActiveSessionState;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			agentMessageTargetLocks: Map<string, Promise<void>>;
			promptWithAgentMessagePreparingGuard(state: ActiveSessionState, message: string): Promise<boolean>;
		};
		internals.sessions.set(parentState.activeSessionId, parentState);
		internals.sessions.set(childState.activeSessionId, childState);
		internals.closingSessions.set(childState.activeSessionId, Promise.resolve());

		const controller = internals.createAgentMessageController(() => parentState);
		const listed = controller.listAgents();
		expect(listed.agents).not.toContainEqual(
			expect.objectContaining({ activeSessionId: childState.activeSessionId }),
		);
		expect(() => internals.getBoundSessionState(childState.activeSessionId)).toThrow("is closing");
		await expect(
			controller.sendAgentMessage({ target: childState.activeSessionId, message: "continue" }),
		).rejects.toThrow("is closing");
		const client = makeClient("client-1", childState.activeSessionId);
		for (const command of [
			{ id: "prompt", type: "prompt", activeSessionId: childState.activeSessionId, message: "continue" },
			{ id: "steer", type: "steer", activeSessionId: childState.activeSessionId, message: "continue" },
			{ id: "follow-up", type: "follow_up", activeSessionId: childState.activeSessionId, message: "continue" },
		] as const) {
			await expect(internals.handleCommand(client, command)).rejects.toThrow("is closing");
		}

		internals.closingSessions.delete(childState.activeSessionId);
		let releaseTargetLock: () => void = () => {};
		const targetLock = new Promise<void>((resolve) => {
			releaseTargetLock = resolve;
		});
		internals.agentMessageTargetLocks.set(childState.activeSessionId, targetLock);
		const guardedPrompt = internals.promptWithAgentMessagePreparingGuard(childState, "continue");
		await Promise.resolve();
		internals.closingSessions.set(childState.activeSessionId, Promise.resolve());
		releaseTargetLock();
		await expect(guardedPrompt).rejects.toThrow("closing before prompt delivery");
		expect(sessionPrompt).not.toHaveBeenCalled();
	});

	it("removes a closing daemon session even when runtime disposal fails", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("child");
		const dispose = vi.fn(async () => {
			throw new Error("dispose failed");
		});
		state.runtime = {
			...state.runtime,
			dispose,
			session: {
				sessionId: "session-child",
				sessionFile: undefined,
				abort: vi.fn(() => new Promise<void>(() => {})),
			},
		} as unknown as ActiveSessionState["runtime"];
		state.extensionUiRequests = new Map();
		state.unsubscribe = vi.fn();
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			closingSessions: Map<string, Promise<void>>;
			closeSession(state: ActiveSessionState, reason: "killed", waitForAbort?: boolean): Promise<void>;
			closeChildSessions: ReturnType<typeof vi.fn>;
			isEmptyDraftContent: ReturnType<typeof vi.fn>;
			abortBashForClose: ReturnType<typeof vi.fn>;
			recordWorkerRecoveryState: ReturnType<typeof vi.fn>;
			broadcastToSession: ReturnType<typeof vi.fn>;
			cancelScheduledJobsForSession: ReturnType<typeof vi.fn>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.closeChildSessions = vi.fn(async () => undefined);
		internals.isEmptyDraftContent = vi.fn(() => true);
		internals.abortBashForClose = vi.fn(async () => {});
		internals.recordWorkerRecoveryState = vi.fn();
		internals.broadcastToSession = vi.fn();
		internals.cancelScheduledJobsForSession = vi.fn();

		await expect(internals.closeSession(state, "killed", false)).rejects.toThrow("dispose failed");

		expect(dispose).toHaveBeenCalledOnce();
		expect(internals.sessions.has(state.activeSessionId)).toBe(false);
		expect(internals.closingSessions.has(state.activeSessionId)).toBe(false);
	});

	it("lists and routes agent messages to peers hosted by another worker", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const source = makeState("source");
		source.runtime = {
			...source.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-source",
				sessionName: "Source",
				isStreaming: false,
				pendingMessageCount: 0,
			},
		} as never;
		const remoteSelector = "remote is closing";
		const receipt = {
			id: "agentmsg-remote",
			source: "agent_message",
			target: { activeSessionId: remoteSelector, sessionId: "session-remote" },
			message: "continue remotely",
			deliveryStatus: "delivered",
			deliveredAt: "2026-01-01T00:00:00.000Z",
			deliveryMode: "auto",
		};
		const sendRemoteAgentSessionMessage = vi.fn().mockResolvedValue(receipt);
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			remoteAgentPeers: Map<string, Record<string, unknown>>;
			createAgentMessageListResult(current: ActiveSessionState): { agents: Array<{ activeSessionId: string }> };
			sendRemoteAgentSessionMessage: typeof sendRemoteAgentSessionMessage;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState: ActiveSessionState;
				origin: "agent";
			}): Promise<unknown>;
		};
		internals.sessions.set(source.activeSessionId, source);
		internals.remoteAgentPeers.set(remoteSelector, {
			activeSessionId: remoteSelector,
			sessionId: "session-remote",
			sessionName: "Remote",
			runtimeKind: "top-level",
			cwd: "/tmp/remote",
			isStreaming: false,
			pendingMessageCount: 0,
		});
		internals.sendRemoteAgentSessionMessage = sendRemoteAgentSessionMessage;

		expect(internals.createAgentMessageListResult(source).agents).toContainEqual(
			expect.objectContaining({ activeSessionId: remoteSelector }),
		);
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: remoteSelector,
				message: "continue remotely",
				fromState: source,
				origin: "agent",
			}),
		).resolves.toEqual(receipt);
		expect(sendRemoteAgentSessionMessage).toHaveBeenCalledWith(
			source,
			remoteSelector,
			"continue remotely",
			undefined,
		);
	});

	it("fails unknown local agent-message targets without worker remote retries", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const source = makeState("source");
		source.runtime = {
			...source.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-source",
				sessionName: "Source",
				isStreaming: false,
				pendingMessageCount: 0,
			},
		} as never;
		const sendRemoteAgentSessionMessage = vi.fn();
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendRemoteAgentSessionMessage: typeof sendRemoteAgentSessionMessage;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState: ActiveSessionState;
				origin: "agent";
			}): Promise<unknown>;
		};
		internals.sessions.set(source.activeSessionId, source);
		internals.sendRemoteAgentSessionMessage = sendRemoteAgentSessionMessage;

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: "deleted-child",
				message: "continue",
				fromState: source,
				origin: "agent",
			}),
		).rejects.toThrow("Unknown active session: deleted-child");
		expect(sendRemoteAgentSessionMessage).not.toHaveBeenCalled();
	});

	it("reports queued status when a direct accept races into the queue", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean, didQueue?: boolean) => void }) => {
				options?.preflightResult?.(true, true);
				return Promise.resolve();
			},
		);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
			},
		} as never;
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				deliveryMode?: "auto" | "steer" | "follow_up";
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "please continue",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "queued",
			target: { activeSessionId: targetState.activeSessionId },
		});
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[1]).toMatchObject({ streamingBehavior: "steer" });

		acceptAgentMessagePrompt.mockClear();
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "please continue later",
				fromState,
				deliveryMode: "follow_up",
				origin: "agent",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "queued",
			target: { activeSessionId: targetState.activeSessionId },
		});
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[1]).toMatchObject({ streamingBehavior: "followUp" });
	});

	it("rate limits agent messages per sender and target pair", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetA = makeState("target-a");
		const targetB = makeState("target-b");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		for (const targetState of [targetA, targetB]) {
			targetState.runtime = {
				...targetState.runtime,
				cwd: "/tmp",
				session: {
					sessionId: `session-${targetState.activeSessionId}`,
					sessionName: targetState.activeSessionId,
					isStreaming: false,
					pendingMessageCount: 0,
					prompt: vi.fn(async () => {}),
					followUp: vi.fn(async () => true),
					clearQueue: vi.fn(() => ({ cleared: 0 })),
					clearQueuedUserMessagesMatching: vi.fn(() => ({ steering: [], followUp: [] })),
				},
			} as never;
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetA.activeSessionId, targetA);
		internals.sessions.set(targetB.activeSessionId, targetB);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.sendAgentSessionMessage({
					targetSelector: targetA.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				}),
			).resolves.toMatchObject({ target: { activeSessionId: targetA.activeSessionId } });
		}
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetA.activeSessionId,
				message: "over limit",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent messaging rate limit exceeded");
		await internals.handleCommand(makeClient("client-1", targetA.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetA.activeSessionId,
		});
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetA.activeSessionId,
				message: "after clear",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetA.activeSessionId } });
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetB.activeSessionId,
				message: "different target",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetB.activeSessionId } });
	});

	it("clears only queued agent-message prompts", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		const agentMessageText =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_test\n\nhello";
		const clearQueuedUserMessagesMatching = vi.fn((predicate: (text: string) => boolean) => ({
			steering: [agentMessageText].filter(predicate),
			followUp: [],
		}));
		const clearQueue = vi.fn(() => ({ steering: ["user prompt"], followUp: ["heartbeat"] }));
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 2,
				clearQueuedUserMessagesMatching,
				clearQueue,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		await internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});

		expect(clearQueuedUserMessagesMatching).toHaveBeenCalledOnce();
		const predicate = clearQueuedUserMessagesMatching.mock.calls[0]?.[0];
		expect(predicate?.(agentMessageText)).toBe(true);
		expect(predicate?.("ordinary queued follow-up")).toBe(false);
		expect(clearQueue).not.toHaveBeenCalled();
	});

	it("pause clears queued agent-message prompts from all sessions", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const firstState = makeState("target-1");
		const secondState = makeState("target-2");
		const firstClear = vi.fn(() => ({ steering: [], followUp: ["agent message"] }));
		const secondClear = vi.fn(() => ({ steering: ["agent message"], followUp: [] }));
		for (const [state, clearQueuedUserMessagesMatching] of [
			[firstState, firstClear],
			[secondState, secondClear],
		] as const) {
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				session: {
					sessionId: `session-${state.activeSessionId}`,
					sessionName: state.activeSessionId,
					isStreaming: false,
					pendingMessageCount: 1,
					clearQueuedUserMessagesMatching,
				},
			} as never;
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			agentMessageRateLimiter: { clear: () => void };
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.agentMessageRateLimiter.clear = vi.fn();
		internals.sessions.set(firstState.activeSessionId, firstState);
		internals.sessions.set(secondState.activeSessionId, secondState);

		await internals.handleCommand(makeClient("client-1", firstState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});

		expect(internals.agentMessageRateLimiter.clear).toHaveBeenCalledOnce();
		expect(firstClear).toHaveBeenCalledOnce();
		expect(secondClear).toHaveBeenCalledOnce();
	});

	it("pause clears queued agent messages concurrently across sessions", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const blockedState = makeState("blocked");
		const readyState = makeState("ready");
		let resolveBlockedClear: () => void = () => {};
		const blockedClear = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const readyClear = vi.fn(() => ({ steering: [], followUp: ["agent message"] }));
		for (const [state, clearQueuedUserMessagesMatching] of [
			[blockedState, blockedClear],
			[readyState, readyClear],
		] as const) {
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				session: {
					sessionId: `session-${state.activeSessionId}`,
					sessionName: state.activeSessionId,
					isStreaming: false,
					pendingMessageCount: 1,
					clearQueuedUserMessagesMatching,
				},
			} as never;
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(blockedState.activeSessionId, blockedState);
		internals.sessions.set(readyState.activeSessionId, readyState);

		const pause = internals.handleCommand(makeClient("client-1", blockedState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(blockedClear).toHaveBeenCalledOnce();
		expect(readyClear).toHaveBeenCalledOnce();
		resolveBlockedClear();
		await pause;
	});

	it("refunds agent message rate limit tokens when delivery fails", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt: vi.fn(async () => {
					throw new Error("missing model");
				}),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.sendAgentSessionMessage({
					targetSelector: targetState.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				}),
			).rejects.toThrow("missing model");
		}
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "after failed sends",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("missing model");
	});

	it("counts concurrent agent message queue reservations against the target queue cap", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		let rejectQueuedMessage: (error: Error) => void = () => {};
		const queueAgentMessagePrompt = vi.fn(
			(_message: string, _streamingBehavior: "steer" | "followUp") =>
				new Promise<boolean>((_resolve, reject) => {
					rejectQueuedMessage = reject;
				}),
		);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: true,
				pendingMessageCount: 19,
				clearQueue: vi.fn(() => ({ cleared: 0 })),
				clearQueuedUserMessagesMatching: vi.fn(() => ({ steering: [], followUp: [] })),
				queueAgentMessagePrompt,
				prompt: vi.fn(async () => {}),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "second",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Target session has too many pending messages");

		rejectQueuedMessage(new Error("release reservation"));
		await expect(first).rejects.toThrow("release reservation");
		await clear;
	});

	it("releases queue reservations once messages are queued so concurrent senders do not halve capacity", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let pending = 0;
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => {
			pending += 1;
			return true;
		});
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: true,
				get pendingMessageCount() {
					return pending;
				},
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);
		// Distinct senders so the per-sender rate limit stays out of the way.
		const senders = Array.from({ length: 12 }, (_, i) => {
			const fromState = makeState(`source-${i}`);
			fromState.runtime = {
				...fromState.runtime,
				session: { sessionId: `session-source-${i}`, sessionName: `Source ${i}` },
			} as never;
			internals.sessions.set(fromState.activeSessionId, fromState);
			return fromState;
		});

		const errors: unknown[] = [];
		for (const [i, fromState] of senders.entries()) {
			void internals
				.sendAgentSessionMessage({
					targetSelector: targetState.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				})
				.catch((error) => {
					errors.push(error);
				});
		}
		for (let attempt = 0; attempt < 200 && queueAgentMessagePrompt.mock.calls.length < 12; attempt++) {
			await Promise.resolve();
		}

		// With reservations held past queue time, 12 concurrent senders would
		// count as 24 against the 20-slot cap and the tail would reject.
		expect(errors).toEqual([]);
		expect(queueAgentMessagePrompt).toHaveBeenCalledTimes(12);
	});

	it("resolves queued sends immediately with a queued receipt while the target is streaming", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		// A real streaming session only resolves this once its turn progresses;
		// the send must not depend on it.
		const waitForAgentMessagePromptDelivery = vi.fn(() => new Promise<void>(() => {}));
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: true,
				pendingMessageCount: 0,
				queueAgentMessagePrompt,
				waitForAgentMessagePromptDelivery,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued while streaming",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "queued",
			target: { activeSessionId: targetState.activeSessionId },
		});
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(waitForAgentMessagePromptDelivery).not.toHaveBeenCalled();
	});

	it("resolves mutual sends between two busy sessions without deadlocking", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const makeBusyState = (name: string) => {
			const state = makeState(name);
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				session: {
					sessionId: `session-${name}`,
					sessionName: name,
					isStreaming: true,
					pendingMessageCount: 0,
					queueAgentMessagePrompt: vi.fn(async () => true),
					// Neither turn ends while both sessions block inside their own send.
					waitForAgentMessagePromptDelivery: vi.fn(() => new Promise<void>(() => {})),
				},
			} as never;
			return state;
		};
		const stateA = makeBusyState("alpha");
		const stateB = makeBusyState("beta");
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(stateA.activeSessionId, stateA);
		internals.sessions.set(stateB.activeSessionId, stateB);

		const [aToB, bToA] = await Promise.all([
			internals.sendAgentSessionMessage({
				targetSelector: stateB.activeSessionId,
				message: "alpha to beta",
				fromState: stateA,
				origin: "agent",
			}),
			internals.sendAgentSessionMessage({
				targetSelector: stateA.activeSessionId,
				message: "beta to alpha",
				fromState: stateB,
				origin: "agent",
			}),
		]);

		expect(aToB).toMatchObject({ deliveryStatus: "queued", target: { activeSessionId: stateB.activeSessionId } });
		expect(bToA).toMatchObject({ deliveryStatus: "queued", target: { activeSessionId: stateA.activeSessionId } });
	});

	it("counts accepted in-flight agent messages against the target queue cap", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 19,
				hasAcceptedPromptInFlight: true,
				acceptAgentMessagePrompt,
				queueAgentMessagePrompt: vi.fn(async () => true),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "over cap",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Target session has too many pending messages");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("reports accepted in-flight agent messages in agent-message lists", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 2,
				hasAcceptedPromptInFlight: true,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageListResult(current: ActiveSessionState): { agents: Array<{ pendingMessageCount: number }> };
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		expect(internals.createAgentMessageListResult(targetState).agents[0]?.pendingMessageCount).toBe(3);
	});

	it("reports non-streaming busy sessions as active in agent-observe summaries", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			diagnostics: [],
			modelFallbackMessage: undefined,
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				sessionFile: undefined,
				sessionManager: { getCwd: () => "/tmp" },
				model: undefined,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				isRetrying: false,
				hasAcceptedPromptInFlight: false,
				pendingMessageCount: 1,
				messages: [],
				state: { pendingToolCalls: new Set(), streamingMessage: undefined },
				hasRunningRlmChildren: () => false,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentObserveListResult(current: ActiveSessionState): { current: { status: string } };
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		expect(internals.createAgentObserveListResult(targetState).current.status).toBe("busy");

		(targetState.runtime.session as { isCompacting: boolean; pendingMessageCount: number }).isCompacting = true;
		(targetState.runtime.session as { isCompacting: boolean; pendingMessageCount: number }).pendingMessageCount = 0;

		expect(internals.createAgentObserveListResult(targetState).current.status).toBe("compacting");
	});

	it("serializes concurrent agent messages to an idle target", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const promptResolves: Array<() => void> = [];
		const prompt = vi.fn(
			(_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) =>
				new Promise<void>((resolve) => {
					promptResolves.push(resolve);
				}),
		);
		const followUp = vi.fn(async () => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt,
				followUp,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		const second = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "second",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(1);

		promptResolves[0]?.();
		await expect(first).resolves.toMatchObject({ message: "first" });
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(followUp).not.toHaveBeenCalled();
		promptResolves[1]?.();
		await expect(second).resolves.toMatchObject({ message: "second" });
	});

	it("queues agent messages behind an idle target with a pending retry", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const prompt = vi.fn(async (_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => {});
		const followUp = vi.fn(async () => true);
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				isRetrying: true,
				pendingMessageCount: 0,
				prompt,
				followUp,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind retry",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(followUp).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("queues agent messages behind existing pending work on an idle target", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const prompt = vi.fn(async (_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => {});
		const followUp = vi.fn(async () => true);
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 1,
				prompt,
				followUp,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind existing work",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(followUp).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("queues agent messages while the target is compacting", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const prompt = vi.fn(async (_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				isCompacting: true,
				pendingMessageCount: 0,
				prompt,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind compaction",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("queues agent messages while target bash is running", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				isBashRunning: true,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued behind bash",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("acknowledges queued agent messages after queue insertion", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		let resolveQueuedDelivery: () => void = () => {};
		const waitForAgentMessagePromptDelivery = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveQueuedDelivery = resolve;
				}),
		);
		const queueAgentMessagePrompt = vi.fn(async () => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: true,
				pendingMessageCount: 0,
				queueAgentMessagePrompt,
				waitForAgentMessagePromptDelivery,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "queued",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetState.activeSessionId } });

		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(waitForAgentMessagePromptDelivery).not.toHaveBeenCalled();
		resolveQueuedDelivery();
	});

	it("recomputes agent message streaming behavior after waiting for the target lock", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const promptResolves: Array<() => void> = [];
		const prompt = vi.fn(
			(_message: string, _options?: { streamingBehavior?: "steer" | "followUp" }) =>
				new Promise<void>((resolve) => {
					promptResolves.push(resolve);
				}),
		);
		const followUp = vi.fn(async () => true);
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt,
				followUp,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		const second = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "second",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(1);
		(targetState.runtime.session as { isStreaming: boolean }).isStreaming = true;
		promptResolves[0]?.();
		await expect(first).resolves.toMatchObject({ message: "first" });
		await Promise.resolve();
		await Promise.resolve();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		expect(followUp).not.toHaveBeenCalled();
		await expect(second).resolves.toMatchObject({ message: "second" });
	});

	it("rejects agent messages when queued delivery is coalesced", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const queueAgentMessagePrompt = vi.fn(async () => false);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: true,
				pendingMessageCount: 1,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "coalesced",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent message was not queued");
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
	});

	it("rejects agent messages when direct delivery preflight fails", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(false);
				return Promise.resolve();
			},
		);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "not accepted",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent message was not accepted");
	});

	it("queues agent messages while daemon prompts prepare to stream", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let resolvePrompt: () => void = () => {};
		let reportPreflight: ((didSucceed: boolean) => void) | undefined;
		const prompt = vi.fn((_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			reportPreflight = options?.preflightResult;
			return new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		});
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt,
				acceptAgentMessagePrompt,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown> | undefined;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);
		const promptClient = makeClient("client-1", targetState.activeSessionId);
		(promptClient.socket as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn();

		internals.handleCommand(promptClient, {
			id: "command-1",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "normal prompt",
		});
		await Promise.resolve();
		await Promise.resolve();
		reportPreflight?.(true);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});
		await Promise.resolve();
		await send;
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		resolvePrompt();
	});

	it("waits for an in-flight agent-message accept before starting daemon prompts", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let resolveAccept: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return new Promise<void>((resolve) => {
					resolveAccept = resolve;
				});
			},
		);
		const prompt = vi.fn(async (_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			options?.preflightResult?.(true);
		});
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt,
				acceptAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown> | undefined;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();

		const promptClient = makeClient("client-1", targetState.activeSessionId);
		(promptClient.socket as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn();
		internals.handleCommand(promptClient, {
			id: "command-1",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "normal prompt",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();

		resolveAccept();
		await send;
		for (let attempt = 0; attempt < 10 && prompt.mock.calls.length === 0; attempt++) {
			await Promise.resolve();
		}

		expect(prompt).toHaveBeenCalledOnce();
	});

	it("queues agent messages while a cron prompt prepares to stream", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let resolvePrompt: () => void = () => {};
		const prompt = vi.fn(
			(_message: string, _options?: unknown) =>
				new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				isBashRunning: false,
				pendingMessageCount: 0,
				prompt,
				acceptAgentMessagePrompt,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const cronRun = internals.runCronJob(
			makeCronJob({ id: "cron-1", source: "cron", activeSessionId: targetState.activeSessionId }),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(prompt).toHaveBeenCalledOnce();

		await internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});

		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(queueAgentMessagePrompt.mock.calls[0]?.[1]).toBe("steer");
		resolvePrompt();
		await cronRun;
	});

	it("keeps the preparing state until every concurrent prompt settles", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		const promptResolves: Array<() => void> = [];
		const prompt = vi.fn(
			(_message: string, _options?: unknown) =>
				new Promise<void>((resolve) => {
					promptResolves.push(resolve);
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const queueAgentMessagePrompt = vi.fn(async (_message: string, _streamingBehavior: "steer" | "followUp") => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt,
				acceptAgentMessagePrompt,
				queueAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown> | undefined;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);
		const promptClient = makeClient("client-1", targetState.activeSessionId);
		(promptClient.socket as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn();

		internals.handleCommand(promptClient, {
			id: "command-1",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "first prompt",
		});
		internals.handleCommand(promptClient, {
			id: "command-2",
			type: "prompt",
			activeSessionId: targetState.activeSessionId,
			message: "second prompt",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(prompt).toHaveBeenCalledTimes(2);

		// The first prompt settles; the second is still in preflight, so agent
		// messages must keep queueing (a plain Set would have lost the flag here).
		promptResolves[0]?.();
		await Promise.resolve();
		await Promise.resolve();

		await internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "agent message",
			origin: "agent",
		});

		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(queueAgentMessagePrompt).toHaveBeenCalledOnce();
		promptResolves[1]?.();
	});

	it("re-checks agent message queue capacity after waiting for the target lock", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		let resolveFirstPrompt: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveFirstPrompt = resolve;
				}),
		);
		const followUp = vi.fn(async () => true);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
				followUp,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		const first = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			fromState,
			origin: "agent",
		});
		const second = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "second",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();
		(targetState.runtime.session as { pendingMessageCount: number }).pendingMessageCount = 20;

		resolveFirstPrompt();
		await expect(first).resolves.toMatchObject({ message: "first" });
		await expect(second).rejects.toThrow("Target session has too many pending messages");
		expect(followUp).not.toHaveBeenCalled();
	});

	it("rate limits CLI agent messages by stable daemon identity", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt: vi.fn(async () => {}),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.handleCommand(makeClient(`client-${i}`, targetState.activeSessionId), {
					id: `command-${i}`,
					type: "send_message",
					targetActiveSessionId: targetState.activeSessionId,
					message: `message ${i}`,
				}),
			).resolves.toMatchObject({ success: true });
		}
		await expect(
			internals.handleCommand(makeClient("client-4", targetState.activeSessionId), {
				id: "command-4",
				type: "send_message",
				targetActiveSessionId: targetState.activeSessionId,
				message: "over limit",
			}),
		).rejects.toThrow("Agent messaging rate limit exceeded");
	});

	it("holds the target lock while clearing queued agent messages", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let resolvePrompt: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			},
		);
		const clearQueuedUserMessagesMatching = vi.fn(() => ({ steering: [], followUp: [] }));
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
				clearQueuedUserMessagesMatching,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "first",
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();
		expect(clearQueuedUserMessagesMatching).not.toHaveBeenCalled();

		resolvePrompt();
		await send;
		await clear;
		expect(clearQueuedUserMessagesMatching).toHaveBeenCalledOnce();
	});

	it("rejects agent messages when pause wins the target lock", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let resolveBlockedClear: () => void = () => {};
		const clearQueuedUserMessagesMatching = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
				clearQueuedUserMessagesMatching,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const pause = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});
		await Promise.resolve();
		await Promise.resolve();

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "after pause requested",
			origin: "agent",
		});
		await Promise.resolve();
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();

		resolveBlockedClear();
		await pause;
		await expect(send).rejects.toThrow("Agent messaging is paused");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("rejects agent messages when the target session changes before delivery", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let resolveBlockedClear: () => void = () => {};
		const clearQueuedUserMessagesMatching = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				acceptAgentMessagePrompt,
				clearQueuedUserMessagesMatching,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();
		await Promise.resolve();

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "after session switch",
			origin: "agent",
		});
		await Promise.resolve();
		(targetState.runtime.session as { sessionId: string }).sessionId = "session-replacement";
		resolveBlockedClear();
		await clear;

		await expect(send).rejects.toThrow("Target session changed before agent message delivery");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("rejects agent messages when the target session closes before delivery", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		targetState.extensionUiRequests = new Map();
		let resolveBlockedClear: () => void = () => {};
		const clearQueuedUserMessagesMatching = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const acceptAgentMessagePrompt = vi.fn(async () => {});
		const dispose = vi.fn(async () => {});
		targetState.runtime = {
			...targetState.runtime,
			dispose,
			cwd: "/tmp",
			metadata: { kind: "subagent", createdAt: 1 },
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				pendingMessageCount: 0,
				messages: [],
				acceptAgentMessagePrompt,
				clearQueuedUserMessagesMatching,
				abort: vi.fn(async () => {}),
				dispose: vi.fn(),
				sessionManager: { appendSessionState: vi.fn(), hasUserContent: () => true },
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const clear = internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});
		await Promise.resolve();
		await Promise.resolve();

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "after close requested",
			origin: "agent",
		});
		await Promise.resolve();

		const close = internals.handleCommand(makeClient("client-2", targetState.activeSessionId), {
			id: "command-2",
			type: "kill",
			activeSessionId: targetState.activeSessionId,
		});
		await close;
		expect(dispose).toHaveBeenCalledOnce();

		resolveBlockedClear();
		await clear;
		await expect(send).rejects.toThrow("Target session is closing before agent message delivery");
		expect(acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("rejects agent messages to the sending session", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("self");
		state.runtime = {
			...state.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-self",
				sessionName: "Self",
				isStreaming: false,
				pendingMessageCount: 0,
				prompt: vi.fn(async () => {}),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: state.activeSessionId,
				message: "self",
				fromState: state,
				origin: "agent",
			}),
		).rejects.toThrow("Agent messaging cannot target the sending session");
		expect(state.runtime.session.prompt).not.toHaveBeenCalled();
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

		setDaemonClientSessionCapabilities(uiClient, "active", new Set(["extension_ui"]));
		setDaemonClientSessionCapabilities(uiClient, "other", new Set());
		expect(shouldSendDaemonOutboundToClient(uiClient, dialogRequest)).toBe(true);
		expect(
			shouldSendDaemonOutboundToClient(uiClient, {
				...dialogRequest,
				activeSessionId: "other",
			}),
		).toBe(false);
	});

	it("delivers session closure while a client is snapshotting and backpressured", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("active");
		state.eventGeneration = "generation-1";
		const write = vi.fn((_data: unknown) => false);
		const client = makeClient("client-1", state.activeSessionId);
		client.socket = { destroyed: false, write } as unknown as Socket;
		client.snapshotActiveSessionIds = new Set([state.activeSessionId]);
		client.snapshotStreaming = true;
		client.backpressured = true;
		client.catchupActiveSessionIds = new Set([state.activeSessionId]);
		state.clients.add(client);
		const internals = daemon as unknown as {
			broadcastToSession(
				state: ActiveSessionState,
				message: { type: "session_closed"; activeSessionId: string; reason: "killed" },
			): void;
		};

		internals.broadcastToSession(state, {
			type: "session_closed",
			activeSessionId: state.activeSessionId,
			reason: "killed",
		});

		expect(write).toHaveBeenCalledOnce();
		expect(String(write.mock.calls[0]?.[0])).toContain('"type":"session_closed"');
		expect(client.catchupActiveSessionIds).not.toContain(state.activeSessionId);
	});

	it("catches up on drain only after events are skipped behind a backpressured write", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("active");
		state.eventGeneration = "generation-1";
		const writes: string[] = [];
		const write = vi.fn((data: unknown) => {
			writes.push(String(data));
			return writes.length === 1;
		});
		const socket = Object.assign(new EventEmitter(), { destroyed: false, write }) as unknown as Socket;
		const internals = daemon as unknown as {
			clients: Set<DaemonSocketClient>;
			sessions: Map<string, ActiveSessionState>;
			handleConnection(socket: Socket): void;
			createAttachResult(client: DaemonSocketClient, state: ActiveSessionState): DaemonAttachResult;
			broadcastToSession(
				state: ActiveSessionState,
				message: {
					type: "extension_error";
					activeSessionId: string;
					extensionPath: string;
					event: string;
					error: string;
				},
			): void;
		};
		internals.handleConnection(socket);
		const client = [...internals.clients][0]!;
		client.attachedActiveSessionIds.add(state.activeSessionId);
		state.clients.add(client);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = () =>
			({
				activeSessionId: state.activeSessionId,
				snapshot: { lastEventSequence: state.lastEventSequence },
				lastEventSequence: state.lastEventSequence,
			}) as unknown as DaemonAttachResult;

		internals.broadcastToSession(state, {
			type: "extension_error",
			activeSessionId: state.activeSessionId,
			extensionPath: "x".repeat(1024 * 1024),
			event: "load",
			error: "first",
		});

		expect(client.backpressured).toBe(true);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
		expect(writes).toHaveLength(2);
		expect(writes[1]).toContain('"error":"first"');

		internals.broadcastToSession(state, {
			type: "extension_error",
			activeSessionId: state.activeSessionId,
			extensionPath: "/tmp/extension.ts",
			event: "load",
			error: "skipped",
		});

		expect(writes).toHaveLength(2);
		expect(client.catchupActiveSessionIds).toEqual(new Set([state.activeSessionId]));

		write.mockImplementation((data: unknown) => {
			writes.push(String(data));
			return true;
		});
		socket.emit("drain");
		await vi.waitFor(() => expect(writes).toHaveLength(3));

		expect(JSON.parse(writes[2] ?? "{}")).toMatchObject({
			type: "session_resynced",
			activeSessionId: state.activeSessionId,
			meta: { sequence: 2, cursor: { generation: "generation-1", sequence: 2 } },
			snapshot: { lastEventSequence: 2 },
		});
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it("marks a chunked attach as snapshotting before deferred streaming", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-snapshot-order-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const state = makeState("active");
			state.eventGeneration = "generation-1";
			const client = makeClient("client-1", state.activeSessionId);
			client.transport = "private-framed";
			const result = {
				activeSessionId: state.activeSessionId,
				snapshot: { summary: {}, state: {}, messages: [] },
				lastEventSequence: 0,
			} as unknown as DaemonAttachResult;
			const streamWorkerSnapshot = vi.fn(async () => undefined);
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createAttachResult: () => DaemonAttachResult;
				streamWorkerSnapshot: typeof streamWorkerSnapshot;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			internals.createAttachResult = () => result;
			internals.streamWorkerSnapshot = streamWorkerSnapshot;

			await internals.handleCommand(client, {
				type: "attach",
				activeSessionId: state.activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			});

			expect(client.snapshotActiveSessionIds).toContain(state.activeSessionId);
			expect(client.snapshotStreaming).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(streamWorkerSnapshot).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps overlapping snapshots active until every stream finishes", () => {
		const client = makeClient("client-1", "active");

		markClientSnapshotStreaming(client, "active");
		markClientSnapshotStreaming(client, "active");
		finishClientSnapshotStreaming(client, "active");

		expect(client.snapshotStreaming).toBe(true);
		expect(client.snapshotActiveSessionIds).toContain("active");
		expect(client.snapshotActiveSessionCounts?.get("active")).toBe(1);

		finishClientSnapshotStreaming(client, "active");
		expect(client.snapshotStreaming).toBe(false);
		expect(client.snapshotActiveSessionIds).not.toContain("active");
	});

	it("falls back to a full replacement when snapshot cache creation fails", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-daemon-replacement-fallback-"));
		try {
			const invalidAgentDir = join(root, "not-a-directory");
			writeFileSync(invalidAgentDir, "file");
			const daemon = new AgentDaemon(join(root, "daemon.sock"), {
				defaultSessionConfig: { agentDir: invalidAgentDir, cwd: root },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const state = makeState("active");
			state.eventGeneration = "generation-1";
			const write = vi.fn((_data: unknown) => true);
			const client = makeClient("client-1", state.activeSessionId);
			client.socket = { destroyed: false, write } as unknown as Socket;
			client.transport = "private-framed";
			setDaemonClientSessionCapabilities(client, state.activeSessionId, new Set(["chunked_snapshot"]));
			state.clients.add(client);
			const result = {
				activeSessionId: state.activeSessionId,
				snapshot: {
					summary: {},
					state: {},
					messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 1), timestamp: 0 }],
				},
				lastEventSequence: 0,
			} as unknown as DaemonAttachResult;
			const internals = daemon as unknown as {
				createAttachResult: () => DaemonAttachResult;
				broadcastToSession(state: ActiveSessionState, message: unknown): void;
			};
			internals.createAttachResult = () => result;

			internals.broadcastToSession(state, {
				type: "session_replaced",
				activeSessionId: state.activeSessionId,
				state: {},
				messages: [],
			});

			expect(write).toHaveBeenCalledTimes(2);
			const replacementFrame = String(write.mock.calls[0]?.[0]);
			expect(replacementFrame).toContain('"type":"session_replaced"');
			expect(replacementFrame).toContain('"snapshotFollows":true');
			expect(String(write.mock.calls[1]?.[0])).toContain('"type":"session_snapshot_begin"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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

	it("adopts client env on session reuse only when the session has none", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-env-"));
		try {
			const sessionPath = join(tempDir, "session.jsonl");
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			// Created env-less (e.g. by a cron job), then opened by an env-carrying
			// client: the session adopts the client's allowlisted identity.
			const state = await create({ type: "create", sessionPath });
			expect(state.clientEnv).toBeUndefined();
			const adopted = await create({
				type: "create",
				sessionPath,
				env: { HERDR_PANE_ID: "w1:p1", PATH: "/evil" },
			});
			expect(adopted).toBe(state);
			expect(state.clientEnv).toEqual({ HERDR_PANE_ID: "w1:p1" });

			// A later client with a different env must not rebind the identity
			// that extensions already captured.
			await create({ type: "create", sessionPath, env: { HERDR_PANE_ID: "w2:p9" } });
			expect(state.clientEnv).toEqual({ HERDR_PANE_ID: "w1:p1" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("makes daemon host controllers available during session_start extension binding", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-controller-race-"));
		try {
			let listedAgentsDuringBind = 0;
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.bindExtensions = vi.fn(async () => {
					const result = options.sessionOptions?.agentMessageController?.listAgents();
					expect(result?.current?.activeSessionId).toBeTruthy();
					listedAgentsDuringBind++;
				});
				return {
					session,
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			await create({ type: "create", sessionPath: join(tempDir, "session.jsonl") });

			expect(listedAgentsDuringBind).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("restores a completed subagent through its parent when an RLM heartbeat becomes due", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-restore-subagent-heartbeat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "active" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}

			const childId = "heartbeat-child";
			const childSessionDir = join(parentArtifactDir, childId);
			const childManager = SessionManager.create(tempDir, childSessionDir);
			childManager.newSession({ parentSession: parentSessionFile });
			childManager.appendSessionInfo("heartbeat-child");
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}
			writeFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId,
					sessionName: "heartbeat-child",
					sessionDir: childSessionDir,
					sessionFile: childSessionFile,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 1,
					rlmMaxDepth: 4,
					rlmParentNodeId: childId,
					status: "completed",
					createdAt: 1,
					updatedAt: "2026-01-01T00:00:00.000Z",
				})}\n`,
			);

			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["extensionsResult"],
				services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["services"],
				diagnostics: [],
			}));
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				getOrCreateCronJobSession(job: AgentCronJob, requirePersistedJob: boolean): Promise<ActiveSessionState>;
			};
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childManager.getSessionId(),
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			const childState = await internals.getOrCreateCronJobSession(heartbeat, true);

			expect(childState.runtime.metadata).toMatchObject({
				kind: "subagent",
				rlmChildId: childId,
			});
			expect(createRuntime).toHaveBeenCalledTimes(2);
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				activeSessionId: childState.activeSessionId,
				sessionId: childManager.getSessionId(),
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels a detached subagent heartbeat when its parent is archived", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-archived-subagent-heartbeat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "archived" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}
			const childManager = SessionManager.create(tempDir, join(parentArtifactDir, "child-1"));
			childManager.newSession({ parentSession: parentSessionFile });
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}

			const createRuntime = vi.fn(async () => {
				throw new Error("archived parent must not be restored");
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				getOrCreateCronJobSession(
					job: AgentCronJob,
					requirePersistedJob: boolean,
				): Promise<ActiveSessionState | undefined>;
			};
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childManager.getSessionId(),
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			await expect(internals.getOrCreateCronJobSession(heartbeat, true)).resolves.toBeUndefined();
			expect(createRuntime).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rehydrates completed RLM subagents into the parent registry and durably deletes them", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-rlm-rehydrate-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("Parent");
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}

			const childId = "child-1";
			const childSessionDir = join(parentArtifactDir, childId);
			const childManager = SessionManager.create(tempDir, childSessionDir);
			childManager.newSession({ parentSession: parentSessionFile });
			childManager.appendSessionInfo("spawn-worker");
			childManager.appendSessionInfo("renamed-worker");
			const childSessionFile = childManager.getSessionFile();
			const childArtifactDir = childManager.getSessionArtifactDir();
			if (!childSessionFile || !childArtifactDir) {
				throw new Error("Missing child session paths");
			}
			const grandchildId = "grandchild-1";
			const grandchildSessionDir = join(childArtifactDir, grandchildId);
			const grandchildManager = SessionManager.create(tempDir, grandchildSessionDir);
			grandchildManager.newSession({ parentSession: childSessionFile });
			grandchildManager.appendSessionInfo("nested-worker");
			const grandchildSessionFile = grandchildManager.getSessionFile();
			if (!grandchildSessionFile) {
				throw new Error("Missing grandchild session file");
			}
			writeFileSync(
				join(childArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: grandchildId,
					sessionName: "nested-worker",
					sessionDir: grandchildSessionDir,
					sessionFile: grandchildSessionFile,
					parentSessionId: childManager.getSessionId(),
					parentSessionFile: childSessionFile,
					rlmDepth: 2,
					rlmMaxDepth: 4,
					rlmParentNodeId: grandchildId,
					status: "completed",
					createdAt: 2,
					updatedAt: "2026-01-01T00:00:00.000Z",
				})}\n${JSON.stringify({
					type: "rlm_subagent",
					childId: "cycle-to-root",
					sessionName: "cycle-to-root",
					sessionDir: parentArtifactDir,
					sessionFile: parentSessionFile,
					parentSessionId: childManager.getSessionId(),
					parentSessionFile: childSessionFile,
					rlmDepth: 2,
					rlmMaxDepth: 4,
					rlmParentNodeId: "cycle-to-root",
					status: "completed",
					createdAt: 3,
					updatedAt: "2026-01-01T00:00:00.000Z",
				})}\n`,
			);
			writeFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId,
					sessionName: "spawn-worker",
					sessionDir: childSessionDir,
					sessionFile: childSessionFile,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 1,
					rlmMaxDepth: 4,
					rlmParentNodeId: childId,
					status: "completed",
					createdAt: 1,
					updatedAt: "2026-01-01T00:00:00.000Z",
				})}\n`,
			);

			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): {
					deleteRlmSubagentRuntime(
						childId: string,
						session: ActiveSessionState["runtime"]["session"],
					): Promise<void>;
				};
				rehydrateCompletedRlmSubagents(parent: ActiveSessionState): Promise<void>;
				closeSession(state: ActiveSessionState, reason: "killed", waitForAbort?: boolean): Promise<void>;
			};

			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentSessionFile });
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === childId,
			);
			const grandchildState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === grandchildId,
			);

			expect(createRuntime).toHaveBeenCalledTimes(3);
			expect(createRuntime.mock.calls[1]?.[0].sessionOptions).toMatchObject({
				rlmDepth: 1,
				rlmMaxDepth: 4,
			});
			expect(createRuntime.mock.calls[2]?.[0].sessionOptions).toMatchObject({
				rlmDepth: 2,
				rlmMaxDepth: 4,
			});
			expect(childState?.runtime.session.sessionName).toBe("renamed-worker");
			expect(childState?.runtime.metadata).toMatchObject({
				kind: "subagent",
				parentActiveSessionId: parentState.activeSessionId,
				parentSessionId: parentState.runtime.session.sessionId,
				rlmChildId: childId,
				rlmParentNodeId: childId,
				sessionDir: childSessionDir,
			});
			expect(parentState.runtime.session.retainFinishedRlmChildSession).toHaveBeenCalledWith(
				childId,
				childState?.runtime.session,
			);
			expect(grandchildState?.runtime.metadata).toMatchObject({
				kind: "subagent",
				parentActiveSessionId: childState?.activeSessionId,
				parentSessionId: childState?.runtime.session.sessionId,
				rlmChildId: grandchildId,
			});
			expect(childState?.runtime.session.retainFinishedRlmChildSession).toHaveBeenCalledWith(
				grandchildId,
				grandchildState?.runtime.session,
			);
			expect(
				[...internals.sessions.values()].some((state) => state.runtime.metadata.rlmChildId === "cycle-to-root"),
			).toBe(false);

			if (!childState) {
				throw new Error("Missing rehydrated child state");
			}
			appendFileSync(join(parentArtifactDir, "rlm-subagents.jsonl"), "{unterminated malformed registry line");
			internals.closeSession = vi.fn(async (state: ActiveSessionState) => {
				internals.sessions.delete(state.activeSessionId);
			});
			await internals
				.createSubagentRuntimeHost(parentState)
				.deleteRlmSubagentRuntime(childId, childState.runtime.session);
			expect(internals.sessions.has(childState.activeSessionId)).toBe(false);
			const persistedLines = readFileSync(join(parentArtifactDir, "rlm-subagents.jsonl"), "utf8")
				.trim()
				.split(/\r?\n/);
			const persistedDeletion = JSON.parse(persistedLines.at(-1) ?? "") as { childId: string; status: string };
			expect(persistedDeletion).toMatchObject({ childId, status: "deleted" });

			await internals.rehydrateCompletedRlmSubagents(parentState);
			expect(createRuntime).toHaveBeenCalledTimes(3);
			expect([...internals.sessions.values()].some((state) => state.runtime.metadata.rlmChildId === childId)).toBe(
				false,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("coalesces retained rehydration with successful and failed explicit session opens", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-rehydrate-open-race-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			const parentSessionFile = parentManager.getSessionFile();
			if (!parentArtifactDir || !parentSessionFile) {
				throw new Error("Missing parent session paths");
			}
			const childId = "racing-child";
			const childSessionDir = join(parentArtifactDir, childId);
			const childManager = SessionManager.create(tempDir, childSessionDir);
			childManager.newSession({ parentSession: parentSessionFile });
			childManager.appendSessionInfo("racing-worker");
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}
			mkdirSync(parentArtifactDir, { recursive: true });
			writeFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId,
					sessionName: "racing-worker",
					sessionDir: childSessionDir,
					sessionFile: childSessionFile,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 1,
					rlmMaxDepth: 4,
					rlmParentNodeId: childId,
					status: "completed",
					createdAt: 1,
					updatedAt: "2026-01-01T00:00:00.000Z",
				})}\n`,
			);

			let bindStarted = false;
			let releaseBind: () => void = () => {};
			const bindGate = new Promise<void>((resolve) => {
				releaseBind = resolve;
			});
			let successfulBindStarted = false;
			let releaseSuccessfulBind: () => void = () => {};
			const successfulBindGate = new Promise<void>((resolve) => {
				releaseSuccessfulBind = resolve;
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				const runtimeNumber = createRuntime.mock.calls.length;
				session.bindExtensions = vi.fn(async () => {
					if (runtimeNumber === 1) {
						bindStarted = true;
						await bindGate;
						throw new Error("explicit bind failed");
					}
					if (runtimeNumber === 3) {
						successfulBindStarted = true;
						await successfulBindGate;
					}
				});
				return {
					session,
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				rehydrateCompletedRlmSubagents(parent: ActiveSessionState): Promise<void>;
			};
			const parentState = makeState("parent");
			parentState.runtime = {
				...parentState.runtime,
				metadata: { kind: "top-level", createdAt: 1 },
				runtimeConfig: {},
				services: { cwd: tempDir, agentDir: tempDir },
				session: makeRuntimeSession(parentManager),
			} as unknown as ActiveSessionState["runtime"];
			internals.sessions.set(parentState.activeSessionId, parentState);

			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: childSessionFile });
			const explicitFailure = explicitOpen.catch((error: unknown) => error);
			for (let attempt = 0; attempt < 50 && !bindStarted; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(bindStarted).toBe(true);
			const rehydrate = internals.rehydrateCompletedRlmSubagents(parentState);
			releaseBind();
			const [explicitError] = await Promise.all([explicitFailure, rehydrate]);

			expect(explicitError).toEqual(expect.objectContaining({ message: "explicit bind failed" }));
			expect(createRuntime).toHaveBeenCalledTimes(2);
			expect(
				[...internals.sessions.values()].filter(
					(state) =>
						state.runtime.session.sessionFile &&
						resolve(state.runtime.session.sessionFile) === resolve(childSessionFile),
				),
			).toHaveLength(1);
			const rehydrated = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === childId,
			);
			expect(rehydrated).toBeDefined();
			expect(parentState.runtime.session.retainFinishedRlmChildSession).toHaveBeenCalledWith(
				childId,
				rehydrated?.runtime.session,
			);

			const siblingId = "successful-racing-child";
			const siblingSessionDir = join(parentArtifactDir, siblingId);
			const siblingManager = SessionManager.create(tempDir, siblingSessionDir);
			siblingManager.newSession({ parentSession: parentSessionFile });
			siblingManager.appendSessionInfo("successful-racing-worker");
			const siblingSessionFile = siblingManager.getSessionFile();
			if (!siblingSessionFile) {
				throw new Error("Missing sibling session file");
			}
			const siblingArtifactDir = siblingManager.getSessionArtifactDir();
			if (!siblingArtifactDir) {
				throw new Error("Missing sibling artifact directory");
			}
			mkdirSync(siblingArtifactDir, { recursive: true });
			writeFileSync(
				join(siblingArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: "cycle-to-root",
					sessionName: "cycle-to-root",
					sessionDir,
					sessionFile: parentSessionFile,
					parentSessionId: siblingManager.getSessionId(),
					parentSessionFile: siblingSessionFile,
					rlmDepth: 0,
					rlmMaxDepth: 4,
					rlmParentNodeId: "cycle-to-root",
					status: "completed",
					createdAt: 2,
					updatedAt: "2026-01-01T00:00:01.000Z",
				})}\n`,
			);
			appendFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: siblingId,
					sessionName: "successful-racing-worker",
					sessionDir: siblingSessionDir,
					sessionFile: siblingSessionFile,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 1,
					rlmMaxDepth: 4,
					rlmParentNodeId: siblingId,
					status: "completed",
					createdAt: 2,
					updatedAt: "2026-01-01T00:00:01.000Z",
				})}\n`,
			);
			const successfulExplicitOpen = internals.createRuntime({
				type: "create",
				sessionPath: siblingSessionFile,
			});
			for (let attempt = 0; attempt < 50 && !successfulBindStarted; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(successfulBindStarted).toBe(true);
			const successfulRehydrate = internals.rehydrateCompletedRlmSubagents(parentState);
			releaseSuccessfulBind();
			const [successfulState] = await Promise.all([successfulExplicitOpen, successfulRehydrate]);

			expect(createRuntime).toHaveBeenCalledTimes(4);
			expect(createRuntime.mock.calls[3]?.[0].sessionOptions).toEqual(
				expect.objectContaining({
					rlmSessionDir: siblingSessionDir,
					rlmDepth: 1,
					rlmMaxDepth: 4,
					rlmParentNodeId: siblingId,
				}),
			);
			expect(successfulState.runtime.metadata).toEqual(
				expect.objectContaining({
					kind: "subagent",
					parentActiveSessionId: parentState.activeSessionId,
					rlmChildId: siblingId,
				}),
			);
			expect(internals.sessions.has(successfulState.activeSessionId)).toBe(true);
			expect(parentState.runtime.session.retainFinishedRlmChildSession).toHaveBeenCalledWith(
				siblingId,
				successfulState.runtime.session,
			);
			expect(successfulState.runtime.session.retainFinishedRlmChildSession).not.toHaveBeenCalledWith(
				"cycle-to-root",
				expect.anything(),
			);
			expect(internals.sessions.get(parentState.activeSessionId)).toBe(parentState);
			expect(
				[...internals.sessions.values()].filter(
					(state) =>
						state.runtime.session.sessionFile &&
						resolve(state.runtime.session.sessionFile) === resolve(siblingSessionFile),
				),
			).toHaveLength(1);

			const stableId = "stable-explicit-child";
			const stableSessionDir = join(parentArtifactDir, stableId);
			const stableManager = SessionManager.create(tempDir, stableSessionDir);
			stableManager.newSession({ parentSession: parentSessionFile });
			stableManager.appendSessionInfo("stable-explicit-worker");
			const stableSessionFile = stableManager.getSessionFile();
			if (!stableSessionFile) {
				throw new Error("Missing stable explicit session file");
			}
			appendFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: stableId,
					sessionName: "stable-explicit-worker",
					sessionDir: stableSessionDir,
					sessionFile: stableSessionFile,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile,
					rlmDepth: 2,
					rlmMaxDepth: 5,
					rlmParentNodeId: stableId,
					status: "completed",
					createdAt: 3,
					updatedAt: "2026-01-01T00:00:02.000Z",
				})}\n`,
			);
			const stableState = await internals.createRuntime({ type: "create", sessionPath: stableSessionFile });
			expect(stableState.runtime.metadata.kind).toBe("top-level");
			await internals.rehydrateCompletedRlmSubagents(parentState);

			expect(createRuntime).toHaveBeenCalledTimes(6);
			expect(createRuntime.mock.calls[5]?.[0].sessionOptions).toEqual(
				expect.objectContaining({
					rlmSessionDir: stableSessionDir,
					rlmDepth: 2,
					rlmMaxDepth: 5,
					rlmParentNodeId: stableId,
				}),
			);
			expect(stableState.runtime.metadata.kind).toBe("top-level");
			expect(internals.sessions.has(stableState.activeSessionId)).toBe(false);
			const restoredStableState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === stableId,
			);
			expect(restoredStableState?.runtime.metadata).toEqual(
				expect.objectContaining({
					kind: "subagent",
					parentActiveSessionId: parentState.activeSessionId,
					rlmChildId: stableId,
				}),
			);
			expect(parentState.runtime.session.retainFinishedRlmChildSession).toHaveBeenCalledWith(
				stableId,
				restoredStableState?.runtime.session,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("gives RLM subagents messaging controllers for their own nested children", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-nested-controller-"));
		try {
			const sessionNamesDuringBind: Array<string | undefined> = [];
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.bindExtensions = vi.fn(async () => {
					sessionNamesDuringBind.push(options.sessionManager.getSessionName());
				});
				return {
					session,
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				bindingSessions: Set<string>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: join(tempDir, "parent.jsonl"),
			});
			const childSessionName = createDefaultRlmSubagentSessionName("spawn a nested worker", "child-1");
			let publishedWhileBinding = false;
			await internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "spawn a nested worker",
				sessionName: childSessionName,
				sessionDir: join(tempDir, "child"),
				model: {} as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 2,
				rlmParentNodeId: "child-1",
				onSessionPublished: (session) => {
					expect(session.sessionName).toBe(childSessionName);
					const state = [...internals.sessions.values()].find(
						(candidate) => candidate.runtime.session === session,
					);
					publishedWhileBinding = !!state && internals.bindingSessions.has(state.activeSessionId);
				},
			});
			expect(publishedWhileBinding).toBe(true);

			const childOptions = createRuntime.mock.calls[1]?.[0];
			const childController = childOptions?.sessionOptions?.agentMessageController;
			expect(childController).toBeDefined();
			const currentChild = childController?.listAgents().current;
			const childActiveSessionId = currentChild?.activeSessionId;
			expect(childActiveSessionId).toBeTruthy();
			expect(currentChild?.sessionName).toBe(childSessionName);
			expect(sessionNamesDuringBind[1]).toBeUndefined();

			const grandchildState = makeState("grandchild", childActiveSessionId);
			grandchildState.runtime = {
				...grandchildState.runtime,
				cwd: tempDir,
				metadata: { ...grandchildState.runtime.metadata, rlmChildId: "grandchild-1" },
				session: {
					sessionId: "session-grandchild",
					sessionName: "Grandchild",
					isStreaming: false,
					pendingMessageCount: 0,
				},
			} as never;
			internals.sessions.set(grandchildState.activeSessionId, grandchildState);
			expect(childController?.listAgents().agents).toContainEqual(
				expect.objectContaining({
					activeSessionId: grandchildState.activeSessionId,
					parentActiveSessionId: childActiveSessionId,
					rlmChildId: "grandchild-1",
				}),
			);

			const sessionsBeforeCancelledStartup = internals.sessions.size;
			vi.mocked(parentState.runtime.session.getRlmChildRunStatus).mockReturnValue("cancelled");
			await expect(
				internals.createRlmSubagentRuntime(parentState, {
					parentSession: parentState.runtime.session,
					id: "cancelled-child",
					prompt: "delete during daemon startup",
					sessionName: "cancelled-worker",
					sessionDir: join(tempDir, "cancelled-child"),
					model: {} as Model<Api>,
					thinkingLevel: "off",
					serviceTier: null,
					scopedModels: [],
					activeToolNames: [],
					customTools: [],
					includeGoals: false,
					includeCompactSkill: false,
					rlmDepth: 1,
					rlmMaxDepth: 2,
					rlmParentNodeId: "cancelled-child",
				}),
			).rejects.toThrow();
			expect(parentState.runtime.session.getRlmChildRunStatus).toHaveBeenCalledWith("cancelled-child");
			expect(internals.sessions.size).toBe(sessionsBeforeCancelledStartup);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("closes a registered RLM runtime when its requested session name cannot be persisted", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-child-name-failure-"));
		try {
			let failingChildSession: ReturnType<typeof makeRuntimeSession> | undefined;
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				if (createRuntime.mock.calls.length > 1) {
					failingChildSession = session;
					session.setSessionName = vi.fn(() => {
						throw new Error("name persistence failed");
					});
				}
				return {
					session,
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: join(tempDir, "parent.jsonl"),
			});
			await expect(
				internals.createRlmSubagentRuntime(parentState, {
					parentSession: parentState.runtime.session,
					id: "child-name-failure",
					prompt: "fail while naming",
					sessionName: "requested-name",
					sessionDir: join(tempDir, "child"),
					model: {} as Model<Api>,
					thinkingLevel: "off",
					serviceTier: null,
					scopedModels: [],
					activeToolNames: [],
					customTools: [],
					includeGoals: false,
					includeCompactSkill: false,
					rlmDepth: 1,
					rlmMaxDepth: 2,
					rlmParentNodeId: "child-name-failure",
				}),
			).rejects.toThrow("name persistence failed");

			expect(failingChildSession).toBeDefined();
			expect(failingChildSession?.disposeAsync).toHaveBeenCalledOnce();
			expect(internals.sessions.size).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("excludes half-bound sessions from targeting until extension binding completes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-binding-gate-"));
		try {
			let releaseBind: () => void = () => {};
			const bindBarrier = new Promise<void>((resolve) => {
				releaseBind = resolve;
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.bindExtensions = vi.fn(async () => {
					await bindBarrier;
				});
				return {
					session,
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown> | undefined;
				createAgentMessageListResult(current: ActiveSessionState): {
					agents: Array<{ activeSessionId: string }>;
				};
				sendAgentSessionMessage(options: {
					targetSelector: string;
					message: string;
					fromState?: ActiveSessionState;
					origin: "agent" | "cli";
				}): Promise<unknown>;
			};
			const fromState = makeState("source");
			fromState.runtime = {
				...fromState.runtime,
				cwd: tempDir,
				session: { sessionId: "session-source", sessionName: "Source", isStreaming: false, pendingMessageCount: 0 },
			} as never;
			internals.sessions.set(fromState.activeSessionId, fromState);

			const created = internals.createRuntime({ type: "create", sessionPath: join(tempDir, "session.jsonl") });
			for (let attempt = 0; attempt < 50 && internals.sessions.size < 2; attempt++) {
				await Promise.resolve();
			}
			const bindingId = [...internals.sessions.keys()].find((id) => id !== fromState.activeSessionId);
			expect(bindingId).toBeTruthy();

			await expect(
				internals.sendAgentSessionMessage({
					targetSelector: bindingId as string,
					message: "too early",
					fromState,
					origin: "agent",
				}),
			).rejects.toThrow("still initializing");
			await expect(
				Promise.resolve(
					internals.handleCommand(makeClient("client-1", bindingId as string), {
						id: "command-1",
						type: "attach",
						activeSessionId: bindingId as string,
					}),
				),
			).rejects.toThrow("still initializing");
			expect(internals.createAgentMessageListResult(fromState).agents.map((agent) => agent.activeSessionId)).toEqual(
				[fromState.activeSessionId],
			);

			releaseBind();
			await created;

			expect(internals.createAgentMessageListResult(fromState).agents.map((agent) => agent.activeSessionId)).toEqual(
				expect.arrayContaining([fromState.activeSessionId, bindingId]),
			);
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

	it("cancels scheduled jobs when a live session is killed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-kill-cron-"));
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
			const sessionFile = join(tempDir, "session.jsonl");
			const removeQueuedFollowUp = vi.fn();
			const abort = vi.fn(async () => {});
			const dispose = vi.fn(async () => {});
			const appendSessionState = vi.fn();
			const state = makeState("active-1") as ActiveSessionState;
			state.extensionUiRequests = new Map();
			state.runtime = {
				metadata: { kind: "top-level", createdAt: 1 },
				cwd: tempDir,
				dispose,
				session: {
					sessionId: "session-1",
					sessionFile,
					messages: ["user message"],
					sessionManager: {
						appendSessionState,
						hasUserContent: () => true,
					},
					abort,
					removeQueuedFollowUp,
				},
			} as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check long run",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep working",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			internals.cronStore.pauseHeartbeat(state.activeSessionId, new Date("2026-01-01T12:01:00.000Z"));
			const rlmHeartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				runtimeKind: "top-level",
				scheduleText: "every 10m",
				prompt: "keep internal work moving",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: state.activeSessionId,
			});

			for (const id of [cron.id, heartbeat.id, rlmHeartbeat.id]) {
				expect(internals.cronStore.list().find((job) => job.id === id)).toMatchObject({ status: "cancelled" });
				expect(internals.cronStore.list().find((job) => job.id === id)).not.toHaveProperty("nextRunAt");
			}
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${heartbeat.id}`);
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${rlmHeartbeat.id}`);
			expect(abort).toHaveBeenCalledOnce();
			expect(dispose).toHaveBeenCalledOnce();
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels scheduled jobs when a saved session is deleted", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-cron-"));
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
			const sessionFile = join(tempDir, "saved-session.jsonl");
			const otherSessionFile = join(tempDir, "other-session.jsonl");
			const cron = internals.cronStore.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check saved session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep saved session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const unrelated = internals.cronStore.create({
				activeSessionId: "active-2",
				sessionId: "session-2",
				sessionFile: otherSessionFile,
				cwd: tempDir,
				scheduleText: "in 2h",
				prompt: "keep other session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			});

			expect(internals.cronStore.list().find((job) => job.id === cron.id)).toMatchObject({ status: "cancelled" });
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
			expect(internals.cronStore.list().find((job) => job.id === unrelated.id)).toMatchObject({ status: "active" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("streams detached saved-session catalog requests", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-saved-session-catalog-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(tempDir, sessionDir);
			session.appendSessionState({ status: "active" });
			session.appendAgentStatus({
				summary: "Finished the task",
				taskState: "completed",
				basedOnMessageCount: 0,
			});
			session.appendSessionState({ status: "active" });
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const internals = daemon as unknown as {
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const writes: string[] = [];
			const client = {
				...makeClient("client-1", "detached"),
				socket: {
					destroyed: false,
					write: (line: string) => {
						writes.push(line);
						return true;
					},
				} as unknown as Socket,
			};

			const response = (await internals.handleCommand(client, {
				id: "list-1",
				type: "list_saved_sessions",
				cwd: tempDir,
				sessionDir,
				scope: "current",
			})) as {
				data: {
					sessions: Array<{
						id: string;
						agentStatus?: {
							summary: string;
							taskState?: "needs_input" | "completed";
							basedOnMessageCount: number;
						};
					}>;
				};
			};
			const updates = writes.map((line) => JSON.parse(line) as { type: string; activeSessionId?: string });

			expect(response.data.sessions).toEqual([
				expect.objectContaining({
					id: session.getSessionId(),
					agentStatus: { summary: "Finished the task", taskState: "completed", basedOnMessageCount: 0 },
				}),
			]);
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "list-1",
						type: "session_list_progress",
						command: "list_saved_sessions",
						loaded: 1,
						total: 1,
					}),
					expect.objectContaining({
						id: "list-1",
						type: "session_list_item",
						command: "list_saved_sessions",
						session: expect.objectContaining({
							id: session.getSessionId(),
							agentStatus: { summary: "Finished the task", taskState: "completed", basedOnMessageCount: 0 },
						}),
					}),
				]),
			);
			expect(updates.every((update) => update.activeSessionId === undefined)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps saved session jobs when file deletion fails", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-cron-fail-"));
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
			const deleteSavedSessionFile = vi.fn(async () => ({ ok: false, error: "delete failed" }) as const);
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				deleteSavedSessionFile: typeof deleteSavedSessionFile;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.deleteSavedSessionFile = deleteSavedSessionFile;
			const sessionFile = join(tempDir, "saved-session.jsonl");
			const cron = internals.cronStore.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check saved session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep saved session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const response = await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			});

			expect(response).toMatchObject({ data: { ok: false, error: "delete failed" } });
			expect(deleteSavedSessionFile).toHaveBeenCalledWith(sessionFile, {
				afterFileRemoved: expect.any(Function),
			});
			expect(internals.cronStore.list().find((job) => job.id === cron.id)).toMatchObject({ status: "active" });
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
			});
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
			makeCronJob({
				id: "heartbeat-1",
				source: "heartbeat",
				activeSessionId: state.activeSessionId,
				deliveryMode: "follow_up",
			}),
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
			makeCronJob({
				id: "rlm-1",
				source: "rlm_heartbeat",
				activeSessionId: state.activeSessionId,
				deliveryMode: "follow_up",
			}),
		);
		const second = await runCronJob(
			makeCronJob({
				id: "rlm-2",
				source: "rlm_heartbeat",
				activeSessionId: state.activeSessionId,
				deliveryMode: "follow_up",
			}),
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

	it("defers heartbeat cron jobs while the target is accepting an agent message", async () => {
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
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			agentMessageAcceptingTargets: Set<string>;
			runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.agentMessageAcceptingTargets.add(state.activeSessionId);

		const result = await internals.runCronJob(
			makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }),
		);

		expect(result).toBe("skipped");
		expect(prompt).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("queues generic cron jobs while the target is accepting an agent message", async () => {
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
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			agentMessageAcceptingTargets: Set<string>;
			runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.agentMessageAcceptingTargets.add(state.activeSessionId);

		await internals.runCronJob(makeCronJob({ id: "cron-1", source: "cron", activeSessionId: state.activeSessionId }));

		expect(followUp).toHaveBeenCalledWith("heartbeat prompt", undefined, { resumeIfIdle: true });
		expect(prompt).not.toHaveBeenCalled();
	});

	it("defers heartbeat cron jobs while an accepted agent message prompt is in flight", async () => {
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
					hasAcceptedPromptInFlight: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			isBashRunning: false,
			hasAcceptedPromptInFlight: true,
			pendingMessageCount: 0,
			prompt,
			followUp,
		} as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);

		const result = await (
			daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }
		).runCronJob(makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }));

		expect(result).toBe("skipped");
		expect(prompt).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("queues generic cron jobs behind accepted agent message prompts", async () => {
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
					hasAcceptedPromptInFlight: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			hasAcceptedPromptInFlight: true,
			pendingMessageCount: 0,
			prompt,
			followUp,
		} as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);

		await (daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }).runCronJob(
			makeCronJob({ id: "cron-1", source: "cron", activeSessionId: state.activeSessionId }),
		);

		expect(followUp).toHaveBeenCalledWith("heartbeat prompt", undefined, { resumeIfIdle: true });
		expect(prompt).not.toHaveBeenCalled();
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

		expect(followUp).toHaveBeenCalledWith("heartbeat prompt", undefined, { resumeIfIdle: true });
		expect(prompt).not.toHaveBeenCalled();
	});

	it("delivers heartbeats with a steering behavior by default", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(async () => {});
		const promptHeartbeat = vi.fn(
			async (
				_job: AgentCronJob,
				_options?: { streamingBehavior?: "steer" | "followUp"; followUpQueueKey?: string },
			) => {},
		);
		const followUp = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isBashRunning: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					promptHeartbeat: typeof promptHeartbeat;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			isBashRunning: false,
			pendingMessageCount: 0,
			prompt,
			promptHeartbeat,
			followUp,
		} as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);

		await (daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }).runCronJob(
			makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }),
		);

		// The preparing guard adds an internal preflightResult hook.
		expect(promptHeartbeat).toHaveBeenCalledWith(
			expect.objectContaining({ id: "heartbeat-1", prompt: "heartbeat prompt" }),
			expect.objectContaining({
				streamingBehavior: "steer",
				source: "rpc",
			}),
		);
		expect(promptHeartbeat.mock.calls[0]?.[1]).toMatchObject({ followUpQueueKey: "heartbeat:heartbeat-1" });
		expect(prompt).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("delivers steer heartbeats after an RPC prompt finishes preflight while its turn is still streaming", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		let releasePrompt = () => {};
		const promptFinished = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		let reportPromptStarted = () => {};
		const promptStarted = new Promise<void>((resolve) => {
			reportPromptStarted = resolve;
		});
		const sessionState = {
			isStreaming: false,
			isBashRunning: false,
			pendingMessageCount: 0,
		};
		const prompt = vi.fn(async (_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			sessionState.isStreaming = true;
			options?.preflightResult?.(true);
			reportPromptStarted();
			await promptFinished;
		});
		const promptHeartbeat = vi.fn(
			async (
				_job: AgentCronJob,
				options?: { streamingBehavior?: "steer" | "followUp"; preflightResult?: (didSucceed: boolean) => void },
			) => {
				options?.preflightResult?.(true);
			},
		);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: typeof sessionState & {
					prompt: typeof prompt;
					promptHeartbeat: typeof promptHeartbeat;
				};
			};
		};
		state.runtime.session = Object.assign(sessionState, { prompt, promptHeartbeat }) as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			agentMessagePreparingTargets: Map<string, number>;
			promptWithAgentMessagePreparingGuard(state: ActiveSessionState, message: string): Promise<void>;
			runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
		};
		internals.sessions.set(state.activeSessionId, state);

		const promptPromise = internals.promptWithAgentMessagePreparingGuard(state, "long-running prompt");
		await promptStarted;
		const preparingReleased = !internals.agentMessagePreparingTargets.has(state.activeSessionId);
		const result = await internals.runCronJob(
			makeCronJob({ id: "heartbeat-1", source: "heartbeat", activeSessionId: state.activeSessionId }),
		);
		releasePrompt();
		await promptPromise;

		expect(preparingReleased).toBe(true);
		expect(result).toBeUndefined();
		expect(promptHeartbeat).toHaveBeenCalledWith(
			expect.objectContaining({ id: "heartbeat-1" }),
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
	});

	it("delivers follow-up heartbeats with a followUp behavior and coalescing key", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(async () => {});
		const promptHeartbeat = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isBashRunning: boolean;
					pendingMessageCount: number;
					prompt: typeof prompt;
					promptHeartbeat: typeof promptHeartbeat;
					followUp: typeof followUp;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			isBashRunning: false,
			pendingMessageCount: 0,
			prompt,
			promptHeartbeat,
			followUp,
		} as never;
		(daemon as unknown as { sessions: Map<string, ActiveSessionState> }).sessions.set(state.activeSessionId, state);

		await (daemon as unknown as { runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> }).runCronJob(
			makeCronJob({
				id: "heartbeat-1",
				source: "heartbeat",
				activeSessionId: state.activeSessionId,
				deliveryMode: "follow_up",
			}),
		);

		// The preparing guard adds an internal preflightResult hook.
		expect(promptHeartbeat).toHaveBeenCalledWith(
			expect.objectContaining({ id: "heartbeat-1", prompt: "heartbeat prompt" }),
			expect.objectContaining({
				streamingBehavior: "followUp",
				followUpQueueKey: "heartbeat:heartbeat-1",
				source: "rpc",
			}),
		);
		expect(prompt).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("prompts idle generic cron jobs without a heartbeat coalescing key", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const prompt = vi.fn(
			async (
				_message: string,
				_options?: { streamingBehavior?: "steer" | "followUp"; followUpQueueKey?: string; source?: string },
			) => {},
		);
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

		// The preparing guard adds an internal preflightResult hook.
		expect(prompt).toHaveBeenCalledWith(
			"heartbeat prompt",
			expect.objectContaining({
				streamingBehavior: "followUp",
				source: "rpc",
			}),
		);
		expect(prompt.mock.calls[0]?.[1]).not.toHaveProperty("followUpQueueKey");
		expect(followUp).not.toHaveBeenCalled();
	});

	it("forwards queue keys when expanded daemon steer commands are queued", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const steer = vi.fn(async () => {});
		const restoreSteeringMessage = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					steer: typeof steer;
					restoreSteeringMessage: typeof restoreSteeringMessage;
				};
			};
		};
		state.runtime.session = { steer, restoreSteeringMessage } as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "steer",
			activeSessionId: state.activeSessionId,
			message: "queued heartbeat",
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_steer",
		});

		expect(steer).toHaveBeenCalledWith("queued heartbeat", undefined, {
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_steer",
			resumeIfIdle: true,
		});
		expect(restoreSteeringMessage).not.toHaveBeenCalled();
	});

	it("rejects invalid heartbeat delivery modes before persisting", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-delivery-mode-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const sessionFile = join(tempDir, "session.jsonl");
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: ActiveSessionState["runtime"]["session"] & {
						sessionFile: string;
						sessionId: string;
					};
				};
			};
			state.runtime = {
				...state.runtime,
				cwd: tempDir,
				session: {
					sessionFile,
					sessionId: "session-1",
				},
			} as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);

			await expect(
				internals.handleCommand(makeClient("client-1", state.activeSessionId), {
					id: "command-1",
					type: "heartbeat_set",
					activeSessionId: state.activeSessionId,
					schedule: "every 5m",
					prompt: "check the run",
					deliveryMode: "followup" as never,
				}),
			).rejects.toThrow('Heartbeat delivery mode must be "steer" or "follow_up"');
			expect(internals.cronStore.getHeartbeat(state.activeSessionId)).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves the current heartbeat delivery mode when replacement omits it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-preserve-delivery-mode-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: ActiveSessionState["runtime"]["session"] & {
						removeQueuedFollowUp: ReturnType<typeof vi.fn>;
						sessionFile: string;
						sessionId: string;
					};
				};
			};
			state.runtime = {
				...state.runtime,
				cwd: tempDir,
				session: {
					removeQueuedFollowUp: vi.fn(() => false),
					sessionFile: join(tempDir, "session.jsonl"),
					sessionId: "session-1",
				},
			} as never;
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				handleCommand(
					client: DaemonSocketClient,
					command: DaemonCommand,
				): Promise<{
					data: { heartbeat: AgentCronJob };
				}>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const client = makeClient("client-1", state.activeSessionId);

			await internals.handleCommand(client, {
				id: "command-1",
				type: "heartbeat_set",
				activeSessionId: state.activeSessionId,
				schedule: "every 5m",
				prompt: "first instruction",
				deliveryMode: "follow_up",
			});
			const replacement = await internals.handleCommand(client, {
				id: "command-2",
				type: "heartbeat_set",
				activeSessionId: state.activeSessionId,
				schedule: "every 10m",
				prompt: "replacement instruction",
			});

			expect(replacement.data.heartbeat).toMatchObject({
				prompt: "replacement instruction",
				deliveryMode: "follow_up",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("removes queued RLM heartbeat follow-ups when only delivery mode changes", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-rlm-delivery-mode-"));
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
				updateRlmHeartbeatForState(
					state: ActiveSessionState,
					input: { id: string; deliveryMode: "steer" | "follow_up" },
				): AgentCronJob | undefined;
			};
			const rlmHeartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check internal state",
				deliveryMode: "follow_up",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const updated = internals.updateRlmHeartbeatForState(state, {
				id: rlmHeartbeat.id,
				deliveryMode: "steer",
			});

			expect(updated).toMatchObject({ id: rlmHeartbeat.id, deliveryMode: "steer" });
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${rlmHeartbeat.id}`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
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

	it("manages a persisted heartbeat after its session unloads", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-unloaded-heartbeat-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "unloaded-session",
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
			});

			const response = await internals.handleCommand(makeClient("client-1", "unloaded-session"), {
				id: "command-1",
				type: "heartbeat_manage",
				activeSessionId: "unloaded-session",
				jobId: heartbeat.id,
				action: "stop",
			});

			expect(response).toMatchObject({
				success: true,
				data: { heartbeat: { id: heartbeat.id, status: "cancelled" } },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("sets models without waiting for model_select extension handlers while running", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const setModel = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					modelRegistry: {
						refreshAvailableModels(): Promise<unknown[]>;
					};
					isStreaming: boolean;
					isCompacting: boolean;
					setModel(model: unknown, options?: { waitForExtensions?: boolean }): Promise<void>;
				};
			};
		};
		state.runtime.session = {
			modelRegistry: {
				refreshAvailableModels: vi.fn(async () => [model]),
			},
			isStreaming: true,
			isCompacting: false,
			setModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "set_model",
			activeSessionId: state.activeSessionId,
			provider: "faux",
			modelId: "faux-2",
		});

		expect(setModel).toHaveBeenCalledWith(model, { waitForExtensions: false });
	});

	it("waits for model_select extension handlers when setting models while idle", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const setModel = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					modelRegistry: {
						refreshAvailableModels(): Promise<unknown[]>;
					};
					isStreaming: boolean;
					isCompacting: boolean;
					setModel(model: unknown, options?: { waitForExtensions?: boolean }): Promise<void>;
				};
			};
		};
		state.runtime.session = {
			modelRegistry: {
				refreshAvailableModels: vi.fn(async () => [model]),
			},
			isStreaming: false,
			isCompacting: false,
			setModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "set_model",
			activeSessionId: state.activeSessionId,
			provider: "faux",
			modelId: "faux-2",
		});

		expect(setModel).toHaveBeenCalledWith(model, { waitForExtensions: true });
	});

	it("cycles models without waiting for model_select extension handlers while running", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const cycleResult = { model, thinkingLevel: "off" as const, isScoped: false };
		const cycleModel = vi.fn(async () => cycleResult);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isCompacting: boolean;
					cycleModel(
						direction?: "forward" | "backward",
						options?: { waitForExtensions?: boolean },
					): Promise<typeof cycleResult | undefined>;
				};
			};
		};
		state.runtime.session = {
			isStreaming: true,
			isCompacting: false,
			cycleModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "cycle_model",
			activeSessionId: state.activeSessionId,
			direction: "backward",
		});

		expect(cycleModel).toHaveBeenCalledWith("backward", { waitForExtensions: false });
	});

	it("waits for model_select extension handlers when cycling models while idle", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const cycleResult = { model, thinkingLevel: "off" as const, isScoped: false };
		const cycleModel = vi.fn(async () => cycleResult);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isCompacting: boolean;
					cycleModel(
						direction?: "forward" | "backward",
						options?: { waitForExtensions?: boolean },
					): Promise<typeof cycleResult | undefined>;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			isCompacting: false,
			cycleModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "cycle_model",
			activeSessionId: state.activeSessionId,
		});

		expect(cycleModel).toHaveBeenCalledWith(undefined, { waitForExtensions: true });
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

function makeCronJob(input: {
	id: string;
	source: AgentCronJob["source"];
	activeSessionId: string;
	deliveryMode?: AgentCronJob["deliveryMode"];
}): AgentCronJob {
	return {
		id: input.id,
		status: "active",
		source: input.source,
		...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
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
		messages: [],
		extensionRunner: {
			hasHandlers: vi.fn(() => false),
			emit: vi.fn(async () => {}),
		},
		sessionFile: sessionManager.getSessionFile(),
		sessionId: sessionManager.getSessionId(),
		get sessionName() {
			return sessionManager.getSessionName();
		},
		setSubagentRuntimeHost: vi.fn(),
		getRlmChildRunStatus: vi.fn(() => "running"),
		retainFinishedRlmChildSession: vi.fn(() => true),
		subscribe: vi.fn(() => vi.fn()),
		bindExtensions: vi.fn(async () => {}),
		setExecEnvProvider: vi.fn(),
		setSessionName: vi.fn((name: string) => sessionManager.appendSessionInfo(name)),
		dispose: vi.fn(),
		disposeAsync: vi.fn(async () => {}),
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
