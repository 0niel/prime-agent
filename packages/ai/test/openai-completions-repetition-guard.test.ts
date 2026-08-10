import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model } from "../src/types.js";
import { REPETITION_GUARD_DISABLED_ENV } from "../src/utils/repetition-guard.js";

function buildModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "repetition-repro",
		name: "Repetition Repro",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_000,
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function withReasoningServer(deltas: string[], run: (baseUrl: string) => Promise<void>): Promise<void> {
	const server = http.createServer(async (req, res) => {
		for await (const _chunk of req) {
			// Drain the request before responding.
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		for (const delta of deltas) {
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-repetition",
					object: "chat.completion.chunk",
					created: 0,
					model: "repetition-repro",
					choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
				})}\n\n`,
			);
		}
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-repetition",
				object: "chat.completion.chunk",
				created: 0,
				model: "repetition-repro",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as AddressInfo;
		await run(`http://127.0.0.1:${port}`);
	} finally {
		server.close();
		await once(server, "close");
	}
}

const context: Context = { messages: [{ role: "user", content: "Think carefully", timestamp: 1 }] };

describe("openai-completions repetition guard", () => {
	afterEach(() => {
		delete process.env[REPETITION_GUARD_DISABLED_ENV];
	});

	it("aborts and classifies the captured repetitive reasoning pattern", async () => {
		const unit = "The the the the the the the ";
		await withReasoningServer(
			Array.from({ length: 2_366 }, () => unit),
			async (baseUrl) => {
				const events = await collectEvents(
					streamOpenAICompletions(buildModel(baseUrl), context, { apiKey: "test-key" }),
				);
				const terminal = events.at(-1);
				expect(terminal?.type).toBe("error");
				if (terminal?.type !== "error") throw new Error("expected an error event");
				expect(terminal.error.stopReason).toBe("error");
				const thinking = terminal.error.content.find((block) => block.type === "thinking");
				expect(thinking?.type === "thinking" ? thinking.thinking.length : 0).toBeLessThan(20_000);
				expect(terminal.error.diagnostics?.at(-1)).toMatchObject({
					type: "provider_stream_failure",
					details: {
						kind: "degenerate_output",
						providerErrorType: "repetition:periodic_tail",
					},
				});
			},
		);
	});

	it("supports an emergency kill switch", async () => {
		process.env[REPETITION_GUARD_DISABLED_ENV] = "1";
		const deltas = Array.from({ length: 600 }, () => "The the the the the the the ");
		await withReasoningServer(deltas, async (baseUrl) => {
			const events = await collectEvents(
				streamOpenAICompletions(buildModel(baseUrl), context, { apiKey: "test-key" }),
			);
			expect(events.at(-1)?.type).toBe("done");
			expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(600);
		});
	});

	it("leaves visible text unguarded", async () => {
		const server = http.createServer(async (req, res) => {
			for await (const _chunk of req) {
				// Drain the request before responding.
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-text",
					object: "chat.completion.chunk",
					created: 0,
					model: "repetition-repro",
					choices: [{ index: 0, delta: { content: "visible ".repeat(2_000) }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`,
			);
			res.end();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const { port } = server.address() as AddressInfo;
			const events = await collectEvents(
				streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`), context, { apiKey: "test-key" }),
			);
			expect(events.at(-1)?.type).toBe("done");
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
