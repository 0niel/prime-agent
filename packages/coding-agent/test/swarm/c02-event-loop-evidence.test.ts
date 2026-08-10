/** Deterministic, test-only C02 event-loop evidence; no production/provider path is imported. */
import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
	artifactBundleIdForSwarmEvidenceCapability,
	canonicalJson,
	createSwarmEvidenceTrustRoot,
	createSwarmManifest,
	type ProcessSampler,
	runSwarmBenchmark,
	SWARM_EVIDENCE_COMMITMENT_SCHEMA,
	type SwarmEvidence,
	swarmEvidenceCommitmentPayload,
	verifyAuthenticatedSwarmEvidence,
	verifySwarmEvidence,
	writeSwarmEvidence,
} from "./swarm-evidence.js";

const execFile = promisify(execFileCallback);
const FANOUT = 64;
const WARMUP_REPETITIONS = 1;
const MEASURED_REPETITIONS = 3;
const cleanups: string[] = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Repetition = {
	parentPendingHighWater: number;
	uiPendingHighWater: number;
	slowCatchupPendingHighWater: number;
	slowCatchupScheduleHighWater: number;
	slowCatchupPromiseHighWater: number;
	timersScheduled: number;
	timersCancelled: number;
	timersFired: number;
	terminalDeliveries: number;
	healthyAttachmentLive: number;
	hookErrors: number;
	observerErrors: number;
	beforeToolVetoes: number;
	droppedReplaceableProgress: number;
	teardownPending: number;
	delayP50Milliseconds: number;
	delayP95Milliseconds: number;
	delayP99Milliseconds: number;
	delayMaxMilliseconds: number;
};

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const waitForDelaySample = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const milliseconds = (nanoseconds: number) => nanoseconds / 1_000_000;

/**
 * Models C02 ownership at the event-loop seam only. Stream dispatch is an
 * immediate Promise.all fanout: this fixture intentionally has no admission
 * queue, provider request, semaphore, limiter, retry, or synthetic 429.
 */
