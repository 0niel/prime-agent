/**
 * A test-only provider for production-path swarm tests.
 *
 * Unlike faux, scripts are selected by the stable request id carried in the
 * fixture prompt.  There is deliberately no FIFO shared between requests and
 * the barrier is an observation latch, never an admission limiter.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
	type StreamOptions,
	type ToolCall,
	type Usage,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";

export interface ScriptedModelDefinition {
	readonly id: string;
	readonly name?: string;
	readonly responseModel?: string;
	readonly reasoning?: boolean;
	readonly cost?: Model<string>["cost"];
}

export type ScriptedBlock =
	| { readonly type: "thinking"; readonly chunks: readonly string[] }
	| { readonly type: "text"; readonly chunks: readonly string[] }
	| {
			readonly type: "toolCall";
			readonly id: string;
			readonly name: string;
			readonly argumentChunks: readonly string[];
	  };

export interface ProviderScript {
	/** A stable logical id, e.g. request-0001. Selection never depends on arrival order. */
	readonly requestId: string;
	readonly blocks?: readonly ScriptedBlock[];
	readonly stopReason?: "stop" | "length" | "toolUse";
	readonly responseId?: string;
	readonly responseModel?: string;
	readonly usage: Usage;
	/** A scripted upstream response status.  429 is not manufactured by a client limiter. */
	readonly upstreamStatus?: number;
	readonly errorCode?: "upstream-429" | "upstream-error";
	/** First-turn scripts may be held after entry; later tool turns normally are not. */
	readonly waitForRelease?: boolean;
}

interface MutableProviderObservation {
	sequence: number;
	requestId: string;
	attempt: number;
	requested: Readonly<{
		api: string;
		provider: string;
		model: string;
		reasoning?: string;
		maxRetries?: number;
	}>;
	eventKinds: readonly AssistantMessageEvent["type"][];
	upstreamStatus: number;
	signalAborted: boolean;
	terminal: "done" | "error" | "aborted";
	responseModel?: string;
	usage?: Usage;
}

export interface ProviderObservation {
	readonly sequence: number;
	readonly requestId: string;
	readonly attempt: number;
	readonly requested: Readonly<{
		api: string;
		provider: string;
		model: string;
		reasoning?: string;
		maxRetries?: number;
	}>;
	readonly eventKinds: readonly AssistantMessageEvent["type"][];
	readonly upstreamStatus: number;
	readonly signalAborted: boolean;
	readonly terminal: "done" | "error" | "aborted";
	readonly responseModel?: string;
	readonly usage?: Usage;
}

export interface BarrierScriptedProvider {
	readonly models: readonly Model<string>[];
	/** Resolves only after every predeclared, barrier-held request entered exactly once. */
	readonly open: Promise<void>;
	release(ids?: readonly string[]): void;
	observations(): readonly ProviderObservation[];
	unregister(): void;
}

export interface CreateBarrierScriptedProviderOptions {
	readonly api: string;
	readonly provider?: string;
	readonly models: readonly ScriptedModelDefinition[];
	/** Each logical id owns its sequence of turns. Arrays are not a cross-request queue. */
	readonly scripts: Readonly<Record<string, readonly ProviderScript[]>>;
	readonly barrier: { readonly expected: readonly string[]; readonly timeoutMs?: number };
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function cloneUsage(usage: Usage): Usage {
	return structuredClone(usage);
}
function clone<T>(value: T): T {
	return structuredClone(value);
}
function requestIdFrom(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((x) => (x.type === "text" ? x.text : "")).join(" ");
		const found = /\brequest-\d{4}\b/.exec(text);
		if (found) return found[0];
	}
	return undefined;
}
function abortedMessage(
	model: Model<string>,
	responseModel: string | undefined,
	usage = EMPTY_USAGE,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel,
		usage: cloneUsage(usage),
		stopReason: "aborted",
		errorMessage: "fixture request aborted",
		timestamp: Date.now(),
	};
}
function errorMessage(
	model: Model<string>,
	responseModel: string | undefined,
	usage: Usage,
	code: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel,
		usage: cloneUsage(usage),
		stopReason: "error",
		errorMessage: code,
		timestamp: Date.now(),
	};
}
function assertScript(script: ProviderScript, requestId: string): void {
	if (script.requestId !== requestId) throw new Error("B00B_SCRIPT_ID_MISMATCH");
	if (!/^request-\d{4}$/.test(requestId)) throw new Error("B00B_BAD_REQUEST_ID");
}

