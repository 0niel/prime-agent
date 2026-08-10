import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertChildResultReference,
	createRlmChildResultReferenceTerminalMessage,
	formatRlmChildResultReference,
	MAX_RLM_CHILD_RESULT_REFERENCE_BYTES,
	materializedTerminalMessageId,
	openRlmDurableOperationStore,
	type RlmChildResultReferenceV1,
	readRlmDurableOperationRegistry,
} from "../src/core/rlm-durable-operations.js";

const uuid = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const parentId = uuid(1);
const assignmentId = uuid(2);
const operationId = uuid(3);
const deliveryId = uuid(4);
const childSessionId = uuid(5);
const resultId = uuid(6);
const handleId = uuid(7);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reference(overrides: Partial<RlmChildResultReferenceV1> = {}): RlmChildResultReferenceV1 {
	return {
		version: 1,
		resultId,
		status: "completed",
		summary: "completed safely",
		preview: "safe preview",
		model: {
			initialResolvedSelector: "test/initial",
			terminalResolvedSelector: "test/final",
			fallbackHistory: ["test/initial"],
		},
		artifacts: [
			{
				version: 1,
				handleId,
				resultId,
				kind: "terminal_output",
				contentType: "text/plain",
				byteLength: 512 * 1024 * 1024,
				sha256: "a".repeat(64),
				retentionState: "retained",
			},
		],
		retentionState: "retained",
		...overrides,
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rlm-c04-wire-"));
	roots.push(root);
	const parentArtifacts = join(root, "parent-artifacts");
	const childArtifacts = join(root, "child-artifacts");
	mkdirSync(parentArtifacts);
	mkdirSync(childArtifacts);
	const parentFile = join(root, "parent.jsonl");
	const childFile = join(root, "child.jsonl");
	writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: parentId })}\n`);
	writeFileSync(childFile, `${JSON.stringify({ type: "session", id: childSessionId })}\n`);
	const store = openRlmDurableOperationStore(parentArtifacts);
	store.admit({
		parentSessionId: parentId,
		parentSessionFile: parentFile,
		parentSessionRoot: root,
		parentArtifactRoot: root,
		childId: "child",
		assignmentId,
		operationId,
		deliveryId,
		childSessionDir: root,
		requestedModel: { provider: "test", modelId: "test" },
		rlmDepth: 1,
		rlmMaxDepth: 2,
	});
	expect(
		store.markMaterialized({
			parentSessionId: parentId,
			assignmentId,
			operationId,
			childSessionId,
			childSessionFile: childFile,
			childSessionRoot: root,
			childArtifactDir: childArtifacts,
			childArtifactRoot: root,
		}),
	).toBe(true);
	const outbox = (message: ReturnType<typeof createRlmChildResultReferenceTerminalMessage>) => ({
		parentSessionId: parentId,
		parentSessionFile: parentFile,
		parentSessionRoot: root,
		parentArtifactRoot: root,
		childSessionId,
		childSessionFile: childFile,
		childSessionRoot: root,
		childArtifactDir: childArtifacts,
		childArtifactRoot: root,
		childId: "child",
		assignmentId,
		operationId,
		deliveryId,
		terminal: "done" as const,
		message,
	});
	return { root, parentArtifacts, childArtifacts, parentFile, childFile, store, outbox };
}

describe("C03 C04 bounded child-result wire seam", () => {
	it("accepts an exact C04 projection and deterministically derives the only content", () => {
		const result = reference();
		assertChildResultReference(result);
		const message = createRlmChildResultReferenceTerminalMessage(result, 1);
		expect(message.content).toBe(formatRlmChildResultReference(result));
		expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(MAX_RLM_CHILD_RESULT_REFERENCE_BYTES);
	});

	it("rejects arbitrary/mismatched content while leaving legacy 24KiB messages unchanged", () => {
		const result = reference();
		const message = createRlmChildResultReferenceTerminalMessage(result, 1);
		const f = fixture();
		expect(() => f.store.appendOutbox(f.outbox({ ...message, content: "arbitrary" }))).toThrow(/deterministic/);
		const legacy = {
			role: "custom" as const,
			customType: "rlm_child_terminal_notice" as const,
			content: "x".repeat(24 * 1024),
			display: true as const,
			details: { kind: "cancelled" as const, childId: "child", sessionName: "child" },
			timestamp: 1,
		};
		expect(() => f.store.appendOutbox(f.outbox(legacy as never))).toThrow(/too large/);
	});

	it("round-trips reference-only delivery through outbox, terminal, inbox, restart and materialization", () => {
		const f = fixture();
		const message = createRlmChildResultReferenceTerminalMessage(reference(), 1);
		expect(f.store.appendOutbox(f.outbox(message))).toBe("new");
		// Store identity compares the canonical message digest, so the exact
		// projection is idempotent without a second hand-off body.
		expect(f.store.appendOutbox(f.outbox(createRlmChildResultReferenceTerminalMessage(reference(), 1)))).toBe(
			"already_recorded",
		);
		expect(
			f.store.recordTerminal({ parentSessionId: parentId, assignmentId, operationId, deliveryId, terminal: "done" }),
		).toBe(true);
		expect(f.store.importOutbox(f.outbox(message))).toBe("new");
		const inbox = f.store.pendingInbox();
		expect(inbox).toHaveLength(1);
		expect(inbox[0]!.message).toEqual(message);
		expect(readFileSync(join(f.childArtifacts, "rlm-terminal-outbox.jsonl"), "utf8")).not.toContain("owner");
		expect(
			f.store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId,
				operationId,
				deliveryId,
				sessionMessageId: materializedTerminalMessageId(deliveryId),
			}),
		).toBe("new");
		const restarted = openRlmDurableOperationStore(f.parentArtifacts, {
			trustedChildRecoveryRoots: () => ({
				childSessionId,
				childSessionFile: f.childFile,
				childSessionRoot: f.root,
				childArtifactDir: f.childArtifacts,
				childArtifactRoot: f.root,
			}),
		});
		expect(restarted.pendingInbox()).toEqual([]);
		expect(
			readRlmDurableOperationRegistry(f.parentArtifacts, () => ({
				childSessionId,
				childSessionFile: f.childFile,
				childSessionRoot: f.root,
				childArtifactDir: f.childArtifacts,
				childArtifactRoot: f.root,
			})).deliveries.size,
		).toBe(1);
	});

	it("fails closed for unknown/nested owner/path/body, bad UUID/digest, duplicate handles, mismatch and malformed JSONL", () => {
		const bads: unknown[] = [
			{ ...reference(), owner: {} },
			{ ...reference(), artifacts: [{ ...reference().artifacts[0]!, owner: { parentSessionId: parentId } }] },
			{ ...reference(), artifacts: [{ ...reference().artifacts[0]!, path: "/private/secret" }] },
			{ ...reference(), artifacts: [{ ...reference().artifacts[0]!, body: "secret" }] },
			{ ...reference(), resultId: "not-a-v4" },
			{ ...reference(), artifacts: [{ ...reference().artifacts[0]!, sha256: "A".repeat(64) }] },
			{ ...reference(), artifacts: [reference().artifacts[0]!, reference().artifacts[0]!] },
			{ ...reference(), artifacts: [{ ...reference().artifacts[0]!, resultId: uuid(8) }] },
			{ ...reference(), status: "completed", error: { code: "invalid_result", message: "no" } },
			{ ...reference(), status: "failed", error: undefined },
		];
		for (const candidate of bads) expect(() => assertChildResultReference(candidate)).toThrow();
		const f = fixture();
		appendFileSync(join(f.parentArtifacts, "rlm-terminal-inbox.jsonl"), "{bad}\n");
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).hasUncertainRecords).toBe(true);
	});

	it("enforces Unicode scalar and UTF-8 byte bounds and the 64KiB projection cap", () => {
		expect(() => assertChildResultReference(reference({ summary: "😀".repeat(4097) }))).toThrow();
		expect(() => assertChildResultReference(reference({ preview: "😀".repeat(2049) }))).toThrow();
		expect(() => assertChildResultReference(reference({ summary: "𐀀".repeat(4097) }))).toThrow();
		const huge = reference({
			artifacts: Array.from({ length: 16 }, (_, index) => ({
				...reference().artifacts[0]!,
				handleId: uuid(index + 20),
			})),
		});
		huge.summary = "𐀀".repeat(4096);
		huge.preview = "𐀀".repeat(2048);
		huge.model = {
			initialResolvedSelector: "𐀀".repeat(512),
			terminalResolvedSelector: "𐀀".repeat(512),
			fallbackHistory: Array.from({ length: 16 }, () => "𐀀".repeat(512)),
		};
		expect(() => assertChildResultReference(huge)).toThrow(/too large/);
	});
});
