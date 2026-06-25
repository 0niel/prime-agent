import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { KernelManager } from "../src/core/kernel/index.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createRlmRunHostHandler } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { MISSING_RIPGREP_MESSAGE } from "../src/utils/tools-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const toolsManagerMock = vi.hoisted(() => ({
	ensureTool: vi.fn(async (): Promise<string | undefined> => "rg"),
}));

vi.mock("../src/utils/tools-manager.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/tools-manager.js")>();
	return {
		...actual,
		ensureTool: toolsManagerMock.ensureTool,
	};
});

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
	abort: () => void;
	status: string;
	error?: string;
	session?: AgentSession;
}

interface InspectableRlmSession {
	_activeRlmChildRuns: Map<string, InspectableRlmRun>;
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
		toolsManagerMock.ensureTool.mockReset();
		toolsManagerMock.ensureTool.mockResolvedValue("rg");
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(options: { depth?: number; maxDepth?: number; streamFn?: StreamFn } = {}): AgentSession {
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
			rlmDepth: options.depth,
			rlmMaxDepth: options.maxDepth,
		});
		return session;
	}

	it("runs a child session under a sub directory and returns an RLM-shaped result", async () => {
		const root = createSession();
		const childUpdates: Array<{
			status: string;
			label: string;
			answerPreview?: string;
			transcript: readonly { role: string; text: string }[];
			structuredTranscript?: readonly { type: string; role: string; text: string }[];
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
		expect(doneUpdate?.transcript).toContainEqual({ role: "user", text: "summarize shard 1" });
		expect(doneUpdate?.transcript).toContainEqual({ role: "assistant", text: "child answer: summarize shard 1" });
		expect(doneUpdate?.structuredTranscript).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "message", role: "user", text: "summarize shard 1" }),
				expect.objectContaining({ type: "message", role: "assistant", text: "child answer: summarize shard 1" }),
			]),
		);
	});

	it("surfaces missing ripgrep as one child-agent error before model work starts", async () => {
		toolsManagerMock.ensureTool.mockResolvedValueOnce(undefined);
		const streamFn = vi.fn((_model, context: Context) => streamAnswer(`child answer: ${userText(context)}`));
		const root = createSession({ streamFn });
		const childUpdates: Array<{ status: string; transcript: readonly { role: string; text: string }[] }> = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				childUpdates.push(event.child);
			}
		});

		await expect(root.runRlmChild("summarize shard 1")).rejects.toThrow(MISSING_RIPGREP_MESSAGE);

		expect(toolsManagerMock.ensureTool).toHaveBeenCalledWith("rg", true);
		expect(streamFn).not.toHaveBeenCalled();
		const errorUpdate = [...childUpdates].reverse().find((update) => update.status === "error");
		expect(errorUpdate?.transcript).toContainEqual({ role: "system", text: MISSING_RIPGREP_MESSAGE });
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

		await expect(root.runRlmChild("nested", { model: "other-model" })).rejects.toThrow(
			"Unsupported rlm.run kwargs: model",
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

		// The run has finished; a second cancel finds nothing to stop.
		expect(root.cancelRlmChildRun(childId)).toBe(false);
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
			});
			expect(byCommId.get("comm-b")).toEqual({
				status: "ok",
				answer: "answer:second",
				usage: { prompt_tokens: 1, completion_tokens: 1 },
				turns: 1,
				session_dir: null,
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
