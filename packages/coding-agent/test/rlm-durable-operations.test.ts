import * as fs from "node:fs";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	materializedTerminalMessageId,
	openRlmDurableOperationStore,
	type RlmDurableIo,
	type RlmTerminalMessage,
	readRlmDurableOperationRegistry,
} from "../src/core/rlm-durable-operations.js";

const uuid = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const parentId = uuid(1);
const assignment = uuid(2);
const operation = uuid(3);
const delivery = uuid(4);
const childId = uuid(5);
const childSessionId = uuid(6);

interface Fixture {
	root: string;
	parentFile: string;
	childFile: string;
	parentArtifacts: string;
	childArtifacts: string;
	childSessions: string;
	admission: ReturnType<typeof admission>;
}
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(path: string, id: string): void {
	writeFileSync(path, `${JSON.stringify({ type: "session", id, version: 3 })}\n`);
}
function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "rlm-durable-"));
	roots.push(root);
	const parentSessions = join(root, "parent-sessions");
	const childSessions = join(root, "child-sessions");
	const parentArtifacts = join(root, "parent-artifacts");
	const childArtifacts = join(root, "child-artifacts");
	mkdirSync(parentSessions);
	mkdirSync(childSessions);
	mkdirSync(parentArtifacts);
	mkdirSync(childArtifacts);
	const parentFile = join(parentSessions, "parent.jsonl");
	const childFile = join(childSessions, "child.jsonl");
	session(parentFile, parentId);
	session(childFile, childSessionId);
	return {
		root,
		parentFile,
		childFile,
		parentArtifacts,
		childArtifacts,
		childSessions,
		admission: admission(parentFile, root, parentArtifacts, childSessions),
	};
}
function admission(parentFile: string, root: string, _parentArtifacts: string, childSessions: string) {
	return {
		parentSessionId: parentId,
		parentSessionFile: parentFile,
		parentSessionRoot: root,
		parentArtifactRoot: root,
		childId,
		assignmentId: assignment,
		operationId: operation,
		deliveryId: delivery,
		childSessionDir: childSessions,
		requestedModel: { provider: "test", modelId: "model" },
		rlmDepth: 1,
		rlmMaxDepth: 2,
	};
}
function message(content = "terminal"): RlmTerminalMessage {
	return {
		role: "custom",
		customType: "rlm_child_terminal_notice",
		content,
		display: true,
		details: { kind: "cancelled" },
		timestamp: 1,
	};
}
function outbox(f: Fixture, terminal: "done" | "error" | "cancelled" = "done", content = "terminal") {
	return {
		parentSessionId: parentId,
		parentSessionFile: f.parentFile,
		parentSessionRoot: f.root,
		parentArtifactRoot: f.root,
		childSessionId,
		childSessionFile: f.childFile,
		childSessionRoot: f.root,
		childArtifactDir: f.childArtifacts,
		childArtifactRoot: f.root,
		childId,
		assignmentId: assignment,
		operationId: operation,
		deliveryId: delivery,
		terminal,
		message: message(content),
	};
}
function materialize(store: ReturnType<typeof openRlmDurableOperationStore>, f: Fixture): void {
	expect(
		store.markMaterialized({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			childSessionId,
			childSessionFile: f.childFile,
			childSessionRoot: f.root,
			childArtifactDir: f.childArtifacts,
			childArtifactRoot: f.root,
		}),
	).toBe(true);
}

function mode(path: string): number {
	return lstatSync(path).mode & 0o777;
}