async function runRepetition(measured: boolean): Promise<Repetition> {
	let pendingChildren = new Map<number, "running">();
	let parentPendingHighWater = 0;
	let pendingProgress: number | undefined;
	let uiPendingHighWater = 0;
	let droppedReplaceableProgress = 0;
	let childFlush: ReturnType<typeof setTimeout> | undefined;
	let progressFlush: ReturnType<typeof setTimeout> | undefined;
	let slowDrain: ReturnType<typeof setTimeout> | undefined;
	const slowPending = new Set<number>();
	let slowCatchupPendingHighWater = 0;
	let slowCatchupScheduleHighWater = 0;
	let slowCatchupPromiseHighWater = 0;
	let activeSlowCatchups = 0;
	let timersScheduled = 0;
	let timersCancelled = 0;
	let timersFired = 0;
	let terminalDeliveries = 0;
	let hookErrors = 0;
	let observerErrors = 0;
	let beforeToolVetoes = 0;
	let healthyAttachmentLive = true;
	const terminalCounts = new Map<number, number>();

	const delay = monitorEventLoopDelay({ resolution: 10 });
	if (measured) delay.enable();
	try {
		const scheduleSlowCatchup = () => {
			if (slowDrain) return;
			slowCatchupScheduleHighWater = Math.max(slowCatchupScheduleHighWater, 1);
			timersScheduled++;
			slowDrain = setTimeout(() => {
				slowDrain = undefined;
				timersFired++;
				activeSlowCatchups++;
				slowCatchupPromiseHighWater = Math.max(slowCatchupPromiseHighWater, activeSlowCatchups);
				// A slow attachment gets its latest state only, while the healthy one stays live.
				slowPending.clear();
				activeSlowCatchups--;
			}, 0);
		};
		const queueProgress = (child: number) => {
			if (pendingProgress !== undefined) droppedReplaceableProgress++;
			pendingProgress = child;
			uiPendingHighWater = Math.max(uiPendingHighWater, 1);
			if (progressFlush) return;
			timersScheduled++;
			progressFlush = setTimeout(() => {
				progressFlush = undefined;
				timersFired++;
				pendingProgress = undefined;
			}, 0);
		};
		const queueChild = (child: number) => {
			pendingChildren.set(child, "running");
			parentPendingHighWater = Math.max(parentPendingHighWater, pendingChildren.size);
			if (childFlush) return;
			timersScheduled++;
			childFlush = setTimeout(() => {
				childFlush = undefined;
				timersFired++;
				pendingChildren = new Map();
			}, 0);
		};
		const terminal = (child: number) => {
			// Structural terminal updates synchronously defeat stale pending activity.
			pendingChildren.delete(child);
			if (pendingProgress === child) pendingProgress = undefined;
			terminalCounts.set(child, (terminalCounts.get(child) ?? 0) + 1);
			terminalDeliveries++;
		};
		const observe = () => {
			try {
				throw new Error("test observer failure");
			} catch {
				observerErrors++;
			}
		};
		const afterHook = () => {
			try {
				throw new Error("test after-hook failure");
			} catch {
				hookErrors++;
			}
		};
		const beforeHook = () => {
			try {
				throw new Error("test veto");
			} catch {
				beforeToolVetoes++;
			}
		};

		if (measured) delay.reset(); // The excluded warmup cannot affect recorded delay percentiles.
		await Promise.all(
			Array.from({ length: FANOUT }, async (_, child) => {
				queueChild(child);
				queueProgress(child);
				slowPending.add(0); // One latest per active session, despite every child stream updating it.
				slowCatchupPendingHighWater = Math.max(slowCatchupPendingHighWater, slowPending.size);
				scheduleSlowCatchup();
				if (child === 0) observe();
				if (child === 1) afterHook();
				if (child === 2) beforeHook();
				await Promise.resolve(); // all 64 child streams have already entered independently
				terminal(child);
			}),
		);
		await nextMacrotask();
		if (measured) await waitForDelaySample();

		// One macrotask settles each owner; teardown sees no stale C02 work.
		expect(childFlush).toBeUndefined();
		expect(progressFlush).toBeUndefined();
		expect(slowDrain).toBeUndefined();
		expect(pendingChildren.size).toBe(0);
		expect(pendingProgress).toBeUndefined();
		expect(slowPending.size).toBe(0);
		expect(timersScheduled).toBe(timersFired + timersCancelled);
		expect(healthyAttachmentLive).toBe(true);
		expect([...terminalCounts.values()]).toHaveLength(FANOUT);
		expect([...terminalCounts.values()].every((count) => count === 1)).toBe(true);
		expect(parentPendingHighWater).toBeLessThanOrEqual(FANOUT);
		expect(uiPendingHighWater).toBeLessThanOrEqual(1);
		expect(slowCatchupPendingHighWater).toBeLessThanOrEqual(1);
		expect(slowCatchupScheduleHighWater).toBe(1);
		expect(slowCatchupPromiseHighWater).toBe(1);
		expect(hookErrors).toBe(1);
		expect(observerErrors).toBe(1);
		expect(beforeToolVetoes).toBe(1);

		const stats = measured
			? {
					delayP50Milliseconds: milliseconds(delay.percentile(50)),
					delayP95Milliseconds: milliseconds(delay.percentile(95)),
					delayP99Milliseconds: milliseconds(delay.percentile(99)),
					delayMaxMilliseconds: milliseconds(delay.max),
				}
			: {
					delayP50Milliseconds: 0,
					delayP95Milliseconds: 0,
					delayP99Milliseconds: 0,
					delayMaxMilliseconds: 0,
				};
		return {
			parentPendingHighWater,
			uiPendingHighWater,
			slowCatchupPendingHighWater,
			slowCatchupScheduleHighWater,
			slowCatchupPromiseHighWater,
			timersScheduled,
			timersCancelled,
			timersFired,
			terminalDeliveries,
			healthyAttachmentLive: Number(healthyAttachmentLive),
			hookErrors,
			observerErrors,
			beforeToolVetoes,
			droppedReplaceableProgress,
			teardownPending: 0,
			...stats,
		};
	} finally {
		for (const timer of [childFlush, progressFlush, slowDrain]) {
			if (!timer) continue;
			clearTimeout(timer);
			timersCancelled++;
		}
		pendingChildren.clear();
		pendingProgress = undefined;
		slowPending.clear();
		healthyAttachmentLive = false;
		delay.disable();
	}
}

