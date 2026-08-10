/**
 * Fresh-process, test-only RSS campaign launcher for PR-B00B.
 *
 * It has no product import, provider credential, network client, or resident
 * daemon. Every measured cell owns a newly spawned Unix process group. A later
 * real-provider fixture can be supplied with --fixture-command; its command,
 * arguments, stdout, stderr, and environment are deliberately not archived.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_RSS_REQUESTED_PERIOD_MS,
	MAX_RSS_SAMPLE_GAP_MS,
	validateRssSampleCadence,
} from "./rss-campaign-cadence.js";
import { childExecArgsWithTsxImport } from "./rss-child-exec-args.js";
import { type ProcessRecord, type ProcessStat, parseProcessStat, processRecordFromStatus } from "./rss-proc.js";
import { RSS_SCAN_RETRY_DELAY_MS, RSS_SCAN_RETRY_WINDOW_MS, retryUnavailableSnapshot } from "./rss-snapshot-retry.js";

const FANOUTS = [1, 4, 16, 64] as const;
const WORKER = new URL("./rss-campaign-worker.ts", import.meta.url);
const WORKER_PATH = fileURLToPath(WORKER);
const DEFAULT_TIMEOUT_MS = 60_000;
const REAP_GRACE_MS = 250;
const REAP_VERIFY_MS = 1_000;
const SCHEMA_VERSION = 2;

type SupportedPlatform = "linux";
type Phase = "baseline" | "started" | "barrier-held" | "terminals" | "cleanup" | "final";
type Status = "complete" | "failed" | "timed_out" | "unsupported";

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
	sampler: {
		source: "proc-status";
		requestedPeriodMs: number;
		maxGapMs: number;
		maxObservedGapMs: number | null;
		sharedPages: "summed-per-process";
	} | null;
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
	requestedPeriodMs: number;
	timeoutMs: number;
	platformRequired?: string;
	fixtureCommand?: string;
	fixtureArgs: readonly string[];
	allocationMiB: number;
	// Test-only delay which makes the pre-release ownership window deterministic.
	identityCaptureDelayMs: number;
	testIgnoreTerm: boolean;
	// Test-only deterministic final-observation fault injection.
	testFailFinalScan: boolean;
	// Test-only one-shot final-observation fault injection for retry coverage.
	testFailFinalScanOnce: boolean;
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
	if (!values.length || values.some((value) => !FANOUTS.includes(value as (typeof FANOUTS)[number])))
		throw new Error("invalid_fanout");
	return [...new Set(values)];
}

function config(): Config {
	const maxGapMs = safeInteger("--interval-ms", MAX_RSS_SAMPLE_GAP_MS, MAX_RSS_SAMPLE_GAP_MS);
	if (maxGapMs !== MAX_RSS_SAMPLE_GAP_MS) throw new Error("interval_ms_must_be_50");
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
		requestedPeriodMs: DEFAULT_RSS_REQUESTED_PERIOD_MS + safeInteger("--test-scheduler-jitter-ms", 0, 0),
		timeoutMs: safeInteger("--timeout-ms", DEFAULT_TIMEOUT_MS, 1),
		platformRequired: option("--platform-required"),
		fixtureCommand: option("--fixture-command"),
		fixtureArgs,
		allocationMiB: safeInteger("--allocation-mib", 1, 1),
		identityCaptureDelayMs: safeInteger("--test-identity-capture-delay-ms", 0, 0),
		testIgnoreTerm: process.argv.includes("--test-ignore-term"),
		testFailFinalScan: process.argv.includes("--test-fail-final-scan"),
		testFailFinalScanOnce: process.argv.includes("--test-fail-final-scan-once"),
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

async function procIdentity(pid: number): Promise<ProcessStat | undefined> {
	try {
		return parseProcessStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return undefined;
	}
}

async function procRecordForIdentity(identity: ProcessStat): Promise<ProcessRecord | undefined> {
	try {
		const status = await readFile(`/proc/${identity.pid}/status`, "utf8");
		// State and PPID can change while status is read. A second stat read
		// anchors the status to the original PID/start-time/process-group identity.
		const confirmation = parseProcessStat(identity.pid, await readFile(`/proc/${identity.pid}/stat`, "utf8"));
		return confirmation ? processRecordFromStatus(identity, status, confirmation) : undefined;
	} catch {
		return undefined;
	}
}

async function procRecord(pid: number): Promise<ProcessRecord | undefined> {
	const identity = await procIdentity(pid);
	return identity ? procRecordForIdentity(identity) : undefined;
}

type GroupSnapshot =
	| { kind: "empty" }
	| { kind: "records"; records: readonly ProcessRecord[] }
	| { kind: "unavailable" };

function snapshotRecords(snapshot: GroupSnapshot): readonly ProcessRecord[] | undefined {
	if (snapshot.kind === "unavailable") return undefined;
	return snapshot.kind === "empty" ? [] : snapshot.records;
}

function exitedDuringScan(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ESRCH";
}

/**
 * Collect a complete group view. An empty records result is a positive claim:
 * every numeric /proc entry was read and no member of this PGID remained.
 * Any non-disappearance read or parse failure makes the entire scan unusable;
 * collapsing it to [] could authorize a signal or a false zero-RSS result.
 */
