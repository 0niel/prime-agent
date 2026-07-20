/**
 * Daemon launch/readiness helpers.
 *
 * This module stays light on imports so clients can start a cold daemon before
 * the heavy main module graph loads. main.ts reuses the same memoized promise.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { appendRotatingLog, expandTildePath, getAgentDir, getClientErrorLogPath, VERSION } from "../config.js";
import { getProcessStartId } from "../core/session-lease.js";
import { DaemonClient, type DaemonHello } from "../modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../modes/daemon/daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "../modes/daemon/daemon-runtime-identity.js";
import { isSessionSummaryBusy, type SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";
import { isHelpCommandRequest, PUBLIC_COMMAND_NAMES, REMOVED_COMMAND_NAMES } from "./command-registry.js";
import { hasPendingDaemonUpdateRestartManifest } from "./daemon-update-manifest.js";
import { createCliSubprocessEnv, formatCurrentCliCommand } from "./subprocess-launch.js";

const DAEMON_STARTUP_TIMEOUT_MS = 30_000;

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

type DaemonVersionProbe =
	| { status: "absent" }
	| { status: "current"; hello: DaemonHello }
	| { status: "stale"; hello?: DaemonHello; compatible: boolean };

/** Connect to a running daemon and check whether it matches this client's protocol and app version. */
export async function probeDaemonVersion(socketPath: string): Promise<DaemonVersionProbe> {
	let client: DaemonClient | undefined;
	for (const timeoutMs of [250, 2000]) {
		const candidate = new DaemonClient(socketPath);
		try {
			await candidate.connect(timeoutMs);
			client = candidate;
			break;
		} catch {
			candidate.close();
		}
	}
	if (!client) {
		return { status: "absent" };
	}
	try {
		const hello = await client.waitForHello(2000);
		const current =
			hello.protocol.version === DAEMON_PROTOCOL_VERSION &&
			hello.schemaId === DAEMON_SCHEMA_ID &&
			hello.appVersion === VERSION;
		if (!current) {
			logDaemonLaunch(
				`running daemon on ${socketPath} is stale: daemon v${hello.appVersion}/proto${hello.protocol.version}` +
					`/schema ${hello.schemaId ?? "legacy"}/build ${hello.runtime?.buildId ?? "unknown"} vs client ` +
					`v${VERSION}/proto${DAEMON_PROTOCOL_VERSION}/schema ${DAEMON_SCHEMA_ID}/build ${getDaemonRuntimeIdentity().buildId}`,
			);
		}
		if (current) {
			return { status: "current", hello };
		}
		return {
			status: "stale",
			hello,
			compatible: hello.protocol.version === 3,
		};
	} catch {
		// Connected but no recognizable greeting: assume a stale daemon.
		logDaemonLaunch(`running daemon on ${socketPath} sent no recognizable hello; treating as stale`);
		return { status: "stale", compatible: false };
	} finally {
		client.close();
	}
}

export async function listActiveDaemonSessionSummaries(
	client: DaemonClient,
	options: { includeClientOwned?: boolean } = {},
): Promise<SessionSummary[]> {
	return (await queryActiveDaemonSessions(client, options)).sessions;
}

async function queryActiveDaemonSessions(
	client: DaemonClient,
	options: { includeClientOwned?: boolean } = {},
): Promise<{ sessions: SessionSummary[]; busyClientOwnedSessionCount: number }> {
	const hello = await client.waitForHello(2000).catch(() => undefined);
	const response =
		hello && hello.protocol.version < DAEMON_PROTOCOL_VERSION
			? await client.requestLegacy({ type: "list", includeClientOwned: options.includeClientOwned })
			: await client.request({ type: "list", includeClientOwned: options.includeClientOwned });
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
	const busyClientOwnedSessionCount = (data as { busyClientOwnedSessionCount?: unknown }).busyClientOwnedSessionCount;
	if (
		busyClientOwnedSessionCount !== undefined &&
		(typeof busyClientOwnedSessionCount !== "number" ||
			!Number.isInteger(busyClientOwnedSessionCount) ||
			busyClientOwnedSessionCount < 0)
	) {
		throw new Error("Daemon returned an invalid client-owned session count");
	}
	return { sessions, busyClientOwnedSessionCount: busyClientOwnedSessionCount ?? 0 };
}

