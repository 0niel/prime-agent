import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	createFixedFanoutScenario,
	createSwarmManifest,
	type ProcessSampler,
	redactEvidence,
	runSwarmBenchmark,
	verifySwarmEvidence,
	writeSwarmEvidence,
} from "./swarm-evidence.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PR-B00 local swarm evidence", () => {
	test("has a stable manifest fingerprint independent of host runtime", () => {
		const config = createFixedFanoutScenario(4);
		expect(createSwarmManifest(config).fingerprint).toBe(createSwarmManifest(config).fingerprint);
	});

	test.each([1, 4, 16, 64])("immediately dispatches every fixed fanout assignment (%i)", async (fanout) => {
		const evidence = await runSwarmBenchmark(createFixedFanoutScenario(fanout as 1 | 4 | 16 | 64));
		expect(evidence.summary).toMatchObject({
			admitted: fanout,
			started: fanout,
			completed: fanout,
			delivered: fanout,
			cleanedUp: fanout,
			independentDispatch: true,
		});
		const firstTerminal = evidence.events.findIndex((event) => event.type === "provider_completed");
		expect(
			evidence.events.slice(0, firstTerminal).filter((event) => event.type === "provider_request_started"),
		).toHaveLength(fanout);
	});

	test("retains fault, requested/resolved assignment, subtree cost, and total process RSS facts", async () => {
		const sampler: ProcessSampler = {
			sample: () => [
				{ pid: 11, rssBytes: 100, label: "root" },
				{ pid: 12, rssBytes: 250, label: "child" },
			],
		};
		const config = createFixedFanoutScenario(4);
		const evidence = await runSwarmBenchmark({
			...config,
			processSampler: sampler,
			faultSchedule: [
				{
					nodeId: "child-1",
					actions: [
						{ type: "progress", message: "working" },
						{ type: "delay", milliseconds: 1 },
						{ type: "restart", reason: "fixture" },
						{ type: "completion", outputTokens: 7 },
					],
				},
				{ nodeId: "child-2", actions: [{ type: "failure", code: "offline", message: "Bearer top-secret" }] },
			],
		});
		expect(evidence.events.map((event) => event.type)).toContain("restart");
		expect(evidence.summary).toMatchObject({ completed: 3, failed: 1, delivered: 3, cleanedUp: 4 });
		expect(evidence.processSamples.every((sample) => sample.totalRssBytes === 350)).toBe(true);
		const run = evidence.costAttribution.find((cost) => cost.id === "run");
		expect(evidence.costAttribution.find((cost) => cost.id === "child-1")?.directOutputTokens).toBe(7);
		expect(evidence.costAttribution.find((cost) => cost.id === "worker")?.kind).toBe("role");
		expect(run).toMatchObject({ kind: "run", directCost: 0 });
		expect(run?.downstreamCost).toBeGreaterThan(0);
		const started = evidence.events.find((event) => event.type === "provider_request_started");
		expect(started?.detail).toMatchObject({
			role: "worker",
			requested: { model: "deterministic-v1", effort: "low" },
			resolved: { revision: "b00" },
		});
	});

	test("redacts sensitive keys and credential-shaped values before writing raw evidence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00-"));
		directories.push(directory);
		const evidence = await runSwarmBenchmark({
			...createFixedFanoutScenario(1),
			metadata: { authorization: "Bearer absolutely-not-on-disk", note: "sk-should-not-survive" },
		});
		await writeSwarmEvidence(directory, evidence);
		const allFiles = await Promise.all(
			["manifest.json", "events.jsonl", "process-samples.json", "cost-attribution.json", "summary.json"].map(
				(name) => readFile(join(directory, name), "utf8"),
			),
		);
		expect(allFiles.join("\n")).not.toContain("absolutely-not-on-disk");
		expect(allFiles.join("\n")).not.toContain("sk-should-not-survive");
		expect(allFiles.join("\n")).toContain("[REDACTED]");
		await expect(verifySwarmEvidence(directory)).resolves.toBeUndefined();
		expect(redactEvidence({ apiKey: "x", normal: "safe" })).toEqual({ apiKey: "[REDACTED]", normal: "safe" });
		expect(redactEvidence({ diagnostic: "Bearer should-not-survive" })).toEqual({ diagnostic: "[REDACTED]" });
	});
	test("rejects tampered hash-covered evidence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00-integrity-"));
		directories.push(directory);
		await writeSwarmEvidence(directory, await runSwarmBenchmark(createFixedFanoutScenario(1)));
		await writeFile(join(directory, "summary.json"), "{}\n");
		await expect(verifySwarmEvidence(directory)).rejects.toThrow("hash mismatch");
	});
});