/** Abort-aware gate. It owns one promise per request, so one abort cannot release a sibling. */
export function createBarrier(expected: readonly string[], timeoutMs: number) {
	const expectedSet = new Set(expected);
	if (expectedSet.size !== expected.length || expected.some((id) => !/^request-\d{4}$/.test(id))) {
		throw new Error("B00B_BAD_BARRIER_EXPECTED");
	}
	let resolveOpen!: () => void;
	let rejectOpen!: (error: Error) => void;
	let openSettled = false;
	let closed = false;
	const open = new Promise<void>((resolve, reject) => {
		resolveOpen = resolve;
		rejectOpen = reject;
	});
	const entered = new Set<string>();
	const released = new Set<string>();
	const waiters = new Map<string, (result: "released" | "aborted") => void>();
	const abortPendingWaiters = () => {
		for (const waiter of waiters.values()) waiter("aborted");
		waiters.clear();
	};
	const rejectPendingOpen = (error: Error) => {
		if (openSettled) return;
		openSettled = true;
		rejectOpen(error);
	};
	const timer = setTimeout(() => {
		if (closed) return;
		closed = true;
		rejectPendingOpen(new Error("B00B_BARRIER_TIMEOUT"));
		abortPendingWaiters();
	}, timeoutMs);
	const enteredRequest = (id: string) => {
		if (!expectedSet.has(id)) return;
		if (entered.has(id)) throw new Error("B00B_BARRIER_DUPLICATE");
		entered.add(id);
		if (entered.size === expectedSet.size && !openSettled) {
			openSettled = true;
			clearTimeout(timer);
			resolveOpen();
		}
	};
	const wait = (id: string, signal: AbortSignal | undefined) =>
		new Promise<"released" | "aborted">((resolve) => {
			let done = false;
			let onAbort: (() => void) | undefined;
			const settle = (result: "released" | "aborted") => {
				if (done) return;
				done = true;
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				waiters.delete(id);
				resolve(result);
			};
			onAbort = () => settle("aborted");
			if (closed || signal?.aborted) return settle("aborted");
			if (released.has(id)) return settle("released");
			waiters.set(id, settle);
			signal?.addEventListener("abort", onAbort, { once: true });
			// The abort may race listener registration in an implementation-specific host.
			if (signal?.aborted) settle("aborted");
		});
	return {
		open,
		entered: enteredRequest,
		wait,
		release(ids?: readonly string[]) {
			for (const id of ids ?? expected) {
				released.add(id);
				waiters.get(id)?.("released");
			}
		},
		close() {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			rejectPendingOpen(new Error("B00B_BARRIER_CLOSED"));
			abortPendingWaiters();
		},
	};
}

/**
 * Registers the actual @earendil-works/pi-ai API provider seam. The returned
 * provider is test-only; no product source imports it.
 */