/** Thrown when a stale-version daemon can't be replaced. The message is user-facing. */
export class StaleDaemonError extends Error {
	constructor(
		readonly socketPath: string,
		hello?: DaemonHello,
	) {
		const daemonIdentity = hello
			? `Daemon: v${hello.appVersion ?? "unknown"}, protocol ${hello.protocol.version}, schema ${hello.schemaId ?? "legacy"}, ` +
				`build ${hello.runtime?.buildId ?? "unknown"}, PID ${hello.supervisorPid ?? "unknown"}, ` +
				`executable ${hello.runtime?.launcherPath ?? hello.runtime?.entrypointPath ?? hello.runtime?.executablePath ?? "unknown"}`
			: `Daemon: unknown build on ${socketPath}`;
		const client = getDaemonRuntimeIdentity();
		super(
			`An incompatible Prime Agent daemon is running.\n\n${daemonIdentity}\n` +
				`Client: v${VERSION}, protocol ${DAEMON_PROTOCOL_VERSION}, schema ${DAEMON_SCHEMA_ID}, build ${client.buildId}, ` +
				`executable ${client.launcherPath ?? client.entrypointPath ?? client.executablePath}\n\nRun:\n` +
				`${formatCurrentCliCommand(["shutdown", "--force"])}\n\nThen retry the original command.`,
		);
		this.name = "StaleDaemonError";
	}
}

interface DaemonProcessIdentity {
	pid: number;
	processStartId?: string;
}

const PROCESS_START_ID_POLL_INTERVAL_MS = 1000;

function hasProcessIdentityExited(identity: DaemonProcessIdentity | undefined, verifyProcessStartId = true): boolean {
	if (!identity) {
		return true;
	}
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	if (!identity.processStartId || !verifyProcessStartId) {
		return false;
	}
	const currentStartId = getProcessStartId(identity.pid);
	return currentStartId !== undefined && currentStartId !== identity.processStartId;
}

async function waitForDaemonGone(
	socketPath: string,
	timeoutMs = 5000,
	requireSocketCleanup = false,
	expectedIdentity?: DaemonProcessIdentity,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let nextProcessStartIdPollAt = 0;
	const hasExpectedProcessExited = (forceStartIdPoll = false) => {
		const now = Date.now();
		const verifyProcessStartId = forceStartIdPoll || now >= nextProcessStartIdPollAt;
		if (verifyProcessStartId) {
			nextProcessStartIdPollAt = now + PROCESS_START_ID_POLL_INTERVAL_MS;
		}
		return hasProcessIdentityExited(expectedIdentity, verifyProcessStartId);
	};
	while (Date.now() < deadline) {
		if (
			!(await canConnectToDaemon(socketPath, 250)) &&
			(!requireSocketCleanup || process.platform === "win32" || !existsSync(socketPath)) &&
			hasExpectedProcessExited()
		) {
			return true;
		}
		await delay(25);
	}
	// A daemon can exit without removing its Unix socket (for example, after a crash
	// during shutdown). Once the cleanup grace has elapsed, a non-listening socket
	// is safe for the replacement daemon's guarded startup path to reclaim.
	return requireSocketCleanup && !(await canConnectToDaemon(socketPath, 250)) && hasExpectedProcessExited(true);
}

function processIdentityFromDaemonHello(hello: DaemonHello | undefined): DaemonProcessIdentity | undefined {
	if (!hello?.supervisorPid || !Number.isInteger(hello.supervisorPid) || hello.supervisorPid <= 0) {
		return undefined;
	}
	const processStartId = hello.supervisorProcessStartId ?? getProcessStartId(hello.supervisorPid);
	return {
		pid: hello.supervisorPid,
		...(processStartId ? { processStartId } : {}),
	};
}

export async function shutdownConnectedDaemonAndWait(
	client: DaemonClient,
	socketPath: string,
	timeoutMs = 5000,
	hello: DaemonHello | undefined = client.hello,
): Promise<boolean> {
	let shutdownAccepted = false;
	const expectedIdentity = processIdentityFromDaemonHello(hello);
	try {
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
	return waitForDaemonGone(socketPath, timeoutMs, shutdownAccepted, expectedIdentity);
}

export async function shutdownDaemonAndWait(socketPath: string, timeoutMs = 5000): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
		const hello = await client.waitForHello(2000).catch(() => undefined);
		return shutdownConnectedDaemonAndWait(client, socketPath, timeoutMs, hello);
	} catch {
		client.close();
		return waitForDaemonGone(socketPath, timeoutMs);
	}
}

// activeSessions is undefined when the daemon is reachable but its sessions couldn't
// be listed — callers must treat that as "possibly busy", not idle.
export type RunningDaemonProbe =
	| { reachable: false }
	| { reachable: true; activeSessions?: SessionSummary[]; busyClientOwnedSessionCount?: number };

export function isSessionBusy(summary: SessionSummary): boolean {
	return isSessionSummaryBusy(summary);
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
		const result = await queryActiveDaemonSessions(client, { includeClientOwned: true });
		return {
			reachable: true,
			activeSessions: result.sessions.filter((summary) => summary.activeSessionId !== undefined),
			...(result.busyClientOwnedSessionCount > 0
				? { busyClientOwnedSessionCount: result.busyClientOwnedSessionCount }
				: {}),
		};
	} catch {
		return { reachable: true };
	} finally {
		client.close();
	}
}

