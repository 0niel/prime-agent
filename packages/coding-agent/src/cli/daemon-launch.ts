/**
 * Interactive-daemon launch/readiness helpers.
 *
 * This module is deliberately light on imports: cli.ts calls
 * maybeStartInteractiveDaemonEarly() BEFORE the heavy main module graph loads,
 * so a cold daemon boots concurrently with this process's own imports instead
 * of serially after them. main.ts reuses the same memoized promise.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { appendRotatingLog, expandTildePath, getClientErrorLogPath, VERSION } from "../config.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION } from "../modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";

export function isDaemonSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const summary = value as { activeSessionId?: unknown; id?: unknown };
	return typeof summary.activeSessionId === "string" || typeof summary.id === "string";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Daemon replacement used to be silent (no crash, no log), so a daemon dying
// out from under another window looked "random". Trace the decisions to the
// client-errors log so replacements are attributable after the fact.
function logDaemonLaunch(message: string): void {
	appendRotatingLog(getClientErrorLogPath(), `[${new Date().toISOString()}] daemon-launch: ${message}`);
}

async function canConnectToDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

type DaemonVersionProbe = "absent" | "current" | "stale";

/** Connect to a running daemon and check whether it matches this client's protocol and app version. */
async function probeDaemonVersion(socketPath: string): Promise<DaemonVersionProbe> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(250);
	} catch {
		client.close();
		return "absent";
	}
	try {
		const hello = await client.waitForHello(2000);
		const current = hello.protocol.version === DAEMON_PROTOCOL_VERSION && hello.appVersion === VERSION;
		if (!current) {
			logDaemonLaunch(
				`running daemon on ${socketPath} is stale: daemon v${hello.appVersion}/proto${hello.protocol.version} ` +
					`vs client v${VERSION}/proto${DAEMON_PROTOCOL_VERSION}`,
			);
		}
		return current ? "current" : "stale";
	} catch {
		// Connected but no recognizable greeting: assume a stale daemon.
		logDaemonLaunch(`running daemon on ${socketPath} sent no recognizable hello; treating as stale`);
		return "stale";
	} finally {
		client.close();
	}
}

export async function listActiveDaemonSessionSummaries(client: DaemonClient): Promise<SessionSummary[]> {
	const hello = await client.waitForHello(2000).catch(() => undefined);
	const response =
		hello && hello.protocol.version < DAEMON_PROTOCOL_VERSION
			? await client.requestLegacy({ type: "list" })
			: await client.request({ type: "list" });
	if (!response.success) {
		throw new Error(response.error);
	}
	const data = response.data;
	if (!data || typeof data !== "object" || !("sessions" in data)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	const sessions = (data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	if (!sessions.every(isDaemonSessionSummary)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	return sessions;
}

/** Thrown when a stale-version daemon can't be replaced. The message is user-facing. */
export class StaleDaemonError extends Error {
	constructor(readonly socketPath: string) {
		super(
			`A background daemon from a different prime-agent version is running on ${socketPath} and can't be driven by ` +
				`this version. Run "prime-agent daemon shutdown" to stop it, then retry.`,
		);
		this.name = "StaleDaemonError";
	}
}

async function waitForDaemonGone(socketPath: string, timeoutMs = 5000, requireSocketCleanup = false): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (
			!(await canConnectToDaemon(socketPath, 250)) &&
			(!requireSocketCleanup || process.platform === "win32" || !existsSync(socketPath))
		) {
			return true;
		}
		await delay(25);
	}
	// A daemon can exit without removing its Unix socket (for example, after a crash
	// during shutdown). Once the cleanup grace has elapsed, a non-listening socket
	// is safe for the replacement daemon's guarded startup path to reclaim.
	return requireSocketCleanup && !(await canConnectToDaemon(socketPath, 250));
}

export async function shutdownDaemonAndWait(socketPath: string, timeoutMs = 5000): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	let shutdownAccepted = false;
	try {
		await client.connect(1000);
		const hello = await client.waitForHello(2000).catch(() => undefined);
		const request =
			hello && hello.protocol.version < DAEMON_PROTOCOL_VERSION
				? client.requestLegacy.bind(client)
				: client.request.bind(client);
		const response = await request({ type: "shutdown" }).catch(() => undefined);
		shutdownAccepted = response?.success === true;
	} catch {
		// A connect failure isn't treated as "gone"; waitForDaemonGone is the source of truth.
	} finally {
		client.close();
	}
	return waitForDaemonGone(socketPath, timeoutMs, shutdownAccepted);
}

// activeSessions is undefined when the daemon is reachable but its sessions couldn't
// be listed — callers must treat that as "possibly busy", not idle.
export type RunningDaemonProbe = { reachable: false } | { reachable: true; activeSessions?: SessionSummary[] };

export function isSessionBusy(summary: SessionSummary): boolean {
	// pendingMessageCount covers queued steering/follow-ups, which live only in
	// memory and would be lost if the daemon were stopped.
	return (
		summary.isStreaming ||
		summary.isCompacting ||
		summary.isBashRunning === true ||
		summary.hasRunningRlmChildren === true ||
		summary.pendingMessageCount > 0
	);
}

export async function probeRunningDaemonSessions(socketPath: string): Promise<RunningDaemonProbe> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
	} catch {
		client.close();
		return { reachable: false };
	}
	try {
		const summaries = await listActiveDaemonSessionSummaries(client);
		return { reachable: true, activeSessions: summaries.filter((summary) => summary.activeSessionId !== undefined) };
	} catch {
		return { reachable: true };
	} finally {
		client.close();
	}
}

