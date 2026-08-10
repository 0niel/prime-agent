import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("./run-production-rss-campaign.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function directory(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `b00b-rss-${label}-`));
	temporary.push(path);
	return path;
}

async function campaign(output: string, args: readonly string[]): Promise<void> {
	await execute(process.execPath, [tsx, launcher, "--output", output, ...args], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), timeout: 30_000 });
}

async function run(output: string, fanout: number, repetition: number): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(output, `run-${fanout}-${repetition}-1.json`), "utf8")) as Record<string, unknown>;
}

describe("B00B RSS campaign", () => {
	it("writes complete structured dry artifacts rather than zero-looking macOS data", async () => {
		const output = join(await directory("dry"), "output");
		await campaign(output, ["--fanout", "1", "--repetitions", "2"]);
		const first = await run(output, 1, 1);
		const second = await run(output, 1, 2);
		if (process.platform === "darwin") {
			expect(first.status).toBe("unsupported");
			expect(second.status).toBe("unsupported");
			expect(first.sampler).toBeNull();
			expect(first.finalRssKiB).toBeNull();
		}
		const mode = (await stat(join(output, "manifest.json"))).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it.skipIf(process.platform !== "linux")("reaps a SIGTERM-ignoring descendant after its group leader exits", async () => {
		const root = await directory("reap");
		const output = join(root, "output");
		const pidFile = join(root, "fixture.pid");
		const fixture = join(root, "ignore-term.cjs");
		await writeFile(fixture, "require('fs').writeFileSync(process.argv[2], String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);", { mode: 0o700 });
		await campaign(output, ["--fanout", "1", "--repetitions", "1", "--timeout-ms", "500", "--fixture-command", process.execPath, "--fixture-arg", fixture, "--fixture-arg", pidFile]);
		const pid = Number(await readFile(pidFile, "utf8"));
		const result = await run(output, 1, 1);
		expect(result.status).toBe("timed_out");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it.skipIf(process.platform !== "linux")("records a real 20 Hz fanout-64 cadence or marks the cell failed", async () => {
		const output = join(await directory("cadence"), "output");
		await campaign(output, ["--fanout", "64", "--repetitions", "1", "--interval-ms", "50"]);
		const result = await run(output, 64, 1);
		if (result.status === "complete") {
			const periodic = (result.samples as { phase: string; monotonicMs: number }[]).filter((sample) => sample.phase === "started");
			const gaps = periodic.slice(1).map((sample, index) => sample.monotonicMs - periodic[index].monotonicMs);
			expect(gaps.length).toBeGreaterThan(0);
			expect(Math.max(...gaps)).toBeLessThanOrEqual(50);
		} else {
			expect(result.reasonCode).toBe(4);
		}
	});

	it("never archives a fixture secret, command, or argument", async () => {
		const root = await directory("secret");
		const output = join(root, "output");
		const secret = "B00B_RSS_SECRET_4f85d5c7";
		const fixture = join(root, "secret-fixture.cjs");
		await writeFile(fixture, "setTimeout(()=>process.exit(0),10)");
		await campaign(output, ["--fanout", "1", "--repetitions", "1", "--fixture-command", process.execPath, "--fixture-arg", fixture, "--fixture-arg", secret]);
		const artifact = await Promise.all(["run-1-0-0.json", "run-1-1-1.json", "manifest.json"].map((name) => readFile(join(output, name), "utf8")));
		for (const content of artifact) {
			expect(content).not.toContain(secret);
			expect(content).not.toContain(fixture);
		}
	});
});
