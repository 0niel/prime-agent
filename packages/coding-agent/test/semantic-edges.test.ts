import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deriveSemanticEdges,
	hashTurnBody,
	IDEMPOTENCY_KEY_HEADER,
	MODEL_REQUEST_ID_HEADER,
	modelRequestHeaders,
	readSemanticEdgeLedger,
	type SemanticEdgeLedgerEvent,
	SemanticEdgeRecorder,
	wrapStreamFnWithSemanticEdges,
} from "../src/core/semantic-edges.js";

describe("SemanticEdgeRecorder", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createRecorder(overrides: Partial<ConstructorParameters<typeof SemanticEdgeRecorder>[0]> = {}) {
		return new SemanticEdgeRecorder({
			ledgerPath: join(tempDir, "semantic-edges.jsonl"),
			sessionId: "root-session",
			...overrides,
		});
	}

	function ledger(): SemanticEdgeLedgerEvent[] {
		return readSemanticEdgeLedger(join(tempDir, "semantic-edges.jsonl"));
	}

	it("emits both wire headers with one opaque uuid4-hex request ID", () => {
		const recorder = createRecorder();
		const requestId = recorder.startTurnRequest();
		expect(requestId).toMatch(/^[0-9a-f]{32}$/);
		expect(modelRequestHeaders(requestId)).toEqual({
			[MODEL_REQUEST_ID_HEADER]: requestId,
			[IDEMPOTENCY_KEY_HEADER]: requestId,
		});
	});

	it("appends registration, request, and outcome events in order", () => {
		const recorder = createRecorder();
		const requestId = recorder.startTurnRequest();
		recorder.finishRequest(requestId);
		expect(ledger()).toEqual([
			{ type: "session_registered", session_id: "root-session" },
			{ type: "request_started", request_id: requestId, session_id: "root-session" },
			{ type: "request_finished", request_id: requestId },
		]);
		expect(recorder.lastCommittedRequestId).toBe(requestId);
	});

	it("reuses a parked retry ID only for a byte-identical body and re-logs the start", () => {
		const recorder = createRecorder();
		const body = hashTurnBody({ provider: "p", id: "m" }, { messages: [{ role: "user", content: "hi" }] });
		const failedId = recorder.startTurnRequest(body);
		recorder.failRequest(failedId);
		recorder.prepareTurnRetry();

		// Same message count and roles but different content must not steal the key.
		const sideBody = hashTurnBody(
			{ provider: "p", id: "m" },
			{ messages: [{ role: "user", content: "side question" }] },
		);
		const sideId = recorder.startTurnRequest(sideBody);
		expect(sideId).not.toBe(failedId);

		const retryId = recorder.startTurnRequest(body);
		expect(retryId).toBe(failedId);
		// The reused retry re-logs request_started so the fold re-claims returned edges.
		const startEvents = ledger().filter((event) => event.type === "request_started");
		expect(startEvents.map((event) => event.request_id)).toEqual([failedId, sideId, failedId]);
	});

	it("keys retry identity on model identity too", () => {
		const recorder = createRecorder();
		const messages = [{ role: "user", content: "hi" }];
		const failedId = recorder.startTurnRequest(hashTurnBody({ provider: "p", id: "m1" }, { messages }));
		recorder.prepareTurnRetry();
		expect(recorder.startTurnRequest(hashTurnBody({ provider: "p", id: "m2" }, { messages }))).not.toBe(failedId);
	});

	it("keys retry identity on the provider too", () => {
		const recorder = createRecorder();
		const messages = [{ role: "user", content: "hi" }];
		const failedId = recorder.startTurnRequest(hashTurnBody({ provider: "p1", id: "m" }, { messages }));
		recorder.prepareTurnRetry();
		expect(recorder.startTurnRequest(hashTurnBody({ provider: "p2", id: "m" }, { messages }))).not.toBe(failedId);
	});

	it("keys retry identity on the system prompt too", () => {
		const recorder = createRecorder();
		const messages = [{ role: "user", content: "hi" }];
		const failedId = recorder.startTurnRequest(
			hashTurnBody({ provider: "p", id: "m" }, { systemPrompt: "a", messages }),
		);
		recorder.prepareTurnRetry();
		expect(
			recorder.startTurnRequest(hashTurnBody({ provider: "p", id: "m" }, { systemPrompt: "b", messages })),
		).not.toBe(failedId);
	});

	it("hashes the body at request time, not at park time", () => {
		const recorder = createRecorder();
		const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [
			{ role: "user", content: [{ type: "text", text: "original" }] },
		];
		const context = { systemPrompt: "s", messages };
		const failedId = recorder.startTurnRequest(hashTurnBody({ provider: "p", id: "m" }, context));

		// TOCTOU: the live message objects mutate between the call and the park.
		messages[0]!.content[0]!.text = "mutated";
		recorder.prepareTurnRetry();

		const retryId = recorder.startTurnRequest(hashTurnBody({ provider: "p", id: "m" }, context));
		expect(retryId).not.toBe(failedId);
	});

	it("mints a fresh ID when a compaction completed between failure and retry", () => {
		const recorder = createRecorder();
		const failedId = recorder.startTurnRequest("body-hash");
		recorder.prepareTurnRetry();
		const compaction = recorder.beginCompaction();
		recorder.finishCompaction(compaction.compactionId, "completed");
		expect(recorder.startTurnRequest("body-hash")).not.toBe(failedId);
	});

	it("keeps the parked ID across a failed compaction", () => {
		const recorder = createRecorder();
		const failedId = recorder.startTurnRequest("body-hash");
		recorder.prepareTurnRetry();
		const compaction = recorder.beginCompaction();
		recorder.finishCompaction(compaction.compactionId, "failed");
		expect(recorder.startTurnRequest("body-hash")).toBe(failedId);
	});

	it("clears a parked retry ID", () => {
		const recorder = createRecorder();
		const failedId = recorder.startTurnRequest("body-hash");
		recorder.prepareTurnRetry();
		recorder.clearTurnRetry();
		expect(recorder.startTurnRequest("body-hash")).not.toBe(failedId);
	});

	it("never reuses a retry parked from a replayed ledger (body unknowable)", () => {
		const first = createRecorder();
		first.startTurnRequest("body-hash");

		const resumed = createRecorder();
		expect(resumed.lastTurnRequestId).toBe(first.lastTurnRequestId);
		resumed.prepareTurnRetry();
		expect(resumed.startTurnRequest("body-hash")).not.toBe(first.lastTurnRequestId);
	});

	it("never matches an undefined parked hash against an undefined call hash", () => {
		const first = createRecorder();
		first.startTurnRequest("body-hash");

		const resumed = createRecorder();
		resumed.prepareTurnRetry();
		// Both sides unknown must still mint fresh; undefined === undefined is not identity.
		expect(resumed.startTurnRequest(undefined)).not.toBe(first.lastTurnRequestId);
	});

	it("replays an existing ledger instead of re-registering on resume", () => {
		const first = createRecorder();
		const requestId = first.startTurnRequest();
		first.finishRequest(requestId);

		const resumed = createRecorder();
		expect(resumed.lastTurnRequestId).toBe(requestId);
		expect(resumed.lastCommittedRequestId).toBe(requestId);
		expect(ledger().filter((event) => event.type === "session_registered")).toHaveLength(1);
	});

	it("does not treat a compaction summary request as the spawnable last turn", () => {
		const recorder = createRecorder();
		const turnId = recorder.startTurnRequest();
		const compaction = recorder.beginCompaction();
		recorder.startCompactionRequest(compaction.compactionId);
		expect(recorder.lastTurnRequestId).toBe(turnId);

		const resumed = createRecorder();
		expect(resumed.lastTurnRequestId).toBe(turnId);
	});

	it("rejects finishing an unknown compaction", () => {
		const recorder = createRecorder();
		expect(() => recorder.finishCompaction("ghost", "completed")).toThrow(/unknown semantic-edge compaction/);
	});

	it("tolerates a torn (unterminated) final line and repairs it on the first append only", () => {
		const recorder = createRecorder();
		recorder.startTurnRequest();
		const path = join(tempDir, "semantic-edges.jsonl");
		appendFileSync(path, '{"type":"request_started","request_id":"torn');
		const tornBytes = readFileSync(path);

		expect(readSemanticEdgeLedger(path)).toHaveLength(2);

		// Construction (e.g. a viewer over a live writer's ledger) must not mutate the file.
		const resumed = createRecorder();
		expect(readFileSync(path).equals(tornBytes)).toBe(true);

		const requestId = resumed.startTurnRequest();
		const events = readSemanticEdgeLedger(path);
		expect(events.filter((event) => event.type === "session_registered")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "request_started", request_id: requestId });
		// The torn line was truncated away, so the whole file parses again.
		expect(events).toHaveLength(3);
	});

	it("readSemanticEdgeLedger never mutates the file", () => {
		const recorder = createRecorder();
		recorder.startTurnRequest();
		const path = join(tempDir, "semantic-edges.jsonl");
		appendFileSync(path, '{"type":"request_started","request_id":"torn');
		const before = readFileSync(path);

		readSemanticEdgeLedger(path);

		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("readSemanticEdgeLedger never opens the ledger for writing", () => {
		// A write-mode open would create the missing file instead of throwing.
		const missing = join(tempDir, "missing.jsonl");
		expect(() => readSemanticEdgeLedger(missing)).toThrow(/ENOENT/);
		expect(existsSync(missing)).toBe(false);
	});

	it("applies torn-tail repair exactly once, not on every append", () => {
		const recorder = createRecorder();
		const originalId = recorder.startTurnRequest();
		const path = join(tempDir, "semantic-edges.jsonl");
		appendFileSync(path, '{"type":"request_started","request_id":"torn');

		const resumed = createRecorder();
		const firstId = resumed.startTurnRequest();
		// A re-applied truncation here would chop the first appended event.
		const secondId = resumed.startTurnRequest();

		const requestIds = readSemanticEdgeLedger(path)
			.filter((event) => event.type === "request_started")
			.map((event) => (event.type === "request_started" ? event.request_id : ""));
		expect(requestIds).toEqual([originalId, firstId, secondId]);
	});

	it("newline-terminates a valid unterminated final line before appending", () => {
		const recorder = createRecorder();
		const firstId = recorder.startTurnRequest();
		const path = join(tempDir, "semantic-edges.jsonl");
		const raw = readFileSync(path, "utf8");
		rmSync(path);
		appendFileSync(path, raw.slice(0, -1));

		const resumed = createRecorder();
		const secondId = resumed.startTurnRequest();
		const requestIds = readSemanticEdgeLedger(path)
			.filter((event) => event.type === "request_started")
			.map((event) => (event.type === "request_started" ? event.request_id : ""));
		expect(requestIds).toEqual([firstId, secondId]);
	});

	it("treats a newline-terminated malformed final line as corruption, not a torn append", () => {
		const path = join(tempDir, "semantic-edges.jsonl");
		const recorder = createRecorder();
		recorder.startTurnRequest();
		appendFileSync(path, '{"broken\n');
		expect(() => readSemanticEdgeLedger(path)).toThrow(/corrupt semantic-edge ledger line 3/);
	});

	it("rejects mid-file ledger corruption loudly", () => {
		const path = join(tempDir, "semantic-edges.jsonl");
		const recorder = createRecorder();
		recorder.startTurnRequest();
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		lines[0] = '{"broken';
		rmSync(path);
		appendFileSync(path, `${lines.join("\n")}\n`);
		expect(() => readSemanticEdgeLedger(path)).toThrow(/corrupt semantic-edge ledger line 1/);
	});
});

