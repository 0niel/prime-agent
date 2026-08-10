/** Authenticated C02 evidence from the integrated owner, daemon attachment, and UI seams. */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { C02_FANOUT, type C02IntegratedRepetition, runC02IntegratedRepetition } from "./c02-integrated-harness.js";
import {
	verifySignedProductionEvidence,
	verifySignedProductionEvidenceFreshProcess,
	writeSignedProductionEvidence,
} from "./production-evidence-adapter.js";

const WARMUP_REPETITIONS = 1;
const MEASURED_REPETITIONS = 3;
const cleanups: string[] = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function samples(repetitions: readonly C02IntegratedRepetition[]) {
	const values = <Key extends keyof C02IntegratedRepetition>(key: Key) =>
		repetitions.map((repetition) => repetition[key]);
	return {
		c02ParentPendingHighWater: values("parentPendingHighWater"),
		c02UiPendingHighWater: values("uiPendingHighWater"),
		c02SlowCatchupPendingHighWater: values("slowCatchupPendingHighWater"),
		c02SlowCatchupScheduleHighWater: values("slowCatchupScheduleHighWater"),
		c02SlowCatchupPromiseHighWater: values("slowCatchupPromiseHighWater"),
		c02TimersScheduled: values("timersScheduled"),
		c02TimersCancelled: values("timersCancelled"),
		c02TimersFired: values("timersFired"),
		c02TerminalDeliveries: values("terminalDeliveries"),
		c02HealthyAttachmentLive: values("healthyAttachmentLive"),
		c02HookErrors: values("hookErrors"),
		c02ObserverErrors: values("observerErrors"),
		c02BeforeToolVetoes: values("beforeToolVetoes"),
		c02DroppedReplaceableProgress: values("droppedReplaceableProgress"),
		c02TeardownPending: values("teardownPending"),
		c02DelayP50Milliseconds: values("delayP50Milliseconds"),
		c02DelayP95Milliseconds: values("delayP95Milliseconds"),
		c02DelayP99Milliseconds: values("delayP99Milliseconds"),
		c02DelayMaxMilliseconds: values("delayMaxMilliseconds"),
	};
}

describe("C02 integrated event-loop evidence", () => {
	test("observes fresh owner, attachment, and UI lifecycle repetitions through B00B", async () => {
		// Excluded warm-up owns a fresh AgentSession, supervisor, clients, UI harness, and delay monitor.
		const warmup = await runC02IntegratedRepetition(false);
		expect(warmup.terminalDeliveries).toBe(C02_FANOUT);
		const repetitions: C02IntegratedRepetition[] = [];
		for (let index = 0; index < MEASURED_REPETITIONS; index++)
			repetitions.push(await runC02IntegratedRepetition(true));
		for (const repetition of repetitions) {
			expect(repetition.parentPendingHighWater).toBe(C02_FANOUT);
			expect(repetition.uiPendingHighWater).toBe(1);
			expect(repetition.slowCatchupPendingHighWater).toBe(1);
			expect(repetition.slowCatchupScheduleHighWater).toBe(1);
			expect(repetition.slowCatchupPromiseHighWater).toBe(1);
			expect(repetition.timersScheduled).toBe(repetition.timersCancelled + repetition.timersFired);
			expect(repetition.terminalDeliveries).toBe(C02_FANOUT);
			expect(repetition.healthyAttachmentLive).toBe(1);
			expect(repetition.hookErrors).toBe(1);
			expect(repetition.observerErrors).toBeGreaterThanOrEqual(1);
			expect(repetition.beforeToolVetoes).toBe(1);
			expect(repetition.teardownPending).toBe(0);
			expect(repetition.delayP99Milliseconds).toBeLessThanOrEqual(50);
			expect(repetition.delayMaxMilliseconds).toBeLessThanOrEqual(100);
		}

		const artifactDirectory = await mkdtemp(join(tmpdir(), "c02-integrated-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "c02-integrated-trust-"));
		cleanups.push(artifactDirectory, trustDirectory);
		const keys = generateKeyPairSync("ed25519");
		const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
		const written = await writeSignedProductionEvidence(
			artifactDirectory,
			trustDirectory,
			{
				scenario: "c02-integrated-owner-attachment-ui",
				attempts: Array.from({ length: C02_FANOUT }, (_, index) => ({
					requestId: `request-${String(index + 1).padStart(4, "0")}` as `request-${string}`,
					attempt: 1,
					requested: { provider: "b00b-scripted", model: "fixture-zero" },
					resolved: {
						api: "b00b-scripted",
						provider: "b00b-scripted",
						model: "fixture-zero",
						responseModel: "fixture-zero-resolved",
					},
					terminal: "done" as const,
					usage: { inputMicroTokens: 0, outputMicroTokens: 0, cacheReadMicroTokens: 0, cacheWriteMicroTokens: 0 },
				})),
				priceCard: {
					version: "c02-integrated-test-only",
					inputMicroCurrencyPerMillionMicroTokens: 0,
					outputMicroCurrencyPerMillionMicroTokens: 0,
				},
				metadata: {
					c02Fanout: C02_FANOUT,
					c02WarmupRepetitions: WARMUP_REPETITIONS,
					c02MeasuredRepetitions: MEASURED_REPETITIONS,
					...samples(repetitions),
					c02EnvironmentNodeMajor: Number(process.versions.node.split(".")[0]),
					c02EnvironmentProcessorCount: cpus().length,
					c02EnvironmentPlatformKnown: true,
				},
			},
			keys.privateKey,
		);
		await expect(
			verifySignedProductionEvidence(artifactDirectory, written.commitmentPath, publicKeyPem),
		).resolves.toBeUndefined();
		await expect(
			verifySignedProductionEvidenceFreshProcess(artifactDirectory, written.commitmentPath, publicKeyPem),
		).resolves.toBeUndefined();
		await writeFile(join(artifactDirectory, "summary.json"), "{}\n");
		await expect(
			verifySignedProductionEvidenceFreshProcess(artifactDirectory, written.commitmentPath, publicKeyPem),
		).rejects.toThrow("B00B_EVIDENCE_FRESH_VERIFY_FAILED");
		// The trust-root commitment is stored separately from the mutable artifact root.
		expect(await readFile(written.commitmentPath, "utf8")).toContain(written.artifactBundleId);
	}, 60_000);
});