describe("RLM durable operation store", () => {
	it("records sibling session/artifact layout with owner-only durable files and deterministic ids", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		const admitted = store.admit(f.admission);
		expect(admitted.lifecycle).toBe("admitted");
		expect(mode(f.parentArtifacts)).toBe(0o700);
		expect(mode(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"))).toBe(0o600);
		expect(materializedTerminalMessageId(delivery)).toBe(`rlm-terminal-${delivery}`);
		materialize(store, f);
		expect(store.appendOutbox(outbox(f))).toBe("new");
		expect(mode(join(f.childArtifacts, "rlm-terminal-outbox.jsonl"))).toBe(0o600);
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(true);
		expect(store.importOutbox(outbox(f))).toBe("new");
		expect(
			store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toBe("new");
		expect(mode(join(f.parentArtifacts, "rlm-terminal-consumed.jsonl"))).toBe(0o600);
	});

	it("makes exact duplicates idempotent and conflicting terminal body uncertain/fail-closed", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		expect(store.admit(f.admission).key).toContain(operation);
		materialize(store, f);
		expect(store.appendOutbox(outbox(f))).toBe("new");
		expect(store.appendOutbox(outbox(f))).toBe("already_recorded");
		expect(() => store.appendOutbox(outbox(f, "done", "different"))).toThrow(/Conflicting/);
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});
		// A physically injected second body is never last-write-wins.
		appendFileSync(
			join(f.childArtifacts, "rlm-terminal-outbox.jsonl"),
			`${JSON.stringify({ version: 1, type: "terminal", ...outbox(f, "done", "different"), recordedAt: new Date().toISOString() })}\n`,
		);
		const rebuilt = readRlmDurableOperationRegistry(f.parentArtifacts);
		expect(rebuilt.operations.get(JSON.stringify([parentId, assignment, operation]))?.uncertain).toBe(true);
		expect(rebuilt.hasUncertainRecords).toBe(true);
	});

	it("requires outbox then ledger then inbox then transcript-consumption", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(false);
		expect(() => store.importOutbox(outbox(f))).toThrow(/ledger-recorded/);
		store.appendOutbox(outbox(f));
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(true);
		store.importOutbox(outbox(f));
		expect(
			store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toBe("new");
		expect(
			store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toBe("already_materialized");
	});

	it("only ignores a malformed non-newline final tail; malformed interior becomes uncertainty", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		const ledger = join(f.parentArtifacts, "rlm-operation-ledger.jsonl");
		appendFileSync(ledger, '{"version":1,"type":"admitted"');
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).hasUncertainRecords).toBe(false);
		appendFileSync(ledger, "\n");
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).hasUncertainRecords).toBe(true);
	});

	it("rejects UUID, terminal projection, traversal, symlink escape, and forged session identity", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		expect(() => store.admit({ ...f.admission, operationId: "not-a-uuid" })).toThrow(/canonical UUID/);
		expect(() => store.admit({ ...f.admission, parentSessionFile: f.childFile })).toThrow(/does not match/);
		const outside = join(f.root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(f.root, "escape"));
		expect(() => store.admit({ ...f.admission, parentArtifactRoot: join(f.root, "escape") })).toThrow(/escapes/);
		store.admit(f.admission);
		materialize(store, f);
		expect(() => store.appendOutbox({ ...outbox(f), terminal: "completed" as never })).toThrow(/Unknown terminal/);
	});

	it("uses a write-all loop, fails zero-progress writes before fsync, and leaves no claimed admission", () => {
		const f = fixture();
		let writes = 0;
		let syncs = 0;
		const partial = {
			...fs,
			writeSync: (fd: number, data: Buffer, offset: number, length: number) => {
				writes++;
				return fs.writeSync(fd, data, offset, Math.max(1, Math.min(length, 3)));
			},
			fsyncSync: (fd: number) => {
				syncs++;
				return fs.fsyncSync(fd);
			},
		} as unknown as RlmDurableIo;
		const store = openRlmDurableOperationStore(f.parentArtifacts, { io: partial });
		store.admit(f.admission);
		expect(writes).toBeGreaterThan(1);
		expect(syncs).toBeGreaterThan(0);
		const zero = { ...fs, writeSync: () => 0 } as unknown as RlmDurableIo;
		const g = fixture();
		const broken = openRlmDurableOperationStore(g.parentArtifacts, { io: zero });
		expect(() => broken.admit(g.admission)).toThrow(/no forward progress/);
		expect(readRlmDurableOperationRegistry(g.parentArtifacts).operations.size).toBe(0);
	});

	it("does not make a cache cut authoritative and passive reads do not repair it", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		store.rebuild();
		const index = join(f.parentArtifacts, "rlm-active-index.json");
		writeFileSync(index, "torn");
		const before = readFileSync(index, "utf8");
		const passive = readRlmDurableOperationRegistry(f.parentArtifacts);
		expect(passive.operations.size).toBe(1);
		expect(readFileSync(index, "utf8")).toBe(before);
		const renameCut = {
			...fs,
			renameSync: () => {
				throw new Error("cut before rename");
			},
		} as unknown as RlmDurableIo;
		expect(openRlmDurableOperationStore(f.parentArtifacts, { io: renameCut }).rebuild().operations.size).toBe(1);
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).operations.size).toBe(1);
	});

	it("allows one exact deleted-assignment discard, never a materialized delivery", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		store.appendOutbox(outbox(f));
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});
		store.importOutbox(outbox(f));
		appendFileSync(
			join(f.parentArtifacts, "rlm-operation-ledger.jsonl"),
			`${JSON.stringify({ version: 1, type: "deleted", parentSessionId: parentId, assignmentId: assignment, operationId: operation, recordedAt: new Date().toISOString() })}\n`,
		);
		expect(
			store.markDiscardedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				reason: "deleted",
			}),
		).toBe("new");
		expect(
			store.markDiscardedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				reason: "deleted",
			}),
		).toBe("already_discarded");
	});
});