export function createBarrierScriptedProvider(options: CreateBarrierScriptedProviderOptions): BarrierScriptedProvider {
	const provider = options.provider ?? "b00b-scripted";
	const sourceId = `b00b-scripted:${options.api}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	const barrier = createBarrier(options.barrier.expected, options.barrier.timeoutMs ?? 5_000);
	const models = options.models.map(
		(definition) =>
			({
				id: definition.id,
				name: definition.name ?? definition.id,
				api: options.api,
				provider,
				baseUrl: "http://127.0.0.1:0",
				reasoning: definition.reasoning ?? true,
				input: ["text"] as ("text" | "image")[],
				cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_384,
			}) satisfies Model<string>,
	);
	if (!models.length) throw new Error("B00B_NO_MODELS");
	const attempts = new Map<string, number>();
	const recorded: MutableProviderObservation[] = [];
	let sequence = 0;
	let unregistered = false;

	const stream = (model: Model<string>, context: Context, streamOptions?: StreamOptions | SimpleStreamOptions) => {
		const output = createAssistantMessageEventStream();
		const requestId = requestIdFrom(context);
		if (!requestId) throw new Error("B00B_MISSING_REQUEST_ID");
		const attempt = attempts.get(requestId) ?? 0;
		attempts.set(requestId, attempt + 1);
		const script = options.scripts[requestId]?.[attempt];
		if (!script) throw new Error("B00B_UNSCRIPTED_ATTEMPT");
		assertScript(script, requestId);
		const observation: MutableProviderObservation = {
			sequence: ++sequence,
			requestId,
			attempt: attempt + 1,
			requested: {
				api: model.api,
				provider: model.provider,
				model: model.id,
				reasoning: (streamOptions as SimpleStreamOptions | undefined)?.reasoning,
				maxRetries: streamOptions?.maxRetries,
			},
			eventKinds: [],
			upstreamStatus: script.upstreamStatus ?? 200,
			signalAborted: false,
			terminal: "error",
		};
		recorded.push(observation);
		queueMicrotask(async () => {
			const emit = (event: AssistantMessageEvent) => {
				observation.eventKinds = [...observation.eventKinds, event.type];
				output.push(event);
			};
			const terminalAbort = () => {
				observation.signalAborted = true;
				observation.terminal = "aborted";
				const message = abortedMessage(model, script.responseModel, script.usage);
				emit({ type: "error", reason: "aborted", error: message });
				output.end(message);
			};
			try {
				// Only the first provider entry belongs to the fanout observation latch; tool turns remain independent.
				if (attempt === 0) barrier.entered(requestId);
				await streamOptions?.onResponse?.({ status: script.upstreamStatus ?? 200, headers: {} }, model);
				if (streamOptions?.signal?.aborted) return terminalAbort();
				if (script.waitForRelease) {
					if ((await barrier.wait(requestId, streamOptions?.signal)) === "aborted") return terminalAbort();
				}
				if (streamOptions?.signal?.aborted) return terminalAbort();
				if ((script.upstreamStatus ?? 200) >= 400 || script.errorCode) {
					observation.terminal = "error";
					const message = errorMessage(
						model,
						script.responseModel,
						script.usage,
						script.errorCode ?? "upstream-error",
					);
					emit({ type: "error", reason: "error", error: message });
					output.end(message);
					return;
				}
				const content: AssistantMessage["content"] = [];
				const partial = (): AssistantMessage => ({
					role: "assistant",
					content: clone(content),
					api: model.api,
					provider: model.provider,
					model: model.id,
					responseModel: script.responseModel,
					usage: cloneUsage(script.usage),
					stopReason: script.stopReason ?? "stop",
					responseId: script.responseId,
					timestamp: Date.now(),
				});
				emit({ type: "start", partial: partial() });
				for (const block of script.blocks ?? []) {
					if (streamOptions?.signal?.aborted) return terminalAbort();
					const contentIndex = content.length;
					if (block.type === "thinking") {
						content.push({ type: "thinking", thinking: "" });
						emit({ type: "thinking_start", contentIndex, partial: partial() });
						for (const delta of block.chunks) {
							if (streamOptions?.signal?.aborted) return terminalAbort();
							(content[contentIndex] as { thinking: string }).thinking += delta;
							emit({ type: "thinking_delta", contentIndex, delta, partial: partial() });
						}
						emit({
							type: "thinking_end",
							contentIndex,
							content: (content[contentIndex] as { thinking: string }).thinking,
							partial: partial(),
						});
					} else if (block.type === "text") {
						content.push({ type: "text", text: "" });
						emit({ type: "text_start", contentIndex, partial: partial() });
						for (const delta of block.chunks) {
							if (streamOptions?.signal?.aborted) return terminalAbort();
							(content[contentIndex] as { text: string }).text += delta;
							emit({ type: "text_delta", contentIndex, delta, partial: partial() });
						}
						emit({
							type: "text_end",
							contentIndex,
							content: (content[contentIndex] as { text: string }).text,
							partial: partial(),
						});
					} else {
						content.push({ type: "toolCall", id: block.id, name: block.name, arguments: {} });
						emit({ type: "toolcall_start", contentIndex, partial: partial() });
						for (const delta of block.argumentChunks) {
							if (streamOptions?.signal?.aborted) return terminalAbort();
							emit({ type: "toolcall_delta", contentIndex, delta, partial: partial() });
						}
						const joined = block.argumentChunks.join("");
						const toolCall = content[contentIndex] as ToolCall;
						toolCall.arguments = JSON.parse(joined || "{}");
						emit({ type: "toolcall_end", contentIndex, toolCall: clone(toolCall), partial: partial() });
					}
				}
				const message = partial();
				observation.terminal = "done";
				observation.responseModel = message.responseModel;
				observation.usage = cloneUsage(message.usage);
				emit({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
				output.end(message);
			} catch {
				if (streamOptions?.signal?.aborted) return terminalAbort();
				observation.terminal = "error";
				const message = errorMessage(model, script.responseModel, script.usage, "script-provider-failure");
				emit({ type: "error", reason: "error", error: message });
				output.end(message);
			}
		});
		return output;
	};
	registerApiProvider({ api: options.api, stream, streamSimple: stream }, sourceId);
	return {
		models,
		open: barrier.open,
		release: (ids) => barrier.release(ids),
		observations: () => recorded.map((item) => clone(item)),
		unregister() {
			if (!unregistered) {
				unregistered = true;
				barrier.close();
				unregisterApiProviders(sourceId);
			}
		},
	};
}
