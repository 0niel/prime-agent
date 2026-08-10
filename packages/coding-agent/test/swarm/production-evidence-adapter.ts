/**
 * B00B bridge from immutable production-path observations to B00A evidence.
 *
 * This module never serializes B00A artifacts itself.  It projects the small,
 * content-free observation surface into B00A's public input, calls its writer,
 * and keeps the authenticated artifact commitment in a sibling trust root.
 */
import { execFile as execFileCallback } from "node:child_process";
import { type KeyObject, sign, verify as verifySignature } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
	canonicalJson,
	runSwarmBenchmark,
	type SwarmBenchmarkConfig,
	verifySwarmEvidence,
	writeSwarmEvidence,
} from "./swarm-evidence.js";

const execFile = promisify(execFileCallback);
const COMMITMENT_SCHEMA = "prime-agent.swarm-evidence-commitment/v1";
const MODEL_IDS = new Set(["fixture-a", "fixture-b", "fixture-zero"]);
const RESOLVED_MODEL_IDS = new Set([...MODEL_IDS].map((id) => `${id}-resolved`));

export interface ExactUsage {
	/** Integer micro-tokens.  No floating point token or price field is accepted. */
	readonly inputMicroTokens: number;
	readonly outputMicroTokens: number;
	readonly cacheReadMicroTokens: number;
	readonly cacheWriteMicroTokens: number;
}
export interface ImmutableAttemptObservation {
	readonly requestId: `request-${string}`;
	readonly attempt: number;
	readonly requested: Readonly<{ provider: string; model: string; revision?: string; effort?: string }>;
	readonly resolved: Readonly<{ provider: string; model: string; responseModel: string }>;
	readonly terminal: "done" | "error" | "aborted";
	readonly usage: ExactUsage;
}
export interface FrozenPriceCard {
	/** Integer micro-currency per million micro-tokens, frozen before dispatch. */
	readonly version: string;
	readonly inputMicroCurrencyPerMillionMicroTokens: number;
	readonly outputMicroCurrencyPerMillionMicroTokens: number;
}
export interface ProductionEvidenceInput {
	readonly scenario: string;
	readonly attempts: readonly ImmutableAttemptObservation[];
	readonly priceCard: FrozenPriceCard;
	readonly metadata?: Readonly<Record<string, unknown>>;
}
interface SignedCommitment {
	readonly schemaVersion: typeof COMMITMENT_SCHEMA;
	readonly artifactBundleId: string;
	readonly signature: string;
}
export interface SignedProductionEvidence {
	readonly artifactBundleId: string;
	readonly commitmentPath: string;
}

function assert(condition: unknown, code: string): asserts condition {
	if (!condition) throw new Error(code);
}
function integer(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}
function commitmentPayload(artifactBundleId: string) {
	return { schemaVersion: COMMITMENT_SCHEMA, artifactBundleId };
}
function safeModel(value: string, resolved = false): string {
	return (resolved ? RESOLVED_MODEL_IDS : MODEL_IDS).has(value) ? value : "[REDACTED]";
}
function publicAttemptId(observation: ImmutableAttemptObservation, index: number): string {
	// Input identity is only used inside B00A's in-memory projection. B00A
	// assigns the public worker/request IDs and redacts all other identities.
	return `attempt-${index + 1}-${observation.attempt}`;
}
function assertInput(input: ProductionEvidenceInput): void {
	assert(input.attempts.length > 0, "B00B_EVIDENCE_NO_ATTEMPTS");
	assert(input.scenario.length > 0, "B00B_EVIDENCE_EMPTY_SCENARIO");
	assert(
		integer(input.priceCard.inputMicroCurrencyPerMillionMicroTokens) &&
			integer(input.priceCard.outputMicroCurrencyPerMillionMicroTokens),
		"B00B_EVIDENCE_NON_INTEGER_PRICE",
	);
	const identities = new Set<string>();
	for (const observation of input.attempts) {
		assert(/^request-\d{4}$/.test(observation.requestId), "B00B_EVIDENCE_REQUEST_ID");
		assert(integer(observation.attempt) && observation.attempt > 0, "B00B_EVIDENCE_ATTEMPT");
		assert(!identities.has(`${observation.requestId}:${observation.attempt}`), "B00B_EVIDENCE_DUPLICATE_ATTEMPT");
		identities.add(`${observation.requestId}:${observation.attempt}`);
		for (const value of Object.values(observation.usage)) assert(integer(value), "B00B_EVIDENCE_NON_INTEGER_USAGE");
	}
}

/**
 * Converts immutable terminal observations into B00A input. The B00A schema
 * currently has input/output columns only, so cache usage is deliberately
 * included in input micro-tokens rather than silently discarded. Its separate
 * integer fields remain part of the immutable adapter input and can be
 * independently recomputed by callers.
 */
