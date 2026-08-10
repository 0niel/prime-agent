/**
 * Fresh-process, test-only RSS campaign launcher for PR-B00B.
 *
 * It has no product import, provider credential, network client, or resident
 * daemon. Every measured cell owns a newly spawned Unix process group. A later
 * real-provider fixture can be supplied with --fixture-command; its command,
 * arguments, stdout, stderr, and environment are deliberately not archived.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const FANOUTS = [1, 4, 16, 64] as const;
const WORKER = new URL("./rss-campaign-worker.ts", import.meta.url);
const MIN_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 60_000;
const SCHEMA_VERSION = 1;

type SupportedPlatform = "linux" | "darwin";
type Phase = "baseline" | "started" | "barrier-held" | "terminals" | "cleanup" | "final";
type Status = "complete" | "failed" | "timed_out" | "unsupported";

interface ProcessRecord {
	pid: number;
	ppid: number;
	start: number;
	rssKiB: number;
}

interface ProcessSample {
	phase: Phase;
	monotonicMs: number;
	totalRssKiB: number;
	processes: readonly ProcessRecord[];
}

interface BoundaryMessage {
	type: "boundary";
	phase: Exclude<Phase, "baseline" | "final">;
	allocatedBytes: number;
}

interface ResultMessage {
	type: "result";
	completed: number;
	failed: number;
	allocatedBytes: number;
}

type WorkerMessage = BoundaryMessage | ResultMessage;

interface Repetition {
	schemaVersion: number;
	kind: "b00b-rss-repetition";
	status: Status;
	fanout: number;
	repetition: number;
	warmup: boolean;
	sampler: { source: "proc-status" | "ps"; intervalMs: number; sharedPages: "summed-per-process" } | null;
	reasonCode: number | null;
	baselineRssKiB: number | null;
	peakRssKiB: number | null;
	terminalRssKiB: number | null;
	finalRssKiB: number | null;
	allocatedBytes: number;
	completed: number;
	failed: number;
	timedOut: boolean;
	samples: readonly ProcessSample[];
}

interface Config {
	fanouts: readonly number[];
	repetitions: number;
	output: string;
	intervalMs: number;
	timeoutMs: number;
	platformRequired?: string;
	fixtureCommand?: string;
	fixtureArgs: readonly string[];
	allocationMiB: number;
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function safeInteger(name: string, fallback: number, minimum: number): number {
	const parsed = Number(option(name) ?? fallback);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid_${name.slice(2)}`);
	return parsed;
}

function parseFanouts(value: string | undefined): readonly number[] {
	if (!value) return FANOUTS;
	const values = value.split(",").map(Number);
	if (!values.length || values.some((value) => !FANOUTS.includes(value as (typeof FANOUTS)[number]))) {
		throw new Error("invalid_fanout");
	}
	return [...new Set(values)];
}

function config(): Config {
	const intervalMs = safeInteger("--interval-ms", MIN_INTERVAL_MS, MIN_INTERVAL_MS);
	const fixtureArgs: string[] = [];
	for (let index = 0; index < process.argv.length; index += 1) {
		if (process.argv[index] === "--fixture-arg") {
			const argument = process.argv[index + 1];
			if (argument === undefined) throw new Error("invalid_fixture_arg");
			fixtureArgs.push(argument);
			index += 1;
		}
	}
	return {
		fanouts: parseFanouts(option("--fanout")),
		repetitions: safeInteger("--repetitions", 3, 1),
		output: option("--output") ?? "b00b-rss-artifacts",
		intervalMs,
		timeoutMs: safeInteger("--timeout-ms", DEFAULT_TIMEOUT_MS, 1),
		platformRequired: option("--platform-required"),
		fixtureCommand: option("--fixture-command"),
		fixtureArgs,
		allocationMiB: safeInteger("--allocation-mib", 1, 1),
	};
}

function monotonicMs(): number {
	return Number(process.hrtime.bigint() / 1_000_000n);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
		.join(",")}}`;
}

async function writeOwnerFile(path: string, content: string): Promise<void> {
	await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
	await chmod(path, 0o600);
}

async function procStartAndRss(pid: number): Promise<ProcessRecord | undefined> {
	try {
		const [statLine, status] = await Promise.all([
			readFile(`/proc/${pid}/stat`, "utf8"),
			readFile(`/proc/${pid}/status`, "utf8"),
		]);
		const close = statLine.lastIndexOf(")");
		const fields = statLine.slice(close + 2).trim().split(/\s+/);
		const ppid = Number(fields[1]); // field 4 after removing pid/comm
		const start = Number(fields[19]); // field 22 after removing pid/comm
		const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
		if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(start) || rss === undefined) return undefined;
		return { pid, ppid, start, rssKiB: Number(rss) };
	} catch {
		return undefined;
	}
}

async function linuxSnapshot(rootPid: number): Promise<readonly ProcessRecord[]> {
	let entries: string[];
	try {
		entries = await readdir("/proc");
	} catch {
		return [];
	}
	const records = (await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => procStartAndRss(Number(entry))))).filter(
		(record): record is ProcessRecord => record !== undefined,
	);
	const descendants = new Set<number>([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const record of records) {
			if (descendants.has(record.ppid) && !descendants.has(record.pid)) {
				descendants.add(record.pid);
				changed = true;
			}
		}
	}
	return records.filter((record) => descendants.has(record.pid)).sort((left, right) => left.pid - right.pid);
}

async function macSnapshot(rootPid: number): Promise<readonly ProcessRecord[]> {
	const ps = spawn("ps", ["-axo", "pid=,ppid=,rss=,lstart="], { stdio: ["ignore", "pipe", "ignore"] });
	let text = "";
	ps.stdout?.setEncoding("utf8");
	ps.stdout?.on("data", (chunk: string) => {
		text += chunk;
	});
	const exited = await new Promise<boolean>((resolve) => {
		ps.once("error", () => resolve(false));
		ps.once("exit", (code) => resolve(code === 0));
	});
	if (!exited) return [];
	const records: ProcessRecord[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const start = Date.parse(match[4]);
		if (Number.isNaN(start)) continue;
		records.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), start });
	}
	const descendants = new Set<number>([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const record of records) {
			if (descendants.has(record.ppid) && !descendants.has(record.pid)) {
				descendants.add(record.pid);
				changed = true;
			}
		}
	}
	return records.filter((record) => descendants.has(record.pid)).sort((left, right) => left.pid - right.pid);
}

async function snapshot(kind: SupportedPlatform, rootPid: number): Promise<readonly ProcessRecord[]> {
	return kind === "linux" ? linuxSnapshot(rootPid) : macSnapshot(rootPid);
}

async function collectorAvailable(kind: SupportedPlatform): Promise<boolean> {
	const own = (await snapshot(kind, process.pid)).find((record) => record.pid === process.pid);
	return own !== undefined && own.rssKiB >= 0 && Number.isSafeInteger(own.start);
}

function total(records: readonly ProcessRecord[]): number {
	return records.reduce((sum, record) => sum + record.rssKiB, 0);
}

function sample(phase: Phase, records: readonly ProcessRecord[]): ProcessSample {
	return { phase, monotonicMs: monotonicMs(), totalRssKiB: total(records), processes: records };
}

async function identityMatches(kind: SupportedPlatform, record: ProcessRecord): Promise<boolean> {
	const current = (await snapshot(kind, record.pid)).find((candidate) => candidate.pid === record.pid);
	return current?.start === record.start;
}

async function reapOwnGroup(kind: SupportedPlatform, leader?: ProcessRecord): Promise<void> {
	if (!leader || !(await identityMatches(kind, leader))) return;
	try {
		process.kill(-leader.pid, "SIGTERM");
	} catch {
		return;
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
	if (await identityMatches(kind, leader)) {
		try {
			process.kill(-leader.pid, "SIGKILL");
		} catch {
			// The group may have cleanly exited between the identity check and kill.
		}
	}
}

function workerArguments(config: Config, fanout: number, scratch: string): string[] {
	const args = ["--expose-gc", ...process.execArgv, WORKER.pathname, "--fanout", String(fanout), "--allocation-mib", String(config.allocationMiB), "--scratch", scratch];
	if (config.fixtureCommand) args.push("--fixture-command", config.fixtureCommand);
	for (const fixtureArg of config.fixtureArgs) args.push("--fixture-arg", fixtureArg);
	return args;
}

async function runCell(config: Config, kind: SupportedPlatform, fanout: number, repetition: number, warmup: boolean, scratch: string): Promise<Repetition> {
	const samples: ProcessSample[] = [sample("baseline", [])];
	let leader: ProcessRecord | undefined;
	let child: ChildProcess | undefined;
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	let completed = 0;
	let failed = fanout;
	let allocatedBytes = 0;
	let resolved = false;
	const finish = async (status: Status): Promise<Repetition> => {
		if (timer) clearInterval(timer);
		await reapOwnGroup(kind, leader);
		const final = sample("final", leader ? await snapshot(kind, leader.pid) : []);
		samples.push(final);
		const byPhase = (phase: Phase) => samples.filter((entry) => entry.phase === phase).at(-1)?.totalRssKiB ?? null;
		const active = samples.filter((entry) => entry.phase !== "baseline" && entry.phase !== "final");
		return {
			schemaVersion: SCHEMA_VERSION,
			kind: "b00b-rss-repetition",
			status,
			fanout,
			repetition,
			warmup,
			sampler: { source: kind === "linux" ? "proc-status" : "ps", intervalMs: config.intervalMs, sharedPages: "summed-per-process" },
			reasonCode: status === "complete" ? null : status === "timed_out" ? 1 : 2,
			baselineRssKiB: 0,
			peakRssKiB: active.length ? Math.max(...active.map((entry) => entry.totalRssKiB)) : null,
			terminalRssKiB: byPhase("terminals"),
			finalRssKiB: final.totalRssKiB,
			allocatedBytes,
			completed,
			failed,
			timedOut,
			samples,
		};
	};
	return new Promise<Repetition>((resolve) => {
		const settle = async (status: Status) => {
			if (resolved) return;
			resolved = true;
			resolve(await finish(status));
		};
		try {
			child = spawn(process.execPath, workerArguments(config, fanout, scratch), {
				cwd: process.cwd(),
				detached: process.platform !== "win32",
				env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: "C", LC_ALL: "C" },
				serialization: "json",
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
		} catch {
			void settle("failed");
			return;
		}
		const pid = child.pid;
		if (!pid) {
			void settle("failed");
			return;
		}
		void snapshot(kind, pid).then((records) => {
			leader = records.find((record) => record.pid === pid);
			samples.push(sample("started", records));
		});
		timer = setInterval(() => {
			if (!leader || resolved) return;
			void snapshot(kind, leader.pid).then((records) => samples.push(sample("started", records)));
		}, config.intervalMs);
		const timeout = setTimeout(() => {
			timedOut = true;
			void settle("timed_out");
		}, config.timeoutMs);
		child.once("error", () => {
			clearTimeout(timeout);
			void settle("failed");
		});
		child.on("message", (message: WorkerMessage) => {
			if (message.type === "result") {
				completed = message.completed;
				failed = message.failed;
				allocatedBytes = Math.max(allocatedBytes, message.allocatedBytes);
				return;
			}
			allocatedBytes = Math.max(allocatedBytes, message.allocatedBytes);
			if (leader) void snapshot(kind, leader.pid).then((records) => samples.push(sample(message.phase, records)));
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			void settle(code === 0 && signal === null && completed === fanout ? "complete" : "failed");
		});
	});
}

function percentile(values: readonly number[], proportion: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(proportion * sorted.length) - 1))];
}

function summary(repetitions: readonly Repetition[]): Record<string, number | null> {
	const complete = repetitions.filter((entry) => entry.status === "complete");
	const peak = complete.map((entry) => (entry.peakRssKiB ?? 0) - (entry.baselineRssKiB ?? 0));
	const final = complete.map((entry) => (entry.finalRssKiB ?? 0) - (entry.baselineRssKiB ?? 0));
	return {
		count: complete.length,
		peakMinKiB: percentile(peak, 0), peakMedianKiB: percentile(peak, 0.5), peakP95KiB: percentile(peak, 0.95), peakMaxKiB: percentile(peak, 1),
		finalMinKiB: percentile(final, 0), finalMedianKiB: percentile(final, 0.5), finalP95KiB: percentile(final, 0.95), finalMaxKiB: percentile(final, 1),
	};
}

async function gitSha(): Promise<string | null> {
	const git = spawn("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
	let value = "";
	git.stdout?.setEncoding("utf8"); git.stdout?.on("data", (chunk: string) => { value += chunk; });
	const code = await new Promise<number | null>((resolve) => git.once("exit", resolve));
	const sha = value.trim();
	return code === 0 && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

async function hashTree(directory: string): Promise<readonly { name: string; sha256: string; bytes: number }[]> {
	const names = (await readdir(directory)).filter((name) => name !== "manifest.json").sort();
	return Promise.all(names.map(async (name) => {
		const content = await readFile(join(directory, name));
		return { name, sha256: sha256(content), bytes: content.byteLength };
	}));
}

async function main(): Promise<void> {
	const settings = config();
	const current = platform();
	if (settings.platformRequired && settings.platformRequired !== current) throw new Error("platform_required_mismatch");
	const platformKind: SupportedPlatform | undefined = current === "linux" || current === "darwin" ? current : undefined;
	// Do not produce a plausible-looking zero-RSS cell if the native counter is
	// absent or inaccessible. The capability is checked before any campaign work.
	const kind = platformKind && (await collectorAvailable(platformKind)) ? platformKind : undefined;
	await mkdir(settings.output, { recursive: true, mode: 0o700 });
	await chmod(settings.output, 0o700);
	const scratch = join(dirname(settings.output), ".b00b-rss-scratch");
	await mkdir(scratch, { recursive: true, mode: 0o700 });
	await chmod(scratch, 0o700);
	const runs: Repetition[] = [];
	if (!kind) {
		for (const fanout of settings.fanouts) runs.push({ schemaVersion: SCHEMA_VERSION, kind: "b00b-rss-repetition", status: "unsupported", fanout, repetition: 0, warmup: true, sampler: null, reasonCode: 3, baselineRssKiB: null, peakRssKiB: null, terminalRssKiB: null, finalRssKiB: null, allocatedBytes: 0, completed: 0, failed: fanout, timedOut: false, samples: [] });
	} else {
		for (const fanout of settings.fanouts) {
			runs.push(await runCell(settings, kind, fanout, 0, true, scratch));
			for (let repetition = 1; repetition <= settings.repetitions; repetition += 1) runs.push(await runCell(settings, kind, fanout, repetition, false, scratch));
		}
	}
	await rm(scratch, { force: true, recursive: true });
	for (const run of runs) await writeOwnerFile(join(settings.output, `run-${run.fanout}-${run.repetition}-${run.warmup ? 0 : 1}.json`), `${canonical(run)}\n`);
	const manifest = {
		schemaVersion: SCHEMA_VERSION, kind: "b00b-rss-campaign", platform: current, release: release(), node: process.version, cpuCount: cpus().length, memoryBytes: totalmem(), gitSha: await gitSha(),
		collector: kind === "linux" ? "proc-status" : kind === "darwin" ? "ps" : "unsupported", intervalMs: settings.intervalMs, timeoutMs: settings.timeoutMs,
		fanouts: settings.fanouts, repetitions: settings.repetitions, warmups: 1, allocationMiB: settings.allocationMiB,
		// Command/env/provider payloads intentionally are absent. This bit only states whether an external fixture was used.
		externalFixture: settings.fixtureCommand !== undefined,
		summaries: settings.fanouts.map((fanout) => ({ fanout, ...summary(runs.filter((run) => run.fanout === fanout && !run.warmup)) })),
		files: await hashTree(settings.output),
	};
	await writeOwnerFile(join(settings.output, "manifest.json"), `${canonical(manifest)}\n`);
	console.log(`b00b-rss: ${runs.filter((run) => run.status === "complete" && !run.warmup).length} completed cells`);
}

await main();