async function groupSnapshot(pgid: number, injectFailure = false): Promise<GroupSnapshot> {
	if (injectFailure) return { kind: "unavailable" };
	let entries: string[];
	try {
		entries = await readdir("/proc");
	} catch {
		return { kind: "unavailable" };
	}
	const identities: ProcessStat[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		try {
			const identity = parseProcessStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
			if (!identity) return { kind: "unavailable" };
			identities.push(identity);
		} catch (error) {
			// A process which vanished between readdir and stat cannot be a live,
			// unobserved group member. Every other unreadable numeric entry fails closed.
			if (!exitedDuringScan(error)) return { kind: "unavailable" };
		}
	}
	const records: ProcessRecord[] = [];
	for (const identity of identities) {
		if (identity.pgid !== pgid) continue;
		try {
			const status = await readFile(`/proc/${identity.pid}/status`, "utf8");
			// State and PPID are not stable identity. Re-read stat after status so
			// PID reuse or a process-group move makes the entire scan unavailable.
			const confirmation = parseProcessStat(identity.pid, await readFile(`/proc/${identity.pid}/stat`, "utf8"));
			const record = confirmation ? processRecordFromStatus(identity, status, confirmation) : undefined;
			// A coherently read status without any Vm* fields denotes a process
			// without an mm and is retained as a zero-RSS owned record.
			if (!record) return { kind: "unavailable" };
			records.push(record);
		} catch (error) {
			// Only a confirmed disappearance is safe to omit after membership was found.
			if (!exitedDuringScan(error)) return { kind: "unavailable" };
		}
	}
	const sorted = records.sort((left, right) => left.pid - right.pid);
	return sorted.length === 0 ? { kind: "empty" } : { kind: "records", records: sorted };
}

/**
 * A /proc scan is only accepted when it completes coherently. Short-lived
 * procfs read/parse races are retried, but a retry never turns an unavailable
 * scan into an empty one without a later positive complete scan.
 */
