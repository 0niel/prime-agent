import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deriveLineageManifest,
	hashTurnBody,
	IDEMPOTENCY_KEY_HEADER,
	LINEAGE_REQUEST_ID_HEADER,
	type LineageEvent,
	type LineageManifest,
	LineageRecorder,
	lineageRequestHeaders,
	readLineageLedger,
	wrapStreamFnWithLineage,
} from "../src/core/lineage.js";
import { assertLineageManifestInvariants } from "./lineage-invariants.js";

const LINEAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

describe("LineageRecorder", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lineage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createRecorder(overrides: Partial<ConstructorParameters<typeof LineageRecorder>[0]> = {}) {
		return new LineageRecorder({
			ledgerPath: join(tempDir, "lineage.jsonl"),
			sessionId: "root-session",
			depth: 0,
			...overrides,
		});
	}

	function ledger(): LineageEvent[] {
		return readLineageLedger(join(tempDir, "lineage.jsonl"));
	}

	it("emits both wire headers with one opaque uuid4-hex request ID", () => {
		const recorder = createRecorder();
		const requestId = recorder.startTurnRequest();
		expect(requestId).toMatch(/^[0-9a-f]{32}$/);
		expect(requestId).toMatch(LINEAGE_ID_PATTERN);
		const headers = lineageRequestHeaders(requestId);
		expect(headers).toEqual({
			[LINEAGE_REQUEST_ID_HEADER]: requestId,
			[IDEMPOTENCY_KEY_HEADER]: requestId,
		});
	});

	it("appends registration and request events to the ledger in order", () => {
		const recorder = createRecorder();
		const requestId = recorder.startTurnRequest();
		expect(ledger()).toEqual([
			{
				type: "session_registered",
				session_id: "root-session",
				depth: 0,
				initial_context_id: recorder.activeContextId,
			},
			{
				type: "request_started",
				request_id: requestId,
				session_id: "root-session",
				context_id: recorder.activeContextId,
				kind: "turn",
			},
		]);
	});

	it("reuses a parked retry ID only for a byte-identical body", () => {
		const recorder = createRecorder();
		const body = () => hashTurnBody({ provider: "p", id: "m" }, { messages: [{ role: "user", content: "hi" }] });
		const failedId = recorder.startTurnRequest(body);
		recorder.prepareTurnRetry();

		// Same message count and roles but different content must not steal the key.
		const sideBody = () =>
			hashTurnBody({ provider: "p", id: "m" }, { messages: [{ role: "user", content: "side question" }] });
		const sideId = recorder.startTurnRequest(sideBody);
		expect(sideId).not.toBe(failedId);

		const retryId = recorder.startTurnRequest(body);
		expect(retryId).toBe(failedId);
		// The reused retry writes no second request event for the same ID.
		const requestEvents = ledger().filter((event) => event.type === "request_started");
		expect(requestEvents.map((event) => event.request_id)).toEqual([failedId, sideId]);
	});

	it("keys retry identity on model identity too", () => {
		const recorder = createRecorder();
		const messages = [{ role: "user", content: "hi" }];
		const failedId = recorder.startTurnRequest(() => hashTurnBody({ provider: "p", id: "m1" }, { messages }));
		recorder.prepareTurnRetry();
		expect(recorder.startTurnRequest(() => hashTurnBody({ provider: "p", id: "m2" }, { messages }))).not.toBe(
			failedId,
		);
	});

	it("mints a fresh ID when the context changed between failure and retry", () => {
		const recorder = createRecorder();
		const body = () => "body-hash";
		const failedId = recorder.startTurnRequest(body);
		recorder.prepareTurnRetry();
		const compaction = recorder.beginCompaction();
		recorder.finishCompaction(compaction.compactionId, "completed");
		expect(recorder.startTurnRequest(body)).not.toBe(failedId);
	});

	it("clears a parked retry ID", () => {
		const recorder = createRecorder();
		const body = () => "body-hash";
		const failedId = recorder.startTurnRequest(body);
		recorder.prepareTurnRetry();
		recorder.clearTurnRetry();
		expect(recorder.startTurnRequest(body)).not.toBe(failedId);
	});

	it("never reuses a retry parked from a replayed ledger (body unknowable)", () => {
		const first = createRecorder();
		const body = () => "body-hash";
		first.startTurnRequest(body);

		const resumed = createRecorder();
		expect(resumed.lastTurnRequestId).toBe(first.lastTurnRequestId);
		resumed.prepareTurnRetry();
		expect(resumed.startTurnRequest(body)).not.toBe(first.lastTurnRequestId);
	});

	it("switches the context epoch only on completed compactions", () => {
		const recorder = createRecorder();
		const initialContext = recorder.activeContextId;

		const failed = recorder.beginCompaction();
		recorder.finishCompaction(failed.compactionId, "failed");
		expect(recorder.activeContextId).toBe(initialContext);

		const completed = recorder.beginCompaction();
		recorder.finishCompaction(completed.compactionId, "completed");
		const newContext = recorder.activeContextId;
		expect(newContext).not.toBe(initialContext);

		const turnId = recorder.startTurnRequest();
		const turnEvent = ledger().find((event) => event.type === "request_started" && event.request_id === turnId);
		expect(turnEvent).toMatchObject({
			context_id: newContext,
			kind: "turn",
			compaction_id: completed.compactionId,
		});

		const compactionRequests = ledger().filter(
			(event) => event.type === "request_started" && event.kind === "compaction",
		);
		expect(compactionRequests).toHaveLength(2);
		expect(
			compactionRequests.every((event) => event.type === "request_started" && event.context_id === initialContext),
		).toBe(true);
	});

	it("replays an existing ledger instead of re-registering on resume", () => {
		const first = createRecorder();
		const compaction = first.beginCompaction();
		first.finishCompaction(compaction.compactionId, "completed");
		const activeAfterCompaction = first.activeContextId;

		const resumed = createRecorder();
		expect(resumed.activeContextId).toBe(activeAfterCompaction);
		expect(ledger().filter((event) => event.type === "session_registered")).toHaveLength(1);
	});

	it("keeps the first terminal session status", () => {
		const recorder = createRecorder();
		recorder.recordSessionStatus("completed");
		recorder.recordSessionStatus("cancelled");
		const statusEvents = ledger().filter((event) => event.type === "session_status");
		expect(statusEvents).toEqual([{ type: "session_status", session_id: "root-session", status: "completed" }]);
	});

	it("tolerates a torn (unterminated) final line and repairs it on the first append only", () => {
		const recorder = createRecorder();
		recorder.startTurnRequest();
		const path = join(tempDir, "lineage.jsonl");
		appendFileSync(path, '{"type":"request_started","request_id":"torn');
		const tornBytes = readFileSync(path);

		expect(readLineageLedger(path)).toHaveLength(2);

		// Construction (e.g. a viewer over a live writer's ledger) must not mutate the file.
		const resumed = createRecorder();
		expect(readFileSync(path).equals(tornBytes)).toBe(true);

		const requestId = resumed.startTurnRequest();
		const events = readLineageLedger(path);
		expect(events.filter((event) => event.type === "session_registered")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "request_started", request_id: requestId });
		// The torn line was truncated away, so the whole file parses again.
		expect(events).toHaveLength(3);
	});

	it("newline-terminates a valid unterminated final line before appending", () => {
		const recorder = createRecorder();
		const firstId = recorder.startTurnRequest();
		const path = join(tempDir, "lineage.jsonl");
		const raw = readFileSync(path, "utf8");
		rmSync(path);
		appendFileSync(path, raw.slice(0, -1));

		const resumed = createRecorder();
		const secondId = resumed.startTurnRequest();
		const requestIds = readLineageLedger(path)
			.filter((event) => event.type === "request_started")
			.map((event) => (event.type === "request_started" ? event.request_id : ""));
		expect(requestIds).toEqual([firstId, secondId]);
	});

	it("treats a newline-terminated malformed final line as corruption, not a torn append", () => {
		const path = join(tempDir, "lineage.jsonl");
		const recorder = createRecorder();
		recorder.startTurnRequest();
		appendFileSync(path, '{"broken\n');
		expect(() => readLineageLedger(path)).toThrow(/corrupt lineage ledger line 3/);
	});

	it("rejects mid-file ledger corruption loudly", () => {
		const path = join(tempDir, "lineage.jsonl");
		const recorder = createRecorder();
		recorder.startTurnRequest();
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		lines[0] = '{"broken';
		rmSync(path);
		appendFileSync(path, `${lines.join("\n")}\n`);
		expect(() => readLineageLedger(path)).toThrow(/corrupt lineage ledger line 1/);
	});

	it("keeps a replayed terminal status over later observations", () => {
		const first = createRecorder();
		first.recordSessionStatus("completed");

		const resumed = createRecorder();
		resumed.recordSessionStatus("cancelled");
		const statusEvents = ledger().filter((event) => event.type === "session_status");
		expect(statusEvents).toEqual([{ type: "session_status", session_id: "root-session", status: "completed" }]);
	});
});

