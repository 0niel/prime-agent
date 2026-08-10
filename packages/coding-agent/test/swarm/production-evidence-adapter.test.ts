import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type ProductionEvidenceInput,
	verifySignedProductionEvidence,
	verifySignedProductionEvidenceFreshProcess,
	writeSignedProductionEvidence,
} from "./production-evidence-adapter.js";
import { canonicalJson, SWARM_EVIDENCE_COMMITMENT_SCHEMA, swarmEvidenceCommitmentPayload } from "./swarm-evidence.js";

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
				resolved: { provider: "b00b-scripted", model: "fixture-a", responseModel: "fixture-b-resolved" },
				terminal: "done",
				usage: { inputMicroTokens: 101, outputMicroTokens: 13, cacheReadMicroTokens: 7, cacheWriteMicroTokens: 3 },
			},
			{
				requestId: "request-0002",
				attempt: 1,
				requested: { provider: "b00b-scripted", model: "fixture-zero" },
				resolved: { provider: "b00b-scripted", model: "fixture-zero", responseModel: "fixture-zero-resolved" },
				terminal: "aborted",
				usage: { inputMicroTokens: 9, outputMicroTokens: 99, cacheReadMicroTokens: 2, cacheWriteMicroTokens: 0 },
			},
		],
	};
}
async function allFiles(directory: string): Promise<string> {
	return (await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")))).join(
		"\n",
	);
}

/** Coherently re-index a semantic-preserving process-sample mutation. */
async function forgeProcessSampleBundle(directory: string): Promise<string> {
	const samplePath = join(directory, "process-samples.json");
	const samples = JSON.parse(await readFile(samplePath, "utf8"));
	samples[0].processes[0].pid += 1;
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
		for (const canary of canaries) expect(content).not.toContain(canary);
		const costs = JSON.parse(await readFile(join(artifactDirectory, "cost-attribution.json"), "utf8"));
		const firstAttempt = costs.find((cost: { id: string }) => cost.id === "worker-0001");
		expect(firstAttempt).toMatchObject({
			directInputTokens: 111,
			directOutputTokens: 13,
			directCost: (111 * 17 + 13 * 29) / 1_000_000,
		});
		const run = costs.find((cost: { id: string }) => cost.id === "run");
		expect(run).toMatchObject({
			downstreamInputTokens: 122,
			downstreamOutputTokens: 13,
			downstreamCost: (122 * 17 + 13 * 29) / 1_000_000,
		});
		// The terminal response model, not the selected requested alias, is retained as the resolved attribution.
		expect(content).toContain("fixture-b-resolved");
		expect(content).not.toContain("alias-secret");
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
});
