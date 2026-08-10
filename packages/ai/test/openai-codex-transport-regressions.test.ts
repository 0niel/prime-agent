import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import { cleanupSessionResources } from "../src/session-resources.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;

const token = (() => {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
})();

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "Be helpful.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function responseEvents(text = "café 🧠"): string[] {
	return [
		JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		}),
		JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
		JSON.stringify({ type: "response.output_text.delta", delta: text }),
		JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		}),
		JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		}),
	];
}

function sseBytes(payload: string, cuts: number[] = []): Uint8Array[] {
	const bytes = new TextEncoder().encode(payload);
	const boundaries = [0, ...cuts.filter((cut) => cut > 0 && cut < bytes.length), bytes.length];
	return boundaries.slice(0, -1).map((start, index) => bytes.slice(start, boundaries[index + 1]));
}

function streamResponse(chunks: Uint8Array[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function runSSE(chunks: Uint8Array[]) {
	global.fetch = vi.fn(async () => streamResponse(chunks)) as typeof fetch;
	return streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result();
}

function completeSSE(text = "fallback"): Response {
	const payload = `${responseEvents(text)
		.map((event) => `data: ${event}`)
		.join("\n\n")}\n\n`;
	return streamResponse(sseBytes(payload));
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
});

describe("Codex SSE framing regressions", () => {
	it.each([
		["LF", "\n\n"],
		["CRLF", "\r\n\r\n"],
		["CR", "\r\r"],
	] as const)("decodes %s-framed events", async (_name, separator) => {
		const payload = `${responseEvents()
			.map((event) => `data: ${event}`)
			.join(separator)}${separator}`;
		const result = await runSSE(sseBytes(payload));
		expect(result.stopReason).toBe("stop");
		expect(result.content.find((block) => block.type === "text")?.text).toBe("café 🧠");
	});

	it("handles mixed and split line endings", async () => {
		const separators = ["\n\r", "\r\n\r\n", "\r\r", "\n\n", "\r\n\n"];
		const events = responseEvents();
		const payload = events.map((event, index) => `data: ${event}${separators[index]}`).join("");
		const bytes = new TextEncoder().encode(payload);
		const cuts: number[] = [];
		for (let index = 1; index < bytes.length; index++) {
			if (bytes[index - 1] === 13 && bytes[index] === 10) cuts.push(index);
		}
		const result = await runSSE(sseBytes(payload, cuts));
		expect(result.stopReason).toBe("stop");
		expect(result.content.find((block) => block.type === "text")?.text).toBe("café 🧠");
	});

	it("preserves UTF-8 characters split across byte chunks", async () => {
		const payload = `${responseEvents()
			.map((event) => `data: ${event}`)
			.join("\n\n")}\n\n`;
		const bytes = new TextEncoder().encode(payload);
		const brain = new TextEncoder().encode("🧠");
		const start = bytes.findIndex((_value, index) => brain.every((part, offset) => bytes[index + offset] === part));
		expect(start).toBeGreaterThan(0);
		const result = await runSSE(sseBytes(payload, [start + 1, start + 2, start + 3]));
		expect(result.content.find((block) => block.type === "text")?.text).toBe("café 🧠");
	});

	it("ignores comments, joins multiline data, and dispatches the terminal event at EOF", async () => {
		const payload = [
			": keepalive",
			"event: response",
			'data: {"type":',
			'data: "response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
		].join("\r\n");
		const result = await runSSE(sseBytes(payload));
		expect(result.stopReason).toBe("length");
	});

	it("cancels a pending SSE read and reports a normalized abort", async () => {
		let cancelled = false;
		global.fetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(": waiting\n"));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 200 },
				),
		) as typeof fetch;
		const controller = new AbortController();
		const pending = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			signal: controller.signal,
		}).result();
		setTimeout(() => controller.abort(), 0);
		const result = await Promise.race([
			pending,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort timed out")), 500)),
		]);
		expect(cancelled).toBe(true);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});
});

type Listener = (event: unknown) => void;

class MockSocketBase {
	readyState = 1;
	readonly listeners = new Map<string, Set<Listener>>();
	readonly closes: Array<{ code?: number; reason?: string }> = [];

	addEventListener(type: string, listener: Listener): void {
		let listeners = this.listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.closes.push({ code, reason });
	}

	dispatch(type: string, event: unknown): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}

	listenerCount(): number {
		return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
	}
}

