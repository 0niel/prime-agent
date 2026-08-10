/**
 * Fresh-process, test-only RSS campaign launcher for PR-B00B.
 *
 * It has no product import, provider credential, network client, or resident
 * daemon. Every measured cell owns a newly spawned Unix process group. A later
 * real-provider fixture can be supplied with --fixture-command; its command,
 * arguments, stdout, stderr, and environment are deliberately not archived.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";

const FANOUTS = [1, 4, 16, 64] as const;
const WORKER = new URL("./rss-campaign-worker.ts", import.meta.url);
const MIN_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 60_000;
const REAP_GRACE_MS = 250;
const REAP_VERIFY_MS = 1_000;
const SCHEMA_VERSION = 1;

type SupportedPlatform = "linux";
type Phase = "baseline" | "started" | "barrier-held" | "terminals" | "cleanup" | "final";
type Status = "complete" | "failed" | "timed_out" | "unsupported";

interface ProcessRecord {
	pid: number;
	ppid: number;
	pgid: number;
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
	memberPids: readonly number[];
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
	sampler: { source: "proc-status"; intervalMs: number; sharedPages: "summed-per-process" } | null;
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

interface GroupOwnership {
	pgid: number;
	leader: ProcessRecord;
	members: Map<number, ProcessRecord>;
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
	if (!values.length || values.some((value) => !FANOUTS.includes(value as (typeof FANOUTS)[number]))) throw new Error("invalid_fanout");
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
	return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

async function writeOwnerFile(path: string, content: string): Promise<void> {
	await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
	await chmod(path, 0o600);
}

async function procRecord(pid: number): Promise<ProcessRecord | undefined> {
	try {
		const [statLine, status] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8")]);
		const close = statLine.lastIndexOf(")");
		const fields = statLine.slice(close + 2).trim().split(/\s+/);
		const ppid = Number(fields[1]); // field 4 after removing pid/comm
		const pgid = Number(fields[2]); // field 5 after removing pid/comm
		const start = Number(fields[19]); // field 22 after removing pid/comm
		const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
		if (![ppid, pgid, start].every(Number.isSafeInteger) || rss === undefined) return undefined;
		return { pid, ppid, pgid, start, rssKiB: Number(rss) };
	} catch {
		return undefined;
	}
}

async function groupSnapshot(pgid: number): Promise<readonly ProcessRecord[]> {
	let entries: string[];
	try {
		entries = await readdir("/proc");
	} catch {
		return [];
	}
	const records = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => procRecord(Number(entry))));
	return records.filter((record): record is ProcessRecord => record?.pgid === pgid).sort((left, right) => left.pid - right.pid);
}

async function collectorAvailable(): Promise<boolean> {
	const own = await procRecord(process.pid);
	return own !== undefined && own.rssKiB >= 0 && Number.isSafeInteger(own.start) && Number.isSafeInteger(own.pgid);
}

function total(records: readonly ProcessRecord[]): number {
	return records.reduce((sum, record) => sum + record.rssKiB, 0);
}

function sample(phase: Phase, records: readonly ProcessRecord[]): ProcessSample {
	// This timestamp is taken only after the native collection finished.
	return { phase, monotonicMs: monotonicMs(), totalRssKiB: total(records), processes: records };
}

function sameIdentity(left: ProcessRecord, right: ProcessRecord): boolean {
	return left.pid === right.pid && left.start === right.start && left.pgid === right.pgid;
}

function remember(ownership: GroupOwnership, records: readonly ProcessRecord[]): void {
	for (const record of records) ownership.members.set(record.pid, record);
}

function hasOwnedAnchor(ownership: GroupOwnership, records: readonly ProcessRecord[]): boolean {
	return records.some((record) => {
		const known = ownership.members.get(record.pid);
		return known !== undefined && sameIdentity(known, record);
	});
}

function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reapOwnGroup(ownership?: GroupOwnership): Promise<boolean> {
	if (!ownership) return true;
	const signalOwnedGroup = async (signal: NodeJS.Signals): Promise<boolean> => {
		const records = await groupSnapshot(ownership.pgid);
		// A negative PID can affect a reused PGID. Signal only when a process whose
		// PID, start tick, and PGID we captured is still anchoring this exact group.
		if (!hasOwnedAnchor(ownership, records)) return records.length === 0;
		remember(ownership, records);
		try {
			process.kill(-ownership.pgid, signal);
			return true;
		} catch {
			return false;
		}
	};
	if (!(await signalOwnedGroup("SIGTERM"))) return false;
	await pause(REAP_GRACE_MS);
	let records = await groupSnapshot(ownership.pgid);
	if (records.length === 0) return true;
	if (!(await signalOwnedGroup("SIGKILL"))) return false;
	const deadline = monotonicMs() + REAP_VERIFY_MS;
	do {
		await pause(10);
		records = await groupSnapshot(ownership.pgid);
	} while (records.length > 0 && monotonicMs() < deadline);
	return records.length === 0;
}

function workerArguments(settings: Config, fanout: number, scratch: string): string[] {
	const args = ["--expose-gc", ...process.execArgv, WORKER.pathname, "--fanout", String(fanout), "--allocation-mib", String(settings.allocationMiB), "--scratch", scratch];
	if (settings.fixtureCommand) args.push("--fixture-command", settings.fixtureCommand);
	for (const fixtureArg of settings.fixtureArgs) args.push("--fixture-arg", fixtureArg);
	return args;
}

function unsupportedRun(fanout: number, repetition: number, warmup: boolean): Repetition {
	return { schemaVersion: SCHEMA_VERSION, kind: "b00b-rss-repetition", status: "unsupported", fanout, repetition, warmup, sampler: null, reasonCode: 3, baselineRssKiB: null, peakRssKiB: null, terminalRssKiB: null, finalRssKiB: null, allocatedBytes: 0, completed: 0, failed: fanout, timedOut: false, samples: [] };
}

async function runCell(settings: Config, fanout: number, repetition: number, warmup: boolean, scratch: string): Promise<Repetition> {
	const samples: ProcessSample[] = [sample("baseline", [])];
	let ownership: GroupOwnership | undefined;
	let child: ChildProcess | undefined;
	let stopped = false;
	let timedOut = false;
	let completed = 0;
	let failed = fanout;
	let allocatedBytes = 0;
	let cadenceFailed = false;
	let queue = Promise.resolve();
	let lastPeriodicSample: number | undefined;
	let periodicSamples = 0;
	const pendingMemberPids = new Set<number>();
	const enqueue = (phase: Phase, memberPids: readonly number[] = []): Promise<void> => {
		for (const pid of memberPids) pendingMemberPids.add(pid);
		queue = queue.then(async () => {
			if (!ownership) return;
			// The worker supplies its direct fixture PIDs at each boundary. Preserve
			// their PID/start/PGID identities before a timeout can make the leader exit.
			const announced = await Promise.all([...pendingMemberPids].map(procRecord));
			remember(ownership, announced.filter((record): record is ProcessRecord => record?.pgid === ownership.pgid));
			const records = await groupSnapshot(ownership.pgid);
			remember(ownership, records);
			const entry = sample(phase, records);
			if (phase === "started") {
				if (lastPeriodicSample !== undefined && entry.monotonicMs - lastPeriodicSample > settings.intervalMs) cadenceFailed = true;
				lastPeriodicSample = entry.monotonicMs;
				periodicSamples += 1;
			}
			samples.push(entry);
		});
		return queue;
	};
	return new Promise<Repetition>((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		let timeout: NodeJS.Timeout | undefined;
		const settle = async (requested: Status): Promise<void> => {
			if (stopped) return;
			stopped = true;
			if (timer) clearInterval(timer);
			if (timeout) clearTimeout(timeout);
			await queue;
			if (requested === "complete" && periodicSamples < 2) cadenceFailed = true;
			const reaped = await reapOwnGroup(ownership);
			const finalRecords = ownership ? await groupSnapshot(ownership.pgid) : [];
			samples.push(sample("final", finalRecords));
			const status = requested === "complete" && (!reaped || cadenceFailed) ? "failed" : requested;
			const byPhase = (phase: Phase) => samples.filter((entry) => entry.phase === phase).at(-1)?.totalRssKiB ?? null;
			const active = samples.filter((entry) => entry.phase !== "baseline" && entry.phase !== "final");
			resolve({
				schemaVersion: SCHEMA_VERSION, kind: "b00b-rss-repetition", status, fanout, repetition, warmup,
				sampler: { source: "proc-status", intervalMs: settings.intervalMs, sharedPages: "summed-per-process" },
				reasonCode: status === "complete" ? null : timedOut ? 1 : cadenceFailed ? 4 : 2,
				baselineRssKiB: 0, peakRssKiB: active.length ? Math.max(...active.map((entry) => entry.totalRssKiB)) : null,
				terminalRssKiB: byPhase("terminals"), finalRssKiB: total(finalRecords), allocatedBytes, completed, failed, timedOut, samples,
			});
		};
		try {
			child = spawn(process.execPath, workerArguments(settings, fanout, scratch), {
				cwd: process.cwd(), detached: true,
				env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: "C", LC_ALL: "C" },
				serialization: "json", stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
		} catch {
			void settle("failed");
			return;
		}
		const pid = child.pid;
		if (!pid) { void settle("failed"); return; }
		void procRecord(pid).then((leader) => {
			if (!leader || leader.pgid !== pid || stopped) { void settle("failed"); return; }
			ownership = { pgid: leader.pgid, leader, members: new Map([[leader.pid, leader]]) };
			void enqueue("started");
			timer = setInterval(() => { if (!stopped) void enqueue("started"); }, settings.intervalMs);
		});
		timeout = setTimeout(() => { timedOut = true; void settle("timed_out"); }, settings.timeoutMs);
		child.once("error", () => void settle("failed"));
		child.on("message", (message: WorkerMessage) => {
			if (message.type === "result") { completed = message.completed; failed = message.failed; allocatedBytes = Math.max(allocatedBytes, message.allocatedBytes); return; }
			allocatedBytes = Math.max(allocatedBytes, message.allocatedBytes);
			void enqueue(message.phase, message.memberPids);
		});
		child.once("exit", (code, signal) => void settle(code === 0 && signal === null && completed === fanout ? "complete" : "failed"));
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
	return { count: complete.length, peakMinKiB: percentile(peak, 0), peakMedianKiB: percentile(peak, 0.5), peakP95KiB: percentile(peak, 0.95), peakMaxKiB: percentile(peak, 1), finalMinKiB: percentile(final, 0), finalMedianKiB: percentile(final, 0.5), finalP95KiB: percentile(final, 0.95), finalMaxKiB: percentile(final, 1) };
}

async function gitSha(): Promise<string | null> {
	const git = spawn("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
	let value = "";
	git.stdout?.setEncoding("utf8");
	git.stdout?.on("data", (chunk: string) => { value += chunk; });
	const code = await new Promise<number | null>((resolve) => git.once("exit", resolve));
	const sha = value.trim();
	return code === 0 && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

async function hashTree(directory: string): Promise<readonly { name: string; sha256: string; bytes: number }[]> {
	const names = (await readdir(directory)).filter((name) => name !== "manifest.json").sort();
	return Promise.all(names.map(async (name) => {
		const path = join(directory, name);
		if (!(await stat(path)).isFile()) throw new Error("output_contains_non_file");
		const content = await readFile(path);
		return { name, sha256: sha256(content), bytes: content.byteLength };
	}));
}

async function freshOutput(directory: string): Promise<void> {
	try {
		const info = await stat(directory);
		if (!info.isDirectory() || (await readdir(directory)).length > 0) throw new Error("output_must_be_new_or_empty");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(directory, { mode: 0o700 });
	}
	await chmod(directory, 0o700);
}

async function main(): Promise<void> {
	const settings = config();
	const current = platform();
	const platformMatches = !settings.platformRequired || settings.platformRequired === current;
	// Darwin ps lstart is wall-clock, whole-second data. It cannot establish the
	// PID/start identity needed before destructive negative-PID signals, so macOS
	// is explicitly unsupported rather than pretending its lstart values are safe.
	const kind: SupportedPlatform | undefined = platformMatches && current === "linux" && (await collectorAvailable()) ? "linux" : undefined;
	await freshOutput(settings.output);
	const scratch = join(dirname(settings.output), `.b00b-rss-scratch-${process.pid}`);
	await mkdir(scratch, { recursive: true, mode: 0o700 });
	await chmod(scratch, 0o700);
	const runs: Repetition[] = [];
	for (const fanout of settings.fanouts) {
		if (!kind) {
			runs.push(unsupportedRun(fanout, 0, true));
			for (let repetition = 1; repetition <= settings.repetitions; repetition += 1) runs.push(unsupportedRun(fanout, repetition, false));
			continue;
		}
		runs.push(await runCell(settings, fanout, 0, true, scratch));
		for (let repetition = 1; repetition <= settings.repetitions; repetition += 1) runs.push(await runCell(settings, fanout, repetition, false, scratch));
	}
	await rm(scratch, { force: true, recursive: true });
	for (const run of runs) await writeOwnerFile(join(settings.output, `run-${run.fanout}-${run.repetition}-${run.warmup ? 0 : 1}.json`), `${canonical(run)}\n`);
	const manifest = {
		schemaVersion: SCHEMA_VERSION, kind: "b00b-rss-campaign", platform: current, release: release(), node: process.version, cpuCount: cpus().length, memoryBytes: totalmem(), gitSha: await gitSha(),
		collector: kind === "linux" ? "proc-status" : "unsupported", intervalMs: settings.intervalMs, timeoutMs: settings.timeoutMs,
		fanouts: settings.fanouts, repetitions: settings.repetitions, warmups: 1, allocationMiB: settings.allocationMiB,
		externalFixture: settings.fixtureCommand !== undefined,
		summaries: settings.fanouts.map((fanout) => ({ fanout, ...summary(runs.filter((run) => run.fanout === fanout && !run.warmup)) })),
		files: await hashTree(settings.output),
	};
	await writeOwnerFile(join(settings.output, "manifest.json"), `${canonical(manifest)}\n`);
	console.log(`b00b-rss: ${runs.filter((run) => run.status === "complete" && !run.warmup).length} completed cells`);
}

await main();
