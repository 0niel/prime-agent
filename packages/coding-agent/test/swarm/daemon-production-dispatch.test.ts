/**
 * Real supervisor/worker dispatch coverage.  The HTTP fixture is deliberately
 * local: workers use the production OpenAI-completions transport, while the
 * test observes request entry without installing a provider in either worker.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { DaemonClient } from "../../src/modes/daemon/daemon-client.js";
import type { DaemonEventCursor, DaemonOutbound, DaemonResponse } from "../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../src/modes/daemon/daemon-session-list.js";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs");
const resources: Array<() => Promise<void> | void> = [];
const completedRoots: string[] = [];

afterEach(async () => {
	while (resources.length) await resources.pop()?.();
});

function pause(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function eventually(predicate: () => boolean, code: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await pause(20);
	}
	throw new Error(code);
}

async function waitForProcessGone(pid: number): Promise<void> {
	await eventually(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	}, `B00B_WORKER_${pid}_SURVIVED`);
}

function recursiveNormalFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const result: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		try {
			const stat = lstatSync(path);
			if (stat.isDirectory()) result.push(...recursiveNormalFiles(path));
			else if (stat.isFile()) result.push(path);
		} catch {
			// Cleanup can atomically rename/remove an entry while an assertion scans it.
		}
	}
	return result;
}

function recursivePaths(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const result: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		result.push(path);
		try {
			if (lstatSync(path).isDirectory()) result.push(...recursivePaths(path));
		} catch {
			// See recursiveNormalFiles.
		}
	}
	return result;
}

async function removeTempRoot(root: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 25 });
			return;
		} catch {
			await pause(50);
		}
	}
	throw new Error("B00B_TEMP_CLEANUP_FAILED");
}
function cwdUnderRoots(cwd: string, roots: readonly string[]): boolean {
	const normalizedCwd = cwd.replace(/\s+\(deleted\)$/, "");
	return roots.some((root) => normalizedCwd === root || normalizedCwd.startsWith(`${root}/`));
}

/** Linux has a portable cwd handle for every visible process; do not require lsof in the pinned image. */
function cwdPidsUnderProc(roots: readonly string[], procRoot = "/proc"): number[] {
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch (error) {
		throw new Error(`B00B_PROC_ROOT_UNREADABLE ${procRoot}: ${(error as Error).message}`);
	}

	const matching = new Set<number>();
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number.parseInt(entry, 10);
		try {
			if (cwdUnderRoots(readlinkSync(join(procRoot, entry, "cwd")), roots)) matching.add(pid);
		} catch (error) {
			// Processes can exit, or their cwd can be inaccessible, between readdir and readlink.
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
			throw new Error(`B00B_PROC_CWD_UNREADABLE ${join(procRoot, entry, "cwd")}: ${(error as Error).message}`);
		}
	}
	return [...matching];
}

function cwdPidsUnderDarwin(roots: readonly string[]): number[] {
	let output: string;
	try {
		output = execFileSync("lsof", ["-n", "-Fpn", "-a", "-d", "cwd"], { encoding: "utf8" });
	} catch (error) {
		const errno = error as NodeJS.ErrnoException & { status?: unknown };
		if (errno.status === 1) return [];
		if (errno.code === "ENOENT")
			throw new Error("B00B_LSOF_UNAVAILABLE_ON_DARWIN: install lsof to enforce the cwd residue assertion");
		throw error;
	}
	let pid: number | undefined;
	const matching = new Set<number>();
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
		if (!line.startsWith("n") || pid === undefined) continue;
		if (cwdUnderRoots(line.slice(1), roots)) matching.add(pid);
	}
	return [...matching];
}

function cwdPidsUnder(roots: readonly string[]): number[] {
	if (process.platform === "linux") return cwdPidsUnderProc(roots);
	if (process.platform === "darwin") return cwdPidsUnderDarwin(roots);
	throw new Error(`B00B_CWD_RESIDUE_CHECK_UNSUPPORTED_PLATFORM: ${process.platform}`);
}

