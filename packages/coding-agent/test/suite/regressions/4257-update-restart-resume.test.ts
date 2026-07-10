import { readFileSync, writeFileSync } from "node:fs";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDaemonUpdateRestartManifestPath } from "../../../src/config.js";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { AgentCronJobStore, AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import type { CustomMessage } from "../../../src/core/messages.js";
import type { BashOperations } from "../../../src/core/tools/bash.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonUpdateRestartManifest } from "../../../src/modes/daemon/daemon-protocol.js";
import { prepareDaemonUpdateRestart } from "../../../src/package-manager-cli.js";
import { createHarness, getUserTexts, type Harness } from "../harness.js";

type AgentDaemonUpdateInternals = {
	sessions: Map<string, ActiveSessionState>;
	cronStore: AgentCronJobStore;
	cronScheduler: AgentCronScheduler;
	prepareUpdateRestart(): Promise<DaemonUpdateRestartManifest>;
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
};

type QueueInternals = {
	_steeringMessages: Array<{
		text: string;
		queueKey?: string;
		agentMessageId?: string;
		prefixMessages: CustomMessage[];
		message: UserMessage | CustomMessage;
	}>;
	_followUpMessages: Array<{
		text: string;
		queueKey?: string;
		agentMessageId?: string;
		prefixMessages: CustomMessage[];
		message: UserMessage | CustomMessage;
	}>;
	_pendingNextTurnMessages: CustomMessage[];
	_acceptedAgentMessagePrompt?: {
		text: string;
		agentMessageId: string;
		message: UserMessage;
		messages: Set<unknown>;
		pendingNextTurnMessages: CustomMessage[];
		deliveredPendingNextTurnMessages: Set<CustomMessage>;
		accepted: Promise<void>;
		resolveAccepted: () => void;
		rejectAccepted: (error: Error) => void;
		turnStarted: boolean;
		cleared: boolean;
	};
};

type AgentInternals = {
	_state: {
		isStreaming: boolean;
	};
};

function createState(
	harness: Harness,
	activeSessionId: string,
	metadata: AgentSessionRuntime["metadata"],
	options: { clientEnv?: Record<string, string>; onDispose?: () => void } = {},
): ActiveSessionState {
	const runtime = {
		session: harness.session,
		metadata,
		runtimeConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
		diagnostics: [],
		dispose: async () => {
			options.onDispose?.();
		},
	} as unknown as AgentSessionRuntime;
	return {
		activeSessionId,
		runtime,
		clients: new Set(),
		extensionUiRequests: new Map(),
		lastEventSequence: 0,
		...(options.clientEnv ? { clientEnv: options.clientEnv } : {}),
	};
}

function hasArchivedState(harness: Harness): boolean {
	return harness.sessionManager
		.getEntries()
		.some((entry) => entry.type === "session_state" && entry.state.status === "archived");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}

function createCustomMessage(content: string): CustomMessage {
	return {
		role: "custom",
		customType: "prime-agent.test",
		content,
		display: false,
		timestamp: Date.now(),
	};
}

describe("issue #4257 update restart resume", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("captures a restart manifest and aborts running bash without archiving the session", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.recordBashResult("echo before", {
			output: "before",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							resolve({ exitCode: null });
						},
						{ once: true },
					);
				});
			},
		};
		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);
		const abortSpy = vi.spyOn(harness.session, "abort");
		const agentAbortSpy = vi.spyOn(harness.session.agent, "abort");

		let disposed = false;
		let abortedBeforeDispose = false;
		const state = createState(
			harness,
			"active-1",
			{ kind: "top-level", createdAt: Date.now() },
			{
				onDispose: () => {
					abortedBeforeDispose = agentAbortSpy.mock.calls.length > 0;
					disposed = true;
				},
			},
		);
		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(state.activeSessionId, state);
		const schedulerStopSpy = vi.spyOn(internals.cronScheduler, "stop");
		const now = new Date("2026-01-01T12:00:00.000Z");
		const cron = internals.cronStore.create({
			activeSessionId: state.activeSessionId,
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile ?? "",
			cwd: harness.tempDir,
			scheduleText: "in 1h",
			prompt: "check long run",
			now,
		});
		const heartbeat = internals.cronStore.createHeartbeat({
			activeSessionId: state.activeSessionId,
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile ?? "",
			cwd: harness.tempDir,
			scheduleText: "every 5m",
			prompt: "keep working",
			now,
		});

		const manifest = await internals.prepareUpdateRestart();
		const bashResult = await bashPromise;

		expect(bashResult.cancelled).toBe(true);
		expect(abortSpy).not.toHaveBeenCalled();
		expect(agentAbortSpy).toHaveBeenCalledOnce();
		expect(abortedBeforeDispose).toBe(true);
		expect(disposed).toBe(true);
		expect(internals.sessions.size).toBe(0);
		expect(schedulerStopSpy).toHaveBeenCalledOnce();
		for (const id of [cron.id, heartbeat.id]) {
			expect(internals.cronStore.list().find((job) => job.id === id)).toMatchObject({ status: "active" });
		}
		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "active-1",
			sessionFile: harness.session.sessionFile,
			shouldResume: true,
			wasBashRunning: true,
		});
		const persistedManifest = JSON.parse(
			readFileSync(getDaemonUpdateRestartManifestPath(harness.tempDir), "utf-8"),
		) as DaemonUpdateRestartManifest;
		expect(persistedManifest).toEqual(manifest);
		writeFileSync(getDaemonUpdateRestartManifestPath(harness.tempDir), JSON.stringify(manifest));
		await expect(prepareDaemonUpdateRestart(`${harness.tempDir}/missing.sock`, harness.tempDir)).resolves.toEqual(
			manifest,
		);
		expect(hasArchivedState(harness)).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "prime-agent.update_restart"),
		).toBe(true);
		abortSpy.mockRestore();
		agentAbortSpy.mockRestore();
		schedulerStopSpy.mockRestore();
	});

	it("keeps active goal abort state until update restart abort settles", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the update-safe task" });
		let releaseIdle: (() => void) | undefined;
		const idlePromise = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const waitForIdleSpy = vi.spyOn(harness.session.agent, "waitForIdle").mockReturnValue(idlePromise);
		const agentAbortSpy = vi.spyOn(harness.session.agent, "abort");
		const internals = harness.session as unknown as { _goalAbortInProgress: boolean };

		harness.session.abortForUpdateRestart();

		expect(agentAbortSpy).toHaveBeenCalledOnce();
		expect(internals._goalAbortInProgress).toBe(true);

		releaseIdle?.();
		await waitForCondition(() => !internals._goalAbortInProgress);

		expect(internals._goalAbortInProgress).toBe(false);
		waitForIdleSpy.mockRestore();
		agentAbortSpy.mockRestore();
	});

	it("rejects new daemon sessions after update restart preparation starts", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const createRuntime = vi.fn(async () => {
			throw new Error("unexpected runtime creation");
		});
		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime,
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		await internals.prepareUpdateRestart();
		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await internals.handleLine(client, JSON.stringify({ id: "late-create", type: "create" }));

		expect(createRuntime).not.toHaveBeenCalled();
		expect(JSON.parse(writes.join("").trim())).toMatchObject({
			id: "late-create",
			type: "response",
			command: "create",
			success: false,
		});
	});

	it("keeps queued draft sessions and subagents resumable", async () => {
		const parentHarness = await createHarness({ persistSession: true });
		const childHarness = await createHarness({ persistSession: true });
		harnesses.push(parentHarness, childHarness);

		const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "queued work" }, image];
		const queuedContext = createCustomMessage("queued context");
		const message: UserMessage = { role: "user", content, timestamp: Date.now() };
		const followUpContent: TextContent[] = [{ type: "text", text: "heartbeat" }];
		const followUpContext = createCustomMessage("follow-up context");
		const followUpMessage: UserMessage = {
			role: "user",
			content: followUpContent,
			timestamp: Date.now(),
		};
		const customFollowUp = createCustomMessage("custom heartbeat");
		const queueInternals = parentHarness.session as unknown as QueueInternals;
		queueInternals._steeringMessages = [
			{
				text: "queued work",
				queueKey: "heartbeat:steer",
				agentMessageId: "agentmsg_steer",
				prefixMessages: [queuedContext],
				message,
			},
		];
		queueInternals._followUpMessages = [
			{
				text: "heartbeat",
				queueKey: "heartbeat:job-1",
				agentMessageId: "agentmsg_followup",
				prefixMessages: [followUpContext],
				message: followUpMessage,
			},
			{
				text: "custom heartbeat",
				queueKey: "heartbeat:custom",
				agentMessageId: "agentmsg_custom",
				prefixMessages: [],
				message: customFollowUp,
			},
		];
		childHarness.session.recordBashResult("echo child", {
			output: "child",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		const daemon = new AgentDaemon(`${parentHarness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: parentHarness.tempDir, agentDir: parentHarness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"parent-active",
			createState(
				parentHarness,
				"parent-active",
				{ kind: "top-level", createdAt: Date.now() },
				{ clientEnv: { PRIME_SESSION: "pane-1" } },
			),
		);
		internals.sessions.set(
			"child-active",
			createState(childHarness, "child-active", {
				kind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: parentHarness.session.sessionId,
				parentSessionFile: parentHarness.session.sessionFile,
				createdAt: Date.now(),
				rlmChildId: "child-1",
			}),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(internals.sessions.size).toBe(0);
		expect(manifest.sessions).toHaveLength(2);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "parent-active",
			clientEnv: { PRIME_SESSION: "pane-1" },
			runtimeMetadata: { kind: "top-level" },
			queue: {
				steering: [
					{
						message: "queued work",
						content,
						images: [image],
						prefixMessages: [queuedContext],
						queueKey: "heartbeat:steer",
						agentMessageId: "agentmsg_steer",
					},
				],
				followUp: [
					{
						message: "heartbeat",
						content: followUpContent,
						prefixMessages: [followUpContext],
						queueKey: "heartbeat:job-1",
						agentMessageId: "agentmsg_followup",
					},
					{
						message: "custom heartbeat",
						queueKey: "heartbeat:custom",
						agentMessageId: "agentmsg_custom",
						customMessage: customFollowUp,
					},
				],
			},
			shouldResume: true,
		});
		expect(manifest.sessions[1]).toMatchObject({
			activeSessionId: "child-active",
			sessionFile: childHarness.session.sessionFile,
			runtimeMetadata: {
				kind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: parentHarness.session.sessionId,
				parentSessionFile: parentHarness.session.sessionFile,
				rlmChildId: "child-1",
			},
			queue: { steering: [], followUp: [], nextTurn: [] },
			shouldResume: false,
		});
		expect(hasArchivedState(parentHarness)).toBe(false);
		expect(hasArchivedState(childHarness)).toBe(false);
	});

	it("captures next-turn context and accepted prompts in the restart manifest", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const pendingNextTurn = createCustomMessage("pending next turn");
		const acceptedNextTurn = createCustomMessage("accepted prompt context");
		const deliveredAcceptedNextTurn = createCustomMessage("already delivered context");
		const acceptedContent: TextContent[] = [
			{ type: "text", text: "accepted prefix" },
			{ type: "text", text: "accepted work" },
		];
		const acceptedMessage: UserMessage = {
			role: "user",
			content: acceptedContent,
			timestamp: Date.now(),
		};
		const queueInternals = harness.session as unknown as QueueInternals;
		queueInternals._pendingNextTurnMessages = [pendingNextTurn];
		queueInternals._acceptedAgentMessagePrompt = {
			text: "accepted work",
			agentMessageId: "agentmsg_accepted",
			message: acceptedMessage,
			messages: new Set([acceptedNextTurn, deliveredAcceptedNextTurn, acceptedMessage]),
			pendingNextTurnMessages: [acceptedNextTurn, deliveredAcceptedNextTurn],
			deliveredPendingNextTurnMessages: new Set([deliveredAcceptedNextTurn]),
			accepted: Promise.resolve(),
			resolveAccepted: () => undefined,
			rejectAccepted: () => undefined,
			turnStarted: false,
			cleared: false,
		};

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "active-1",
			shouldResume: true,
			hadAcceptedPromptInFlight: true,
		});
		expect(manifest.sessions[0]?.queue.nextTurn).toEqual([pendingNextTurn]);
		expect(manifest.sessions[0]?.queue.acceptedPrompt).toEqual({
			message: "accepted work",
			content: acceptedContent,
			agentMessageId: "agentmsg_accepted",
			nextTurn: [acceptedNextTurn],
		});
	});

	it("materializes queued in-memory drafts before update restart", async () => {
		const harness = await createHarness({ persistSession: false });
		harnesses.push(harness);

		const followUpContent: TextContent[] = [
			{ type: "text", text: "queued context" },
			{ type: "text", text: "queued follow-up" },
		];
		const queueInternals = harness.session as unknown as QueueInternals;
		queueInternals._followUpMessages = [
			{
				text: "queued follow-up",
				queueKey: "heartbeat:job-1",
				agentMessageId: "agentmsg_followup",
				prefixMessages: [],
				message: { role: "user", content: followUpContent, timestamp: Date.now() },
			},
		];

		const sessionDir = `${harness.tempDir}/sessions`;
		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir, sessionDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.sessions).toHaveLength(1);
		const session = manifest.sessions[0];
		expect(session?.sessionFile.startsWith(`${sessionDir}/`)).toBe(true);
		expect(harness.session.sessionFile).toBe(session?.sessionFile);
		expect(readFileSync(session?.sessionFile ?? "", "utf8")).toContain('"type":"session"');
		expect(session?.queue.followUp).toEqual([
			{
				message: "queued follow-up",
				content: followUpContent,
				queueKey: "heartbeat:job-1",
				agentMessageId: "agentmsg_followup",
			},
		]);
		expect(session?.shouldResume).toBe(true);
	});

	it("materializes busy in-memory drafts before update restart", async () => {
		const harness = await createHarness({ persistSession: false });
		harnesses.push(harness);
		(harness.session.agent as unknown as AgentInternals)._state.isStreaming = true;

		const sessionDir = `${harness.tempDir}/sessions`;
		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir, sessionDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.sessions).toHaveLength(1);
		const session = manifest.sessions[0];
		expect(session?.sessionFile.startsWith(`${sessionDir}/`)).toBe(true);
		expect(harness.session.sessionFile).toBe(session?.sessionFile);
		expect(session).toMatchObject({
			shouldResume: true,
			wasStreaming: true,
			queue: { steering: [], followUp: [], nextTurn: [] },
		});
	});

	it("keeps undelivered accepted-prompt context after the accepted turn starts", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const pendingNextTurn = createCustomMessage("pending next turn");
		const acceptedNextTurn = createCustomMessage("accepted prompt context");
		const deliveredAcceptedNextTurn = createCustomMessage("already delivered context");
		const acceptedMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "accepted work" }],
			timestamp: Date.now(),
		};
		const queueInternals = harness.session as unknown as QueueInternals;
		queueInternals._pendingNextTurnMessages = [pendingNextTurn];
		queueInternals._acceptedAgentMessagePrompt = {
			text: "accepted work",
			agentMessageId: "agentmsg_accepted",
			message: acceptedMessage,
			messages: new Set([acceptedMessage, deliveredAcceptedNextTurn]),
			pendingNextTurnMessages: [acceptedNextTurn, deliveredAcceptedNextTurn],
			deliveredPendingNextTurnMessages: new Set([deliveredAcceptedNextTurn]),
			accepted: Promise.resolve(),
			resolveAccepted: () => undefined,
			rejectAccepted: () => undefined,
			turnStarted: true,
			cleared: false,
		};

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "active-1",
			shouldResume: true,
			hadAcceptedPromptInFlight: true,
		});
		expect(manifest.sessions[0]?.queue.nextTurn).toEqual([pendingNextTurn, acceptedNextTurn]);
		expect(manifest.sessions[0]?.queue.acceptedPrompt).toBeUndefined();
	});

	it("accepts restore_next_turn through daemon command parsing", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(["active-1"]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};
		const restoredMessage = createCustomMessage("restored next turn");

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "restore-1",
				type: "restore_next_turn",
				activeSessionId: "active-1",
				messages: [restoredMessage],
			}),
		);

		expect(JSON.parse(writes.join("").trim())).toMatchObject({
			id: "restore-1",
			type: "response",
			command: "restore_next_turn",
			success: true,
		});
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([restoredMessage]);
	});

	it("accepts restored prompt content through daemon command parsing", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("accepted restored prompt")]);

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const promptContent: TextContent[] = [
			{ type: "text", text: "accepted prefix" },
			{ type: "text", text: "accepted work" },
		];
		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(["active-1"]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "active-1",
				message: "accepted work",
				content: promptContent,
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_accepted",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		expect(
			writes
				.join("")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([expect.objectContaining({ id: "prompt-1", command: "prompt", success: true })]);
		expect(harness.session.messages.find((message) => message.role === "user")?.content).toEqual(promptContent);
	});

	it("restores agent-message ids and reports deduped follow-ups", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const queueInternals = harness.session as unknown as QueueInternals;
		const restoredSteerContent: TextContent[] = [
			{ type: "text", text: "restored steer context" },
			{ type: "text", text: "restored steer" },
		];
		const restoredFollowUpContent: TextContent[] = [
			{ type: "text", text: "restored follow-up context" },
			{ type: "text", text: "restored follow-up" },
		];
		const restoredPrefix = createCustomMessage("restored custom prefix");
		queueInternals._followUpMessages = [
			{
				text: "existing",
				queueKey: "heartbeat:job-1",
				agentMessageId: "agentmsg_existing",
				prefixMessages: [],
				message: { role: "user", content: [{ type: "text", text: "existing" }], timestamp: Date.now() },
			},
		];
		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(["active-1"]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-1",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer",
				content: restoredSteerContent,
				queueKey: "heartbeat:steer",
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_restored_steer",
				prefixMessages: [restoredPrefix],
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "duplicate",
				queueKey: "heartbeat:job-1",
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_duplicate",
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-2",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				content: restoredFollowUpContent,
				queueKey: "heartbeat:job-2",
				expandPromptTemplates: false,
				agentMessageId: "agentmsg_restored_followup",
			}),
		);

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true, data: { queued: false } }),
			expect.objectContaining({ id: "follow-up-2", command: "follow_up", success: true, data: { queued: true } }),
		]);
		expect(harness.session.getSteeringQueueSnapshots()).toEqual([
			expect.objectContaining({
				text: "restored steer",
				content: restoredSteerContent,
				prefixMessages: [restoredPrefix],
				queueKey: "heartbeat:steer",
				agentMessageId: "agentmsg_restored_steer",
			}),
		]);
		expect(harness.session.getFollowUpQueueSnapshots()).toEqual([
			expect.objectContaining({ text: "existing", agentMessageId: "agentmsg_existing" }),
			expect.objectContaining({
				text: "restored follow-up",
				content: restoredFollowUpContent,
				agentMessageId: "agentmsg_restored_followup",
			}),
		]);
	});

	it("resumes restored queues without promoting steering messages to prompts", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("seed response"),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
			fauxAssistantMessage("handled follow-up"),
		]);
		await harness.session.prompt("start");

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(["active-1"]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-1",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer 1",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-2",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer 2",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "resume-1",
				type: "resume_queue",
				activeSessionId: "active-1",
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "steer-2", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "resume-1", command: "resume_queue", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["start", "restored steer 1", "restored steer 2", "restored follow-up"]);
		expect(harness.session.getSteeringQueueSnapshots()).toEqual([]);
		expect(harness.session.getFollowUpQueueSnapshots()).toEqual([]);
	});

	it("drains restored queues when a continuation prompt resumes interrupted work", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled continuation"), fauxAssistantMessage("handled follow-up")]);
		harness.session.agent.state.messages.push(createCustomMessage("update interrupted"));

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(["active-1"]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "steer-1",
				type: "steer",
				activeSessionId: "active-1",
				message: "restored steer",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "active-1",
				message: "continue interrupted work",
				expandPromptTemplates: false,
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "prompt-1", command: "prompt", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["continue interrupted work", "restored steer", "restored follow-up"]);
		expect(harness.session.getSteeringQueueSnapshots()).toEqual([]);
		expect(harness.session.getFollowUpQueueSnapshots()).toEqual([]);
	});

	it("resumes restored queues after an update marker without prior transcript messages", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled restored follow-up")]);
		harness.session.agent.state.messages.push(createCustomMessage("update interrupted"));

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(["active-1"]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "follow-up-1",
				type: "follow_up",
				activeSessionId: "active-1",
				message: "restored follow-up",
				expandPromptTemplates: false,
			}),
		);
		await internals.handleLine(
			client,
			JSON.stringify({
				id: "resume-1",
				type: "resume_queue",
				activeSessionId: "active-1",
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		const responses = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "resume-1", command: "resume_queue", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["restored follow-up"]);
		expect(harness.session.getFollowUpQueueSnapshots()).toEqual([]);
	});

	it("reports resume_queue failure when no work can resume", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);
		const writes: string[] = [];
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			} as unknown as DaemonSocketClient["socket"],
			attachedActiveSessionIds: new Set(["active-1"]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "resume-1",
				type: "resume_queue",
				activeSessionId: "active-1",
			}),
		);
		await Promise.resolve();

		const response = JSON.parse(writes.join("").trim());
		expect(response).toMatchObject({ id: "resume-1", command: "resume_queue", success: false });
		expect(JSON.stringify(response)).toContain("No messages to continue from");
	});
});