describe("deriveSemanticEdges", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-semantic-derive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function recorderAt(name: string, options: { parentSessionId?: string; spawnedByRequestId?: string } = {}) {
		return new SemanticEdgeRecorder({
			ledgerPath: join(tempDir, name),
			sessionId: name.replace(".jsonl", ""),
			...options,
		});
	}

	function eventsAt(name: string): SemanticEdgeLedgerEvent[] {
		return readSemanticEdgeLedger(join(tempDir, name));
	}

	it("links a committed turn chain with continuation edges", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);
		const r2 = root.startTurnRequest();
		root.finishRequest(r2);

		expect(deriveSemanticEdges([eventsAt("root.jsonl")]).edges).toEqual([
			{ source_request_id: r1, target_request_id: r2, type: "continuation" },
		]);
	});

	it("defers the subagent_call edge to the child's first COMMITTED request", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);

		const child = recorderAt("child.jsonl", { parentSessionId: "root", spawnedByRequestId: r1 });
		const c1 = child.startTurnRequest();
		child.failRequest(c1);
		const c2 = child.startTurnRequest();
		child.finishRequest(c2);

		expect(deriveSemanticEdges([eventsAt("root.jsonl"), eventsAt("child.jsonl")]).edges).toEqual([
			{ source_request_id: r1, target_request_id: c2, type: "subagent_call" },
		]);
	});

	it("routes subagent_return to the parent's next committed request", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);

		const child = recorderAt("child.jsonl", { parentSessionId: "root", spawnedByRequestId: r1 });
		const c1 = child.startTurnRequest();
		child.finishRequest(c1);

		root.recordChildReturned("child", c1);
		// A duplicate return claim for the same child is ignored.
		root.recordChildReturned("child", c1);
		const r2 = root.startTurnRequest();
		root.finishRequest(r2);

		expect(deriveSemanticEdges([eventsAt("root.jsonl"), eventsAt("child.jsonl")]).edges).toEqual([
			{ source_request_id: c1, target_request_id: r2, type: "subagent_return" },
			{ source_request_id: r1, target_request_id: r2, type: "continuation" },
			{ source_request_id: r1, target_request_id: c1, type: "subagent_call" },
		]);
	});

	it("emits a compaction edge and suppresses the continuation from the same summary", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);
		const compaction = root.beginCompaction();
		const s1 = root.startCompactionRequest(compaction.compactionId);
		root.finishRequest(s1);
		root.finishCompaction(compaction.compactionId, "completed");
		const r2 = root.startTurnRequest();
		root.finishRequest(r2);

		expect(deriveSemanticEdges([eventsAt("root.jsonl")]).edges).toEqual([
			{ source_request_id: r1, target_request_id: s1, type: "continuation" },
			{ source_request_id: s1, target_request_id: r2, type: "compaction" },
		]);
	});

	it("emits no compaction edge for a failed compaction and re-claims the pending continuation", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);
		const compaction = root.beginCompaction();
		const s1 = root.startCompactionRequest(compaction.compactionId);
		root.failRequest(s1);
		root.finishCompaction(compaction.compactionId, "failed");
		const r2 = root.startTurnRequest();
		root.finishRequest(r2);

		expect(deriveSemanticEdges([eventsAt("root.jsonl")]).edges).toEqual([
			{ source_request_id: r1, target_request_id: r2, type: "continuation" },
		]);
	});

	it("emits no compaction edge for an extension-supplied compaction (no summary request)", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);
		const compaction = root.beginCompaction();
		root.finishCompaction(compaction.compactionId, "completed");
		const r2 = root.startTurnRequest();
		root.finishRequest(r2);

		expect(deriveSemanticEdges([eventsAt("root.jsonl")]).edges).toEqual([
			{ source_request_id: r1, target_request_id: r2, type: "continuation" },
		]);
	});

	it("re-claims a failed request's edges on the next commit", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);
		const r2 = root.startTurnRequest();
		root.failRequest(r2);
		const r3 = root.startTurnRequest();
		root.finishRequest(r3);

		expect(deriveSemanticEdges([eventsAt("root.jsonl")]).edges).toEqual([
			{ source_request_id: r1, target_request_id: r3, type: "continuation" },
		]);
	});

	it("commits a retried request's edges exactly once under ID reuse", () => {
		const root = recorderAt("root.jsonl");
		const r0 = root.startTurnRequest();
		root.finishRequest(r0);
		const r1 = root.startTurnRequest("body-hash");
		root.failRequest(r1);
		root.prepareTurnRetry();
		const retried = root.startTurnRequest("body-hash");
		expect(retried).toBe(r1);
		root.finishRequest(r1);

		expect(deriveSemanticEdges([eventsAt("root.jsonl")]).edges).toEqual([
			{ source_request_id: r0, target_request_id: r1, type: "continuation" },
		]);
	});

	it("tolerates an in-flight request at the ledger tail without edges or throws", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);
		root.startTurnRequest();

		expect(deriveSemanticEdges([eventsAt("root.jsonl")]).edges).toEqual([]);
	});

	it("derives the same edges regardless of ledger order", () => {
		const root = recorderAt("root.jsonl");
		const r1 = root.startTurnRequest();
		root.finishRequest(r1);
		const child = recorderAt("child.jsonl", { parentSessionId: "root", spawnedByRequestId: r1 });
		const c1 = child.startTurnRequest();
		child.finishRequest(c1);
		root.recordChildReturned("child", c1);
		const r2 = root.startTurnRequest();
		root.finishRequest(r2);

		const forward = deriveSemanticEdges([eventsAt("root.jsonl"), eventsAt("child.jsonl")]).edges;
		const reversed = deriveSemanticEdges([eventsAt("child.jsonl"), eventsAt("root.jsonl")]).edges;
		expect(new Set(reversed.map((edge) => JSON.stringify(edge)))).toEqual(
			new Set(forward.map((edge) => JSON.stringify(edge))),
		);
		expect(forward).toHaveLength(3);
	});
});

