/**
 * B00B bridge from immutable production-path observations to B00A evidence.
 *
 * This module never serializes B00A artifacts itself.  It projects the small,
 * content-free observation surface into B00A's public input, calls its writer,
 * and keeps the authenticated artifact commitment in a sibling trust root.
 */
import { execFile as execFileCallback } from "node:child_process";
import { type KeyObject, sign } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
	artifactBundleIdForSwarmEvidenceCapability,
	canonicalJson,
	createSwarmEvidenceTrustRoot,
	runSwarmBenchmark,
	SWARM_EVIDENCE_COMMITMENT_SCHEMA,
	type SwarmBenchmarkConfig,
	swarmEvidenceCommitmentPayload,
	verifyAuthenticatedSwarmEvidence,
	writeSwarmEvidence,
} from "./swarm-evidence.js";

const execFile = promisify(execFileCallback);
const MODEL_IDS = new Set(["fixture-a", "fixture-b", "fixture-zero"]);
const RESPONSE_MODEL_IDS = new Set([...MODEL_IDS].map((id) => `${id}-resolved`));
const PROVIDER = "b00b-scripted";

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
	readonly resolved: Readonly<{ api: string; provider: string; model: string; responseModel: string }>;
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
function safeModel(value: string, responseModel = false): string {
	return (responseModel ? RESPONSE_MODEL_IDS : MODEL_IDS).has(value) ? value : "[REDACTED]";
}
function publicAttemptId(observation: ImmutableAttemptObservation): string {
	return `attempt-${observation.requestId.slice("request-".length)}-${String(observation.attempt).padStart(2, "0")}`;
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
		assert(
			Boolean(observation.requested.provider && observation.requested.model),
			"B00B_EVIDENCE_REQUESTED_PROVENANCE",
		);
		assert(
			Boolean(
				observation.resolved.api &&
					observation.resolved.provider &&
					observation.resolved.model &&
					observation.resolved.responseModel,
			),
			"B00B_EVIDENCE_RESOLVED_PROVENANCE",
		);
	}
}

/**
 * Converts immutable terminal observations into B00A input. The B00A schema
 * records only integer usage: cache read/write are included in direct input,
 * terminal error/abort output is zero, and every retry attempt is a distinct
 * stable assignment. B00A stores exact cost numerators over its documented
 * 1,000,000 scale, never binary floating-point money.
 */
export function projectProductionObservations(input: ProductionEvidenceInput): SwarmBenchmarkConfig {
	assertInput(input);
	return {
		scenario: input.scenario,
		assignments: input.attempts.map((observation, index) => ({
			nodeId: `attempt-worker-${String(index + 1).padStart(4, "0")}`,
			role: "provider-attempt",
			requestId: observation.requestId,
			attempt: observation.attempt,
			attemptId: publicAttemptId(observation),
			requested: {
				provider: observation.requested.provider === PROVIDER ? PROVIDER : "[REDACTED]",
				model: safeModel(observation.requested.model),
				// revision/effort remain explicitly present but content-free.
				...(observation.requested.revision === undefined ? {} : { revision: "[REDACTED]" }),
				...(observation.requested.effort === undefined ? {} : { effort: "[REDACTED]" }),
			},
			resolved: {
				api: observation.resolved.api === PROVIDER ? PROVIDER : "[REDACTED]",
				provider: observation.resolved.provider === PROVIDER ? PROVIDER : "[REDACTED]",
				model: safeModel(observation.resolved.model),
				// responseModel, not selected resolved model, is the attribution authority.
				responseModel: safeModel(observation.resolved.responseModel, true),
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
							nodeId: `attempt-worker-${String(index + 1).padStart(4, "0")}`,
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
	const writerCapability = await writeSwarmEvidence(artifactRoot, evidence);
	// This value is taken from the writer's opaque registration, never manifest.json.
	const artifactBundleId = artifactBundleIdForSwarmEvidenceCapability(writerCapability);
	const commitment = {
		schemaVersion: SWARM_EVIDENCE_COMMITMENT_SCHEMA,
		artifactBundleId,
		signature: sign(
			null,
			Buffer.from(canonicalJson(swarmEvidenceCommitmentPayload(artifactBundleId))),
			signer,
		).toString("base64"),
	};
	const commitmentPath = `${trustRoot}/artifact-commitment.json`;
	await writeFile(commitmentPath, `${canonicalJson(commitment)}\n`, { encoding: "utf8", mode: 0o600 });
	return { artifactBundleId, commitmentPath };
}

/**
 * Fresh-process safe verification. The supplied public key is registered as an
 * opaque trust root before the B00B verifier authenticates the commitment.
 */
export async function verifySignedProductionEvidence(
	directory: string,
	commitmentPath: string,
	trustedPublicKeyPem: string,
): Promise<void> {
	const commitmentRaw = await readFile(commitmentPath, "utf8");
	const trustRoot = createSwarmEvidenceTrustRoot(trustedPublicKeyPem);
	await verifyAuthenticatedSwarmEvidence(directory, commitmentRaw, trustRoot);
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
