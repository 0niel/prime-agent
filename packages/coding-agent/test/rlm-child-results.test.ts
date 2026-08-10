import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createOrGetTerminalChildResult,
	getChildResultProjection,
	MAX_STREAM_CHUNK_BYTES,
	readOwnedArtifact,
	recordChildResultDisposition,
	resolveOwnedChildResult,
} from "../src/core/rlm-child-results.js";

const ids = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
	"44444444-4444-4444-8444-444444444444",
	"55555555-5555-4555-8555-555555555555",
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
});
