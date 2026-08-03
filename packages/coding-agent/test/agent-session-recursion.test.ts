import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { type HostRequestHandlers, KernelManager } from "../src/core/kernel/index.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	createDefaultRlmSubagentSessionName,
	createRlmRunHostHandler,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const lastMessage = context.messages[context.messages.length - 1];
	if (!lastMessage || lastMessage.role !== "user") {
		return "";
	}
	if (typeof lastMessage.content === "string") {
		return lastMessage.content;
	}
	return lastMessage.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistantMessage(text);
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

interface TestCommMessage {
	header: { msg_type: string };
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

interface KernelCommTestApi {
	handleCommMessage(incoming: TestCommMessage): void;
	sendCommMessage(commId: string, data: Record<string, unknown>): Promise<void>;
}

interface CapturedCommReply {
	commId: string;
	data: Record<string, unknown>;
}

interface InspectableRlmRun {
	id: string;
	sessionDir: string;
	abort: () => void;
	status: string;
	error?: string;
	session?: AgentSession;
}

interface InspectableRlmSession {
	_activeRlmChildRuns: Map<string, InspectableRlmRun>;
	_deletingRlmChildren: Map<
		string,
		{ subagent: ReturnType<AgentSession["listRlmSubagents"]>["subagents"][number]; promise: Promise<unknown> }
	>;
	_retryableRlmSubagentDeletions: Map<string, ReturnType<AgentSession["listRlmSubagents"]>["subagents"][number]>;
	_retainedRlmChildSessions: Map<string, AgentSession>;
	_retainedRlmChildUnsubscribes: Map<string, () => void>;
	_createKernelHostHandlers(): HostRequestHandlers;
	_reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void>;
}

interface KernelPumpTestApi {
	iopub: AsyncIterable<Buffer[]> & { close(): void };
	startIopubPump(): void;
}

interface KernelExecuteTestApi {
	start: () => Promise<void>;
	state: "idle" | "starting" | "running" | "shutdown";
	activeExecution?: unknown;
	shell?: {
		send(frames: Buffer[]): Promise<void>;
		close(): void;
	};
	connection?: {
		ip: string;
		transport: "tcp";
		shell_port: number;
		iopub_port: number;
		stdin_port: number;
		control_port: number;
		hb_port: number;
		signature_scheme: "hmac-sha256";
		key: string;
		kernel_name: string;
	};
}

function rlmCommOpenData(commId: string, data: Record<string, unknown>): TestCommMessage {
	return {
		header: { msg_type: "comm_open" },
		parent_header: {},
		metadata: {},
		content: {
			comm_id: commId,
			target_name: "host.request",
			data,
		},
	};
}

function rlmCommOpen(commId: string, prompt: string, kwargs: Record<string, unknown> = {}): TestCommMessage {
	return rlmCommOpenData(commId, { type: "rlm.run", prompt, kwargs });
}

function encodeTestMessage(message: TestCommMessage): Buffer[] {
	return [
		Buffer.from("<IDS|MSG>"),
		Buffer.from(""),
		Buffer.from(JSON.stringify(message.header)),
		Buffer.from(JSON.stringify(message.parent_header)),
		Buffer.from(JSON.stringify(message.metadata)),
		Buffer.from(JSON.stringify(message.content)),
	];
}

function asyncFrames(frames: Buffer[][]): AsyncIterable<Buffer[]> & { close(): void } {
	return {
		close: () => {},
		async *[Symbol.asyncIterator]() {
			for (const frame of frames) {
				await sleep(0);
				yield frame;
			}
		},
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(10);
	}
}

async function expectSettlesWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
	const result = await Promise.race([
		promise.then(() => "settled" as const),
		sleep(timeoutMs).then(() => "timeout" as const),
	]);
	expect(result).toBe("settled");
}