function assertNoRunResidue(roots: readonly string[]): void {
	expect(roots.every((root) => !existsSync(root))).toBe(true);
	expect(cwdPidsUnder(roots)).toEqual([]);
	const runNames = new Set(roots.map((root) => root.slice(root.lastIndexOf("/") + 1)));
	expect(readdirSync(tmpdir()).filter((entry) => runNames.has(entry))).toEqual([]);
}

function assertNoFixtureKey(texts: readonly string[], key: string): void {
	const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	const escapedKey = [...key]
		.map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.join("");
	for (const text of texts) {
		const decoded = text
			.replace(/\\u\{([\dA-Fa-f]+)\}/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
			.replace(/\\u([\dA-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
			.replace(/\\x([\dA-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		const normalized = decoded.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
		expect(text).not.toContain(key);
		expect(text).not.toContain(escapedKey);
		expect(decoded).not.toContain(key);
		expect(normalized).not.toContain(normalizedKey);
		// Catch a key serialized as fragments with punctuation/whitespace between characters.
		const splitKey = [...key]
			.map((character) => character.replace(/[\^$.*+?()[\]{}|]/g, "\\$&"))
			.join("[^a-zA-Z0-9]*");
		expect(decoded).not.toMatch(new RegExp(splitKey, "i"));
	}
}
function summary(value: unknown): SessionSummary {
	if (!value || typeof value !== "object") throw new Error("B00B_MISSING_SESSION_SUMMARY");
	return value as SessionSummary;
}

function active(summaryValue: SessionSummary): string {
	return summaryValue.activeSessionId ?? summaryValue.id;
}

function requestId(body: string): string {
	const match = /request-\d{4}/.exec(body);
	if (!match) throw new Error("B00B_LOCAL_FIXTURE_MISSING_REQUEST_ID");
	return match[0];
}

interface ProviderAttempt {
	readonly requestId: string;
	readonly rootIdentity: string;
	readonly attempt: number;
	readonly enteredAt: number;
	responseStatus?: number;
	responseAt?: number;
	responseEndedAt?: number;
	requestAbortedAt?: number;
	requestClosedAt?: number;
	responseClosedAt?: number;
}

interface LocalProvider {
	readonly url: string;
	readonly entered: readonly string[];
	readonly attempts: readonly ProviderAttempt[];
	readonly maxInFlight: number;
	release(ids: readonly string[]): void;
	close(): Promise<void>;
}

function rootIdentity(body: string): string {
	const match = /b00b-root:([^"\s]+)/.exec(body);
	if (!match) throw new Error("B00B_LOCAL_FIXTURE_MISSING_ROOT_IDENTITY");
	return match[1];
}

/** Test-only preload: observes, but never changes, the real Socket.write result. */
function createSocketWriteObserver(root: string): { preloadPath: string; tracePath: string } {
	const preloadPath = join(root, "socket-write-observer.cjs");
	const tracePath = join(root, "socket-write-0600.log");
	writeFileSync(
		preloadPath,
		`const { appendFileSync } = require("node:fs");
const { Socket } = require("node:net");
const trace = process.env.B00B_SOCKET_WRITE_TRACE;
// Workers inherit NODE_OPTIONS, but their role env exists before preload evaluation.
if (trace && !process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER) {
  const realWrite = Socket.prototype.write;
  Socket.prototype.write = function (...args) {
    const accepted = realWrite.apply(this, args);
    const wire = args[0];
    const text = Buffer.isBuffer(wire) ? wire.toString("utf8") : String(wire);
    if (!accepted && text.includes('"type":"session_event"')) {
      try { appendFileSync(trace, "0600 " + JSON.stringify({ writableLength: this.writableLength, bytes: Buffer.byteLength(text) }) + "\\n"); } catch {}
    }
    return accepted;
  };
}`,
	);
	return { preloadPath, tracePath };
}

/**
 * This is a real HTTP/SSE upstream from the worker's perspective.  It is not a
 * model limiter: each POST enters immediately and receives its own scripted
 * response.  429 is an actual upstream HTTP response, never a local result.
 */
async function localProvider(canary: string): Promise<LocalProvider> {
	const entered: string[] = [];
	const attempts: ProviderAttempt[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const releaseWaiters = new Map<string, Set<() => void>>();
	const sockets = new Set<Socket>();
	let closePromise: Promise<void> | undefined;
	const waitForRelease = (id: string, response: ServerResponse): Promise<boolean> =>
		new Promise((resolveRelease) => {
			const release = () => finish(true);
			const closed = () => finish(false);
			const finish = (wasReleased: boolean) => {
				releaseWaiters.get(id)?.delete(release);
				response.off("close", closed);
				resolveRelease(wasReleased);
			};
			const waiters = releaseWaiters.get(id) ?? new Set<() => void>();
			waiters.add(release);
			releaseWaiters.set(id, waiters);
			// Worker cancellation destroys the response; it never relies on request.destroyed,
			// which can be true after an otherwise usable async request body is read.
			response.once("close", closed);
		});
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			void (async () => {
				let id: string;
				try {
					id = requestId(body);
				} catch {
					response.writeHead(400).end("B00B_BAD_LOCAL_REQUEST");
					return;
				}
				if (request.headers.authorization !== `Bearer ${canary}`) {
					response.writeHead(401).end("B00B_BAD_LOCAL_AUTHORIZATION");
					return;
				}
				let identity: string;
				try {
					identity = rootIdentity(body);
				} catch {
					response.writeHead(400).end("B00B_BAD_ROOT_IDENTITY");
					return;
				}
				entered.push(id);
				const record: ProviderAttempt = {
					requestId: id,
					rootIdentity: identity,
					attempt: entered.filter((entry) => entry === id).length,
					enteredAt: Date.now(),
				};
				attempts.push(record);
				request.once("aborted", () => {
					record.requestAbortedAt = Date.now();
				});
				request.once("close", () => {
					record.requestClosedAt = Date.now();
				});
				response.once("close", () => {
					record.responseClosedAt = Date.now();
				});
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				try {
					if (!(await waitForRelease(id, response))) return;
					if (response.destroyed || response.writableEnded) return;
					if (id === "request-0003" && record.attempt === 1) {
						record.responseStatus = 429;
						record.responseAt = Date.now();
						response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
						response.end(
							JSON.stringify({ error: { message: "fixture upstream 429", type: "rate_limit_error" } }),
						);
						return;
					}
					if (id === "request-0002") await pause(2_000);
					if (response.destroyed || response.writableEnded) return;
					record.responseStatus = 200;
					record.responseAt = Date.now();
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
					const content = id === "request-0001" ? `${"x".repeat(512 * 1024)} fast-tail` : "cancelled-root-content";
					const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
					event({
						id: `fixture-${id}`,
						model: "fixture-resolved",
						choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
					});
					event({
						id: `fixture-${id}`,
						model: "fixture-resolved",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
					});
					response.end("data: [DONE]\n\n");
					record.responseEndedAt = Date.now();
				} finally {
					inFlight -= 1;
				}
			})().catch(() => {
				if (!response.headersSent) response.writeHead(500);
				response.end("B00B_LOCAL_FIXTURE_FAILURE");
			});
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();

	if (!address || typeof address === "string" || address.address !== "127.0.0.1")
		throw new Error("B00B_LOCAL_FIXTURE_NOT_LOOPBACK_ONLY");
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		entered,
		attempts,
		get maxInFlight() {
			return maxInFlight;
		},
		release: (ids) => {
			// Release only attempts already at the named provider barrier. A retry
			// remains independently held until this method is called again.
			for (const id of ids) for (const waiter of [...(releaseWaiters.get(id) ?? [])]) waiter();
		},
		close: () => {
			if (closePromise) return closePromise;
			closePromise = new Promise<void>((resolveClose) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolveClose());
			});
			return closePromise;
		},
	};
}
function spawnSupervisor(
	agentDir: string,
	socketPath: string,
	cwd: string,
	canary: string,
	observer: { preloadPath: string; tracePath: string },
): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath], {
		cwd,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
			B00B_FIXTURE_KEY: canary,
			B00B_SOCKET_WRITE_TRACE: observer.tracePath,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${observer.preloadPath}`.trim(),
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json"),
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: undefined,
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD: undefined,
			PRIME_AGENT_INTERNAL_SESSION_LEASES_ENABLED: undefined,
			PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: undefined,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	Object.assign(child, { b00bStderr: () => stderr });
	resources.push(() => {
		if (child.exitCode === null) child.kill("SIGTERM");
	});
	return child;
}

async function connect(socketPath: string, child: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError = "";
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("B00B_SUPERVISOR_EXITED");
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(200);
			await client.waitForHello(1_000);
			return client;
		} catch (error) {
			lastError = String(error);
			client.close();
			await pause(25);
		}
	}
	throw new Error(
		`B00B_SUPERVISOR_CONNECT_TIMEOUT ${lastError} ${(child as ChildProcess & { b00bStderr?: () => string }).b00bStderr?.() ?? ""}`,
	);
}

async function attachThenPause(
	socketPath: string,
	activeSessionId: string,
): Promise<{ cursor: DaemonEventCursor; close(): void }> {
	const socket = createConnection(socketPath);
	resources.push(() => {
		socket.destroy();
	});
	const first = await new Promise<DaemonResponse>((resolveLine, rejectLine) => {
		let buffered = "";
		const timeout = setTimeout(() => rejectLine(new Error("B00B_BLOCKED_ATTACH_TIMEOUT")), 5_000);
		socket.on("error", rejectLine);
		socket.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			const decoded = JSON.parse(line) as DaemonResponse | { type: "daemon_hello" };
			if (decoded.type === "daemon_hello") return;
			clearTimeout(timeout);
			socket.pause(); // Known cursor reached. Do not drain this attachment.
			resolveLine(decoded);
		});
		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({
					type: "command",
					id: "blocked-attach",
					clientId: "b00b-blocked",
					protocol: { name: "prime-agent.daemon", version: 7 },
					command: {
						type: "attach",
						activeSessionId,
						capabilities: ["attach_snapshot", "event_sequence"],
					},
				})}\n`,
			);
		});
	});
	if (!first.success || !first.data || typeof first.data !== "object")
		throw new Error(`B00B_BLOCKED_ATTACH_FAILED ${JSON.stringify(first)}`);
	const cursor = (first.data as { lastEventCursor?: DaemonEventCursor }).lastEventCursor;
	if (!cursor) throw new Error("B00B_BLOCKED_ATTACH_NO_CURSOR");
	return { cursor, close: () => socket.destroy() };
}

describe("B00B real daemon production dispatch", () => {
	test("enumerates Linux-style proc cwd links without lsof", () => {
		const procRoot = mkdtempSync(join(tmpdir(), "b00b-proc-"));
		try {
			const matchingRoot = join(procRoot, "matching-root");
			const otherRoot = join(procRoot, "other-root");
			mkdirSync(matchingRoot);
			mkdirSync(otherRoot);
			mkdirSync(join(procRoot, "101"));
			mkdirSync(join(procRoot, "202"));
			// A process may exit after /proc is listed, leaving no cwd link.
			mkdirSync(join(procRoot, "303"));
			mkdirSync(join(procRoot, "404"));
			writeFileSync(join(procRoot, "not-a-pid"), "ignored");
			// proc cwd entries are symlinks; Linux appends this suffix for a deleted cwd.
			symlinkSync(matchingRoot, join(procRoot, "101", "cwd"));
			symlinkSync(otherRoot, join(procRoot, "202", "cwd"));
			symlinkSync(`${matchingRoot} (deleted)`, join(procRoot, "404", "cwd"));
			expect(cwdPidsUnderProc([matchingRoot], procRoot)).toEqual([101, 404]);
			expect(() => cwdPidsUnderProc([], join(procRoot, "missing"))).toThrow("B00B_PROC_ROOT_UNREADABLE");
		} finally {
			rmSync(procRoot, { recursive: true, force: true });
		}
	});

	test.each([1, 2, 3])(
		"isolates paused attachment, cancellation, and upstream 429 across real supervisor workers (run %i)",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "b00b-daemon-"));
			const canary = `fixture-key-B00B-${randomUUID()}`;
			resources.push(() => removeTempRoot(root));
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			const socketPath = join(tmpdir(), `b00b-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			const upstream = await localProvider(canary);
			resources.push(() => upstream.close());
			const observer = createSocketWriteObserver(root);
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						"b00b-local": {
							baseUrl: upstream.url,
							apiKey: "B00B_FIXTURE_KEY",
							api: "openai-completions",
							models: [{ id: "fixture-a", api: "openai-completions", reasoning: false, input: ["text"] }],
						},
					},
				}),
			);
			const supervisor = spawnSupervisor(agentDir, socketPath, projectDir, canary, observer);
			const control = await connect(socketPath, supervisor);
			resources.push(() => control.close());
			const create = async (name: string) => {
				const result = await control.request({
					type: "create",
					name,
					config: {
						cwd: projectDir,
						agentDir,
						provider: "b00b-local",
						model: "fixture-a",
						noTools: true,
						noExtensions: true,
						noSkills: true,
					},
				});
				if (!result.success) throw new Error("B00B_CREATE_ROOT_FAILED");
				return summary(result.data);
			};
			const fast = await create("fast-root");
			const cancelled = await create("cancelled-root");
			const rateLimited = await create("rate-limited-root");

			const workerPids = [fast.workerPid, cancelled.workerPid, rateLimited.workerPid];
			expect(workerPids.every((pid): pid is number => typeof pid === "number" && pid > 1)).toBe(true);
			const concreteWorkerPids = workerPids as number[];
			expect(new Set(concreteWorkerPids).size).toBe(3);

			const blocked = await attachThenPause(socketPath, active(fast));
			const draining = await connect(socketPath, supervisor);
			resources.push(() => draining.close());
			const drainEvents: Array<{ event: Extract<DaemonOutbound, { type: "session_event" }>; observedAt: number }> =
				[];
			draining.onMessage((message) => {
				if (message.type === "session_event" && message.activeSessionId === active(fast))
					drainEvents.push({ event: message, observedAt: Date.now() });
			});
			const attached = await draining.request({
				type: "attach",
				activeSessionId: active(fast),
				capabilities: ["attach_snapshot", "event_sequence"],
			});
			expect(attached.success).toBe(true);

			const cancelledObserver = await connect(socketPath, supervisor);
			resources.push(() => cancelledObserver.close());
			const cancelledEvents: Array<{
				event: Extract<DaemonOutbound, { type: "session_event" }>;
				observedAt: number;
			}> = [];
			cancelledObserver.onMessage((message) => {
				if (message.type === "session_event" && message.activeSessionId === active(cancelled))
					cancelledEvents.push({ event: message, observedAt: Date.now() });
			});
			const cancelledAttached = await cancelledObserver.request({
				type: "attach",
				activeSessionId: active(cancelled),
				capabilities: ["attach_snapshot", "event_sequence"],
			});
			expect(cancelledAttached.success).toBe(true);

			const dispatch = (session: SessionSummary, id: string) =>
				control.request(
					{ type: "prompt", activeSessionId: active(session), message: `${id} b00b-root:${active(session)}` },
					10_000,
				);
			const admissions = await Promise.all([
				dispatch(fast, "request-0001"),
				dispatch(cancelled, "request-0002"),
				dispatch(rateLimited, "request-0003"),
			]);
			expect(admissions.every((item) => item.success)).toBe(true);
			await eventually(() => new Set(upstream.entered).size === 3, "B00B_PROVIDER_ENTRY_TIMEOUT");
			// Before any fixture release, all three independent production HTTP requests overlap.
			expect(upstream.maxInFlight).toBeGreaterThanOrEqual(3);
			expect(upstream.entered.filter((id) => id === "request-0001")).toHaveLength(1);
			expect(upstream.entered.filter((id) => id === "request-0002")).toHaveLength(1);
			expect(upstream.entered.filter((id) => id === "request-0003")).toHaveLength(1);
			// Abort is root-local. Its open response must actually be closed upstream,
			// rather than merely suppressing a locally continuing model result.
			const aborted = await control.request({ type: "abort", activeSessionId: active(cancelled) });
			expect(aborted.success).toBe(true);
			await eventually(() => {
				const cancelledAttempt = upstream.attempts.find((attempt) => attempt.requestId === "request-0002");
				return Boolean(cancelledAttempt?.requestAbortedAt || cancelledAttempt?.responseClosedAt);
			}, "B00B_CANCEL_DID_NOT_CLOSE_UPSTREAM");
			const cancelledAttempt = upstream.attempts.find((attempt) => attempt.requestId === "request-0002");
			expect(cancelledAttempt).toMatchObject({
				requestId: "request-0002",
				rootIdentity: active(cancelled),
				attempt: 1,
			});

			// The first rate-root attempt genuinely returns 429. Its second attempt is
			// held at the fixture barrier, so a sibling must finish while it backs off.
			upstream.release(["request-0003"]);
			await eventually(
				() =>
					upstream.attempts.some(
						(attempt) =>
							attempt.requestId === "request-0003" && attempt.attempt === 1 && attempt.responseStatus === 429,
					),
				"B00B_GENUINE_429_NOT_OBSERVED",
			);
			await eventually(
				() => upstream.attempts.some((attempt) => attempt.requestId === "request-0003" && attempt.attempt === 2),
				"B00B_429_RETRY_TIMEOUT",
			);
			upstream.release(["request-0001"]);
			const idle = await control.request({ type: "wait_for_idle", activeSessionId: active(fast) }, 30_000);
			expect(idle.success).toBe(true);
			await eventually(
				() => drainEvents.some(({ event }) => event.event.type === "message_end"),
				"B00B_DRAINING_ATTACHMENT_DID_NOT_COMPLETE",
			);
			const ordered = drainEvents
				.map(({ event }) => event.meta?.sequence)
				.filter((sequence): sequence is number => sequence !== undefined);
			expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
			expect(ordered.length).toBeGreaterThan(2);
			const fastCompletedAt = Date.now();
			const rateFirst = upstream.attempts.find(
				(attempt) => attempt.requestId === "request-0003" && attempt.attempt === 1,
			);
			const rateSecond = upstream.attempts.find(
				(attempt) => attempt.requestId === "request-0003" && attempt.attempt === 2,
			);
			expect(rateFirst).toMatchObject({ rootIdentity: active(rateLimited), responseStatus: 429 });
			expect(rateSecond).toMatchObject({ rootIdentity: active(rateLimited) });
			expect(rateFirst?.responseAt).toBeTypeOf("number");
			expect(rateSecond?.enteredAt).toBeLessThanOrEqual(fastCompletedAt);
			expect(rateSecond?.responseEndedAt).toBeUndefined();

			// The paused raw client caused a natural real net.Socket.write false in
			// the supervisor. The preload only records its return and writableLength.
			const falseWrites = existsSync(observer.tracePath)
				? readFileSync(observer.tracePath, "utf8")
						.split("\n")
						.filter((line) => line.startsWith("0600 "))
						.map((line) => JSON.parse(line.slice(5)) as { writableLength: number; bytes: number })
				: [];
			expect(falseWrites.length).toBeGreaterThanOrEqual(1);
			expect(falseWrites.length).toBeLessThanOrEqual(8);
			expect(Math.max(...falseWrites.map((entry) => entry.writableLength))).toBeLessThanOrEqual(2 * 1024 * 1024);
			expect(Math.max(...falseWrites.map((entry) => entry.bytes))).toBeLessThanOrEqual(2 * 1024 * 1024);

			// Reattach from the cursor known before the paused write. The supervisor
			// supplies a bounded snapshot/replay rather than a per-attachment model queue.
			const catchup = await connect(socketPath, supervisor);
			resources.push(() => catchup.close());
			const resynced = await catchup.request({
				type: "attach",
				activeSessionId: active(fast),
				capabilities: ["attach_snapshot", "event_sequence"],
				resumeCursor: { activeSessionId: active(fast), ...blocked.cursor },
			});
			if (!resynced.success || !resynced.data || typeof resynced.data !== "object")
				throw new Error("B00B_CATCHUP_FAILED");
			const catchupData = resynced.data as { snapshot?: { messages?: unknown[] }; replay?: { toSequence?: number } };
			expect(catchupData.snapshot?.messages?.length).toBeGreaterThanOrEqual(2);
			expect(catchupData.replay?.toSequence).toBeGreaterThanOrEqual(blocked.cursor.sequence);

			upstream.release(["request-0003"]);
			const rateLimitedIdle = await control.request(
				{ type: "wait_for_idle", activeSessionId: active(rateLimited) },
				30_000,
			);
			expect(rateLimitedIdle.success).toBe(true);
			const rateLimitedMessages = await control.request({
				type: "get_messages",
				activeSessionId: active(rateLimited),
			});
			expect(JSON.stringify(rateLimitedMessages)).toContain("fixture-resolved");
			expect(upstream.entered.filter((id) => id === "request-0003")).toHaveLength(2);
			expect(rateSecond?.responseEndedAt).toBeGreaterThan(fastCompletedAt);

			const cancelledIdle = await control.request(
				{ type: "wait_for_idle", activeSessionId: active(cancelled) },
				30_000,
			);
			expect(cancelledIdle.success).toBe(true);
			const cancelledMessages = await control.request({ type: "get_messages", activeSessionId: active(cancelled) });
			expect(JSON.stringify(cancelledMessages)).not.toContain("cancelled-root-content");
			const cancelledTerminals = cancelledEvents.filter(
				({ event }) =>
					event.event.type === "message_end" &&
					(event.event.message as { stopReason?: string }).stopReason === "aborted",
			);
			expect(cancelledTerminals).toHaveLength(1);
			const cancelledTerminalSequence = cancelledTerminals[0]?.event.meta?.sequence ?? -1;
			expect(
				cancelledEvents.filter(
					({ event }) =>
						event.event.type === "message_update" && (event.meta?.sequence ?? -1) > cancelledTerminalSequence,
				),
			).toHaveLength(0);
			// The provider saw a genuine status-429 request while fast completed;
			// no test code implements a permit, semaphore, or fabricated response.
			expect(upstream.entered).toContain("request-0003");

			// Explicitly release every local client, including the deliberately paused raw socket,
			// before asking the supervisor to stop accepting work.
			blocked.close();
			catchup.close();
			draining.close();
			const shutdown = await control.request({ type: "shutdown" }, 10_000);
			expect(shutdown.success).toBe(true);
			control.close();

			const supervisorPid = supervisor.pid;
			expect(typeof supervisorPid).toBe("number");
			await Promise.all([
				waitForProcessGone(supervisorPid as number),
				...concreteWorkerPids.map((pid) => waitForProcessGone(pid)),
			]);
			await eventually(() => !existsSync(socketPath), "B00B_SUPERVISOR_SOCKET_SURVIVED");

			const artifactPaths = recursivePaths(root).filter((path) =>
				/(?:^|[/\\])[^/\\]*(?:recovery|orphan|\.tmp)[^/\\]*$/i.test(path),
			);
			expect(artifactPaths).toEqual([]);
			const capturedTexts = [
				(supervisor as ChildProcess & { b00bStderr?: () => string }).b00bStderr?.() ?? "",
				...recursiveNormalFiles(root).map((path) => readFileSync(path, "utf8")),
			];
			assertNoFixtureKey(capturedTexts, canary);
			await upstream.close();
			await removeTempRoot(root);
			completedRoots.push(root);
			assertNoRunResidue([root]);
		},
		60_000,
	);

	test("leaves no b00b-daemon cwd process or directory after all repeated runs", () => {
		expect(completedRoots).toHaveLength(3);
		assertNoRunResidue(completedRoots);
	});
});
