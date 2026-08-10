/** Production-path coverage for the B00B test-only scripted provider. */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { convertToLlm } from "../../src/core/messages.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import { createBarrierScriptedProvider, type ProviderScript } from "./production-scripted-provider.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: {
		input: input * 0.000001,
		output: output * 0.000002,
		cacheRead: cacheRead * 0.0000001,
		cacheWrite: cacheWrite * 0.0000002,
		total: input * 0.000001 + output * 0.000002 + cacheRead * 0.0000001 + cacheWrite * 0.0000002,
	},
});
const canaries = [
	"B00B-system-秘密",
	"B00B-user-secret",
	"B00B-thinking-secret",
	"B00B-tool-args-secret",
	"B00B-tool-result-secret",
	"B00B-error-secret",
];

function provider(scripts: Record<string, readonly ProviderScript[]>, expected: readonly string[]) {
	const registered = createBarrierScriptedProvider({
		api: "b00b-scripted-api",
		provider: "b00b-scripted",
		barrier: { expected, timeoutMs: 2_000 },
		models: [
			{
				id: "fixture-a",
				responseModel: "fixture-a-resolved",
				cost: { input: 1.1, output: 2.2, cacheRead: 0.1, cacheWrite: 0.2 },
			},
			{
				id: "fixture-b",
				responseModel: "fixture-b-resolved",
				cost: { input: 3.3, output: 4.4, cacheRead: 0.3, cacheWrite: 0.4 },
			},
			{
				id: "fixture-zero",
				responseModel: "fixture-zero-resolved",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		scripts,
	});
	cleanups.push(() => registered.unregister());
	return registered;
}
function simple(requestId: string, options: Partial<ProviderScript> = {}): ProviderScript {
	return {
		requestId,
		blocks: [{ type: "text", chunks: ["safe-", "output"] }],
		usage: usage(11, 7),
		responseModel: "fixture-a-resolved",
		...options,
	};
}
function agentFor(
	model: ReturnType<typeof provider>["models"][number],
	tools: NonNullable<import("@earendil-works/pi-agent-core").AgentOptions["initialState"]>["tools"] = [],
) {
	return new Agent({ getApiKey: () => "fixture-key", initialState: { model, systemPrompt: canaries[0], tools } });
}

async function readTree(directory: string): Promise<string> {
	const names = await readdir(directory);
	return (await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
}

describe("B00B production scripted provider", () => {
	test("registers through the real AI registry and holds a 1/4 fanout only as an observation barrier", async () => {
		const ids = ["request-0001", "request-0002", "request-0003", "request-0004"] as const;
		const fixture = provider(Object.fromEntries(ids.map((id) => [id, [simple(id, { waitForRelease: true })]])), ids);
		const agents = ids.map((_id, index) => agentFor(fixture.models[index % 3]!));
		const events = agents.map(() => [] as string[]);
		for (const [index, agent] of agents.entries()) {
			agent.subscribe((event) => {
				events[index]!.push(event.type);
			});
		}
		const runs = agents.map((agent, index) =>
			agent.prompt(`request-${String(index + 1).padStart(4, "0")} ${canaries[1]}`),
		);
		await fixture.open;
		const entries = fixture.observations();
		expect(entries).toHaveLength(4);
		expect(entries.map((entry) => entry.requestId).sort()).toEqual([...ids]);
		expect(entries.every((entry) => entry.eventKinds.length === 0)).toBe(true);
		// This releases 2..4 while 1 remains held: no semaphore/queue sits before provider entry.
		fixture.release(ids.slice(1));
		await Promise.all(runs.slice(1));
		expect(fixture.observations().find((entry) => entry.requestId === "request-0001")?.eventKinds).toEqual([]);
		fixture.release([ids[0]]);
		await runs[0];
		for (const types of events) {
			expect(types.indexOf("message_start")).toBeLessThan(types.indexOf("message_update"));
			expect(types.filter((type) => type === "message_end")).toHaveLength(2); // user plus one assistant terminal
		}
		expect(
			fixture.observations().every((entry) => entry.terminal === "done" && entry.eventKinds.at(-1) === "done"),
		).toBe(true);
	});

	test("uses exact thinking/text/tool stream events, executes one tool turn, and attributes resolved model and terminal usage", async () => {
		const id = "request-0005";
		const fixture = provider(
			{
				[id]: [
					{
						requestId: id,
						waitForRelease: true,
						responseId: "response-safe-0005",
						responseModel: "fixture-b-resolved",
						stopReason: "toolUse",
						usage: usage(101, 17, 0, 101),
						blocks: [
							{ type: "thinking", chunks: [canaries[2].slice(0, 8), canaries[2].slice(8)] },
							{ type: "text", chunks: ["call-", "tool"] },
							{
								type: "toolCall",
								id: "tool-0005",
								name: "fixture_tool",
								argumentChunks: [`{"value":"${canaries[3]}"}`],
							},
						],
					},
					{
						requestId: id,
						responseModel: "fixture-b-resolved",
						usage: usage(102, 9, 101, 1),
						blocks: [{ type: "text", chunks: ["final-", "safe"] }],
					},
				],
			},
			[id],
		);
		let toolCalls = 0;
		const tool = {
			name: "fixture_tool",
			label: "fixture tool",
			description: "test-only",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				toolCalls++;
				return { content: [{ type: "text" as const, text: canaries[4] }], details: {}, terminate: false };
			},
		};
		const agent = agentFor(fixture.models[1]!, [tool]);
		const lifecycle: string[] = [];
		agent.subscribe((event) => {
			lifecycle.push(event.type);
		});
		const run = agent.prompt(`${id} ${canaries[1]}`);
		await fixture.open;
		fixture.release([id]);
		await run;
		expect(toolCalls).toBe(1);
		const observed = fixture.observations();
		expect(observed).toHaveLength(2);
		expect(observed[0]?.eventKinds).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(observed[1]?.eventKinds).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		expect(observed.map((item) => item.responseModel)).toEqual(["fixture-b-resolved", "fixture-b-resolved"]);
		expect(observed.map((item) => item.usage?.cacheRead)).toEqual([0, 101]);
		expect(lifecycle.filter((type) => type === "message_end")).toHaveLength(4); // user, assistant, tool result, assistant
		const final = agent.state.messages.at(-1);
		expect(final).toMatchObject({
			role: "assistant",
			responseModel: "fixture-b-resolved",
			usage: usage(102, 9, 101, 1),
		});
	});

	test("isolates abort and upstream 429 from released siblings without client-side rate limiting", async () => {
		const ids = ["request-0006", "request-0007", "request-0008"] as const;
		const fixture = provider(
			{
				[ids[0]]: [simple(ids[0], { waitForRelease: true })],
				[ids[1]]: [
					{
						requestId: ids[1],
						waitForRelease: true,
						upstreamStatus: 429,
						errorCode: "upstream-429",
						usage: usage(23, 0, 5, 0),
					},
				],
				[ids[2]]: [
					simple(ids[2], { waitForRelease: true, responseModel: "fixture-zero-resolved", usage: usage(3, 2) }),
				],
			},
			ids,
		);
		const agents = [agentFor(fixture.models[0]!), agentFor(fixture.models[1]!), agentFor(fixture.models[2]!)];
		const runs = agents.map((agent, index) => agent.prompt(ids[index]!));
		await fixture.open;
		agents[0]!.abort();
		fixture.release([ids[1], ids[2]]);
		await Promise.all(runs);
		const observed = fixture.observations();
		expect(observed.find((item) => item.requestId === ids[0])).toMatchObject({
			terminal: "aborted",
			signalAborted: true,
			eventKinds: ["error"],
		});
		expect(observed.find((item) => item.requestId === ids[1])).toMatchObject({
			upstreamStatus: 429,
			terminal: "error",
			eventKinds: ["error"],
		});
		expect(observed.find((item) => item.requestId === ids[2])).toMatchObject({
			terminal: "done",
			responseModel: "fixture-zero-resolved",
		});
		expect(observed.filter((item) => item.requestId === ids[0])[0]?.eventKinds).toHaveLength(1);
	});

	test("runs through AgentSession.promptAndWait with a registered provider and writes no canary or network fixture", async () => {
		const id = "request-0009";
		const fixture = provider({ [id]: [simple(id, { waitForRelease: true, responseModel: "fixture-a-resolved" })] }, [
			id,
		]);
		const directory = await mkdtemp(join(tmpdir(), "b00b-session-"));
		const auth = AuthStorage.inMemory();
		const model = fixture.models[0]!;
		auth.setRuntimeApiKey(model.provider, "fixture-key");
		const registry = ModelRegistry.inMemory(auth);
		registry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "fixture-key",
			api: model.api,
			models: fixture.models.map((candidate) => ({
				id: candidate.id,
				name: candidate.name,
				api: candidate.api,
				reasoning: candidate.reasoning,
				input: candidate.input,
				cost: candidate.cost,
				contextWindow: candidate.contextWindow,
				maxTokens: candidate.maxTokens,
				baseUrl: candidate.baseUrl,
			})),
		});
		const agent = new Agent({
			getApiKey: () => "fixture-key",
			initialState: { model, systemPrompt: canaries[0], tools: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			cwd: directory,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(async () => {
			session.dispose();
			await rm(directory, { recursive: true, force: true });
		});
		const run = session.promptAndWait(`${id} ${canaries[1]}`);
		await fixture.open;
		fixture.release([id]);
		await run;
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", responseModel: "fixture-a-resolved" });
		const disk = await readTree(directory);
		for (const canary of canaries) expect(disk).not.toContain(canary);
	});
});