export function projectProductionObservations(input: ProductionEvidenceInput): SwarmBenchmarkConfig {
	assertInput(input);
	return {
		scenario: input.scenario,
		assignments: input.attempts.map((observation, index) => ({
			nodeId: publicAttemptId(observation, index),
			role: "provider-attempt",
			requested: {
				provider: observation.requested.provider === "b00b-scripted" ? "b00b-scripted" : "[REDACTED]",
				model: safeModel(observation.requested.model),
				...(observation.requested.revision === undefined ? {} : { revision: observation.requested.revision }),
				...(observation.requested.effort === undefined ? {} : { effort: observation.requested.effort }),
			},
			resolved: {
				provider: observation.resolved.provider === "b00b-scripted" ? "b00b-scripted" : "[REDACTED]",
				// responseModel is the attribution authority, never the selected model.
				model: safeModel(observation.resolved.responseModel, true),
			},
			inputTokens:
				observation.usage.inputMicroTokens +
				observation.usage.cacheReadMicroTokens +
				observation.usage.cacheWriteMicroTokens,
			outputTokens: observation.terminal === "done" ? observation.usage.outputMicroTokens : 0,
		})),
		faultSchedule: input.attempts
			.map((observation, index) =>
				observation.terminal === "done"
					? undefined
					: {
							nodeId: publicAttemptId(observation, index),
							actions: [{ type: "failure" as const, code: "[REDACTED]", message: "[REDACTED]" }],
						},
			)
			.filter((value): value is NonNullable<typeof value> => value !== undefined),
		priceCard: {
			version: input.priceCard.version,
			inputPerMillionTokens: input.priceCard.inputMicroCurrencyPerMillionMicroTokens,
			outputPerMillionTokens: input.priceCard.outputMicroCurrencyPerMillionMicroTokens,
		},
		metadata: input.metadata,
	};
}

/** Writes B00A artifacts, then signs their commitment outside the artifact root. */
export async function writeSignedProductionEvidence(
	directory: string,
	trustDirectory: string,
	input: ProductionEvidenceInput,
	signer: KeyObject,
): Promise<SignedProductionEvidence> {
	const artifactRoot = await realpath(directory).catch(async () => {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		return realpath(directory);
	});
	await mkdir(trustDirectory, { recursive: true, mode: 0o700 });
	const trustRoot = await realpath(trustDirectory);
	assert(
		artifactRoot !== trustRoot &&
			!trustRoot.startsWith(`${artifactRoot}/`) &&
			!artifactRoot.startsWith(`${trustRoot}/`),
		"B00B_EVIDENCE_TRUST_ROOT_OVERLAP",
	);
	const evidence = await runSwarmBenchmark(projectProductionObservations(input));
	await writeSwarmEvidence(artifactRoot, evidence);
	const manifest = JSON.parse(await readFile(`${artifactRoot}/manifest.json`, "utf8")) as {
		artifactBundleId?: unknown;
	};
	assert(
		typeof manifest.artifactBundleId === "string" && /^[0-9a-f]{64}$/.test(manifest.artifactBundleId),
		"B00B_EVIDENCE_WRITER_ID",
	);
	const artifactBundleId = manifest.artifactBundleId;
	const commitment: SignedCommitment = {
		schemaVersion: COMMITMENT_SCHEMA,
		artifactBundleId,
		signature: sign(null, Buffer.from(canonicalJson(commitmentPayload(artifactBundleId))), signer).toString("base64"),
	};
	const commitmentPath = `${trustRoot}/artifact-commitment.json`;
	await writeFile(commitmentPath, `${canonicalJson(commitment)}\n`, { encoding: "utf8", mode: 0o600 });
	return { artifactBundleId, commitmentPath };
}

/** Fresh-process safe verification: authenticate an externally supplied key first, then B00A semantics. */
export async function verifySignedProductionEvidence(
	directory: string,
	commitmentPath: string,
	trustedPublicKeyPem: string,
): Promise<void> {
	const raw = await readFile(commitmentPath, "utf8");
	const commitment = JSON.parse(raw) as Partial<SignedCommitment>;
	assert(raw === `${canonicalJson(commitment)}\n`, "B00B_EVIDENCE_NONCANONICAL_COMMITMENT");
	assert(
		commitment.schemaVersion === COMMITMENT_SCHEMA &&
			typeof commitment.artifactBundleId === "string" &&
			/^[0-9a-f]{64}$/.test(commitment.artifactBundleId) &&
			typeof commitment.signature === "string",
		"B00B_EVIDENCE_BAD_COMMITMENT",
	);
	assert(
		verifySignature(
			null,
			Buffer.from(canonicalJson(commitmentPayload(commitment.artifactBundleId))),
			trustedPublicKeyPem,
			Buffer.from(commitment.signature, "base64"),
		),
		"B00B_EVIDENCE_BAD_SIGNATURE",
	);
	await verifySwarmEvidence(directory, commitment.artifactBundleId);
}

/** Runs the authentication-plus-B00A verifier in a clean Node process. */
export async function verifySignedProductionEvidenceFreshProcess(
	directory: string,
	commitmentPath: string,
	trustedPublicKeyPem: string,
): Promise<void> {
	const moduleUrl = new URL("./production-evidence-adapter.ts", import.meta.url).href;
	const program = `import { verifySignedProductionEvidence as v } from ${JSON.stringify(moduleUrl)}; await v(process.argv[1], process.argv[2], Buffer.from(process.argv[3], "base64").toString("utf8"));`;
	try {
		await execFile(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				program,
				directory,
				commitmentPath,
				Buffer.from(trustedPublicKeyPem).toString("base64"),
			],
			{ cwd: process.cwd(), maxBuffer: 256 * 1024 },
		);
	} catch (error) {
		const detail = error as { stderr?: string; stdout?: string };
		// Do not forward child output: production fixtures may contain canaries.
		throw new Error(
			`B00B_EVIDENCE_FRESH_VERIFY_FAILED:${detail.stderr ? "stderr" : detail.stdout ? "stdout" : "exit"}`,
			{ cause: error },
		);
	}
}