describe("Codex WebSocket cancellation regressions", () => {
	it("rejects pre-aborted requests before constructing or sending", async () => {
		let constructed = 0;
		class MockWebSocket extends MockSocketBase {
			constructor() {
				super();
				constructed++;
			}
			send(): void {
				throw new Error("must not send");
			}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => completeSSE()) as typeof fetch;
		const controller = new AbortController();
		controller.abort();

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "websocket",
			signal: controller.signal,
		}).result();

		expect(constructed).toBe(0);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("closes and cleans up when aborted during connection", async () => {
		let socket: MockWebSocket | undefined;
		class MockWebSocket extends MockSocketBase {
			constructor() {
				super();
				socket = this;
			}
			send(): void {}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		const controller = new AbortController();
		const pending = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "websocket",
			signal: controller.signal,
		}).result();
		await Promise.resolve();
		controller.abort();
		const result = await pending;

		expect(result.stopReason).toBe("aborted");
		expect(socket?.closes).toContainEqual({ code: 1000, reason: "aborted" });
		expect(socket?.listenerCount()).toBe(0);
	});

	it("observes a synchronous WebSocket error and falls back to SSE", async () => {
		let socket: MockWebSocket | undefined;
		class MockWebSocket extends MockSocketBase {
			constructor() {
				super();
				socket = this;
				queueMicrotask(() => this.dispatch("open", {}));
			}
			send(): void {
				this.dispatch("error", { message: "sync failure" });
			}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => completeSSE("fallback")) as typeof fetch;

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token, transport: "auto" }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((block) => block.type === "text")?.text).toBe("fallback");
		expect(socket?.closes.length).toBeGreaterThan(0);
		expect(socket?.listenerCount()).toBe(0);
		expect(global.fetch).toHaveBeenCalledOnce();
	});

	it("clears debug stats and sticky SSE fallback state during session cleanup", async () => {
		let constructed = 0;
		class MockWebSocket extends MockSocketBase {
			constructor() {
				super();
				constructed++;
				queueMicrotask(() => this.dispatch("open", {}));
			}
			send(): void {
				this.dispatch("error", { message: "transport unavailable" });
			}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => completeSSE("fallback")) as typeof fetch;
		const sessionId = "cleanup-fallback";

		await streamOpenAICodexResponses(model, context, { apiKey: token, transport: "auto", sessionId }).result();
		expect(constructed).toBe(1);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBe(true);

		cleanupSessionResources(sessionId);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();

		await streamOpenAICodexResponses(model, context, { apiKey: token, transport: "auto", sessionId }).result();
		expect(constructed).toBe(2);
	});

	it("aborts a request cleaned up while its websocket is still connecting", async () => {
		let socket: MockWebSocket | undefined;
		let constructed: (() => void) | undefined;
		const didConstruct = new Promise<void>((resolve) => {
			constructed = resolve;
		});
		class MockWebSocket extends MockSocketBase {
			constructor() {
				super();
				socket = this;
				constructed?.();
			}
			send(): void {
				throw new Error("cleaned-up socket must not send");
			}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => completeSSE("must-not-fallback")) as typeof fetch;
		const sessionId = "cleanup-connecting";
		const pending = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "auto",
			sessionId,
		}).result();
		await didConstruct;

		cleanupSessionResources(sessionId);
		socket?.dispatch("open", {});
		const result = await Promise.race([
			pending,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cleanup timed out")), 500)),
		]);
		expect(result.stopReason).toBe("aborted");
		expect(socket?.closes.some(({ reason }) => reason === "aborted")).toBe(true);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();
	});

	it("aborts an open pending request during session cleanup without recreating fallback state", async () => {
		let sent: (() => void) | undefined;
		const didSend = new Promise<void>((resolve) => {
			sent = resolve;
		});
		class MockWebSocket extends MockSocketBase {
			constructor() {
				super();
				queueMicrotask(() => this.dispatch("open", {}));
			}
			send(): void {
				sent?.();
			}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => completeSSE("must-not-fallback")) as typeof fetch;
		const sessionId = "cleanup-active";
		const pending = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "auto",
			sessionId,
		}).result();
		await didSend;

		cleanupSessionResources(sessionId);
		const result = await Promise.race([
			pending,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cleanup timed out")), 500)),
		]);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();
		await Promise.resolve();
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();
	});

	it("keeps sticky SSE fallback state when only debug stats are reset", async () => {
		let constructed = 0;
		class MockWebSocket extends MockSocketBase {
			constructor() {
				super();
				constructed++;
				queueMicrotask(() => this.dispatch("open", {}));
			}
			send(): void {
				this.dispatch("error", { message: "transport unavailable" });
			}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => completeSSE("fallback")) as typeof fetch;
		const sessionId = "debug-reset-fallback";

		await streamOpenAICodexResponses(model, context, { apiKey: token, transport: "auto", sessionId }).result();
		expect(constructed).toBe(1);
		resetOpenAICodexWebSocketDebugStats(sessionId);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();

		await streamOpenAICodexResponses(model, context, { apiKey: token, transport: "auto", sessionId }).result();
		expect(constructed).toBe(1);
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it("evicts an active aborted cached socket", async () => {
		const sockets: MockWebSocket[] = [];
		let secondSend: (() => void) | undefined;
		const secondSent = new Promise<void>((resolve) => {
			secondSend = resolve;
		});
		class MockWebSocket extends MockSocketBase {
			private sends = 0;
			constructor() {
				super();
				sockets.push(this);
				queueMicrotask(() => this.dispatch("open", {}));
			}
			send(): void {
				this.sends++;
				if (this === sockets[0] && this.sends === 2) {
					secondSend?.();
					return;
				}
				for (const event of responseEvents("ok")) this.dispatch("message", { data: event });
			}
		}
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		const sessionId = "abort-cache";
		const first = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "websocket-cached",
			sessionId,
		}).result();
		expect(first.stopReason).toBe("stop");

		const controller = new AbortController();
		const secondPending = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "websocket-cached",
			sessionId,
			signal: controller.signal,
		}).result();
		await secondSent;
		controller.abort();
		const second = await secondPending;
		expect(second.stopReason).toBe("aborted");

		const third = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "websocket-cached",
			sessionId,
		}).result();
		expect(third.stopReason).toBe("stop");
		expect(sockets).toHaveLength(2);
		expect(sockets[0].closes.some((close) => close.reason === "aborted")).toBe(true);
	});
});
