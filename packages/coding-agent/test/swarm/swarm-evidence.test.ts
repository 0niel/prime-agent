import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	canonicalJson,
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
async function evidenceDirectory(fanout = 4): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00a-"));
	directories.push(directory);
	await writeSwarmEvidence(directory, await runSwarmBenchmark(createFixedFanoutScenario(fanout as 1 | 4 | 16 | 64)));
	return directory;
}
describe("PR-B00A deterministic local swarm evidence", () => {
	test("has a stable public manifest fingerprint independent of host runtime", () => {
		const config = createFixedFanoutScenario(4);
		expect(createSwarmManifest(config).fingerprint).toBe(createSwarmManifest(config).fingerprint);
		expect(JSON.stringify(createSwarmManifest(config))).not.toContain("local-fake");
	});
	test("canonical serialization rejects lossy values and orders object keys", () => {
		expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
		expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
		expect(() => canonicalJson(NaN)).toThrow("non-finite");
	});
	test("writes a byte-identical logical oracle while timing remains separate", async () => {
		const first = await evidenceDirectory(),
			second = await evidenceDirectory();
		expect(await readFile(join(first, "oracle.jsonl"), "utf8")).toBe(
			await readFile(join(second, "oracle.jsonl"), "utf8"),
		);
		const oracle = await readFile(join(first, "oracle.jsonl"), "utf8");
		expect(oracle).toContain('"requestId":"request-0001"');
		expect(oracle).not.toContain("elapsedMilliseconds");
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
	test("retains only content-free facts, stable IDs, exact economics, and nested tree totals", async () => {
		const sampler: ProcessSampler = {
			sample: () => [
				{ pid: 11, rssBytes: 100, label: "root" },
				{ pid: 12, rssBytes: 250, label: "child" },
			],
		};
		const base = createFixedFanoutScenario(4);
		const evidence = await runSwarmBenchmark({
			...base,
			assignments: [
				{ ...base.assignments[0]!, parentNodeId: undefined, role: "lead" },
				{ ...base.assignments[1]!, parentNodeId: "child-1", role: "worker" },
				...base.assignments.slice(2),
			],
			processSampler: sampler,
			faultSchedule: [
				{
					nodeId: "child-1",
					actions: [
						{ type: "progress", message: "real-secret" },
						{ type: "delay", milliseconds: 1 },
						{ type: "restart", reason: "real-secret" },
						{ type: "completion", outputTokens: 7 },
					],
				},
				{ nodeId: "child-2", actions: [{ type: "failure", code: "offline", message: "Bearer top-secret" }] },
			],
		});
		expect(evidence.events.map((event) => event.type)).toContain("restart");
		expect(
			evidence.events.every(
				(event) => /^worker-\d{4}$/.test(event.nodeId) && /^request-\d{4}$/.test(event.requestId),
			),
		).toBe(true);
		expect(evidence.summary).toMatchObject({ completed: 3, failed: 1, delivered: 3, cleanedUp: 4 });
		expect(evidence.processSamples.every((sample) => sample.totalRssBytes === 350)).toBe(true);
		const lead = evidence.costAttribution.find((cost) => cost.id === "role-0001");
		const run = evidence.costAttribution.find((cost) => cost.id === "run");
		expect(lead?.downstreamInputTokens).toBe(64);
		expect(run).toMatchObject({ kind: "run", directCost: 0 });
		expect(run?.downstreamCost).toBeGreaterThan(0);
	});
	test("whole artifacts are canary-safe even for unicode, chunks, paths, and ordinary fields", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-agent-b00a-canary-"));
		directories.push(directory);
		const canaries = [
			"absolutely-not-on-disk",
			"sk-should-not-survive",
			"S\u00c9CR\u00c8T-\ud83d\udd12",
			"split-canary-A",
			"split-canary-B",
			"/private/canary.txt",
		];
		const evidence = await runSwarmBenchmark({
			...createFixedFanoutScenario(1),
			metadata: {
				authorization: `Bearer ${canaries[0]}`,
				ordinary: canaries[2],
				chunks: [canaries[3], canaries[4]],
				path: canaries[5],
			},
			faultSchedule: [
				{
					nodeId: "child-1",
					actions: [
						{ type: "progress", message: canaries.join("") },
						{ type: "failure", code: canaries[0], message: canaries[1] },
					],
				},
			],
		});
		await writeSwarmEvidence(directory, evidence);
		const all = (
			await Promise.all(
				[
					"manifest.json",
					"events.jsonl",
					"oracle.jsonl",
					"process-samples.json",
					"cost-attribution.json",
					"summary.json",
				].map((name) => readFile(join(directory, name), "utf8")),
			)
		).join("\n");
		for (const canary of canaries) expect(all).not.toContain(canary);
		expect(all).toContain("[REDACTED]");
		await expect(verifySwarmEvidence(directory)).resolves.toBeUndefined();
		expect(redactEvidence({ apiKey: "x", normal: "safe" })).toEqual({ apiKey: "[REDACTED]", normal: "[REDACTED]" });
	});
	test("fails closed on tampering, missing, extra, symlink, duplicate index, reordering, and noncanonical evidence", async () => {
		const directory = await evidenceDirectory(1);
		await writeFile(join(directory, "summary.json"), "{}\n");
		await expect(verifySwarmEvidence(directory)).rejects.toThrow("hash mismatch");
		await rm(join(directory, "summary.json"));
		await expect(verifySwarmEvidence(directory)).rejects.toThrow("unexpected or missing");
		const extra = await evidenceDirectory(1);
		await writeFile(join(extra, "unindexed.json"), "{}\n");
		await expect(verifySwarmEvidence(extra)).rejects.toThrow("unexpected or missing");
		const link = await evidenceDirectory(1);
		await rm(join(link, "summary.json"));
		await symlink(join(link, "events.jsonl"), join(link, "summary.json"));
		await expect(verifySwarmEvidence(link)).rejects.toThrow("unsafe");
		const duplicate = await evidenceDirectory(1);
		const manifest = JSON.parse(await readFile(join(duplicate, "manifest.json"), "utf8"));
		manifest.artifacts[1] = manifest.artifacts[0];
		await writeFile(join(duplicate, "manifest.json"), `${canonicalJson(manifest)}\n`);
		await expect(verifySwarmEvidence(duplicate)).rejects.toThrow("invalid or duplicate");
		const reorder = await evidenceDirectory(1);
		const eventPath = join(reorder, "events.jsonl");
		const [a, b] = (await readFile(eventPath, "utf8")).trim().split("\n");
		await writeFile(eventPath, `${b}\n${a}\n`);
		await expect(verifySwarmEvidence(reorder)).rejects.toThrow("hash mismatch");
	});
	test("rejects a manifest whose valid hashes cover semantically invalid summary", async () => {
		const directory = await evidenceDirectory(1);
		const summaryPath = join(directory, "summary.json");
		const summary = JSON.parse(await readFile(summaryPath, "utf8"));
		summary.completed = 99;
		const summaryRaw = `${canonicalJson(summary)}\n`;
		await writeFile(summaryPath, summaryRaw);
		const manifestPath = join(directory, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const artifact = manifest.artifacts.find((item: { path: string }) => item.path === "summary.json");
		artifact.bytes = Buffer.byteLength(summaryRaw);
		const { createHash } = await import("node:crypto");
		artifact.sha256 = createHash("sha256").update(summaryRaw).digest("hex");
		await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
		await expect(verifySwarmEvidence(directory)).rejects.toThrow("summary/event mismatch");
	});
	test("rejects recomputed hashes that hide broken exact economics", async () => {
		const directory = await evidenceDirectory(1);
		const costsPath = join(directory, "cost-attribution.json");
		const costs = JSON.parse(await readFile(costsPath, "utf8"));
		costs.find((cost: { kind: string }) => cost.kind === "node").directCost = 7;
		const costsRaw = `${canonicalJson(costs)}
`;
		await writeFile(costsPath, costsRaw);
		const manifestPath = join(directory, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const artifact = manifest.artifacts.find((item: { path: string }) => item.path === "cost-attribution.json");
		const { createHash } = await import("node:crypto");
		artifact.bytes = Buffer.byteLength(costsRaw);
		artifact.sha256 = createHash("sha256").update(costsRaw).digest("hex");
		await writeFile(
			manifestPath,
			`${canonicalJson(manifest)}
`,
		);
		await expect(verifySwarmEvidence(directory)).rejects.toThrow("direct economics mismatch");
	});
});
