import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type ProductionEvidenceInput,
	projectProductionObservations,
	verifySignedProductionEvidence,
	verifySignedProductionEvidenceFreshProcess,
	writeSignedProductionEvidence,
} from "./production-evidence-adapter.js";
import {
	COST_NUMERATOR_SCALE,
	canonicalJson,
	createSwarmEvidenceTrustRoot,
	currentProcessSampler,
	SWARM_EVIDENCE_COMMITMENT_SCHEMA,
	swarmEvidenceCommitmentPayload,
	verifyAuthenticatedSwarmEvidence,
} from "./swarm-evidence.js";

const cleanup: string[] = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const canaries = ["B00B-adapter-秘密", "B00B-adapter-split-A", "B00B-adapter-split-B"];
function input(): ProductionEvidenceInput {
	return {
		scenario: canaries[0]!,
		metadata: { [canaries[1]!]: canaries[2] },
		priceCard: {
			version: "fixture-price-card-v1",
			inputMicroCurrencyPerMillionMicroTokens: 17,
			outputMicroCurrencyPerMillionMicroTokens: 29,
		},
		attempts: [
			{
				requestId: "request-0001",
				attempt: 1,
				requested: { provider: "b00b-scripted", model: "fixture-a", revision: "alias-secret", effort: "high" },
				resolved: {
					api: "b00b-scripted",
					provider: "b00b-scripted",
					model: "fixture-a",
					responseModel: "fixture-b-resolved",
				},
				terminal: "done",
				usage: { inputMicroTokens: 101, outputMicroTokens: 13, cacheReadMicroTokens: 7, cacheWriteMicroTokens: 3 },
			},
			{
				// A failed retry remains a separately authenticated attempt even at zero usage.
				requestId: "request-0001",
				attempt: 2,
				requested: { provider: "b00b-scripted", model: "fixture-zero" },
				resolved: {
					api: "b00b-scripted",
					provider: "b00b-scripted",
					model: "fixture-zero",
					responseModel: "fixture-zero-resolved",
				},
				terminal: "error",
				usage: { inputMicroTokens: 0, outputMicroTokens: 99, cacheReadMicroTokens: 0, cacheWriteMicroTokens: 0 },
			},
			{
				requestId: "request-0002",
				attempt: 1,
				requested: { provider: "b00b-scripted", model: "fixture-zero" },
				resolved: {
					api: "b00b-scripted",
					provider: "b00b-scripted",
					model: "fixture-zero",
					responseModel: "fixture-zero-resolved",
				},
				terminal: "aborted",
				usage: { inputMicroTokens: 9, outputMicroTokens: 99, cacheReadMicroTokens: 2, cacheWriteMicroTokens: 0 },
			},
		],
	};
}
async function allFiles(directory: string): Promise<string> {
	const contents: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) contents.push(await allFiles(path));
		else if (entry.isFile()) contents.push(await readFile(path, "utf8"));
	}
	return contents.join("\n");
}
function privacyVariants(value: string): readonly string[] {
	const unicodeEscaped = [...value]
		.map((character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
		.join("");
	return [value, value.normalize("NFC"), value.normalize("NFKC"), unicodeEscaped];
}
function expectNoCanaryLeak(chunks: readonly string[]): void {
	const joined = chunks.join("");
	for (const canary of canaries)
		for (const variant of privacyVariants(canary))
			expect(joined.normalize("NFKC")).not.toContain(variant.normalize("NFKC"));
}

/** Coherently re-index a semantic-preserving process-sample mutation. */
async function forgeProcessSampleBundle(directory: string): Promise<string> {
	const samplePath = join(directory, "process-samples.json");
	const samples = JSON.parse(await readFile(samplePath, "utf8"));
	const firstSample = samples[0];
	const firstProcess = firstSample.processes[0];
	if (firstProcess) firstProcess.pid += 1;
	// B00A's default sampler legitimately returns no processes on some hosts.
	// A zero-RSS process remains schema-valid and leaves the sample total intact.
	else firstSample.processes.push({ pid: 1, rssBytes: 0 });
	const sampleRaw = `${canonicalJson(samples)}\n`;
	await writeFile(samplePath, sampleRaw);
	const manifestPath = join(directory, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const artifact = manifest.artifacts.find((item: { path: string }) => item.path === "process-samples.json");
	artifact.bytes = Buffer.byteLength(sampleRaw);
	artifact.sha256 = createHash("sha256").update(sampleRaw).digest("hex");
	manifest.artifactBundleId = createHash("sha256").update(canonicalJson(manifest.artifacts)).digest("hex");
	await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
	return manifest.artifactBundleId;
}

describe("B00B signed production evidence adapter", () => {
	test("authenticates an external Ed25519 commitment before canonical B00A verification in a fresh Node process", async () => {
		const artifactDirectory = await mkdtemp(join(tmpdir(), "b00b-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "b00b-trust-"));
		cleanup.push(artifactDirectory, trustDirectory);
		const keys = generateKeyPairSync("ed25519");
		const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
		const written = await writeSignedProductionEvidence(artifactDirectory, trustDirectory, input(), keys.privateKey);
		const canonicalTrustDirectory = await realpath(trustDirectory);
		const canonicalArtifactDirectory = await realpath(artifactDirectory);
		expect(written.commitmentPath.startsWith(`${canonicalTrustDirectory}/`)).toBe(true);
		expect(written.commitmentPath.startsWith(`${canonicalArtifactDirectory}/`)).toBe(false);
		await expect(
			verifySignedProductionEvidence(artifactDirectory, written.commitmentPath, publicPem),
		).resolves.toBeUndefined();
		await expect(
			verifySignedProductionEvidenceFreshProcess(artifactDirectory, written.commitmentPath, publicPem),
		).resolves.toBeUndefined();
		const content = await allFiles(artifactDirectory);
		expectNoCanaryLeak([content]);
		const costs = JSON.parse(await readFile(join(artifactDirectory, "cost-attribution.json"), "utf8"));
		const firstAttempt = costs.find((cost: { id: string }) => cost.id === "worker-0001");
		expect(firstAttempt).toMatchObject({
			directInputTokens: 111,
			directOutputTokens: 13,
			directCostNumerator: 111 * 17 + 13 * 29,
		});
		expect(COST_NUMERATOR_SCALE).toBe(1_000_000);
		const run = costs.find((cost: { id: string }) => cost.id === "run");
		expect(run).toMatchObject({
			downstreamInputTokens: 122,
			downstreamOutputTokens: 13,
			downstreamCostNumerator: 122 * 17 + 13 * 29,
		});
		// The terminal response model, not the selected requested alias, is retained as the resolved attribution.
		expect(content).toContain("fixture-b-resolved");
		expect(content).toContain('"api":"b00b-scripted"');
		expect(content).toContain('"responseModel":"fixture-b-resolved"');
		expect(content).not.toContain("alias-secret");
		const manifest = JSON.parse(await readFile(join(artifactDirectory, "manifest.json"), "utf8"));
		expect(manifest.assignments.map((assignment: { attemptId: string }) => assignment.attemptId)).toEqual([
			"attempt-0001-01",
			"attempt-0001-02",
			"attempt-0002-01",
		]);
		const retry = manifest.assignments[1];
		expect(retry.resolved).toMatchObject({ model: "fixture-zero", responseModel: "fixture-zero-resolved" });
	});

	test("rejects manifest read-back, coherent forgery, wrong key, and a commitment from another artifact directory", async () => {
		const firstArtifactDirectory = await mkdtemp(join(tmpdir(), "b00b-first-artifact-"));
		const firstTrustDirectory = await mkdtemp(join(tmpdir(), "b00b-first-trust-"));
		const secondArtifactDirectory = await mkdtemp(join(tmpdir(), "b00b-second-artifact-"));
		const secondTrustDirectory = await mkdtemp(join(tmpdir(), "b00b-second-trust-"));
		cleanup.push(firstArtifactDirectory, firstTrustDirectory, secondArtifactDirectory, secondTrustDirectory);
		const signer = generateKeyPairSync("ed25519");
		const publicPem = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
		const first = await writeSignedProductionEvidence(
			firstArtifactDirectory,
			firstTrustDirectory,
			input(),
			signer.privateKey,
		);
		const second = await writeSignedProductionEvidence(
			secondArtifactDirectory,
			secondTrustDirectory,
			input(),
			signer.privateKey,
		);

		const manifestReadBack = await forgeProcessSampleBundle(firstArtifactDirectory);
		expect(manifestReadBack).not.toBe(first.artifactBundleId);
		// A new ID derived from mutable artifacts has no authority over the original signature.
		await expect(
			verifySignedProductionEvidence(firstArtifactDirectory, first.commitmentPath, publicPem),
		).rejects.toThrow("trusted artifact bundle mismatch");
		await expect(
			verifySignedProductionEvidence(firstArtifactDirectory, second.commitmentPath, publicPem),
		).rejects.toThrow("trusted artifact bundle mismatch");
		// An attacker can self-generate a key and sign the manifest read-back ID,
		// but this cannot replace the externally configured root.
		const attacker = generateKeyPairSync("ed25519");
		const attackerCommitmentPath = join(firstTrustDirectory, "attacker-commitment.json");
		await writeFile(
			attackerCommitmentPath,
			`${canonicalJson({
				schemaVersion: SWARM_EVIDENCE_COMMITMENT_SCHEMA,
				artifactBundleId: manifestReadBack,
				signature: sign(
					null,
					Buffer.from(canonicalJson(swarmEvidenceCommitmentPayload(manifestReadBack))),
					attacker.privateKey,
				).toString("base64"),
			})}\n`,
		);
		await expect(
			verifySignedProductionEvidence(firstArtifactDirectory, attackerCommitmentPath, publicPem),
		).rejects.toThrow("B00B_EVIDENCE_BAD_SIGNATURE");
		const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
		await expect(
			verifySignedProductionEvidence(secondArtifactDirectory, second.commitmentPath, wrongKey),
		).rejects.toThrow("B00B_EVIDENCE_BAD_SIGNATURE");
	});

	test("coherently forges an empty default B00A sample but cannot satisfy the original external commitment", async () => {
		const artifactDirectory = await mkdtemp(join(tmpdir(), "b00b-empty-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "b00b-empty-trust-"));
		cleanup.push(artifactDirectory, trustDirectory);
		const sampler = vi.spyOn(currentProcessSampler, "sample").mockReturnValue([]);
		const signer = generateKeyPairSync("ed25519");
		const publicPem = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
		let written: Awaited<ReturnType<typeof writeSignedProductionEvidence>>;
		try {
			written = await writeSignedProductionEvidence(artifactDirectory, trustDirectory, input(), signer.privateKey);
		} finally {
			sampler.mockRestore();
		}
		const originalSamples = JSON.parse(await readFile(join(artifactDirectory, "process-samples.json"), "utf8"));
		expect(originalSamples[0].processes).toEqual([]);
		expect(originalSamples[0].totalRssBytes).toBe(0);
		const forgedBundleId = await forgeProcessSampleBundle(artifactDirectory);
		const forgedSamples = JSON.parse(await readFile(join(artifactDirectory, "process-samples.json"), "utf8"));
		expect(forgedSamples[0]).toMatchObject({ processes: [{ pid: 1, rssBytes: 0 }], totalRssBytes: 0 });
		// The forged artifact remains B00A-canonical when re-indexed against its new identity.
		const attacker = generateKeyPairSync("ed25519");
		const attackerCommitmentPath = join(trustDirectory, "attacker-commitment.json");
		await writeFile(
			attackerCommitmentPath,
			`${canonicalJson({
				schemaVersion: SWARM_EVIDENCE_COMMITMENT_SCHEMA,
				artifactBundleId: forgedBundleId,
				signature: sign(
					null,
					Buffer.from(canonicalJson(swarmEvidenceCommitmentPayload(forgedBundleId))),
					attacker.privateKey,
				).toString("base64"),
			})}\n`,
		);
		const attackerPublicPem = attacker.publicKey.export({ type: "spki", format: "pem" }).toString();
		await expect(
			verifySignedProductionEvidence(artifactDirectory, attackerCommitmentPath, attackerPublicPem),
		).resolves.toBeUndefined();
		await expect(
			verifySignedProductionEvidence(artifactDirectory, written.commitmentPath, publicPem),
		).rejects.toThrow("trusted artifact bundle mismatch");
	});

	test("rejects a coherent manifest/index forgery and tampered external commitment", async () => {
		const artifactDirectory = await mkdtemp(join(tmpdir(), "b00b-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "b00b-trust-"));
		cleanup.push(artifactDirectory, trustDirectory);
		const keys = generateKeyPairSync("ed25519");
		const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
		const written = await writeSignedProductionEvidence(artifactDirectory, trustDirectory, input(), keys.privateKey);
		const manifestPath = join(artifactDirectory, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		// A read-back / coherent-index attacker can choose a new bundle identity, but cannot forge the external signature.
		manifest.artifactBundleId = "0".repeat(64);
		await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
		await expect(
			verifySignedProductionEvidence(artifactDirectory, written.commitmentPath, publicPem),
		).rejects.toThrow("artifact bundle identity mismatch");
		const commitment = JSON.parse(await readFile(written.commitmentPath, "utf8"));
		commitment.artifactBundleId = "0".repeat(64);
		await writeFile(written.commitmentPath, `${canonicalJson(commitment)}\n`);
		await expect(
			verifySignedProductionEvidence(artifactDirectory, written.commitmentPath, publicPem),
		).rejects.toThrow("B00B_EVIDENCE_BAD_SIGNATURE");
	});
	test("keeps zero-price, cache, done/error/abort, and retry economics in exact numerators", () => {
		const source = input();
		const zero: ProductionEvidenceInput = {
			...source,
			priceCard: {
				...source.priceCard,
				inputMicroCurrencyPerMillionMicroTokens: 0,
				outputMicroCurrencyPerMillionMicroTokens: 0,
			},
		};
		const projected = projectProductionObservations(zero);
		expect(projected.assignments).toHaveLength(3);
		expect(projected.assignments.map((assignment) => assignment.inputTokens)).toEqual([111, 0, 11]);
		expect(projected.assignments.map((assignment) => assignment.outputTokens)).toEqual([13, 0, 0]);
		expect(projected.assignments.map((assignment) => assignment.attemptId)).toEqual([
			"attempt-0001-01",
			"attempt-0001-02",
			"attempt-0002-01",
		]);
		expect(projected.priceCard).toMatchObject({ inputPerMillionTokens: 0, outputPerMillionTokens: 0 });
	});

	test("privacy scans recursive normal outputs and captured console/stderr in normalized, escaped, and split forms", async () => {
		const artifactDirectory = await mkdtemp(join(tmpdir(), "b00b-privacy-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "b00b-privacy-trust-"));
		cleanup.push(artifactDirectory, trustDirectory);
		const keys = generateKeyPairSync("ed25519");
		const capturedConsole: string[] = [];
		const capturedStderr: string[] = [];
		const originalError = console.error;
		const originalWrite = process.stderr.write;
		console.error = (...values: unknown[]) => capturedConsole.push(values.map(String).join(" "));
		process.stderr.write = ((chunk: unknown) => {
			capturedStderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await writeSignedProductionEvidence(artifactDirectory, trustDirectory, input(), keys.privateKey);
		} finally {
			console.error = originalError;
			process.stderr.write = originalWrite;
		}
		expectNoCanaryLeak([await allFiles(artifactDirectory), ...capturedConsole, ...capturedStderr]);
	});
	test("rejects fabricated trust roots and malformed or noncanonical commitments", async () => {
		const artifactDirectory = await mkdtemp(join(tmpdir(), "b00b-root-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "b00b-root-trust-"));
		cleanup.push(artifactDirectory, trustDirectory);
		const keys = generateKeyPairSync("ed25519");
		const written = await writeSignedProductionEvidence(artifactDirectory, trustDirectory, input(), keys.privateKey);
		const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
		const commitment = await readFile(written.commitmentPath, "utf8");
		await expect(
			verifyAuthenticatedSwarmEvidence(
				artifactDirectory,
				commitment,
				{} as ReturnType<typeof createSwarmEvidenceTrustRoot>,
			),
		).rejects.toThrow("registered swarm evidence trust root is required");
		await expect(
			verifyAuthenticatedSwarmEvidence(artifactDirectory, `${commitment} `, createSwarmEvidenceTrustRoot(publicPem)),
		).rejects.toThrow("non-canonical JSON: artifact commitment");
		await expect(
			verifyAuthenticatedSwarmEvidence(
				artifactDirectory,
				`${canonicalJson({ schemaVersion: SWARM_EVIDENCE_COMMITMENT_SCHEMA, artifactBundleId: written.artifactBundleId, signature: "%%%" })}\n`,
				createSwarmEvidenceTrustRoot(publicPem),
			),
		).rejects.toThrow("B00B_EVIDENCE_BAD_SIGNATURE");
	});
});
