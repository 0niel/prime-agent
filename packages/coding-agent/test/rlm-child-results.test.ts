import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createOrGetTerminalChildResult,
	getChildResultProjection,
	MAX_ARTIFACTS_PER_RESULT,
	MAX_CHILD_RESULT_JSON_BYTES,
	MAX_ARTIFACT_BYTES,
	MAX_ARTIFACT_BYTES_PER_CHILD_SESSION,
	MAX_STREAM_CHUNK_BYTES,
	readOwnedArtifact,
	recordChildResultDisposition,
	resolveOwnedChildResult,
} from "../src/core/rlm-child-results.js";

// SessionManager emits UUIDv7 session IDs; the remaining C04 correlation
// identifiers are its own opaque UUIDv4 authority IDs.
const ids = [
	"0196f4a0-1234-7000-8000-111111111111",
	"0196f4a0-5678-7000-8000-222222222222",
	"33333333-3333-4333-8333-333333333333",
	"44444444-4444-4444-8444-444444444444",
	"55555555-5555-4555-8555-555555555555",
	"66666666-6666-4666-8666-666666666666",
	"77777777-7777-4777-8777-777777777777",
	"88888888-8888-4888-8888-888888888888",
	"99999999-9999-4999-8999-999999999999",
	"0196f4a0-9abc-7000-8000-aaaaaaaaaaaa",
	"0196f4a0-def0-7000-8000-bbbbbbbbbbbb",
];
function owner(file: string) {
	return {
		parentSessionId: ids[0],
		childSessionId: ids[1],
		childSessionFile: file,
		assignmentId: ids[2],
		operationId: ids[3],
		deliveryId: ids[4],
	};
}