export async function shouldUseLegacyOwnedSessionWorkerFrontend(socketPath: string): Promise<boolean> {
	const version = await probeDaemonVersion(socketPath);
	if (version.status !== "stale") {
		return false;
	}
	const running = await probeRunningDaemonSessions(socketPath);
	return (
		running.reachable &&
		(running.activeSessions === undefined ||
			(running.busyClientOwnedSessionCount ?? 0) > 0 ||
			running.activeSessions.some((summary) => isSessionBusy(summary)))
	);
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
			const result = await queryActiveDaemonSessions(client, { includeClientOwned: true });
			loadedSessionCount = result.sessions.length;
			hasBusySessions =
				result.busyClientOwnedSessionCount !== 0 || result.sessions.some((summary) => isSessionBusy(summary));
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
	if (probe.status === "current") {
		return;
	}
	if (probe.status === "stale") {
		const stopped = await shutdownStaleDaemonIfNotBusy(socketPath);
		if (!stopped) {
			if (probe.compatible) {
				logDaemonLaunch(`using compatible legacy daemon on ${socketPath} while busy work completes`);
				return;
			}
			throw new StaleDaemonError(socketPath, probe.hello);
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
			env: createCliSubprocessEnv(),
			// The daemon writes its own rotating log (see daemon-mode); nothing here
			// needs its stdout/stderr, so leave them detached.
			stdio: "ignore",
		},
	);
	child.unref();

	const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const started = await probeDaemonVersion(socketPath);
		if (started.status === "current") {
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

const EARLY_LAUNCH_EXCLUDED_FLAGS = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);
const EARLY_LAUNCH_VALUE_FLAGS = new Set([
	"--mode",
	"--daemon-socket",
	"--provider",
	"--model",
	"--api-key",
	"--cwd",
	"--system-prompt",
	"--append-system-prompt",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--autonomous-gate",
	"--autonomous-gate-retries",
	"--autonomous-gate-timeout-ms",
	"--autonomous-max-continuations",
	"--autonomous-max-turns",
	"--autonomous-max-tokens",
	"--autonomous-timeout-ms",
]);

function findFirstEarlyLaunchPositional(args: readonly string[]): { index: number; value: string } | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") {
			return args[index + 1] === undefined ? undefined : { index: index + 1, value: args[index + 1]! };
		}
		if (EARLY_LAUNCH_VALUE_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (arg === "--resume" || arg === "-r") {
			if (args[index + 1] && !args[index + 1]!.startsWith("-")) {
				index++;
			}
			continue;
		}
		if (!arg.startsWith("-")) {
			return { index, value: arg };
		}
	}
	return undefined;
}

export function shouldStartDaemonEarly(
	args: readonly string[],
	startupBenchmark: boolean,
	pendingUpdateRecovery = false,
): boolean {
	if (startupBenchmark || pendingUpdateRecovery) {
		return false;
	}
	const modeIndex = args.indexOf("--mode");
	if (modeIndex !== -1 && args[modeIndex + 1] === "daemon") {
		return false;
	}
	if (args.some((arg) => EARLY_LAUNCH_EXCLUDED_FLAGS.has(arg))) {
		return false;
	}
	if (args.includes("--print") || args.includes("-p")) {
		return true;
	}
	const firstPositional = findFirstEarlyLaunchPositional(args);
	const isHelpCommand =
		firstPositional?.value === "help" && isHelpCommandRequest(args.slice(firstPositional.index + 1));
	if (
		firstPositional &&
		(REMOVED_COMMAND_NAMES.has(firstPositional.value) ||
			(PUBLIC_COMMAND_NAMES.has(firstPositional.value) &&
				firstPositional.value !== "agents" &&
				(firstPositional.value !== "help" || isHelpCommand)))
	) {
		return false;
	}
	return true;
}

export function maybeStartDaemonEarly(args: readonly string[]): void {
	const benchmarkFlag = (process.env.PI_STARTUP_BENCHMARK ?? "").toLowerCase();
	const startupBenchmark = benchmarkFlag === "1" || benchmarkFlag === "true" || benchmarkFlag === "yes";
	const socketIndex = args.indexOf("--daemon-socket");
	const socketPath =
		socketIndex !== -1 && args[socketIndex + 1] ? (args[socketIndex + 1] as string) : defaultDaemonSocketPath();
	const pendingUpdateRecovery = hasPendingDaemonUpdateRestartManifest(socketPath, getAgentDir());
	if (!shouldStartDaemonEarly(args, startupBenchmark, pendingUpdateRecovery)) {
		if (pendingUpdateRecovery) {
			logDaemonLaunch(`deferring daemon startup on ${socketPath} until pending update recovery completes`);
		}
		return;
	}
	const cwdIndex = args.indexOf("--cwd");
	const cwdArg = cwdIndex !== -1 ? args[cwdIndex + 1] : undefined;
	const spawnCwd = cwdArg ? resolve(expandTildePath(cwdArg)) : undefined;
	if (spawnCwd && !existsSync(spawnCwd)) {
		return;
	}
	void ensureInteractiveDaemonRunning(socketPath, spawnCwd);
}