describe("AgentSession rlm recursion", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-recursion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		options: {
			depth?: number;
			maxDepth?: number;
			streamFn?: StreamFn;
			agentMessageController?: AgentSessionMessageController;
			subagentRuntimeHost?: SubagentRuntimeHost;
			rlmSessionDir?: string;
		} = {},
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "",
				tools: [],
				thinkingLevel: "off",
			},
			streamFn: options.streamFn ?? ((_model, context) => streamAnswer(`child answer: ${userText(context)}`)),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			agentMessageController: options.agentMessageController,
			subagentRuntimeHost: options.subagentRuntimeHost,
			rlmDepth: options.depth,
			rlmMaxDepth: options.maxDepth,
			rlmSessionDir: options.rlmSessionDir,
		});
		return session;
	}

	it("creates readable collision-resistant default subagent session names", () => {
		expect(createDefaultRlmSubagentSessionName("Summarize the HTTP API!", "sub-a1b2c3d4")).toBe(
			"subagent-summarize-the-http-api-a1b2c3d4",
		);
		expect(createDefaultRlmSubagentSessionName("Summarize the HTTP API!", "sub-eeeeffff")).not.toBe(
			createDefaultRlmSubagentSessionName("Summarize the HTTP API!", "sub-a1b2c3d4"),
		);
		expect(createDefaultRlmSubagentSessionName("same task", "sub-aBcDeFgH")).not.toBe(
			createDefaultRlmSubagentSessionName("same task", "sub-AbCdEfGh"),
		);
		expect(createDefaultRlmSubagentSessionName("x".repeat(200), "sub-a1b2c3d4")).toHaveLength(64);
	});

	it("lets the orchestrator choose a unique subagent session name", async () => {
		const root = createSession();
		const result = await root.runRlmChild("inspect the API", { name: "  api-reviewer  " });
		if (!result.session_dir) {
			throw new Error("Missing child session directory");
		}
		const childId = basename(result.session_dir);
		const childSession = root.getRlmChildSession(childId);
		if (!childSession) {
			throw new Error("Missing retained child session");
		}
		expect(childSession.sessionName).toBe("api-reviewer");
		expect(root.listRlmSubagents().subagents[0]?.session_name).toBe("api-reviewer");

		await expect(root.runRlmChild("collide with child id", { name: childId })).rejects.toThrow(
			`RLM subagent session name "${childId}" is already in use`,
		);
		await expect(root.runRlmChild("inspect another API", { name: "api-reviewer" })).rejects.toThrow(
			'RLM subagent session name "api-reviewer" is already in use',
		);
		await expect(
			root.runRlmChild("collide with retained session id", { name: childSession.sessionId }),
		).rejects.toThrow(`RLM subagent session name "${childSession.sessionId}" is already in use`);
		await expect(root.runRlmChild("invalid name", { name: "   " })).rejects.toThrow("rlm.run name must not be empty");
		await expect(root.runRlmChild("reserved name", { name: "all" })).rejects.toThrow(
			"Broadcast agent messaging is not supported",
		);
	});

	it("reserves a running child's current name after it is renamed", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage(`child answer: ${userText(context)}`),
					});
				});
				return stream;
			},
		});
		const runPromise = root.runRlmChild("rename while running", { name: "spawn-worker" });
		await waitFor(() => childStarted);
		const running = root.listRlmSubagents().subagents[0];
		if (!running) {
			throw new Error("Missing running child");
		}
		if (!running.session_id) {
			throw new Error("Missing running child session ID");
		}
		root.getRlmChildSession(running.rlm_child_id)?.setSessionName("renamed-running-worker");
		expect(root.listRlmSubagents().subagents[0]?.session_name).toBe("renamed-running-worker");

		await expect(root.runRlmChild("reuse renamed selector", { name: "renamed-running-worker" })).rejects.toThrow(
			'RLM subagent session name "renamed-running-worker" is already in use',
		);
		await expect(root.runRlmChild("reuse running session id", { name: running.session_id })).rejects.toThrow(
			`RLM subagent session name "${running.session_id}" is already in use`,
		);
		releaseChild();
		await runPromise;
	});

	it("makes an externally restored retained child listable and deletable", async () => {
		const childId = "restored-child";
		const childDir = join(tempDir, childId);
		mkdirSync(childDir, { recursive: true });
		const child = createSession({ rlmSessionDir: childDir });
		child.setSessionName("restored-worker");
		const disposeChild = vi.spyOn(child, "disposeAsync");
		const root = createSession();
		const childStatuses: string[] = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update" && event.child.id === childId) {
				childStatuses.push(event.child.status);
			}
		});

		expect(root.retainFinishedRlmChildSession(childId, child)).toBe(true);
		expect(root.listRlmSubagents().subagents).toEqual([
			expect.objectContaining({
				rlm_child_id: childId,
				session_name: "restored-worker",
				status: "completed",
			}),
		]);

		await expect(root.deleteRlmSubagent("restored-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: childId, session_name: "restored-worker" },
		});
		expect(disposeChild).toHaveBeenCalledOnce();
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		expect(childStatuses).toEqual(["cancelled"]);
	});

	it("hides a retained child after failed deletion and keeps it selector-retryable", async () => {
		const childId = "retained-retry-child";
		const childDir = join(tempDir, childId);
		mkdirSync(childDir, { recursive: true });
		const child = createSession({ rlmSessionDir: childDir });
		child.setSessionName("retained-retry-worker");
		let deleteAttempts = 0;
		const deleteRuntime = vi.fn(async (_childId: string, session: AgentSession) => {
			deleteAttempts++;
			if (deleteAttempts === 1) {
				throw new Error("retained close failed");
			}
			await session.disposeAsync();
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});
		expect(root.retainFinishedRlmChildSession(childId, child)).toBe(true);
		const retainedSnapshot = root.listRlmSubagents().subagents[0];
		if (!retainedSnapshot?.session_id) {
			throw new Error("Missing retained child session ID");
		}

		await expect(root.deleteRlmSubagent("retained-retry-worker")).rejects.toThrow("retained close failed");
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		expect((root as unknown as InspectableRlmSession)._retryableRlmSubagentDeletions.size).toBe(1);
		child.setSessionName("renamed-retry-worker");
		await expect(root.runRlmChild("reuse retry selector", { name: "retained-retry-worker" })).rejects.toThrow(
			'RLM subagent session name "retained-retry-worker" is already in use',
		);
		await expect(root.runRlmChild("reuse retry session ID", { name: retainedSnapshot.session_id })).rejects.toThrow(
			`RLM subagent session name "${retainedSnapshot.session_id}" is already in use`,
		);

		await expect(root.deleteRlmSubagent("retained-retry-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: childId, session_name: "retained-retry-worker" },
		});
		expect(deleteRuntime).toHaveBeenCalledTimes(2);
		expect((root as unknown as InspectableRlmSession)._retryableRlmSubagentDeletions.size).toBe(0);
	});

	it("makes an orchestrator-chosen name override a custom runtime's preexisting name", async () => {
		const hostedChild = createSession();
		hostedChild.setSessionName("factory-assigned-name");
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		await root.runRlmChild("inspect custom runtime", { name: "orchestrator-name" });

		expect(hostedChild.sessionName).toBe("orchestrator-name");
	});

	it("runs a child session under a sub directory and returns an RLM-shaped result", async () => {
		const root = createSession();
		const childUpdates: Array<{
			status: string;
			label: string;
			answerPreview?: string;
			tokenCount?: number;
			toolUseCount?: number;
		}> = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				childUpdates.push(event.child);
			}
		});

		const result = await root.runRlmChild("summarize shard 1");

		expect(result.answer).toBe("child answer: summarize shard 1");
		expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 });
		expect(result.turns).toBe(1);
		expect(result.session_dir).not.toBeNull();
		expect(basename(result.session_dir!)).toMatch(/^sub-/);
		expect(dirname(result.session_dir!)).toBe(root.sessionManager.getSessionArtifactDir());
		expect(existsSync(result.session_dir!)).toBe(true);
		expect(readdirSync(result.session_dir!).some((name) => name.endsWith(".jsonl"))).toBe(true);
		expect(childUpdates[0]?.status).toBe("running");
		expect(childUpdates[0]?.label).toBe("summarize shard 1");
		const doneUpdate = [...childUpdates].reverse().find((update) => update.status === "done");
		expect(doneUpdate?.answerPreview).toBe("child answer: summarize shard 1");
		// Context tokens from the child's own assistant usage (input 7 + output 3); no tools ran.
		expect(doneUpdate?.tokenCount).toBe(10);
		expect(doneUpdate?.toolUseCount).toBeUndefined();
	});

	it("lists a completed child with its parent-scoped messaging identity until disposal", async () => {
		let daemonChildId = "";
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({
					current: { activeSessionId: "parent-active", sessionId: "parent-session" },
					agents: [
						{
							activeSessionId: "other-child-active",
							sessionId: "other-child-session",
							runtimeKind: "subagent",
							cwd: tempDir,
							isStreaming: false,
							unfinishedActionCount: 0,
							parentActiveSessionId: "other-parent",
							rlmChildId: daemonChildId,
						},
						{
							activeSessionId: "child-active",
							sessionId: "child-session",
							runtimeKind: "subagent",
							cwd: tempDir,
							isStreaming: false,
							unfinishedActionCount: 0,
							parentActiveSessionId: "parent-active",
							rlmChildId: daemonChildId,
						},
					],
				}),
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});

		const result = await root.runRlmChild("retained worker");
		if (!result.session_dir) {
			throw new Error("Missing child session directory");
		}
		daemonChildId = basename(result.session_dir);

		expect(root.getRlmChildSession(daemonChildId)?.getLastAssistantText()).toBe("child answer: retained worker");
		const expectedSessionName = createDefaultRlmSubagentSessionName("retained worker", daemonChildId);
		expect(root.getRlmChildSession(daemonChildId)?.sessionName).toBe(expectedSessionName);
		const expectedRegistry = {
			subagents: [
				{
					rlm_child_id: daemonChildId,
					active_session_id: "child-active",
					session_id: "child-session",
					session_name: expectedSessionName,
					session_dir: result.session_dir,
					status: "completed",
				},
			],
		};
		expect(root.listRlmSubagents()).toEqual(expectedRegistry);
		const inspectable = root as unknown as InspectableRlmSession;
		const conflictingDeletion = {
			...expectedRegistry.subagents[0],
			rlm_child_id: "deleting-child",
			session_name: daemonChildId,
			status: "completed" as const,
		};
		inspectable._deletingRlmChildren.set("deleting-child", {
			subagent: conflictingDeletion,
			promise: Promise.resolve({ subagent: conflictingDeletion }),
		});
		await expect(root.deleteRlmSubagent(daemonChildId)).rejects.toThrow("is ambiguous");
		inspectable._deletingRlmChildren.delete("deleting-child");

		const handlers = inspectable._createKernelHostHandlers();
		const listHandler = handlers["rlm.list_subagents"];
		const deleteHandler = handlers["rlm.delete_subagent"];
		if (!listHandler || !deleteHandler) {
			throw new Error("Missing RLM subagent registry host handlers");
		}
		await expect(listHandler({})).resolves.toEqual(expectedRegistry);
		await expect(deleteHandler({ target: expectedSessionName })).resolves.toEqual({
			subagent: expectedRegistry.subagents[0],
		});
		expect(root.getRlmChildSession(daemonChildId)).toBeUndefined();
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(deleteHandler({ target: expectedSessionName })).rejects.toThrow("No direct RLM subagent matches");

		root.dispose();

		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("disposes an inline child when setting its session name fails", async () => {
		const root = createSession();
		const appendSessionInfo = vi.spyOn(SessionManager.prototype, "appendSessionInfo").mockImplementation(() => {
			throw new Error("session info failed");
		});
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		try {
			await expect(root.runRlmChild("inline naming failure", { name: "bad-name" })).rejects.toThrow(
				"session info failed",
			);
			expect(dispose).toHaveBeenCalled();
		} finally {
			appendSessionInfo.mockRestore();
			dispose.mockRestore();
		}
	});

	it("emits updated child session names after a retained child is renamed", async () => {
		const root = createSession();
		const events: unknown[] = [];
		root.subscribe((event) => events.push(event));

		const result = await root.runRlmChild("rename after completion", { name: "original-worker" });
		if (!result.session_dir) {
			throw new Error("Missing child session directory");
		}
		const childId = basename(result.session_dir);
		const child = root.getRlmChildSession(childId);
		if (!child) {
			throw new Error("Missing retained child session");
		}

		child.setSessionName("renamed-worker");

		const childUpdates = events.filter(
			(event): event is { type: "rlm_child_update"; child: { sessionName?: string } } =>
				typeof event === "object" && event !== null && (event as { type?: string }).type === "rlm_child_update",
		);
		expect(childUpdates.at(-1)?.child.sessionName).toBe("renamed-worker");
	});

	it("surfaces a child's recap on its snapshot once the summarizer sets it", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
				});
				return stream;
			},
		});

		const recaps: Array<string | undefined> = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				recaps.push(event.child.recap);
			}
		});

		const runPromise = root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const rootRun = [...(root as unknown as InspectableRlmSession)._activeRlmChildRuns.values()][0];
		if (!rootRun?.session) {
			throw new Error("Missing child session on root run");
		}
		expect(root.listRlmSubagents()).toEqual({
			subagents: [
				{
					rlm_child_id: rootRun.id,
					active_session_id: null,
					session_id: rootRun.session.sessionId,
					session_name: createDefaultRlmSubagentSessionName("slow shard", rootRun.id),
					session_dir: rootRun.sessionDir,
					status: "running",
				},
			],
		});

		// What the daemon summarizer does for subagents: stash the recap on the session,
		// which emits recap_update and re-emits the parent's enriched child snapshot.
		rootRun.session.setCurrentRecap("Summarizing the slow shard");
		await waitFor(() => recaps.includes("Summarizing the slow shard"));

		releaseChild();
		await runPromise;
	});

	it("runs a child agent without requiring ripgrep", async () => {
		const streamFn = vi.fn((_model, context: Context) => streamAnswer(`child answer: ${userText(context)}`));
		const root = createSession({ streamFn });

		const result = await root.runRlmChild("summarize shard 1");

		expect(result.answer).toBe("child answer: summarize shard 1");
		expect(streamFn).toHaveBeenCalledOnce();
	});

	it("adds child usage to the parent session aggregate", async () => {
		const root = createSession();
		const parentAssistant = assistantMessage("running ipython", usage(0, 0));
		root.agent.state.messages.push(parentAssistant);
		root.sessionManager.appendMessage(parentAssistant);

		const before = root.getSessionStats();
		const result = await root.runRlmChild("summarize shard 2");
		const after = root.getSessionStats();

		expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 });
		expect(after.tokens.input).toBe(before.tokens.input + result.usage.prompt_tokens);
		expect(after.tokens.output).toBe(before.tokens.output + result.usage.completion_tokens);
		expect(after.tokens.total).toBe(
			before.tokens.total + result.usage.prompt_tokens + result.usage.completion_tokens,
		);
		expect(after.cost).toBe(before.cost + 10);
		expect(parentAssistant.usage.totalTokens).toBe(0);

		const parentEntry = root.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message === parentAssistant);
		if (!parentEntry || parentEntry.type !== "message" || parentEntry.message.role !== "assistant") {
			throw new Error("parent assistant entry was not recorded");
		}
		expect(parentEntry.message.usage.input).toBe(result.usage.prompt_tokens);
		expect(parentEntry.message.usage.output).toBe(result.usage.completion_tokens);
		expect(parentEntry.message.usage.cost.total).toBe(10);

		const sessionFile = root.sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("parent session file was not created");
		}
		expect(readFileSync(sessionFile, "utf-8")).toContain('"type":"child_usage_attributed"');

		const reloaded = SessionManager.open(sessionFile, join(tempDir, "sessions"));
		const reloadedAttribution = reloaded.getEntries().find((entry) => entry.type === "child_usage_attributed");
		if (!reloadedAttribution || reloadedAttribution.type !== "child_usage_attributed") {
			throw new Error("child usage attribution entry was not persisted");
		}
		expect(reloadedAttribution.childUsage.input).toBe(result.usage.prompt_tokens);
		expect(reloadedAttribution.childUsage.output).toBe(result.usage.completion_tokens);
		expect(reloadedAttribution.aggregateUsage.input).toBe(result.usage.prompt_tokens);
		expect(reloadedAttribution.aggregateUsage.output).toBe(result.usage.completion_tokens);
		expect(reloadedAttribution.aggregateUsage.cost.total).toBe(10);

		const reloadedParentEntry = reloaded.getEntries().find((entry) => entry.type === "message");
		if (
			!reloadedParentEntry ||
			reloadedParentEntry.type !== "message" ||
			reloadedParentEntry.message.role !== "assistant"
		) {
			throw new Error("reloaded parent assistant entry was not recorded");
		}
		expect(reloadedParentEntry.message.usage.input).toBe(result.usage.prompt_tokens);
		expect(reloadedParentEntry.message.usage.output).toBe(result.usage.completion_tokens);
		expect(reloadedParentEntry.message.usage.cost.total).toBe(10);
	});

	it("rejects child creation at the configured recursion depth cap", async () => {
		const root = createSession({ depth: 1, maxDepth: 1 });

		await expect(root.runRlmChild("nested")).rejects.toThrow("RLM recursion depth limit reached");
	});

	it("rejects unsupported rlm.run kwargs loudly", async () => {
		const root = createSession();

		await expect(root.runRlmChild("nested", { temperature: 0 })).rejects.toThrow(
			"Unsupported rlm.run kwargs: temperature",
		);
	});

	it("cancels active rlm children when the parent session is disposed", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});

		const runPromise = root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const run = [...runs.values()][0];

		root.dispose();

		expect(run.status).toBe("cancelled");
		expect(run.error).toBe("Parent session disposed");
		releaseChild();
		await expect(runPromise).rejects.toThrow();
	});

	it("cancels active rlm children when the parent session is aborted", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});

		const runPromise = root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const run = [...runs.values()][0];

		await root.abort();

		expect(run.status).toBe("cancelled");
		expect(run.error).toBe("Parent session aborted");
		releaseChild();
		await expect(runPromise).rejects.toThrow("Parent session aborted");
	});

	it("does not cancel active rlm children when only the parent turn is interrupted", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});

		const runPromise = root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const run = [...runs.values()][0];

		root.requestAbort();

		expect(run.status).toBe("running");
		expect(run.error).toBeUndefined();
		releaseChild();
		await expect(runPromise).resolves.toMatchObject({ answer: "child answer: slow shard" });
	});

	it("cancels a single rlm child run by id and reports unknown ids", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});
		const childStatuses: string[] = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				childStatuses.push(event.child.status);
			}
		});

		const runPromise = root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const childId = [...runs.keys()][0];
		if (!childId) {
			throw new Error("Missing child run id");
		}
		const run = runs.get(childId);

		expect(root.cancelRlmChildRun("unknown-child")).toBe(false);
		expect(run?.status).toBe("running");

		expect(root.cancelRlmChildRun(childId)).toBe(true);
		expect(run?.status).toBe("cancelled");
		expect(run?.error).toBe("Cancelled by user");
		// The cancelled update is pushed at cancel time, before the (possibly
		// stuck) child unwinds; viewers must not keep showing a running child.
		expect(childStatuses[childStatuses.length - 1]).toBe("cancelled");
		releaseChild();
		await expect(runPromise).rejects.toThrow("Cancelled by user");
		expect(childStatuses[childStatuses.length - 1]).toBe("cancelled");
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });

		// The run has finished; a second cancel finds nothing to stop.
		expect(root.cancelRlmChildRun(childId)).toBe(false);
	});

	it("does not let completion retention resurrect a child being deleted", async () => {
		let releaseRetention: () => void = () => {};
		const retentionGate = new Promise<void>((resolve) => {
			releaseRetention = resolve;
		});
		let releaseStarted = false;
		const hostedChild = createSession();
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: async (_childId, child) => {
					await child.disposeAsync();
				},
				releaseRlmSubagentRuntime: async (runtime, options, status) => {
					if (status !== "done") {
						await runtime.session.disposeAsync();
						return;
					}
					releaseStarted = true;
					await retentionGate;
					if (!options.parentSession.retainFinishedRlmChildSession(options.id, runtime.session)) {
						await runtime.session.disposeAsync();
					}
				},
			},
		});

		const runPromise = root.runRlmChild("fast child", { name: "fast-worker" });
		const runFailure = expect(runPromise).rejects.toThrow("Deleted by parent orchestrator");
		await waitFor(() => releaseStarted);
		const completed = root.listRlmSubagents().subagents[0];
		if (!completed) {
			throw new Error("Missing completed child during release");
		}
		const deletion = root.deleteRlmSubagent("fast-worker");
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(deletion).resolves.toEqual({ subagent: completed });
		await runFailure;
		releaseRetention();
		await Promise.resolve();

		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("keeps failed closure retryable without hanging or late resurrection", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const childDir = join(tempDir, "release-failure-child");
		const hostedChild = createSession({
			rlmSessionDir: childDir,
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
				});
				return stream;
			},
		});
		let deleteAttempts = 0;
		const deleteRuntime = vi.fn(async (_childId: string, child: AgentSession) => {
			deleteAttempts++;
			if (deleteAttempts === 1) {
				throw new Error("close failed");
			}
			await child.disposeAsync();
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
				releaseRlmSubagentRuntime: async () => {
					throw new Error("release failed");
				},
			},
		});

		const runPromise = root.runRlmChild("slow release", { name: "release-worker" });
		await waitFor(() => childStarted);
		const runFailure = expect(runPromise).rejects.toThrow("Deleted by parent orchestrator");
		const deletion = root.deleteRlmSubagent("release-worker");
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(deletion).rejects.toThrow("close failed");
		await runFailure;
		expect((root as unknown as InspectableRlmSession)._activeRlmChildRuns.size).toBe(0);
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });

		// The failed close remains directly retryable by the original selector even
		// though the cancelled child is hidden from the public registry.
		await expect(root.deleteRlmSubagent("release-worker")).resolves.toMatchObject({
			subagent: { session_name: "release-worker" },
		});
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		releaseChild();
		await Promise.resolve();
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("does not restore failed delete retry state after parent teardown", async () => {
		let rejectDelete: (error: Error) => void = () => {};
		const deleteGate = new Promise<void>((_resolve, reject) => {
			rejectDelete = reject;
		});
		let childStarted = false;
		const hostedChild = createSession({
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				return stream;
			},
		});
		const deleteRuntime = vi.fn(async () => {
			await deleteGate;
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});

		const runPromise = root.runRlmChild("delete during parent teardown", { name: "teardown-worker" });
		const runFailure = expect(runPromise).rejects.toThrow("Deleted by parent orchestrator");
		await waitFor(() => childStarted);
		const deletion = root.deleteRlmSubagent("teardown-worker");
		const deletionFailure = expect(deletion).rejects.toThrow("close failed during teardown");
		await waitFor(() => deleteRuntime.mock.calls.length === 1);

		await root.disposeAsync();
		rejectDelete(new Error("close failed during teardown"));
		await deletionFailure;
		await runFailure;

		const internals = root as unknown as InspectableRlmSession;
		expect(internals._activeRlmChildRuns.size).toBe(0);
		expect(internals._retainedRlmChildSessions.size).toBe(0);
		expect(internals._retainedRlmChildUnsubscribes.size).toBe(0);
		expect(internals._retryableRlmSubagentDeletions.size).toBe(0);
	});

	it("drops a hidden delete retry after detached runtime release succeeds", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const hostedChild = createSession({
			streamFn: (_model, context) => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(userText(context)) });
				});
				return stream;
			},
		});
		const releaseRuntime = vi.fn(async () => {
			await hostedChild.disposeAsync();
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: async () => {
					throw new Error("close failed");
				},
				releaseRlmSubagentRuntime: releaseRuntime,
			},
		});

		const runPromise = root.runRlmChild("release after failed close", { name: "eventual-release-worker" });
		const runFailure = expect(runPromise).rejects.toThrow("Deleted by parent orchestrator");
		await waitFor(() => childStarted);
		await expect(root.deleteRlmSubagent("eventual-release-worker")).rejects.toThrow("close failed");
		await runFailure;
		const internals = root as unknown as InspectableRlmSession;
		expect(internals._retryableRlmSubagentDeletions.size).toBe(1);

		releaseChild();
		await waitFor(() => releaseRuntime.mock.calls.length === 1);
		await waitFor(() => internals._retryableRlmSubagentDeletions.size === 0);
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(root.deleteRlmSubagent("eventual-release-worker")).rejects.toThrow("No direct RLM subagent matches");
	});

	it("does not expose a cancelled child when release cleanup fails", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const hostedChild = createSession({
			streamFn: (_model, context) => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(userText(context)) });
				});
				return stream;
			},
		});
		const disposeHostedChild = vi.spyOn(hostedChild, "disposeAsync");
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: async () => {},
				releaseRlmSubagentRuntime: async () => {
					throw new Error("release failed");
				},
			},
		});

		const runPromise = root.runRlmChild("cancel before failed release", { name: "cancelled-worker" });
		await waitFor(() => childStarted);
		const childId = root.listRlmSubagents().subagents[0]?.rlm_child_id;
		expect(childId).toBeTruthy();
		expect(root.cancelRlmChildRun(childId as string)).toBe(true);
		releaseChild();

		await expect(runPromise).rejects.toThrow();
		expect(disposeHostedChild).toHaveBeenCalledOnce();
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("deletes a queued child without waiting for blocked startup", async () => {
		let releaseRuntimeCreation: () => void = () => {};
		const runtimeCreationGate = new Promise<void>((resolve) => {
			releaseRuntimeCreation = resolve;
		});
		let runtimeCreationStarted = false;
		const hostedChild = createSession();
		const releaseRuntime = vi.fn(async () => {
			await hostedChild.disposeAsync();
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					runtimeCreationStarted = true;
					await runtimeCreationGate;
					return { session: hostedChild };
				},
				deleteRlmSubagentRuntime: async () => {},
				releaseRlmSubagentRuntime: releaseRuntime,
			},
		});
		const runPromise = root.runRlmChild("blocked before runtime creation", { name: "queued-worker" });
		const runFailure = expect(runPromise).rejects.toThrow("Deleted by parent orchestrator");
		await waitFor(() => runtimeCreationStarted);
		const queued = root.listRlmSubagents().subagents[0];
		expect(queued).toBeDefined();

		await expect(root.deleteRlmSubagent("queued-worker")).resolves.toEqual({ subagent: queued });
		await runFailure;
		expect((root as unknown as InspectableRlmSession)._activeRlmChildRuns.size).toBe(1);
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(root.runRlmChild("replacement", { name: "queued-worker" })).rejects.toThrow("already in use");

		releaseRuntimeCreation();
		await waitFor(() => releaseRuntime.mock.calls.length === 1);
		await waitFor(() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.size === 0);
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("keeps late startup cleanup retryable when release and fallback delete fail", async () => {
		let releaseRuntimeCreation: () => void = () => {};
		const runtimeCreationGate = new Promise<void>((resolve) => {
			releaseRuntimeCreation = resolve;
		});
		let runtimeCreationStarted = false;
		const hostedChild = createSession();
		const disposeHostedChild = vi.spyOn(hostedChild, "disposeAsync");
		let deleteAttempts = 0;
		const deleteRuntime = vi.fn(async () => {
			deleteAttempts++;
			if (deleteAttempts === 1) {
				throw new Error("fallback delete failed");
			}
			await hostedChild.disposeAsync();
		});
		const releaseRuntime = vi.fn(async () => {
			throw new Error("cancelled release failed");
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					runtimeCreationStarted = true;
					await runtimeCreationGate;
					return { session: hostedChild };
				},
				deleteRlmSubagentRuntime: deleteRuntime,
				releaseRlmSubagentRuntime: releaseRuntime,
			},
		});

		const runPromise = root.runRlmChild("delete during runtime creation", { name: "starting-worker" });
		const runFailure = expect(runPromise).rejects.toThrow("Deleted by parent orchestrator");
		await waitFor(() => runtimeCreationStarted);
		const starting = root.listRlmSubagents().subagents[0];
		expect(starting).toBeDefined();

		await expect(root.deleteRlmSubagent("starting-worker")).resolves.toEqual({ subagent: starting });
		await runFailure;
		expect(deleteRuntime).not.toHaveBeenCalled();
		releaseRuntimeCreation();

		const internals = root as unknown as InspectableRlmSession;
		await waitFor(() => releaseRuntime.mock.calls.length === 1);
		await waitFor(() => internals._retryableRlmSubagentDeletions.size === 1);
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		expect(deleteRuntime).toHaveBeenCalledTimes(1);
		expect(disposeHostedChild).not.toHaveBeenCalled();

		await internals._reapDeletedRlmSubagentRuntimesAfterCompaction();
		expect(deleteRuntime).toHaveBeenCalledTimes(2);
		expect(disposeHostedChild).toHaveBeenCalledOnce();
		expect(internals._retryableRlmSubagentDeletions.size).toBe(0);
	});

	it("deletes a running direct child by name and waits for runtime cleanup", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
				});
				return stream;
			},
		});

		const runPromise = root.runRlmChild("slow named shard", { name: "slow-worker" });
		await waitFor(() => childStarted);
		const running = root.listRlmSubagents().subagents[0];
		if (!running) {
			throw new Error("Missing running child registry entry");
		}
		const runFailure = expect(runPromise).rejects.toThrow("Deleted by parent orchestrator");
		const deletion = root.deleteRlmSubagent("slow-worker");
		const duplicateDeletion = root.deleteRlmSubagent(running.rlm_child_id);
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(deletion).resolves.toEqual({ subagent: running });
		await expect(duplicateDeletion).resolves.toEqual({ subagent: running });
		await runFailure;
		releaseChild();
		expect(root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("cancels nested rlm child runs through the root session", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let releaseNested: () => void = () => {};
		const nestedRelease = new Promise<void>((resolve) => {
			releaseNested = resolve;
		});
		let childStarted = false;
		let nestedStarted = false;
		const root = createSession({
			maxDepth: 2,
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				} else if (text === "nested shard") {
					nestedStarted = true;
					void nestedRelease.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});

		const runPromise = root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const rootRuns = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		const rootRun = [...rootRuns.values()][0];
		if (!rootRun?.session) {
			throw new Error("Missing child session on root run");
		}

		const childSession = rootRun.session;
		const nestedPromise = childSession.runRlmChild("nested shard");
		await waitFor(() => nestedStarted);
		const nestedRuns = (childSession as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(nestedRuns.size).toBe(1);
		const nestedId = [...nestedRuns.keys()][0];
		if (!nestedId) {
			throw new Error("Missing nested run id");
		}

		await expect(root.deleteRlmSubagent(nestedId)).rejects.toThrow("No direct RLM subagent matches");
		expect(root.cancelRlmChildRun(nestedId)).toBe(true);
		releaseNested();
		await expect(nestedPromise).rejects.toThrow("Cancelled by user");
		expect(rootRun.status).toBe("running");

		releaseChild();
		await expect(runPromise).resolves.toMatchObject({ answer: "child answer: slow shard" });
	});

	it("runs parallel rlm comm requests independently", async () => {
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let releaseChildren: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChildren = resolve;
		});
		const replies: CapturedCommReply[] = [];
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async ({ prompt }) => {
					active++;
					started++;
					maxActive = Math.max(maxActive, active);
					await release;
					active--;
					return {
						answer: `answer:${prompt}`,
						usage: { prompt_tokens: 1, completion_tokens: 1 },
						turns: 1,
						session_dir: null,
						model: "test/model",
					};
				}),
			},
		});

		try {
			const kernel = manager as unknown as KernelCommTestApi;
			kernel.sendCommMessage = async (commId, data) => {
				replies.push({ commId, data });
			};

			kernel.handleCommMessage(rlmCommOpen("comm-a", "first"));
			kernel.handleCommMessage(rlmCommOpen("comm-b", "second"));

			await waitFor(() => started === 2);
			expect(maxActive).toBe(2);

			releaseChildren();
			await waitFor(() => replies.length === 2);

			const byCommId = new Map(replies.map((reply) => [reply.commId, reply.data]));
			expect(byCommId.get("comm-a")).toEqual({
				status: "ok",
				answer: "answer:first",
				usage: { prompt_tokens: 1, completion_tokens: 1 },
				turns: 1,
				session_dir: null,
				model: "test/model",
			});
			expect(byCommId.get("comm-b")).toEqual({
				status: "ok",
				answer: "answer:second",
				usage: { prompt_tokens: 1, completion_tokens: 1 },
				turns: 1,
				session_dir: null,
				model: "test/model",
			});
		} finally {
			await manager.dispose();
		}
	});

	it("handles rlm comm requests from the iopub pump outside active execution", async () => {
		const replies: CapturedCommReply[] = [];
		let promptSeen = "";
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async ({ prompt }) => {
					promptSeen = prompt;
					return {
						answer: `answer:${prompt}`,
						usage: { prompt_tokens: 1, completion_tokens: 1 },
						turns: 1,
						session_dir: null,
						model: "test/model",
					};
				}),
			},
		});

		try {
			const kernel = manager as unknown as KernelCommTestApi & KernelPumpTestApi;
			kernel.sendCommMessage = async (commId, data) => {
				replies.push({ commId, data });
			};
			kernel.iopub = asyncFrames([encodeTestMessage(rlmCommOpen("comm-detached", "detached child"))]);

			kernel.startIopubPump();

			await waitFor(() => replies.length === 1);

			expect(promptSeen).toBe("detached child");
			expect(replies[0]).toEqual({
				commId: "comm-detached",
				data: {
					status: "ok",
					answer: "answer:detached child",
					usage: { prompt_tokens: 1, completion_tokens: 1 },
					turns: 1,
					session_dir: null,
					model: "test/model",
				},
			});
		} finally {
			await manager.dispose();
		}
	});

	it("handles rlm calls from asyncio tasks after the scheduling cell is idle", async () => {
		const prompts: string[] = [];
		const manager = new KernelManager({
			cwd: tempDir,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async ({ prompt }) => {
					prompts.push(prompt);
					return {
						answer: `answer:${prompt}`,
						usage: { prompt_tokens: 1, completion_tokens: 1 },
						turns: 1,
						session_dir: null,
						model: "test/model",
					};
				}),
			},
		});

		try {
			const scheduled = await manager.execute(`
import asyncio
import rlm

async def _delayed_rlm():
    await asyncio.sleep(0.05)
    return await rlm.run("detached child after idle")

_task = asyncio.create_task(_delayed_rlm())
print("scheduled")
`);

			expect(scheduled.status).toBe("ok");
			expect(scheduled.stdout.trim()).toBe("scheduled");
			await waitFor(() => prompts.includes("detached child after idle"));

			const finished = await manager.execute(`
_result = await _task
print(_result.answer)
`);

			expect(finished.status).toBe("ok");
			expect(finished.stdout.trim()).toBe("answer:detached child after idle");
		} finally {
			await manager.dispose();
		}
	});

	it("clears active execution when execute_request send fails", async () => {
		const manager = new KernelManager({ python: process.execPath });
		const kernel = manager as unknown as KernelExecuteTestApi;
		const sendError = new Error("send failed");
		kernel.start = async () => {};
		kernel.state = "running";
		kernel.shell = {
			send: async (_frames: Buffer[]) => {
				throw sendError;
			},
			close: () => {},
		};
		kernel.connection = {
			ip: "127.0.0.1",
			transport: "tcp",
			shell_port: 1,
			iopub_port: 2,
			stdin_port: 3,
			control_port: 4,
			hb_port: 5,
			signature_scheme: "hmac-sha256",
			key: "",
			kernel_name: "python3",
		};

		try {
			await expect(manager.execute("print('hello')")).rejects.toThrow("send failed");
			expect(kernel.activeExecution).toBeUndefined();
		} finally {
			await manager.dispose();
		}
	});

	it("rejects removed background rlm comm request types", async () => {
		const replies: CapturedCommReply[] = [];
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async () => ({
					answer: "unused",
					usage: { prompt_tokens: 1, completion_tokens: 1 },
					turns: 1,
					session_dir: null,
					model: "test/model",
				})),
			},
		});

		try {
			const kernel = manager as unknown as KernelCommTestApi;
			kernel.sendCommMessage = async (commId, data) => {
				replies.push({ commId, data });
			};

			kernel.handleCommMessage(rlmCommOpenData("comm-bg", { type: "background", prompt: "slow", kwargs: {} }));

			await waitFor(() => replies.length === 1);

			expect(replies[0]).toEqual({
				commId: "comm-bg",
				data: {
					status: "error",
					error: 'host request type "background" is not available in this session',
				},
			});
		} finally {
			await manager.dispose();
		}
	});

	it("waits for in-flight rlm comm work during dispose and buffers failures", async () => {
		let started = false;
		let handlerSettled = false;
		let released = false;
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = () => {
				if (released) return;
				released = true;
				resolve();
			};
		});
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async () => {
					started = true;
					try {
						await release;
						throw new Error("child failed after dispose");
					} finally {
						handlerSettled = true;
					}
				}),
			},
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			const kernel = manager as unknown as KernelCommTestApi;

			kernel.handleCommMessage(rlmCommOpen("comm-dispose", "slow child"));

			await waitFor(() => started);
			const disposePromise = manager.dispose();
			let disposeSettled = false;
			const trackedDispose = disposePromise.then(() => {
				disposeSettled = true;
			});

			await sleep(25);
			expect(disposeSettled).toBe(false);

			releaseChild();
			await expectSettlesWithin(trackedDispose, 1000);
			expect(handlerSettled).toBe(true);

			const kernelStderr = (manager as unknown as { kernelStderr: string }).kernelStderr;
			expect(kernelStderr).toContain("[kernel] host request failed for comm comm-dispose");
			expect(kernelStderr).toContain("[kernel] failed to send host request error reply for comm comm-dispose");
			expect(stderrSpy).not.toHaveBeenCalled();
		} finally {
			releaseChild();
			await manager.dispose();
			stderrSpy.mockRestore();
		}
	});
});

