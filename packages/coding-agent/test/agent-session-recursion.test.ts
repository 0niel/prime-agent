import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
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
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
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

function rlmCommOpen(commId: string, prompt: string, kwargs: Record<string, unknown> = {}): TestCommMessage {
	return {
		header: { msg_type: "comm_open" },
		parent_header: {},
		metadata: {},
		content: {
			comm_id: commId,
			target_name: "rlm.run",
			data: { type: "run", prompt, kwargs },
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

	function createSession(options: { depth?: number; maxDepth?: number } = {}): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "",
				tools: [],
				thinkingLevel: "off",
			},
			streamFn: (_model, context) => streamAnswer(`child answer: ${userText(context)}`),
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
		expect(existsSync(result.session_dir!)).toBe(true);
		expect(readdirSync(result.session_dir!).some((name) => name.endsWith(".jsonl"))).toBe(true);
		expect(childUpdates[0]?.status).toBe("running");
		expect(childUpdates[0]?.label).toBe("summarize shard 1");
		const doneUpdate = [...childUpdates].reverse().find((update) => update.status === "done");
		expect(doneUpdate?.answerPreview).toBe("child answer: summarize shard 1");
		expect(doneUpdate?.transcript).toContainEqual({ role: "user", text: "summarize shard 1" });
		expect(doneUpdate?.transcript).toContainEqual({ role: "assistant", text: "child answer: summarize shard 1" });
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
			rlmRunHandler: async ({ prompt }) => {
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

	it("waits for in-flight rlm comm work during dispose and logs failures", async () => {
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
			rlmRunHandler: async () => {
				started = true;
				try {
					await release;
					throw new Error("child failed after dispose");
				} finally {
					handlerSettled = true;
				}
			},
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

			const logLines = errorSpy.mock.calls.map((call) => call.map(String).join(" "));
			expect(logLines.some((line) => line.includes("[kernel] rlm.run failed for comm comm-dispose"))).toBe(true);
			expect(
				logLines.some((line) => line.includes("[kernel] failed to send rlm.run error reply for comm comm-dispose")),
			).toBe(true);
		} finally {
			releaseChild();
			await manager.dispose();
			errorSpy.mockRestore();
		}
	});
});