describe("deriveLineageManifest", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lineage-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("folds a root and child ledger pair into a valid lineage-v1 manifest", () => {
		const rootPath = join(tempDir, "root.jsonl");
		const childPath = join(tempDir, "child.jsonl");

		const root = new LineageRecorder({ ledgerPath: rootPath, sessionId: "root-session", depth: 0 });
		const spawnRequestId = root.startTurnRequest();
		const compaction = root.beginCompaction();
		root.finishCompaction(compaction.compactionId, "completed");
		root.startTurnRequest();

		const child = new LineageRecorder({
			ledgerPath: childPath,
			sessionId: "child-session",
			depth: 1,
			parentSessionId: "root-session",
			spawnedByRequestId: spawnRequestId,
		});
		child.startTurnRequest();
		const childCompaction = child.beginCompaction();
		child.finishCompaction(childCompaction.compactionId, "failed");
		child.recordSessionStatus("completed");

		const manifest = deriveLineageManifest([readLineageLedger(rootPath), readLineageLedger(childPath)]);
		assertLineageManifestInvariants(manifest);

		expect(manifest.sessions).toHaveLength(2);
		expect(manifest.contexts).toHaveLength(3);
		expect(manifest.compactions).toHaveLength(2);
		expect(manifest.requests).toHaveLength(5);

		const childSession = manifest.sessions.find((session) => session.session_id === "child-session");
		expect(childSession).toMatchObject({
			parent_session_id: "root-session",
			depth: 1,
			spawned_by_request_id: spawnRequestId,
			status: "completed",
		});
		const failedCompaction = manifest.compactions.find(
			(entry) => entry.compaction_id === childCompaction.compactionId,
		);
		expect(failedCompaction?.status).toBe("failed");
		expect(failedCompaction?.target_context_id).toBeUndefined();
	});

	it("drops torn-tail orphans on both sides of the compaction crash window", () => {
		const path = join(tempDir, "root.jsonl");
		const root = new LineageRecorder({ ledgerPath: path, sessionId: "root-session", depth: 0 });
		root.startTurnRequest();
		const events = readLineageLedger(path);

		// Crash between compaction_begun and its summary request.
		const begunOnly: LineageEvent[] = [
			...events,
			{
				type: "compaction_begun",
				compaction_id: "compaction-a",
				session_id: "root-session",
				source_context_id: root.activeContextId,
				target_context_id: "context-a",
			},
		];
		const begunManifest = deriveLineageManifest([begunOnly]);
		assertLineageManifestInvariants(begunManifest);
		expect(begunManifest.compactions).toHaveLength(0);

		// Inverse window: a compaction request whose begun record is missing.
		const requestOnly: LineageEvent[] = [
			...events,
			{
				type: "request_started",
				request_id: "orphan-request",
				session_id: "root-session",
				context_id: root.activeContextId,
				kind: "compaction",
				compaction_id: "compaction-missing",
			},
		];
		const requestManifest = deriveLineageManifest([requestOnly]);
		assertLineageManifestInvariants(requestManifest);
		expect(requestManifest.requests.some((request) => request.request_id === "orphan-request")).toBe(false);
	});

	it("keeps an unfinished compaction as in_progress without a target context", () => {
		const path = join(tempDir, "root.jsonl");
		const root = new LineageRecorder({ ledgerPath: path, sessionId: "root-session", depth: 0 });
		root.beginCompaction();
		const manifest = deriveLineageManifest([readLineageLedger(path)]);
		assertLineageManifestInvariants(manifest);
		expect(manifest.compactions).toHaveLength(1);
		expect(manifest.compactions[0]).toMatchObject({ status: "in_progress" });
		expect(manifest.compactions[0]?.target_context_id).toBeUndefined();
		expect(manifest.contexts).toHaveLength(1);
	});
});