async function groupSnapshotWithRetries(
	pgid: number,
	shouldInjectFailure: (attempt: number) => boolean = () => false,
): Promise<GroupSnapshot> {
	// Fork/exec children can briefly have a stat record but no VmRSS. Retry
	// complete scans through this short convergence window, never individual
	// records: a successful return is always one coherent full-group view.
	return retryUnavailableSnapshot(
		(attempt) => groupSnapshot(pgid, shouldInjectFailure(attempt)),
		(snapshot) => snapshot.kind === "unavailable",
		{ now: monotonicMs, pause },
		RSS_SCAN_RETRY_WINDOW_MS,
		RSS_SCAN_RETRY_DELAY_MS,
	);
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

interface ReapResult {
	reaped: boolean;
	collectionFailed: boolean;
}

async function reapOwnGroup(ownership?: GroupOwnership): Promise<ReapResult> {
	if (!ownership) return { reaped: true, collectionFailed: false };
	let collectionFailed = false;
	const signalOwnedGroup = async (signal: NodeJS.Signals): Promise<boolean> => {
		const snapshot = await groupSnapshotWithRetries(ownership.pgid);
		const records = snapshotRecords(snapshot);
		if (!records) {
			collectionFailed = true;
			return false;
		}
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
	if (!(await signalOwnedGroup("SIGTERM"))) return { reaped: false, collectionFailed };
	await pause(REAP_GRACE_MS);
	let snapshot = await groupSnapshotWithRetries(ownership.pgid);
	let records = snapshotRecords(snapshot);
	if (!records) return { reaped: false, collectionFailed: true };
	if (records.length === 0) return { reaped: true, collectionFailed };
	if (!(await signalOwnedGroup("SIGKILL"))) return { reaped: false, collectionFailed };
	const deadline = monotonicMs() + REAP_VERIFY_MS;
	for (;;) {
		await pause(10);
		snapshot = await groupSnapshotWithRetries(ownership.pgid);
		records = snapshotRecords(snapshot);
		if (records?.length === 0) return { reaped: true, collectionFailed };
		if (records === undefined) collectionFailed = true;
		// After SIGKILL, a short /proc outage need not decide the result. Keep
		// checking through the existing verification deadline, but only a later
		// complete empty scan can establish a successful reap/final zero.
		if (monotonicMs() >= deadline) return { reaped: false, collectionFailed };
	}
}

function workerArguments(settings: Config, fanout: number, scratch: string): string[] {
	const args = [
		"--expose-gc",
		...childExecArgsWithTsxImport(process.execArgv),
		WORKER_PATH,
		"--fanout",
		String(fanout),
		"--allocation-mib",
		String(settings.allocationMiB),
		"--scratch",
		scratch,
	];
	if (settings.fixtureCommand) args.push("--fixture-command", settings.fixtureCommand);
	for (const fixtureArg of settings.fixtureArgs) args.push("--fixture-arg", fixtureArg);
	if (settings.testIgnoreTerm) args.push("--test-ignore-term");
	return args;
}

function unsupportedRun(fanout: number, repetition: number, warmup: boolean): Repetition {
	return {
		schemaVersion: SCHEMA_VERSION,
		kind: "b00b-rss-repetition",
		status: "unsupported",
		fanout,
		repetition,
		warmup,
		sampler: null,
		reasonCode: 3,
		baselineRssKiB: null,
		peakRssKiB: null,
		terminalRssKiB: null,
		finalRssKiB: null,
		allocatedBytes: 0,
		completed: 0,
		failed: fanout,
		timedOut: false,
		samples: [],
	};
}

async function runCell(
	settings: Config,
	fanout: number,
	repetition: number,
	warmup: boolean,
	scratch: string,
): Promise<Repetition> {
	const samples: ProcessSample[] = [sample("baseline", [])];
	let ownership: GroupOwnership | undefined;
	let child: ChildProcess | undefined;
	let stopped = false;
	let timedOut = false;
	let completed = 0;
	let failed = fanout;
	let allocatedBytes = 0;
	let collectorFailed = false;
	let queue = Promise.resolve();
	const pendingMemberPids = new Set<number>();
	const enqueue = (phase: Phase, memberPids: readonly number[] = []): Promise<void> => {
		for (const pid of memberPids) pendingMemberPids.add(pid);
		queue = queue.then(async () => {
			const currentOwnership = ownership;
			if (!currentOwnership) return;
			// The worker supplies its direct fixture PIDs at each boundary. Preserve
			// their PID/start/PGID identities before a timeout can make the leader exit.
			const announced = await Promise.all([...pendingMemberPids].map(procRecord));
			remember(
				currentOwnership,
				announced.filter((record): record is ProcessRecord => record?.pgid === currentOwnership.pgid),
			);
			const snapshot = await groupSnapshotWithRetries(currentOwnership.pgid);
			const records = snapshotRecords(snapshot);
			if (!records) {
				collectorFailed = true;
				return;
			}
			remember(currentOwnership, records);
			samples.push(sample(phase, records));
		});
		return queue;
	};
	const reapDirectChild = async (): Promise<void> => {
		// Before release the worker protocol has not allocated or spawned anything.
		// Never use a negative PGID without an authenticated /proc identity anchor.
		const direct = child;
		if (!direct || direct.exitCode !== null || direct.signalCode !== null) return;
		try {
			direct.kill("SIGKILL");
		} catch {
			return;
		}
		await new Promise<void>((resolve) => {
			if (direct.exitCode !== null || direct.signalCode !== null) resolve();
			else direct.once("exit", () => resolve());
		});
	};
	return new Promise<Repetition>((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let executionStarted = false;
		let settle: (requested: Status) => Promise<void>;
		const startExecution = (): void => {
			if (executionStarted || stopped) return;
			executionStarted = true;
			void enqueue("started");
			timer = setInterval(() => {
				if (!stopped) void enqueue("started");
			}, settings.requestedPeriodMs);
			timeout = setTimeout(() => {
				timedOut = true;
				void settle("timed_out");
			}, settings.timeoutMs);
		};
		settle = async (requested: Status): Promise<void> => {
			if (stopped) return;
			stopped = true;
			if (timer) clearInterval(timer);
			if (timeout) clearTimeout(timeout);
			await queue;
			const cadence = validateRssSampleCadence(
				samples.filter((entry) => entry.phase === "started").map((entry) => entry.monotonicMs),
			);
			const cadenceFailed = !cadence.valid;

			// A failed startup is deliberately not represented as an empty owned
			// group: no exact PID/start/PGID anchor was ever authenticated.
			if (!ownership) {
				await reapDirectChild();
				resolve({
					schemaVersion: SCHEMA_VERSION,
					kind: "b00b-rss-repetition",
					status: "failed",
					fanout,
					repetition,
					warmup,
					sampler: {
						source: "proc-status",
						requestedPeriodMs: settings.requestedPeriodMs,
						maxGapMs: MAX_RSS_SAMPLE_GAP_MS,
						maxObservedGapMs: cadence.maxObservedGapMs,
						sharedPages: "summed-per-process",
					},
					reasonCode: 2,
					baselineRssKiB: 0,
					peakRssKiB: null,
					terminalRssKiB: null,
					finalRssKiB: null,
					allocatedBytes: 0,
					completed: 0,
					failed: fanout,
					timedOut: false,
					samples,
				});
				return;
			}

			const reap = await reapOwnGroup(ownership);
			const finalSnapshot = await groupSnapshotWithRetries(
				ownership.pgid,
				(attempt) => settings.testFailFinalScan || (settings.testFailFinalScanOnce && attempt === 0),
			);
			const finalRecords = snapshotRecords(finalSnapshot);
			const finalCollectionFailed = finalRecords === undefined;
			if (finalRecords) samples.push(sample("final", finalRecords));
			const collectionFailure = collectorFailed || reap.collectionFailed || finalCollectionFailed;
			const emptyOwnedGroup = !collectionFailure && reap.reaped && finalRecords?.length === 0;
			const status =
				requested === "complete" && emptyOwnedGroup && !cadenceFailed
					? "complete"
					: requested === "timed_out" && emptyOwnedGroup && !cadenceFailed
						? "timed_out"
						: "failed";
			const byPhase = (phase: Phase) => samples.filter((entry) => entry.phase === phase).at(-1)?.totalRssKiB ?? null;
			const active = samples.filter((entry) => entry.phase !== "baseline" && entry.phase !== "final");
			resolve({
				schemaVersion: SCHEMA_VERSION,
				kind: "b00b-rss-repetition",
				status,
				fanout,
				repetition,
				warmup,
				sampler: {
					source: "proc-status",
					requestedPeriodMs: settings.requestedPeriodMs,
					maxGapMs: MAX_RSS_SAMPLE_GAP_MS,
					maxObservedGapMs: cadence.maxObservedGapMs,
					sharedPages: "summed-per-process",
				},
				reasonCode: status === "complete" ? null : collectionFailure ? 5 : timedOut ? 1 : cadenceFailed ? 4 : 2,
				baselineRssKiB: 0,
				peakRssKiB: active.length ? Math.max(...active.map((entry) => entry.totalRssKiB)) : null,
				terminalRssKiB: byPhase("terminals"),
				finalRssKiB: collectionFailure ? null : total(finalRecords ?? []),
				allocatedBytes,
				completed,
				failed,
				timedOut,
				samples,
			});
		};
		try {
			child = spawn(process.execPath, workerArguments(settings, fanout, scratch), {
				cwd: process.cwd(),
				detached: true,
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
		child.once("error", () => void settle("failed"));
		child.on("message", (message: WorkerMessage) => {
			if (message.type === "boundary") startExecution();
			if (message.type === "result") {
				completed = message.completed;
				failed = message.failed;
				allocatedBytes = Math.max(allocatedBytes, message.allocatedBytes);
				return;
			}
			allocatedBytes = Math.max(allocatedBytes, message.allocatedBytes);
			void enqueue(message.phase, message.memberPids);
		});
		child.once(
			"exit",
			(code, signal) => void settle(code === 0 && signal === null && completed === fanout ? "complete" : "failed"),
		);
		void (async () => {
			if (settings.identityCaptureDelayMs) await pause(settings.identityCaptureDelayMs);
			const leader = await procRecord(pid);
			if (!leader || leader.pgid !== pid || stopped) {
				void settle("failed");
				return;
			}
			ownership = { pgid: leader.pgid, leader, members: new Map([[leader.pid, leader]]) };
			// The worker remains gated until this release. Its first boundary proves
			// execution began, at which point startExecution arms the timeout.
			try {
				child?.send({ type: "release" }, (error) => {
					if (error && !stopped) void settle("failed");
				});
			} catch {
				void settle("failed");
			}
		})();
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
		peakMinKiB: percentile(peak, 0),
		peakMedianKiB: percentile(peak, 0.5),
		peakP95KiB: percentile(peak, 0.95),
		peakMaxKiB: percentile(peak, 1),
		finalMinKiB: percentile(final, 0),
		finalMedianKiB: percentile(final, 0.5),
		finalP95KiB: percentile(final, 0.95),
		finalMaxKiB: percentile(final, 1),
	};
}

async function gitSha(): Promise<string | null> {
	const git = spawn("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
	let value = "";
	git.stdout?.setEncoding("utf8");
	git.stdout?.on("data", (chunk: string) => {
		value += chunk;
	});
	const code = await new Promise<number | null>((resolve) => git.once("exit", resolve));
	const sha = value.trim();
	return code === 0 && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

async function hashTree(directory: string): Promise<readonly { name: string; sha256: string; bytes: number }[]> {
	const names = (await readdir(directory)).filter((name) => name !== "manifest.json").sort();
	return Promise.all(
		names.map(async (name) => {
			const path = join(directory, name);
			if (!(await stat(path)).isFile()) throw new Error("output_contains_non_file");
			const content = await readFile(path);
			return { name, sha256: sha256(content), bytes: content.byteLength };
		}),
	);
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
	const kind: SupportedPlatform | undefined =
		platformMatches && current === "linux" && (await collectorAvailable()) ? "linux" : undefined;
	await freshOutput(settings.output);
	const scratch = join(dirname(settings.output), `.b00b-rss-scratch-${process.pid}`);
	await mkdir(scratch, { recursive: true, mode: 0o700 });
	await chmod(scratch, 0o700);
	const runs: Repetition[] = [];
	for (const fanout of settings.fanouts) {
		if (!kind) {
			runs.push(unsupportedRun(fanout, 0, true));
			for (let repetition = 1; repetition <= settings.repetitions; repetition += 1)
				runs.push(unsupportedRun(fanout, repetition, false));
			continue;
		}
		runs.push(await runCell(settings, fanout, 0, true, scratch));
		for (let repetition = 1; repetition <= settings.repetitions; repetition += 1)
			runs.push(await runCell(settings, fanout, repetition, false, scratch));
	}
	await rm(scratch, { force: true, recursive: true });
	for (const run of runs)
		await writeOwnerFile(
			join(settings.output, `run-${run.fanout}-${run.repetition}-${run.warmup ? 0 : 1}.json`),
			`${canonical(run)}\n`,
		);
	const manifest = {
		schemaVersion: SCHEMA_VERSION,
		kind: "b00b-rss-campaign",
		platform: current,
		release: release(),
		node: process.version,
		cpuCount: cpus().length,
		memoryBytes: totalmem(),
		gitSha: await gitSha(),
		collector: kind === "linux" ? "proc-status" : "unsupported",
		requestedPeriodMs: settings.requestedPeriodMs,
		maxGapMs: MAX_RSS_SAMPLE_GAP_MS,
		timeoutMs: settings.timeoutMs,
		fanouts: settings.fanouts,
		repetitions: settings.repetitions,
		warmups: 1,
		allocationMiB: settings.allocationMiB,
		externalFixture: settings.fixtureCommand !== undefined,
		summaries: settings.fanouts.map((fanout) => ({
			fanout,
			...summary(runs.filter((run) => run.fanout === fanout && !run.warmup)),
		})),
		files: await hashTree(settings.output),
	};
	await writeOwnerFile(join(settings.output, "manifest.json"), `${canonical(manifest)}\n`);
	console.log(`b00b-rss: ${runs.filter((run) => run.status === "complete" && !run.warmup).length} completed cells`);
}

await main();
