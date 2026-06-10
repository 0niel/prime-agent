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
import { expandTildePath, VERSION } from "../config.js";
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
		return current ? "current" : "stale";
	} catch {
		// Connected but no recognizable greeting: assume a stale daemon.
		return "stale";
	} finally {
		client.close();
	}
}

export async function listActiveDaemonSessionSummaries(client: DaemonClient): Promise<SessionSummary[]> {
	const response = await client.request({ type: "list" });
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

/**
 * Stop a stale daemon so a current-version one can replace it, but only when it
 * has no live sessions. Returns true once the daemon is no longer accepting
 * connections.
 */
async function shutdownStaleDaemonIfIdle(socketPath: string): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
		let hasLiveSessions = true;
		try {
			const summaries = await listActiveDaemonSessionSummaries(client);
			hasLiveSessions = summaries.some((summary) => summary.activeSessionId !== undefined);
		} catch {
			// If we cannot confirm the daemon is idle, leave it running rather than
			// risking a shutdown of live sessions on a transient list failure.
		}
		if (hasLiveSessions) {
			return false;
		}
		await client.request({ type: "shutdown" }).catch(() => undefined);
	} catch {
		// Connection failures mean the daemon is already gone.
	} finally {
		client.close();
	}

	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!(await canConnectToDaemon(socketPath, 250))) {
			return true;
		}
		await delay(25);
	}
	return false;
}

async function ensureDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void> {
	const probe = await probeDaemonVersion(socketPath);
	if (probe === "current") {
		return;
	}
	if (probe === "stale") {
		const stopped = await shutdownStaleDaemonIfIdle(socketPath);
		if (!stopped) {
			console.error(
				`Warning: the daemon on ${socketPath} runs a different prime-agent version but has active sessions, so it was left running. Run "prime-agent daemon shutdown" when its sessions are done to upgrade it.`,
			);
			return;
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
		promise.catch(() => {
			ensurePromises.delete(socketPath);
		});
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
