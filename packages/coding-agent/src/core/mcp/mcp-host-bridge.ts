import { randomUUID } from "node:crypto";
import type { HostRequestContext } from "../kernel/index.js";

/** Immutable host-only binding; deliberately carries no configurable headers. */
export interface McpHostBinding {
	readonly server: string;
	readonly endpoint: string;
	readonly declarationRevision: string;
	readonly authRevision?: string;
	readonly oauth: boolean;
}
export interface McpHostBridgeOptions {
	withOAuthAccessToken: <T>(server: string, operation: (token: string) => Promise<T>, forceRefresh?: boolean) => Promise<T>;
	/** Resolves the post-refresh sealed-reference revision before the retry is sent. */
	resolveBinding?: (binding: McpHostBinding) => McpHostBinding;
	/** Retires the old epoch/session before a forced credential refresh. Cleanup failures are non-authoritative. */
	/** Returns true only when the old binding was retired; required before retrying a transport abort. */
	beforeForceRefresh?: (binding: McpHostBinding) => Promise<boolean | void>;
	fetch?: typeof fetch;
	maxResponseBytes?: number;
	requestTimeoutMs?: number;
}
type Rpc = { jsonrpc: "2.0"; id?: string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
type State = { binding: McpHostBinding; nextId: number; initialize?: Promise<void>; sessionId?: string; generation: number; controllers: Set<AbortController>; inFlight: Set<Promise<void>>; epoch: number };
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

function bindingKey(binding: McpHostBinding): string {
	return `${binding.server}\0${binding.endpoint}\0${binding.declarationRevision}\0${binding.authRevision ?? "anonymous"}`;
}
function rpc(value: unknown): Rpc {
	if (!value || typeof value !== "object" || Array.isArray(value) || (value as Rpc).jsonrpc !== "2.0") throw new Error("MCP response is not valid JSON-RPC.");
	const candidate = value as Record<string, unknown>;
	const hasResult = Object.prototype.hasOwnProperty.call(candidate, "result");
	const hasError = Object.prototype.hasOwnProperty.call(candidate, "error");
	if (hasResult === hasError) throw new Error("MCP response must contain exactly one of result or error.");
	if (hasError) {
		const error = candidate.error;
		if (!error || typeof error !== "object" || Array.isArray(error) || typeof (error as { code?: unknown }).code !== "number" || !Number.isFinite((error as { code: number }).code) || typeof (error as { message?: unknown }).message !== "string") throw new Error("MCP response has an invalid error object.");
	}
	return candidate as Rpc;
}
async function drain(response: Response, maximum: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
	try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) { await reader.cancel("MCP response exceeds limit"); throw new Error("MCP response exceeds the allowed size."); } chunks.push(value); } }
	finally { reader.releaseLock(); }
	return new TextDecoder().decode(Buffer.concat(chunks));
}
async function readRpc(response: Response, id: string, maximum: number): Promise<Rpc> {
	if (!response.body) throw new Error("MCP response has no body.");
	const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let events = 0; let buffer = ""; let data: string[] = [];
	// Syntax failures and unrelated ids may be skipped on a persistent stream.
	// Once an envelope claims our id, strict JSON-RPC validation is authoritative.
	const parseJson = (text: string): Rpc | undefined => {
		let raw: unknown; try { raw = JSON.parse(text); } catch { return undefined; }
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { id?: unknown }).id !== id) return undefined;
		return rpc(raw);
	};
	try {
		for (;;) {
			const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
			if (bytes > maximum) { await reader.cancel("MCP response exceeds limit"); throw new Error("MCP response exceeds the allowed size."); }
			buffer += decoder.decode(part.value, { stream: true });
			const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || /^\s*data:/m.test(buffer);
			if (!sse) { const value = parseJson(buffer); if (value) { await reader.cancel(); return value; } continue; }
			for (;;) {
				const next = buffer.indexOf("\n"); if (next < 0) break; const line = buffer.slice(0, next).replace(/\r$/, ""); buffer = buffer.slice(next + 1);
				if (!line) { if (data.length) { if (++events > 128) { await reader.cancel("MCP response has too many events"); throw new Error("MCP response has too many events."); } const value = parseJson(data.join("\n")); data = []; if (value) { await reader.cancel(); return value; } } }
				else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
			}
		}
		if (data.length) { const value = parseJson(data.join("\n")); if (value) return value; }
		const final = buffer ? parseJson(buffer) : undefined; if (final) return final;
		throw new Error("MCP response did not contain the matching JSON-RPC id.");
	} catch (error) {
		// A correlated malformed envelope is terminal even on an endless SSE body.
		// Cancel before surfacing it so no persistent response remains owned here.
		try { await reader.cancel("MCP response is invalid"); } catch { /* preserve protocol error */ }
		throw error;
	} finally { reader.releaseLock(); }
}