describe("wrapStreamFnWithLineage", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lineage-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const model = { provider: "p", id: "m" } as Parameters<StreamFn>[0];
	const context = { systemPrompt: "s", messages: [], tools: [] } as unknown as Parameters<StreamFn>[1];

	function recorderIn(name: string): LineageRecorder {
		return new LineageRecorder({ ledgerPath: join(tempDir, name), sessionId: name, depth: 0 });
	}

	it("adds both lineage headers on top of caller headers without dropping them", () => {
		const recorder = recorderIn("a.jsonl");
		const captured: Array<Record<string, string> | undefined> = [];
		const inner: StreamFn = (_model, _context, options) => {
			captured.push(options?.headers);
			return createAssistantMessageEventStream();
		};
		const wrapped = wrapStreamFnWithLineage(inner, recorder);

		wrapped(model, context, { headers: { "x-sentinel": "keep-me" } });

		expect(captured).toHaveLength(1);
		const headers = captured[0] ?? {};
		expect(headers["x-sentinel"]).toBe("keep-me");
		expect(headers[LINEAGE_REQUEST_ID_HEADER]).toMatch(/^[0-9a-f]{32}$/);
		expect(headers[IDEMPOTENCY_KEY_HEADER]).toBe(headers[LINEAGE_REQUEST_ID_HEADER]);
		expect(headers[LINEAGE_REQUEST_ID_HEADER]).toBe(recorder.lastTurnRequestId);
	});

	it("rebinding a wrapped streamFn attributes calls to the new recorder only", () => {
		const parentRecorder = recorderIn("parent.jsonl");
		const childRecorder = recorderIn("child.jsonl");
		let innerCalls = 0;
		const inner: StreamFn = () => {
			innerCalls += 1;
			return createAssistantMessageEventStream();
		};
		const parentWrapped = wrapStreamFnWithLineage(inner, parentRecorder);
		const childWrapped = wrapStreamFnWithLineage(parentWrapped, childRecorder);

		childWrapped(model, context, undefined);

		expect(innerCalls).toBe(1);
		expect(childRecorder.lastTurnRequestId).toBeDefined();
		// A double-wrap would also mint a parent request for the child's call.
		expect(parentRecorder.lastTurnRequestId).toBeUndefined();
		expect(
			readLineageLedger(join(tempDir, "parent.jsonl")).filter((event) => event.type === "request_started"),
		).toHaveLength(0);
	});
});

