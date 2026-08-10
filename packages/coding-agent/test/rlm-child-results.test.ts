import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createOrGetTerminalChildResult,
	getChildResultProjection,
	MAX_STREAM_CHUNK_BYTES,
	readOwnedArtifact,
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
		const file = join(root, "child.json");
		writeFileSync(file, "{}\n");
		try {
			const input = {
				owner: owner(file),
				childArtifactRoot: root,
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
			const grant = resolveOwnedChildResult(input.owner, result.artifacts[0].handleId, root);
			expect(grant).toBeDefined();
			expect(
				new TextDecoder().decode(
					readOwnedArtifact(grant!.capability, { offset: 0, length: MAX_STREAM_CHUNK_BYTES }),
				),
			).toBe("private");
			expect(
				resolveOwnedChildResult({ ...input.owner, assignmentId: ids[4] }, result.artifacts[0].handleId, root),
			).toBeUndefined();
			expect(getChildResultProjection(input.owner, result.resultId, root)).toEqual(result);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects inline payloads and treats a different retry stream as an immutable conflict", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-stream-"));
		const file = join(root, "child.json");
		writeFileSync(file, "{}\n");
		const stream = (text: string) =>
			(async function* () {
				yield new TextEncoder().encode(text);
			})();
		try {
			const input = {
				owner: owner(file),
				childArtifactRoot: root,
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
});
