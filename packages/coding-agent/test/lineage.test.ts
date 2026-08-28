import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deriveLineageManifest,
	IDEMPOTENCY_KEY_HEADER,
	LINEAGE_REQUEST_ID_HEADER,
	type LineageEvent,
	LineageRecorder,
	lineageRequestHeaders,
	readLineageLedger,
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

	it("reuses a parked retry ID only for a body-identical call", () => {
		const recorder = createRecorder();
		const shape = { messageCount: 3, lastRole: "user" };
		const failedId = recorder.startTurnRequest(shape);
		recorder.prepareTurnRetry();

		// An interleaved call with a different body (e.g. a side question) must not steal the key.
		const sideId = recorder.startTurnRequest({ messageCount: 4, lastRole: "user" });
		expect(sideId).not.toBe(failedId);

		const retryId = recorder.startTurnRequest(shape);
		expect(retryId).toBe(failedId);
		// The reused retry writes no second request event for the same ID.
		const requestEvents = ledger().filter((event) => event.type === "request_started");
		expect(requestEvents.map((event) => event.request_id)).toEqual([failedId, sideId]);
	});

	it("mints a fresh ID when the context changed between failure and retry", () => {
		const recorder = createRecorder();
		const shape = { messageCount: 2, lastRole: "user" };
		const failedId = recorder.startTurnRequest(shape);
		recorder.prepareTurnRetry();
		const compaction = recorder.beginCompaction();
		recorder.finishCompaction(compaction.compactionId, "completed");
		expect(recorder.startTurnRequest(shape)).not.toBe(failedId);
	});

	it("clears a parked retry ID", () => {
		const recorder = createRecorder();
		const shape = { messageCount: 1, lastRole: "user" };
		const failedId = recorder.startTurnRequest(shape);
		recorder.prepareTurnRetry();
		recorder.clearTurnRetry();
		expect(recorder.startTurnRequest(shape)).not.toBe(failedId);
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

	it("tolerates a torn final ledger line and repairs on the next append", () => {
		const recorder = createRecorder();
		recorder.startTurnRequest();
		const path = join(tempDir, "lineage.jsonl");
		appendFileSync(path, '{"type":"request_started","request_id":"torn');

		expect(readLineageLedger(path)).toHaveLength(2);

		const resumed = createRecorder();
		const requestId = resumed.startTurnRequest();
		const events = readLineageLedger(path);
		expect(events.filter((event) => event.type === "session_registered")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "request_started", request_id: requestId });
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
