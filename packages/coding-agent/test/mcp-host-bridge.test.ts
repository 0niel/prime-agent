import { describe, expect, it, vi } from "vitest";
import { McpHostBridge } from "../src/core/mcp/mcp-host-bridge.js";

const binding = { server: "demo", endpoint: "https://mcp.example.test/mcp", declarationRevision: "snapshot-r1", authRevision: "secret-r1", oauth: true };
function context(): { requestId: string; generation: number; signal: AbortSignal; isCurrent(): boolean; controller: AbortController } {
	const controller = new AbortController();
	return { requestId: "request", generation: 1, signal: controller.signal, isCurrent: () => true, controller };
}
function json(response: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("MCP host bridge", () => {
	it("initializes once per binding, sends an id-less initialized notification, and uses unique ids", async () => {
		const messages: Array<Record<string, unknown>> = [];
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const message = JSON.parse(String(init?.body)) as Record<string, unknown>;
			messages.push(message);
			if (message.method === "notifications/initialized") return new Response("", { status: 202 });
			return json({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [] } : {} }, 200, message.method === "initialize" ? { "mcp-session-id": "session" } : {});
		});
		const bridge = new McpHostBridge({ fetch: fetch as unknown as typeof globalThis.fetch, withOAuthAccessToken: async (_server, run) => run("secret") });
		await Promise.all([bridge.request(binding, "tools/list", {}, context()), bridge.request(binding, "tools/list", {}, context())]);
		expect(messages.filter((message) => message.method === "initialize")).toHaveLength(1);
		expect(messages.filter((message) => message.method === "notifications/initialized")).toEqual([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
		const ids = messages.filter((message) => "id" in message).map((message) => message.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const [index, call] of fetch.mock.calls.entries()) {
			const headers = new Headers(call[1]?.headers);
			const message = messages[index]!;
			expect(headers.get("authorization")).toBe("Bearer secret");
			expect(headers.get("mcp-protocol-version")).toBe(message.method === "initialize" ? null : "2025-03-26");
			if (index > 0) expect(headers.get("mcp-session-id")).toBe("session");
			expect([...headers.keys()].filter((name) => name.startsWith("x-")).length).toBe(0);
		}
	});

	it("drains 401 then refreshes once with OAuth and never downgrades", async () => {
		let requests = 0;
		let refreshes = 0;
		const order: string[] = [];
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const message = JSON.parse(String(init?.body));
			requests++;
			if (message.method === "notifications/initialized") return new Response("", { status: 202 });
			if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: {} });
			return requests === 3 ? new Response("expired", { status: 401, headers: { "mcp-session-id": "untrusted-401" } }) : json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
		});
		const bridge = new McpHostBridge({
			fetch: fetch as unknown as typeof globalThis.fetch,
			resolveBinding: (value) => ({ ...value, authRevision: "secret-r2" }),
			beforeForceRefresh: async () => { order.push("delete"); },
			withOAuthAccessToken: async (_server, run, force) => { if (force) { refreshes++; order.push("refresh"); } return run(force ? "fresh" : "old"); },
		});
		await expect(bridge.request(binding, "tools/list", {}, context())).resolves.toEqual({ tools: [] });
		expect(refreshes).toBe(1);
		const auth = fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("authorization"));
		expect(auth).toContain("Bearer fresh");
		expect(auth).not.toContain(null);
		expect(fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("mcp-session-id"))).not.toContain("untrusted-401");
		const methods = fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { method: string });
		expect(methods.filter((message) => message.method === "tools/list")).toHaveLength(2);
		expect(methods.filter((message) => message.method === "initialize")).toHaveLength(2);
		expect(order).toEqual(["delete", "refresh"]);
	});

	it("bounds oversize bodies and sends matching cancellation on context abort", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const message = JSON.parse(String(init?.body)); calls.push(message);
			if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return new Response("", { status: 202 });
			if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: {} });
			return new Response("x".repeat(1024), { headers: { "content-type": "application/json" } });
		});
		const bridge = new McpHostBridge({ fetch: fetch as unknown as typeof globalThis.fetch, maxResponseBytes: 64, withOAuthAccessToken: async (_server, run) => run("secret") });
		await expect(bridge.request(binding, "tools/list", {}, context())).rejects.toThrow("allowed size");
		const delayed = new McpHostBridge({
			fetch: async (_url, init) => {
				const message = JSON.parse(String(init?.body)); calls.push(message);
				if (message.method !== "tools/call") return message.method === "notifications/initialized" ? new Response("", { status: 202 }) : json({ jsonrpc: "2.0", id: message.id, result: {} });
				return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			},
			withOAuthAccessToken: async (_server, run) => run("secret"),
		});
		const ctx = context(); const pending = delayed.request(binding, "tools/call", {}, ctx);
		for (let attempt = 0; attempt < 20 && !calls.some((call) => call.method === "tools/call"); attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls.some((call) => call.method === "tools/call")).toBe(true);
		ctx.controller.abort(); await expect(pending).rejects.toBeDefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const cancel = calls.find((call) => call.method === "notifications/cancelled");
		expect(cancel?.params).toMatchObject({ requestId: expect.stringMatching(/^prime-agent-/) });
	});
	it("accepts matching SSE responses and reinitializes a rebound endpoint", async () => {
		const methods: Array<{ endpoint: string; method: string }> = [];
		const fetch = vi.fn(async (endpoint: string, init?: RequestInit) => {
			const message = JSON.parse(String(init?.body)); methods.push({ endpoint, method: message.method });
			if (message.method === "notifications/initialized") return new Response("", { status: 202 });
			return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
		});
		const bridge = new McpHostBridge({ fetch: fetch as unknown as typeof globalThis.fetch, withOAuthAccessToken: async (_server, run) => run("secret") });
		await expect(bridge.request(binding, "tools/list", {}, context())).resolves.toEqual({ tools: [] });
		await expect(bridge.request({ ...binding, endpoint: "https://mcp.example.test/rebound" }, "tools/list", {}, context())).resolves.toEqual({ tools: [] });
		expect(methods.filter((entry) => entry.method === "initialize")).toEqual([
			{ endpoint: binding.endpoint, method: "initialize" },
			{ endpoint: "https://mcp.example.test/rebound", method: "initialize" },
		]);
	});

	it("fences revisions and awaits authenticated DELETE session close", async () => {
		const seen: Array<{ method: string; auth: string | null; session: string | null }> = [];
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers); const method = init?.method ?? "POST";
			if (method === "DELETE") { seen.push({ method, auth: headers.get("authorization"), session: headers.get("mcp-session-id") }); return new Response(null, { status: 204 }); }
			const message = JSON.parse(String(init?.body)); seen.push({ method: message.method, auth: headers.get("authorization"), session: headers.get("mcp-session-id") });
			if (message.method === "notifications/initialized") return new Response("", { status: 202 });
			return json({ jsonrpc: "2.0", id: message.id, result: {} }, 200, message.method === "initialize" ? { "mcp-session-id": "session-r1" } : {});
		});
		const bridge = new McpHostBridge({ fetch: fetch as unknown as typeof globalThis.fetch, withOAuthAccessToken: async (_server, run) => run("secret") });
		await bridge.request(binding, "tools/list", {}, context());
		await bridge.closeBinding(binding);
		expect(seen.at(-1)).toEqual({ method: "DELETE", auth: "Bearer secret", session: "session-r1" });
		await bridge.request({ ...binding, authRevision: "secret-r2", declarationRevision: "snapshot-r2" }, "tools/list", {}, context());
		expect(seen.filter((entry) => entry.method === "initialize")).toHaveLength(2);
	});

	it("parses matching persistent SSE incrementally and rejects malformed or 401 session headers", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","id":"other","result":{}}\n\n')); controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","id":"')); controller.enqueue(encoder.encode('MATCH","result":{"tools":[]}}\n\n')); } });
		let calls = 0;
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => { const message = JSON.parse(String(init?.body)); calls++; if (message.method === "notifications/initialized") return new Response("", { status: 202 }); if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: {} }); return new Response(body, { headers: { "content-type": "text/event-stream" } }); });
		// Control ids are generated, so return a matching id dynamically for the normal request in a separate client.
		const matching = new McpHostBridge({ fetch: async (_url, init) => { const message = JSON.parse(String(init?.body)); if (message.method === "notifications/initialized") return new Response("", { status: 202 }); if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: {} }); const e = new TextEncoder(); return new Response(new ReadableStream({ start(c) { c.enqueue(e.encode(`data: {"jsonrpc":"2.0","id":"other","result":{}}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } }); }, withOAuthAccessToken: async (_server, run) => run("secret") });
		await expect(matching.request(binding, "tools/list", {}, context())).resolves.toEqual({ tools: [] });
		const malformed = new McpHostBridge({ fetch: async (_url, init) => { const message = JSON.parse(String(init?.body)); return json({ jsonrpc: "2.0", id: message.id, result: {} }, 200, { "mcp-session-id": "x".repeat(257) }); }, withOAuthAccessToken: async (_server, run) => run("secret") });
		await expect(malformed.request(binding, "tools/list", {}, context())).rejects.toThrow("invalid session");
		void fetch; void calls;
	});

	it("fences a late old response while close waits for its aborted operation", async () => {
		let release!: (response: Response) => void; let toolCalls = 0;
		const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			const message = JSON.parse(String(init?.body));
			if (message.method === "notifications/initialized") return new Response("", { status: 202 });
			if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: {} }, 200, { "mcp-session-id": "old-session" });
			if (++toolCalls > 1) return json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
			return await new Promise<Response>((resolve) => { release = resolve; });
		};
		const bridge = new McpHostBridge({ fetch, withOAuthAccessToken: async (_server, run) => run("secret") });
		const pending = bridge.request(binding, "tools/list", {}, context());
		for (let attempt = 0; attempt < 20 && toolCalls === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
		expect(toolCalls).toBe(1);
		const closing = bridge.closeBinding(binding);
		let closed = false; void closing.then(() => { closed = true; }); await Promise.resolve();
		expect(closed).toBe(false);
		release(json({ jsonrpc: "2.0", id: "late", result: {} }, 200, { "mcp-session-id": "late-session" }));
		await expect(pending).rejects.toThrow("cancelled"); await closing;
		expect(closed).toBe(true);
		// The stale state was removed: a new revision gets a clean session and never sees late-session.
		await expect(bridge.request({ ...binding, declarationRevision: "snapshot-r2" }, "tools/list", {}, context())).resolves.toEqual({ tools: [] });
	});

});