// Idle-but-loaded sessions reload from disk on the fresh daemon, so only a busy
// session blocks replacing a stale daemon.
async function shutdownStaleDaemonIfNotBusy(socketPath: string): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	let connected = false;
	let hasBusySessions = false;
	let loadedSessionCount = 0;
	try {
		await client.connect(1000);
		connected = true;
		try {
			const summaries = await listActiveDaemonSessionSummaries(client);
			loadedSessionCount = summaries.length;
			hasBusySessions = summaries.some(isSessionBusy);
		} catch {
			// Couldn't confirm idleness: treat as busy rather than risk interrupting work.
			hasBusySessions = true;
		}
	} catch {
		// Couldn't reach it to inspect; don't send a blind shutdown, just verify below.
	} finally {
		client.close();
	}

	if (!connected) {
		return waitForDaemonGone(socketPath);
	}
	if (hasBusySessions) {
		logDaemonLaunch(`refusing to replace stale daemon on ${socketPath}: busy session(s) present`);
		return false;
	}
	logDaemonLaunch(
		`replacing stale daemon on ${socketPath} (idle): ${loadedSessionCount} loaded session(s) will reload`,
	);
	return shutdownDaemonAndWait(socketPath);
}

async function ensureDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void> {
	const probe = await probeDaemonVersion(socketPath);
	if (probe === "current") {
		return;
	}
	if (probe === "stale") {
		const stopped = await shutdownStaleDaemonIfNotBusy(socketPath);
		if (!stopped) {
			throw new StaleDaemonError(socketPath);
		}
	}

	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for daemon launch");
	}

	const child = spawn(
		process.execPath,
		[...process.execArgv, entrypoint, "--mode", "daemon", "--daemon-socket", socketPath],
		{
			cwd: spawnCwd ?? process.cwd(),
			detached: true,
			env: process.env,
			// The daemon writes its own rotating log (see daemon-mode); nothing here
			// needs its stdout/stderr, so leave them detached.
			stdio: "ignore",
		},
	);
	child.unref();

	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await canConnectToDaemon(socketPath, 250)) {
			return;
		}
		await delay(25);
	}

	throw new Error(`Timed out waiting for daemon to start on ${socketPath}`);
}

const ensurePromises = new Map<string, Promise<void>>();

/**
 * Ensure a current-version daemon is listening on socketPath, spawning one if
 * needed. Memoized per socket so the early kick from cli.ts and the await in
 * main.ts share one probe/spawn; failed attempts are forgotten so a later call
 * retries (and surfaces the real error at its await site).
 */
export function ensureInteractiveDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void> {
	let promise = ensurePromises.get(socketPath);
	if (!promise) {
		promise = ensureDaemonRunning(socketPath, spawnCwd);
		ensurePromises.set(socketPath, promise);
		const clear = () => {
			if (ensurePromises.get(socketPath) === promise) {
				ensurePromises.delete(socketPath);
			}
		};
		promise.then(clear, clear);
	}
	return promise;
}

const EARLY_LAUNCH_EXCLUDED_FLAGS = new Set([
	"--mode",
	"--print",
	"-p",
	"--help",
	"-h",
	"--version",
	"-v",
	"--no-session",
	"--list-models",
	"--export",
]);

const EARLY_LAUNCH_EXCLUDED_COMMANDS = new Set(["daemon", "install", "remove", "update", "list", "config"]);

/** Conservative pre-parse of argv: true only when startup clearly heads into daemon-backed interactive mode. */
export function shouldStartInteractiveDaemonEarly(
	args: readonly string[],
	stdinIsTTY: boolean | undefined,
	startupBenchmark: boolean,
): boolean {
	if (startupBenchmark || !stdinIsTTY) {
		return false;
	}
	const firstPositional = args.find((arg) => arg.length > 0 && !arg.startsWith("-"));
	if (firstPositional && EARLY_LAUNCH_EXCLUDED_COMMANDS.has(firstPositional)) {
		return false;
	}
	return !args.some((arg) => EARLY_LAUNCH_EXCLUDED_FLAGS.has(arg));
}

/**
 * Fire-and-forget daemon launch for interactive startups, called from cli.ts
 * before the heavy module graph is imported. A wrong "yes" merely starts the
 * daemon that the next interactive run would need anyway; a wrong "no" only
 * means main.ts starts it later, as before. Never throws — errors surface when
 * main.ts awaits the memoized promise.
 */
export function maybeStartInteractiveDaemonEarly(args: readonly string[]): void {
	const benchmarkFlag = (process.env.PI_STARTUP_BENCHMARK ?? "").toLowerCase();
	const startupBenchmark = benchmarkFlag === "1" || benchmarkFlag === "true" || benchmarkFlag === "yes";
	if (!shouldStartInteractiveDaemonEarly(args, process.stdin.isTTY, startupBenchmark)) {
		return;
	}
	const socketIndex = args.indexOf("--daemon-socket");
	const socketPath =
		socketIndex !== -1 && args[socketIndex + 1] ? (args[socketIndex + 1] as string) : defaultDaemonSocketPath();
	// Honor --cwd: main() chdirs after parsing, but this runs before; spawn the
	// daemon from the target directory so it matches the old post-chdir behavior.
	const cwdIndex = args.indexOf("--cwd");
	const cwdArg = cwdIndex !== -1 ? args[cwdIndex + 1] : undefined;
	const spawnCwd = cwdArg ? resolve(expandTildePath(cwdArg)) : undefined;
	if (spawnCwd && !existsSync(spawnCwd)) {
		// Invalid --cwd: skip the early spawn; main() reports the error.
		return;
	}
	void ensureInteractiveDaemonRunning(socketPath, spawnCwd);
}