describe("C04 bounded child results", () => {
	it("commits an opaque streamed result idempotently and denies cross-owner bytes", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		try {
			const input = {
				owner: owner(file),
				childArtifactRoot: artifacts,
				candidate: {
					status: "completed" as const,
					summary: "done",
					preview: "safe",
					artifacts: [
						{
							kind: "terminal_output" as const,
							contentType: "text/plain" as const,
							data: (async function* () {
								yield new TextEncoder().encode("private");
							})(),
						},
					],
					model: { initialResolvedSelector: "test/a", terminalResolvedSelector: "test/a" },
				},
			};
			const result = await createOrGetTerminalChildResult(input);
			const again = await createOrGetTerminalChildResult({
				...input,
				candidate: {
					...input.candidate,
					artifacts: [
						{
							...input.candidate.artifacts![0]!,
							data: (async function* () {
								yield new TextEncoder().encode("private");
							})(),
						},
					],
				},
			});
			expect(again).toEqual(result);
			await expect(
				createOrGetTerminalChildResult({ ...input, candidate: { ...input.candidate, preview: "different" } }),
			).rejects.toThrow("immutable operation conflict");
			expect(JSON.stringify(result)).not.toContain("private");
			const grant = resolveOwnedChildResult(input.owner, result.artifacts[0].handleId, artifacts);
			expect(grant).toBeDefined();
			expect(
				new TextDecoder().decode(
					readOwnedArtifact(grant!.capability, { offset: 0, length: MAX_STREAM_CHUNK_BYTES }),
				),
			).toBe("private");
			expect(
				resolveOwnedChildResult({ ...input.owner, assignmentId: ids[4] }, result.artifacts[0].handleId, artifacts),
			).toBeUndefined();
			expect(getChildResultProjection(input.owner, result.resultId, artifacts)).toEqual(result);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects inline payloads and treats a different retry stream as an immutable conflict", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-stream-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		const stream = (text: string) =>
			(async function* () {
				yield new TextEncoder().encode(text);
			})();
		try {
			const input = {
				owner: owner(file),
				childArtifactRoot: artifacts,
				candidate: {
					status: "completed" as const,
					summary: "done",
					preview: "safe",
					artifacts: [{ kind: "terminal_output" as const, contentType: "text/plain" as const, data: stream("A") }],
				},
			};
			await createOrGetTerminalChildResult(input);
			await expect(
				createOrGetTerminalChildResult({
					...input,
					candidate: { ...input.candidate, artifacts: [{ ...input.candidate.artifacts[0]!, data: stream("B") }] },
				}),
			).rejects.toThrow("immutable operation conflict");
			await expect(
				createOrGetTerminalChildResult({
					...input,
					owner: { ...input.owner, operationId: ids[4] },
					candidate: {
						...input.candidate,
						artifacts: [{ ...input.candidate.artifacts[0]!, data: "not-a-stream" as never }],
					},
				}),
			).rejects.toThrow("payload must be");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("requires the exact SessionManager child artifact binding and keeps a loser from removing a winner reservation", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-binding-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		const sibling = join(root, "session-artifacts", ids[4]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		const base = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			candidate: { status: "completed" as const, summary: "done", preview: "safe" },
		};
		try {
			await expect(createOrGetTerminalChildResult({ ...base, childArtifactRoot: sibling })).rejects.toThrow(
				"exact SessionManager",
			);
			let release!: () => void;
			const held = createOrGetTerminalChildResult({
				...base,
				candidate: {
					...base.candidate,
					artifacts: [
						{
							kind: "terminal_output" as const,
							contentType: "text/plain" as const,
							data: (async function* () {
								await new Promise<void>((resolve) => {
									release = resolve;
								});
								yield new TextEncoder().encode("winner");
							})(),
						},
					],
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			await expect(createOrGetTerminalChildResult(base)).rejects.toThrow("immutable operation conflict");
			release();
			const winner = await held;
			expect(getChildResultProjection(base.owner, winner.resultId, artifacts)).toEqual(winner);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("publishes disposition before removal so a resolved capability cannot return payload after delete", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-disposition-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		const input = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			candidate: {
				status: "completed" as const,
				summary: "done",
				preview: "safe",
				artifacts: [
					{
						kind: "terminal_output" as const,
						contentType: "text/plain" as const,
						data: (async function* () {
							yield new TextEncoder().encode("private");
						})(),
					},
				],
			},
		};
		try {
			const result = await createOrGetTerminalChildResult(input);
			const grant = resolveOwnedChildResult(input.owner, result.artifacts[0]!.handleId, artifacts)!;
			expect(
				recordChildResultDisposition(input.owner, { resultId: result.resultId, disposition: "deleted" }, artifacts),
			).toBe(true);
			expect(readOwnedArtifact(grant.capability, { offset: 0, length: 7 })).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts the UUIDv7 child binding emitted by SessionManager without widening C04 identifiers", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-v7-binding-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		try {
			const result = await createOrGetTerminalChildResult({
				owner: owner(file),
				childArtifactRoot: artifacts,
				candidate: { status: "completed", summary: "v7 child", preview: "safe" },
			});
			expect(getChildResultProjection(owner(file), result.resultId, artifacts)).toEqual(result);
			await expect(
				createOrGetTerminalChildResult({
					owner: { ...owner(file), assignmentId: ids[1] },
					childArtifactRoot: artifacts,
					candidate: { status: "completed", summary: "bad authority", preview: "safe" },
				}),
			).rejects.toThrow("assignmentId");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caps the complete stored JSON before publishing and leaves no artifacts for a valid-field oversize record", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-json-cap-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		try {
			const withinCap = await createOrGetTerminalChildResult({
				owner: owner(file),
				childArtifactRoot: artifacts,
				candidate: {
					status: "completed",
					summary: "😀".repeat(4096),
					preview: "😀".repeat(2048),
					facts: [{ claim: "f".repeat(1024) }],
					nextActions: ["n".repeat(512)],
				},
			});
			const resultPath = join(artifacts, "rlm-child-results", "results", `${withinCap.resultId}.json`);
			expect(Buffer.byteLength(readFileSync(resultPath))).toBeLessThanOrEqual(MAX_CHILD_RESULT_JSON_BYTES);
			expect(getChildResultProjection(owner(file), withinCap.resultId, artifacts)).toEqual(withinCap);

			await expect(
				createOrGetTerminalChildResult({
					owner: { ...owner(file), operationId: ids[5], deliveryId: ids[6] },
					childArtifactRoot: artifacts,
					candidate: {
						status: "completed",
						summary: "😀".repeat(4096),
						preview: "😀".repeat(2048),
						facts: Array.from({ length: 32 }, () => ({ claim: "f".repeat(1024) })),
						nextActions: Array.from({ length: 16 }, () => "n".repeat(512)),
					},
				}),
			).rejects.toThrow("result record too large");
			const c04 = join(artifacts, "rlm-child-results");
			expect(readdirSync(join(c04, "objects"))).toEqual([]);
			expect(readdirSync(join(c04, "handle-index"))).toEqual([]);
			expect(readdirSync(join(c04, "results"))).toEqual([`${withinCap.resultId}.json`]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves a sibling artifact and a readable result after a handle-specific delete", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-partial-delete-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		const stream = (value: string) =>
			(async function* () {
				yield new TextEncoder().encode(value);
			})();
		try {
			const input = {
				owner: owner(file),
				childArtifactRoot: artifacts,
				candidate: {
					status: "completed" as const,
					summary: "two objects",
					preview: "safe",
					artifacts: [
						{ kind: "terminal_output" as const, contentType: "text/plain" as const, data: stream("first") },
						{ kind: "attachment" as const, contentType: "text/plain" as const, data: stream("second") },
					],
				},
			};
			const result = await createOrGetTerminalChildResult(input);
			expect(
				recordChildResultDisposition(input.owner, { resultId: result.resultId, handleId: result.artifacts[0]!.handleId, disposition: "deleted" }, artifacts),
			).toBe(true);
			const projected = getChildResultProjection(input.owner, result.resultId, artifacts)!;
			expect(projected.retentionState).toBe("retained");
			expect(projected.artifacts[0]!.retentionState).toBe("deleted");
			const retained = resolveOwnedChildResult(input.owner, result.artifacts[1]!.handleId, artifacts)!;
			expect(new TextDecoder().decode(readOwnedArtifact(retained.capability, { offset: 0, length: 16 }))).toBe("second");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prevalidates combined artifacts, rolls back publication, and cannot bypass child quota with another parent UUIDv7", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-rollback-quota-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		const data = (value = "x") =>
			(async function* () {
				yield new TextEncoder().encode(value);
			})();
		try {
			const tooMany = Array.from({ length: MAX_ARTIFACTS_PER_RESULT }, () => ({
				kind: "attachment" as const,
				contentType: "text/plain" as const,
				data: data(),
			}));
			await expect(
				createOrGetTerminalChildResult({
					owner: owner(file),
					childArtifactRoot: artifacts,
					candidate: {
						status: "failed",
						summary: "too many",
						preview: "safe",
						error: { message: "diagnostic counts too", diagnostic: { kind: "diagnostic", contentType: "text/plain", data: data() } },
						artifacts: tooMany,
					},
				}),
			).rejects.toThrow("artifact count");

			const c04 = join(artifacts, "rlm-child-results");
			mkdirSync(join(c04, "operation-index"), { recursive: true });
			writeFileSync(join(c04, "operation-index", `${ids[3]}.json`), "not-an-index");
			await expect(
				createOrGetTerminalChildResult({
					owner: owner(file),
					childArtifactRoot: artifacts,
					candidate: { status: "completed", summary: "commit collision", preview: "safe", artifacts: [{ kind: "attachment", contentType: "text/plain", data: data("orphan") }] },
				}),
			).rejects.toThrow();
			expect(readdirSync(join(c04, "objects"))).toEqual([]);
			expect(readdirSync(join(c04, "results"))).toEqual([]);
			expect(readdirSync(join(c04, "handle-index"))).toEqual([]);

			const quotaResultId = ids[5];
			// parentSessionId is caller correlation metadata. A record created through
			// another valid parent must still consume this trusted child's one quota.
			const quotaOwner = { ...owner(file), parentSessionId: ids[9], assignmentId: ids[6], operationId: ids[7], deliveryId: ids[8] };
			const quotaArtifacts = Array.from({ length: 4 }, (_, index) => ({
				version: 1,
				handleId: [ids[3], ids[4], ids[7], ids[8]][index]!,
				resultId: quotaResultId,
				kind: "attachment",
				contentType: "application/octet-stream",
				byteLength: MAX_ARTIFACT_BYTES,
				sha256: "0".repeat(64),
				creatorAssignmentId: quotaOwner.assignmentId,
				ownerSessionId: quotaOwner.childSessionId,
				retentionState: "retained",
			}));
			writeFileSync(
				join(c04, "results", `${quotaResultId}.json`),
				JSON.stringify({
					schemaVersion: 1, version: 1, resultId: quotaResultId, owner: quotaOwner, status: "completed", summary: "quota", preview: "safe",
					facts: [], nextActions: [], model: { initialResolvedSelector: "unknown", terminalResolvedSelector: "unknown" }, artifacts: quotaArtifacts,
					retentionState: "retained", committedAt: "2026-01-01T00:00:00.000Z", retention: { disposition: "retain_until", expiresAt: "2027-01-01T00:00:00.000Z" }, requestDigest: "1".repeat(64),
				}),
			);
			await expect(
				createOrGetTerminalChildResult({
					owner: { ...owner(file), assignmentId: ids[8], operationId: ids[6], deliveryId: ids[7] },
					childArtifactRoot: artifacts,
					candidate: { status: "completed", summary: "new assignment", preview: "safe", artifacts: [{ kind: "attachment", contentType: "text/plain", data: data() }] },
				}),
			).rejects.toThrow("session artifact quota");
			expect(MAX_ARTIFACT_BYTES * 4).toBe(MAX_ARTIFACT_BYTES_PER_CHILD_SESSION);
			expect(readdirSync(join(c04, "objects"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("releases operation and child-quota reservations when corrupt stored results make aggregation fail", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-aggregate-cleanup-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, "{}\n");
		const corruptResultId = ids[3];
		const data = () =>
			(async function* () {
				yield new TextEncoder().encode("retry-safe");
			})();
		try {
			const c04 = join(artifacts, "rlm-child-results");
			mkdirSync(join(c04, "results"), { recursive: true });
			// aggregateBytes is intentionally fail-closed rather than silently
			// ignoring a corrupt durable record. Its throw occurs after reservation.
			writeFileSync(join(c04, "results", `${corruptResultId}.json`), "not a C04 result");
			const input = {
				owner: owner(file),
				childArtifactRoot: artifacts,
				candidate: { status: "completed" as const, summary: "retry", preview: "safe", artifacts: [{ kind: "attachment" as const, contentType: "text/plain" as const, data: data() }] },
			};
			await expect(createOrGetTerminalChildResult(input)).rejects.toThrow("uncertain C04 result store");
			const reservationDir = join(c04, "operation-index");
			expect(readdirSync(reservationDir).filter((name) => name.endsWith(".reserve"))).toEqual([]);
			// Once the operator removes the corrupt result, the exact same operation
			// can reserve and publish normally; no stale in-memory or on-disk lease remains.
			rmSync(join(c04, "results", `${corruptResultId}.json`));
			const retried = await createOrGetTerminalChildResult({ ...input, candidate: { ...input.candidate, artifacts: [{ kind: "attachment", contentType: "text/plain", data: data() }] } });
			expect(getChildResultProjection(input.owner, retried.resultId, artifacts)).toEqual(retried);
			expect(readdirSync(reservationDir).filter((name) => name.endsWith(".reserve"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