function validSessionId(value: string | null): value is string { return !!value && value.length <= 256 && /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/.test(value); }

export class McpHostBridge {
	private readonly states = new Map<string, State>();
	private readonly controllers = new Set<AbortController>();
	/** Each old binding has one transition, installed before any current-binding lookup. */
	private readonly bindingRefreshFlights = new Map<string, Promise<{ binding: McpHostBinding; retired: boolean }>>();
	/** Whole public lifecycles, including close/refresh/retry, for disposal fencing. */
	private readonly operations = new Set<Promise<void>>();
	private readonly fetchImpl: typeof fetch;
	private readonly maximum: number;
	private readonly timeout: number;
	private disposed = false;
	private disposePromise?: Promise<void>;
	private generation = 0;
	constructor(private readonly options: McpHostBridgeOptions) { this.fetchImpl = options.fetch ?? fetch; this.maximum = options.maxResponseBytes ?? MAX_RESPONSE_BYTES; this.timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS; }
	private async whole<T>(action: () => Promise<T>): Promise<T> {
		const operation = action(); const settled = operation.then(() => undefined, () => undefined); this.operations.add(settled);
		try { return await operation; } finally { this.operations.delete(settled); }
	}
	private state(binding: McpHostBinding): State {
		if (this.disposed) throw new Error("MCP host bridge is disposed.");
		const key = bindingKey(binding); let state = this.states.get(key);
		if (!state) { state = { binding, nextId: 0, generation: this.generation, controllers: new Set(), inFlight: new Set(), epoch: 0 }; this.states.set(key, state); }
		return state;
	}
	private id(state: State): string { return `prime-agent-${randomUUID()}-${++state.nextId}`; }
	private current(state: State, context?: HostRequestContext, epoch?: number): boolean { return !this.disposed && state.generation === this.generation && (epoch === undefined || state.epoch === epoch) && (!context || (!context.signal.aborted && context.isCurrent())); }
	private rekey(state: State, binding: McpHostBinding, preserveInitialize = false, replaceCanonical = true): void {
		if (this.disposed) throw new Error("MCP host bridge is disposed.");
		const oldKey = bindingKey(state.binding); if (this.states.get(oldKey) === state) this.states.delete(oldKey);
		state.binding = binding; state.sessionId = undefined; if (!preserveInitialize) state.initialize = undefined; state.generation = this.generation; state.epoch += 1;
		for (const controller of state.controllers) controller.abort();
		if (replaceCanonical) this.states.set(bindingKey(binding), state);
	}
	private async tracked<T>(state: State, action: () => Promise<T>): Promise<T> {
		const operation = action(); const settled = operation.then(() => undefined, () => undefined); state.inFlight.add(settled);
		try { return await operation; } finally { state.inFlight.delete(settled); }
	}
	private async post(state: State, message: Rpc, context: HostRequestContext | undefined, token: string | undefined, response = true, allowCancelled = false): Promise<Rpc | undefined> { const epoch = state.epoch; return this.tracked(state, async () => {
		if (!allowCancelled && !this.current(state, context, epoch)) throw new Error("MCP request was cancelled.");
		const controller = new AbortController(); this.controllers.add(controller); state.controllers.add(controller);
		const abort = () => controller.abort(); if (!allowCancelled) context?.signal.addEventListener("abort", abort, { once: true });
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeout);
		try {
			const headers: Record<string, string> = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
			// The initialize request negotiates the version in params. Every later
			// protocol message carries the negotiated version explicitly.
			if (message.method !== "initialize") headers["MCP-Protocol-Version"] = "2025-03-26";
			// The only credential header that can ever cross this boundary is this host-derived bearer.
			if (token) headers.Authorization = `Bearer ${token}`;
			if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;
			const result = await this.fetchImpl(state.binding.endpoint, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal, redirect: "error" });
			if (!allowCancelled && !this.current(state, context, epoch)) { try { await drain(result, this.maximum); } catch { /* stale response */ } throw new Error("MCP request was cancelled."); }
			if (!result.ok) { try { await drain(result, this.maximum); } catch { /* drain boundedly, never disclose a body */ } const error = new Error(`MCP request failed: ${result.status}`) as Error & { status?: number }; error.status = result.status; throw error; }
			const sessionId = result.headers.get("mcp-session-id"); if (sessionId !== null && !validSessionId(sessionId)) throw new Error("MCP response has an invalid session id.");
			const parsed = response ? await readRpc(result, message.id!, this.maximum) : (await drain(result, this.maximum), undefined);
			if (!allowCancelled && !this.current(state, context, epoch)) throw new Error("MCP request was cancelled.");
			if (sessionId) state.sessionId = sessionId;
			return parsed;
		} catch (error) {
			if ((error as { name?: string }).name === "AbortError") {
				Object.assign(error as object, { mcpAbortReason: timedOut ? "timeout" : context?.signal.aborted ? "cancelled" : !this.current(state, context, epoch) ? "retired" : "transport" });
			}
			throw error;
		} finally { clearTimeout(timer); this.controllers.delete(controller); state.controllers.delete(controller); if (!allowCancelled) context?.signal.removeEventListener("abort", abort); }
	}); }
	private async authenticated<T>(state: State, run: (token: string | undefined) => Promise<T>, refresh = false): Promise<T> { return state.binding.oauth ? this.options.withOAuthAccessToken(state.binding.server, run, refresh) : run(undefined); }
	private adoptResolvedBinding(state: State, prior: McpHostBinding, resolved: McpHostBinding, message: Rpc): McpHostBinding {
		const oldKey = bindingKey(prior); const resolvedKey = bindingKey(resolved); const currentKey = bindingKey(state.binding);
		if (resolvedKey === oldKey || currentKey === resolvedKey) return state.binding;
		// Only the exact old epoch may advance. If a peer already owns the newer
		// canonical key, advance this caller without replacing that canonical state.
		if (currentKey === oldKey) this.rekey(state, resolved, message.method === "initialize", !this.states.has(resolvedKey));
		return state.binding;
	}
	private async refreshBinding(state: State, prior: McpHostBinding, message: Rpc): Promise<{ binding: McpHostBinding; retired: boolean }> {
		const key = bindingKey(prior);
		let flight = this.bindingRefreshFlights.get(key);
		if (!flight) {
			flight = (async () => {
				const initial = this.options.resolveBinding?.(prior) ?? prior;
				if (bindingKey(initial) !== key) return { binding: this.adoptResolvedBinding(state, prior, initial, message), retired: true };
				let retired = false;
				try { retired = (await this.options.beforeForceRefresh?.(prior)) === true; } catch { /* cleanup is best effort */ }
				// Retirement itself can rotate the sealed binding. Never issue another
				// refresh against the old reference when that has already happened.
				const afterRetirement = this.options.resolveBinding?.(prior) ?? prior;
				if (bindingKey(afterRetirement) !== key) return { binding: this.adoptResolvedBinding(state, prior, afterRetirement, message), retired };
				await this.authenticated(state, async () => undefined, true);
				const renewed = this.options.resolveBinding?.(prior) ?? prior;
				if (bindingKey(renewed) === key) throw new Error("MCP OAuth refresh did not rotate its binding revision.");
				return { binding: this.adoptResolvedBinding(state, prior, renewed, message), retired };
			})();
			this.bindingRefreshFlights.set(key, flight);
			void flight.finally(() => { if (this.bindingRefreshFlights.get(key) === flight) this.bindingRefreshFlights.delete(key); }).catch(() => {});
		}
		return flight;
	}
	private async send(state: State, message: Rpc, context: HostRequestContext, response = true, allowCancelled = false): Promise<Rpc | undefined> {
		const prior = state.binding;
		try { return await this.authenticated(state, (token) => this.post(state, message, context, token, response, allowCancelled)); }
		catch (error) {
			const aborted = (error as { name?: string; mcpAbortReason?: string }).name === "AbortError";
			const retryable = (error as { status?: number }).status === 401 || (aborted && (error as { mcpAbortReason?: string }).mcpAbortReason === "retired");
			// User cancellation, timeout, and an unproven transport abort never refresh credentials.
			if (this.disposed || !state.binding.oauth || !retryable || !context.isCurrent() || context.signal.aborted) throw error;
			const refreshed = await this.refreshBinding(state, prior, message);
			if (aborted && !refreshed.retired) throw error;
			if (message.method !== "initialize") await this.initialize(state, context);
			return this.authenticated(state, (token) => this.post(state, message, context, token, response, allowCancelled));
		}
	}
	private async initialize(state: State, context: HostRequestContext): Promise<void> {
		if (state.initialize) return state.initialize;
		const initialization = (async () => { const id = this.id(state); const result = await this.send(state, { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Prime Agent", version: "0" } } }, context); if (!result || result.error || !Object.prototype.hasOwnProperty.call(result, "result") || !result.result || typeof result.result !== "object" || Array.isArray(result.result) || (result.result as { protocolVersion?: unknown }).protocolVersion !== "2025-03-26") throw new Error("MCP initialize returned an invalid protocol version."); await this.send(state, { jsonrpc: "2.0", method: "notifications/initialized" }, context, false); })();
		state.initialize = initialization;
		try { await initialization; } catch (error) { if (state.initialize === initialization) state.initialize = undefined; throw error; }
	}
	private async doRequest(binding: McpHostBinding, method: string, params: unknown, context: HostRequestContext): Promise<unknown> {
		if (!/^[A-Za-z0-9_.\-/]+$/.test(method) || method === "initialize" || method.startsWith("notifications/")) throw new Error("MCP method is unavailable.");
		const state = this.state(binding); await this.initialize(state, context); const id = this.id(state);
		const cancelled = () => { void this.send(state, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }, context, false, true).catch(() => {}); };
		context.signal.addEventListener("abort", cancelled, { once: true });
		try { const result = await this.send(state, { jsonrpc: "2.0", id, method, params }, context); if (!result || result.error) throw new Error(`MCP ${method} failed.`); return result.result; }
		finally { context.signal.removeEventListener("abort", cancelled); }
	}
	async request(binding: McpHostBinding, method: string, params: unknown, context: HostRequestContext): Promise<unknown> { return this.whole(() => this.doRequest(binding, method, params, context)); }
	/** Close one authenticated binding before credential rotation or deletion. */
	private async doCloseBinding(binding: McpHostBinding): Promise<void> {
		const state = this.states.get(bindingKey(binding));
		if (!state) return;
		const closeSession = state.sessionId;
		this.states.delete(bindingKey(binding)); state.sessionId = undefined; state.generation = -1;
		for (const active of state.controllers) active.abort();
		await Promise.allSettled([...state.inFlight]);
		if (!closeSession) return;
		const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeout);
		try { await this.authenticated(state, async (token) => { const headers: Record<string, string> = { "MCP-Protocol-Version": "2025-03-26", "Mcp-Session-Id": closeSession }; if (token) headers.Authorization = `Bearer ${token}`; const result = await this.fetchImpl(state.binding.endpoint, { method: "DELETE", headers, signal: controller.signal, redirect: "error" }); try { await drain(result, this.maximum); } catch { /* bounded close body */ } }); }
		finally { clearTimeout(timer); }
	}

	async closeBinding(binding: McpHostBinding): Promise<void> {
		if (this.disposed) throw new Error("MCP host bridge is disposed.");
		return this.whole(() => this.doCloseBinding(binding));
	}
	/** Fence all in-flight operations, then await authenticated DELETE session closure. */
	dispose(): Promise<void> {
		if (!this.disposePromise) this.disposePromise = this.disposeOnce();
		return this.disposePromise;
	}
	private async disposeOnce(): Promise<void> {
		this.disposed = true; this.generation += 1;
		for (const controller of this.controllers) controller.abort();
		// Snapshot before awaiting: repeated callers wait for precisely this lifecycle.
		const states = [...this.states.values()];
		await Promise.allSettled([...this.operations]);
		await Promise.allSettled(states.flatMap((state) => [...state.inFlight]));
		await Promise.allSettled(states.filter((state) => state.sessionId).map(async (state) => {
			const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeout);
			try { await this.authenticated(state, async (token) => { const headers: Record<string, string> = { "MCP-Protocol-Version": "2025-03-26", "Mcp-Session-Id": state.sessionId! }; if (token) headers.Authorization = `Bearer ${token}`; const result = await this.fetchImpl(state.binding.endpoint, { method: "DELETE", headers, signal: controller.signal, redirect: "error" }); try { await drain(result, this.maximum); } catch { /* bounded close body */ } }); }
			finally { clearTimeout(timer); }
		}));
		this.states.clear();
	}
}