function arrays(repetitions: readonly Repetition[]) {
	const values = <Key extends keyof Repetition>(key: Key) => repetitions.map((repetition) => repetition[key]);
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

async function verifyFresh(directory: string, commitmentPath: string, publicKeyPem: string): Promise<void> {
	const moduleUrl = new URL("./swarm-evidence.ts", import.meta.url).href;
	const program = `import { createSwarmEvidenceTrustRoot as r, verifyAuthenticatedSwarmEvidence as v } from ${JSON.stringify(moduleUrl)}; import { readFile } from "node:fs/promises"; await v(process.argv[1], await readFile(process.argv[2], "utf8"), r(Buffer.from(process.argv[3], "base64").toString("utf8")));`;
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
			Buffer.from(publicKeyPem).toString("base64"),
		],
		{ cwd: process.cwd(), maxBuffer: 256 * 1024 },
	);
}

describe("C02 deterministic event-loop evidence", () => {
	test("records three fresh 64-child repetitions with canonical B00B verification", async () => {
		const warmup = await runRepetition(false);
		expect(warmup.terminalDeliveries).toBe(FANOUT);
		const repetitions: Repetition[] = [];
		for (let repetition = 0; repetition < MEASURED_REPETITIONS; repetition++)
			repetitions.push(await runRepetition(true));
		for (const repetition of repetitions) {
			expect(repetition.delayP99Milliseconds).toBeLessThanOrEqual(50);
			expect(repetition.delayMaxMilliseconds).toBeLessThanOrEqual(100);
			expect(repetition.teardownPending).toBe(0);
		}

		const sampler: ProcessSampler = { sample: () => [] };
		const config = {
			scenario: "c02-event-loop-scripted-local-fixture",
			assignments: Array.from({ length: FANOUT }, (_, index) => ({
				nodeId: `child-${index + 1}`,
				role: "event-loop-child",
				requested: { provider: "b00b-scripted", model: "fixture-zero" },
				inputTokens: 0,
				outputTokens: 0,
			})),
			priceCard: { version: "c02-test-only", inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
			processSampler: sampler,
			metadata: {
				c02Fanout: FANOUT,
				c02WarmupRepetitions: WARMUP_REPETITIONS,
				c02MeasuredRepetitions: MEASURED_REPETITIONS,
				...arrays(repetitions),
				c02EnvironmentNodeMajor: Number(process.versions.node.split(".")[0]),
				c02EnvironmentProcessorCount: cpus().length,
				c02EnvironmentPlatformKnown: true,
			},
		};
		const manifest = createSwarmManifest(config);
		expect(manifest.metadata.c02Fanout).toBe(FANOUT);
		const evidence: SwarmEvidence = await runSwarmBenchmark(config);
		const artifactDirectory = await mkdtemp(join(tmpdir(), "c02-event-loop-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "c02-event-loop-trust-"));
		cleanups.push(artifactDirectory, trustDirectory);
		const capability = await writeSwarmEvidence(artifactDirectory, evidence);
		await expect(verifySwarmEvidence(artifactDirectory, capability)).resolves.toBeUndefined();

		const artifactBundleId = artifactBundleIdForSwarmEvidenceCapability(capability);
		const keys = generateKeyPairSync("ed25519");
		const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
		const commitmentPath = join(trustDirectory, "artifact-commitment.json");
		await writeFile(
			commitmentPath,
			`${canonicalJson({
				schemaVersion: SWARM_EVIDENCE_COMMITMENT_SCHEMA,
				artifactBundleId,
				signature: sign(
					null,
					Buffer.from(canonicalJson(swarmEvidenceCommitmentPayload(artifactBundleId))),
					keys.privateKey,
				).toString("base64"),
			})}\n`,
		);
		await verifyAuthenticatedSwarmEvidence(
			artifactDirectory,
			await readFile(commitmentPath, "utf8"),
			createSwarmEvidenceTrustRoot(publicKeyPem),
		);
		await expect(verifyFresh(artifactDirectory, commitmentPath, publicKeyPem)).resolves.toBeUndefined();

		// The signature binds the out-of-band writer identity; mutation cannot pass a fresh verifier.
		await writeFile(join(artifactDirectory, "summary.json"), "{}\n");
		await expect(verifyFresh(artifactDirectory, commitmentPath, publicKeyPem)).rejects.toBeDefined();
	}, 30_000);
});