interface InspectableRlmDirSession {
	_ensureRlmSessionDir(): string | undefined;
	_rlmKernelEnv(): Record<string, string>;
}

describe("AgentSession RLM session dir", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		sessionManager: SessionManager,
		agentDir?: string,
		serperKey?: string,
		loadWebsearchSkill = false,
		rlmSessionDir?: string,
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		if (serperKey !== undefined) {
			authStorage.set("serper", { type: "api_key", key: serperKey });
		}
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: () => streamAnswer("ignored"),
		});
		const skills: Skill[] = loadWebsearchSkill
			? [
					{
						kind: "markdown",
						name: "websearch",
						description: "",
						filePath: "/x/websearch/SKILL.md",
						baseDir: "/x/websearch",
						sourceInfo: createSyntheticSourceInfo("/x/websearch/SKILL.md", { source: "package" }),
						disableModelInvocation: false,
					},
				]
			: [];
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			agentDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({ skills }),
			rlmSessionDir,
		});
		return session;
	}

	it("does not create a /tmp dir or set RLM_SESSION_DIR for a non-persisted session", () => {
		const root = createSession(SessionManager.inMemory(tempDir));
		const inspectable = root as unknown as InspectableRlmDirSession;

		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("prime-agent-rlm-"));

		expect(inspectable._ensureRlmSessionDir()).toBeUndefined();
		const env = inspectable._rlmKernelEnv();
		expect(env.RLM_SESSION_DIR).toBeUndefined();
		expect(env.RLM_HARNESS_STATE_DIR).toBeUndefined();
		expect(env.RLM_GLOBAL_HARNESS_STATE_DIR).toBeDefined();
		expect(env).toMatchObject({ RLM_DEPTH: "0" });

		const after = readdirSync(tmpdir()).filter((name) => name.startsWith("prime-agent-rlm-"));
		expect(after).toEqual(before);
	});

	it("uses the persistent artifact dir and sets RLM_SESSION_DIR for a persisted session", () => {
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const root = createSession(sessionManager);
		const inspectable = root as unknown as InspectableRlmDirSession;

		const artifactDir = sessionManager.getSessionArtifactDir();
		expect(artifactDir).toBeDefined();
		expect(inspectable._ensureRlmSessionDir()).toBe(artifactDir);
		expect(inspectable._rlmKernelEnv().RLM_SESSION_DIR).toBe(artifactDir);
		expect(inspectable._rlmKernelEnv().RLM_HARNESS_STATE_DIR).toBe(join(artifactDir!, "harness"));
		expect(inspectable._rlmKernelEnv().RLM_GLOBAL_HARNESS_STATE_DIR).toBeDefined();
	});

	it("points RLM_HARNESS_STATE_DIR at the session's own artifact dir for subagent sessions", () => {
		// Subagent layout: the parent assigns rlmSessionDir, but the child's own
		// sessionManager persists artifacts (and reads local harness state) elsewhere.
		const subDir = join(tempDir, "parent-artifact", "sub-abc12345");
		mkdirSync(subDir, { recursive: true });
		const sessionManager = SessionManager.create(tempDir, subDir);
		const root = createSession(sessionManager, undefined, undefined, false, subDir);
		const inspectable = root as unknown as InspectableRlmDirSession;

		const artifactDir = sessionManager.getSessionArtifactDir();
		expect(artifactDir).toBeDefined();
		expect(artifactDir).not.toBe(subDir);
		const env = inspectable._rlmKernelEnv();
		expect(env.RLM_SESSION_DIR).toBe(subDir);
		expect(env.RLM_HARNESS_STATE_DIR).toBe(join(artifactDir!, "harness"));
	});

	it("falls back to the rlm session dir for RLM_HARNESS_STATE_DIR without an artifact dir", () => {
		const ephemeralDir = join(tempDir, "ephemeral-rlm");
		mkdirSync(ephemeralDir, { recursive: true });
		const root = createSession(SessionManager.inMemory(tempDir), undefined, undefined, false, ephemeralDir);
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.RLM_SESSION_DIR).toBe(ephemeralDir);
		expect(env.RLM_HARNESS_STATE_DIR).toBe(join(ephemeralDir, "harness"));
	});

	it("loads the ephemeral RLM harness path into the host system prompt", () => {
		const ephemeralDir = join(tempDir, "ephemeral-rlm");
		mkdirSync(join(ephemeralDir, "harness"), { recursive: true });
		writeFileSync(
			join(ephemeralDir, "harness", "harness_state.json"),
			JSON.stringify({
				schema: 1,
				entries: {
					prompt: {},
					memory: {
						ephemeral_note: {
							id: "ephemeral_note",
							kind: "memory",
							title: "Ephemeral note",
							content: "Loaded from the RLM session harness path.",
							path: "000",
							scope: "local",
							reference: {},
							arguments: {},
							metadata: {},
							source: "test",
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-01T00:00:00.000Z",
							version: 1,
						},
					},
					skill: {},
					subagent: {},
				},
				refinements: [],
			}),
			"utf8",
		);
		const root = createSession(SessionManager.inMemory(tempDir), undefined, undefined, false, ephemeralDir);

		const prompt = root.systemPrompt;

		expect(prompt).toContain("Ephemeral note");
		expect(prompt).toContain("Loaded from the RLM session harness path.");
	});

	it("exports the configured agentDir to the kernel so skills find auth.json", () => {
		const agentDir = join(tempDir, "custom-agent-dir");
		const root = createSession(SessionManager.inMemory(tempDir), agentDir);
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(agentDir);
	});

	it("omits the agentDir env var when none is configured", () => {
		const root = createSession(SessionManager.inMemory(tempDir));
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBeUndefined();
	});

	it("exports agentDir but skips key injection when no websearch skill is loaded", () => {
		const agentDir = join(tempDir, "custom-agent-dir");
		const root = createSession(SessionManager.inMemory(tempDir), agentDir, "stored-key", false);
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(agentDir);
		expect(env.SERPER_API_KEY).toBeUndefined();
	});

	it("injects the key for a custom websearch skill even when bundled is off", () => {
		const previous = process.env.SERPER_API_KEY;
		delete process.env.SERPER_API_KEY;
		try {
			// loadWebsearchSkill=true models a --skill/project websearch; the bundled
			// setting is irrelevant because the gate checks the loaded skill, not settings.
			const root = createSession(SessionManager.inMemory(tempDir), undefined, "custom-key", true);
			const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
			expect(env.SERPER_API_KEY).toBe("custom-key");
		} finally {
			if (previous === undefined) delete process.env.SERPER_API_KEY;
			else process.env.SERPER_API_KEY = previous;
		}
	});

	it("injects a literal stored Serper key into the kernel", () => {
		const previous = process.env.SERPER_API_KEY;
		delete process.env.SERPER_API_KEY;
		try {
			const root = createSession(SessionManager.inMemory(tempDir), undefined, "literal-serper-key", true);
			const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
			expect(env.SERPER_API_KEY).toBe("literal-serper-key");
		} finally {
			if (previous === undefined) delete process.env.SERPER_API_KEY;
			else process.env.SERPER_API_KEY = previous;
		}
	});

	it("resolves an env-var-reference Serper key before injecting it", () => {
		const previousKey = process.env.SERPER_API_KEY;
		const previousRef = process.env.MY_SERPER_REF;
		delete process.env.SERPER_API_KEY;
		process.env.MY_SERPER_REF = "resolved-secret";
		try {
			const root = createSession(SessionManager.inMemory(tempDir), undefined, "MY_SERPER_REF", true);
			const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
			expect(env.SERPER_API_KEY).toBe("resolved-secret");
		} finally {
			if (previousKey === undefined) delete process.env.SERPER_API_KEY;
			else process.env.SERPER_API_KEY = previousKey;
			if (previousRef === undefined) delete process.env.MY_SERPER_REF;
			else process.env.MY_SERPER_REF = previousRef;
		}
	});
});