describe("wrapStreamFnWithSemanticEdges", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-semantic-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const model = { provider: "p", id: "m" } as Parameters<StreamFn>[0];
	const context = { systemPrompt: "s", messages: [], tools: [] } as unknown as Parameters<StreamFn>[1];

	function recorderIn(name: string): SemanticEdgeRecorder {
		return new SemanticEdgeRecorder({ ledgerPath: join(tempDir, name), sessionId: name });
	}

	function message(stopReason: "stop" | "error" | "aborted") {
		return {
			role: "assistant",
			content: [],
			api: "a",
			provider: "p",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		};
	}

	it("adds both wire headers on top of caller headers without dropping them", () => {
		const recorder = recorderIn("a.jsonl");
		const captured: Array<Record<string, string> | undefined> = [];
		const inner: StreamFn = (_model, _context, options) => {
			captured.push(options?.headers);
			return createAssistantMessageEventStream();
		};
		const wrapped = wrapStreamFnWithSemanticEdges(inner, recorder);

		wrapped(model, context, { headers: { "x-sentinel": "keep-me" } });

		expect(captured).toHaveLength(1);
		const headers = captured[0] ?? {};
		expect(headers["x-sentinel"]).toBe("keep-me");
		expect(headers[MODEL_REQUEST_ID_HEADER]).toMatch(/^[0-9a-f]{32}$/);
		expect(headers[IDEMPOTENCY_KEY_HEADER]).toBe(headers[MODEL_REQUEST_ID_HEADER]);
		expect(headers[MODEL_REQUEST_ID_HEADER]).toBe(recorder.lastTurnRequestId);
	});

	it("commits the request when its stream resolves and fails it on error or aborted", async () => {
		const recorder = recorderIn("b.jsonl");
		const streams: Array<ReturnType<typeof createAssistantMessageEventStream>> = [];
		const inner: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			streams.push(stream);
			return stream;
		};
		const wrapped = wrapStreamFnWithSemanticEdges(inner, recorder);

		wrapped(model, context, undefined);
		streams[0]!.push({ type: "done", reason: "stop", message: message("stop") as never });
		await new Promise((resolve) => setImmediate(resolve));

		wrapped(model, context, undefined);
		streams[1]!.push({ type: "error", reason: "error", error: message("error") as never });
		await new Promise((resolve) => setImmediate(resolve));

		const events = readSemanticEdgeLedger(join(tempDir, "b.jsonl"));
		const outcomes = events.filter((event) => event.type === "request_finished" || event.type === "request_failed");
		expect(outcomes.map((event) => event.type)).toEqual(["request_finished", "request_failed"]);
	});

	it("fails the request when the inner stream function throws", () => {
		const recorder = recorderIn("c.jsonl");
		const inner: StreamFn = () => {
			throw new Error("no transport");
		};
		const wrapped = wrapStreamFnWithSemanticEdges(inner, recorder);

		expect(() => wrapped(model, context, undefined)).toThrow("no transport");
		const events = readSemanticEdgeLedger(join(tempDir, "c.jsonl"));
		expect(events.at(-1)).toMatchObject({ type: "request_failed" });
	});

	it("rebinding a wrapped streamFn attributes calls to the new recorder only", () => {
		const parentRecorder = recorderIn("parent.jsonl");
		const childRecorder = recorderIn("child.jsonl");
		let innerCalls = 0;
		const inner: StreamFn = () => {
			innerCalls += 1;
			return createAssistantMessageEventStream();
		};
		const parentWrapped = wrapStreamFnWithSemanticEdges(inner, parentRecorder);
		const childWrapped = wrapStreamFnWithSemanticEdges(parentWrapped, childRecorder);

		childWrapped(model, context, undefined);

		expect(innerCalls).toBe(1);
		expect(childRecorder.lastTurnRequestId).toBeDefined();
		// A double-wrap would also mint a parent request for the child's call.
		expect(parentRecorder.lastTurnRequestId).toBeUndefined();
		expect(
			readSemanticEdgeLedger(join(tempDir, "parent.jsonl")).filter((event) => event.type === "request_started"),
		).toHaveLength(0);
	});
});