describe("assertLineageManifestInvariants negative calibration", () => {
	function validManifest(): LineageManifest {
		return {
			sessions: [
				{ session_id: "root", depth: 0, initial_context_id: "root-c0", status: "running" },
				{
					session_id: "child",
					parent_session_id: "root",
					depth: 1,
					initial_context_id: "child-c0",
					spawned_by_request_id: "root-r1",
					status: "completed",
				},
			],
			contexts: [
				{ context_id: "root-c0", session_id: "root", transition: "root" },
				{
					context_id: "root-c1",
					session_id: "root",
					previous_context_id: "root-c0",
					transition: "compact",
					compaction_id: "root-k1",
				},
				{ context_id: "child-c0", session_id: "child", transition: "spawn" },
			],
			compactions: [
				{
					compaction_id: "root-k1",
					session_id: "root",
					source_context_id: "root-c0",
					target_context_id: "root-c1",
					summary_request_id: "root-r2",
					status: "completed",
				},
			],
			requests: [
				{ request_id: "root-r1", session_id: "root", context_id: "root-c0", kind: "turn" },
				{
					request_id: "root-r2",
					session_id: "root",
					context_id: "root-c0",
					kind: "compaction",
					compaction_id: "root-k1",
				},
				{ request_id: "child-r1", session_id: "child", context_id: "child-c0", kind: "turn" },
			],
		};
	}

	it("accepts the calibration manifest", () => {
		expect(() => assertLineageManifestInvariants(validManifest())).not.toThrow();
	});

	const rejections: Array<[string, (manifest: LineageManifest) => void]> = [
		["duplicate session ids", (m) => m.sessions.push({ ...m.sessions[0]! })],
		["duplicate request ids", (m) => m.requests.push({ ...m.requests[0]! })],
		[
			"a second root session",
			(m) => m.sessions.push({ session_id: "root2", depth: 0, initial_context_id: "root-c0", status: "running" }),
		],
		["a root session with nonzero depth", (m) => Object.assign(m.sessions[0]!, { depth: 1 })],
		[
			"a root session with a spawn request",
			(m) => Object.assign(m.sessions[0]!, { spawned_by_request_id: "root-r1" }),
		],
		["a child depth that skips a level", (m) => Object.assign(m.sessions[1]!, { depth: 2 })],
		["an unknown parent session", (m) => Object.assign(m.sessions[1]!, { parent_session_id: "ghost" })],
		["a child without a spawn request", (m) => Object.assign(m.sessions[1]!, { spawned_by_request_id: undefined })],
		[
			"a spawn request that is not a parent turn",
			(m) => Object.assign(m.sessions[1]!, { spawned_by_request_id: "root-r2" }),
		],
		[
			"a spawn request owned by the wrong session",
			(m) => Object.assign(m.sessions[1]!, { spawned_by_request_id: "child-r1" }),
		],
		["an initial context with the wrong transition", (m) => Object.assign(m.contexts[2]!, { transition: "root" })],
		[
			"a context cycle",
			(m) =>
				Object.assign(m.contexts[0]!, {
					previous_context_id: "root-c1",
					transition: "compact",
					compaction_id: "root-k1",
				}),
		],
		["a request on another session's context", (m) => Object.assign(m.requests[2]!, { context_id: "root-c0" })],
		["a compaction request off its source context", (m) => Object.assign(m.requests[1]!, { context_id: "root-c1" })],
		[
			"a compaction request without a compaction id",
			(m) => Object.assign(m.requests[1]!, { compaction_id: undefined }),
		],
		[
			"a turn on a compact context without its compaction id",
			(m) => m.requests.push({ request_id: "root-r3", session_id: "root", context_id: "root-c1", kind: "turn" }),
		],
		[
			"a non-completed compaction with a target context",
			(m) => Object.assign(m.compactions[0]!, { status: "failed" }),
		],
		["a missing summary request", (m) => m.requests.splice(1, 1)],
		["an invalid id pattern", (m) => Object.assign(m.sessions[0]!, { session_id: "bad id!" })],
	];

	it.each(rejections)("rejects %s", (_label, mutate) => {
		const manifest = validManifest();
		mutate(manifest);
		expect(() => assertLineageManifestInvariants(manifest)).toThrow();
	});
});
