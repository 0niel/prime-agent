/**
 * Real supervisor/worker dispatch coverage.  The HTTP fixture is deliberately
 * local: workers use the production OpenAI-completions transport, while the
 * test observes request entry without installing a provider in either worker.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
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

function recursiveFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const result: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		try {
			if (lstatSync(path).isDirectory()) result.push(...recursiveFiles(path));
			else result.push(path);
		} catch {
			// Supervisor cleanup may atomically rename/remove a descriptor mid-scan.
		}
	}
	return result;
}

function assertNoFixtureKey(texts: readonly string[], key: string): void {
	const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	for (const text of texts) {
		const decoded = text.replace(/\\u([\dA-Fa-f]{4})/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
		expect(decoded).not.toContain(key);
		expect(decoded.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()).not.toContain(normalizedKey);
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

interface LocalProvider {
	readonly url: string;
	readonly entered: readonly string[];
	readonly maxInFlight: number;
	close(): Promise<void>;
}

/**
 * This is a real HTTP/SSE upstream from the worker's perspective.  It is not a
 * model limiter: each POST enters immediately and receives its own scripted
 * response.  429 is an actual upstream HTTP response, never a local result.
 */
async function localProvider(): Promise<LocalProvider> {
	const entered: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			let id: string;
			try {
				id = requestId(body);
			} catch {
				response.writeHead(400).end("B00B_BAD_LOCAL_REQUEST");
				return;
			}

			entered.push(id);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const attempt = entered.filter((entry) => entry === id).length;
			if (id === "request-0003" && attempt === 1) {
				response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
				response.end(JSON.stringify({ error: { message: "fixture upstream 429", type: "rate_limit_error" } }));
				inFlight -= 1;
				return;
			}
			const emitSuccess = () => {
				if (request.destroyed || response.destroyed) return;
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				// The large body deliberately exceeds a socket high-water mark. A paused
				// attachment must be resynced instead of accumulating unbounded events.
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
				inFlight -= 1;
			};
			// Keep this upstream request in flight until its root's real abort signal
			// closes the transport; no sibling shares this timer.
			if (id === "request-0002") setTimeout(emitSuccess, 2_000);
			else emitSuccess();
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();

	if (!address || typeof address === "string" || address.address !== "127.0.0.1")
		throw new Error("B00B_LOCAL_FIXTURE_NOT_LOOPBACK_ONLY");
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		entered,
		get maxInFlight() {
			return maxInFlight;
		},
		close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
	};
}

function spawnSupervisor(agentDir: string, socketPath: string, cwd: string): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath], {
		cwd,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
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

async function attachThenPause(socketPath: string, activeSessionId: string): Promise<{ cursor: DaemonEventCursor }> {
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
	return { cursor };
}

describe("B00B real daemon production dispatch", () => {
	test("isolates paused attachment, cancellation, and upstream 429 across real supervisor workers", async () => {
		const root = mkdtempSync(join(tmpdir(), "b00b-daemon-"));
		resources.push(async () => {
			for (let attempt = 0; attempt < 20; attempt++) {
				try {
					rmSync(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 25 });
					return;
				} catch {
					await pause(50);
				}
			}
			throw new Error("B00B_TEMP_CLEANUP_FAILED");
		});
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const socketPath = join(tmpdir(), `b00b-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const upstream = await localProvider();
		resources.push(() => upstream.close());
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"b00b-local": {
						baseUrl: upstream.url,
						apiKey: "fixture-key-B00B-canary",
						api: "openai-completions",
						models: [{ id: "fixture-a", api: "openai-completions", reasoning: false, input: ["text"] }],
					},
				},
			}),
		);
		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
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
		const drainEvents: Extract<DaemonOutbound, { type: "session_event" }>[] = [];
		draining.onMessage((message) => {
			if (message.type === "session_event" && message.activeSessionId === active(fast)) drainEvents.push(message);
		});
		const attached = await draining.request({
			type: "attach",
			activeSessionId: active(fast),
			capabilities: ["attach_snapshot", "event_sequence"],
		});
		expect(attached.success).toBe(true);

		const dispatch = (session: SessionSummary, id: string) =>
			control.request({ type: "prompt", activeSessionId: active(session), message: id }, 10_000);
		const admissions = await Promise.all([
			dispatch(fast, "request-0001"),
			dispatch(cancelled, "request-0002"),
			dispatch(rateLimited, "request-0003"),
		]);
		expect(admissions.every((item) => item.success)).toBe(true);
		await eventually(() => new Set(upstream.entered).size === 3, "B00B_PROVIDER_ENTRY_TIMEOUT");
		expect(upstream.entered.filter((id) => id === "request-0001")).toHaveLength(1);

		expect(upstream.entered.filter((id) => id === "request-0002")).toHaveLength(1);

		// All three independently created workers enter the real upstream before
		// cancellation; a provider-side barrier is not faked by the client.

		// Abort and HTTP 429 are root-local. They cannot prevent the draining
		// attachment's independent root from reaching a normal terminal.
		const aborted = await control.request({ type: "abort", activeSessionId: active(cancelled) });
		expect(aborted.success).toBe(true);
		const idle = await control.request({ type: "wait_for_idle", activeSessionId: active(fast) }, 30_000);
		expect(idle.success).toBe(true);
		await eventually(
			() => drainEvents.some((event) => event.type === "session_event" && event.event.type === "message_end"),
			"B00B_DRAINING_ATTACHMENT_DID_NOT_COMPLETE",
		);
		const ordered = drainEvents
			.map((event) => event.meta?.sequence)
			.filter((sequence): sequence is number => sequence !== undefined);
		expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
		expect(ordered.length).toBeGreaterThan(2);

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

		await eventually(
			() => upstream.entered.filter((id) => id === "request-0003").length === 2,
			"B00B_429_RETRY_TIMEOUT",
		);
		const rateLimitedIdle = await control.request(
			{ type: "wait_for_idle", activeSessionId: active(rateLimited) },
			30_000,
		);
		expect(rateLimitedIdle.success).toBe(true);
		const rateLimitedMessages = await control.request({ type: "get_messages", activeSessionId: active(rateLimited) });
		expect(JSON.stringify(rateLimitedMessages)).toContain("fixture-resolved");
		expect(upstream.entered.filter((id) => id === "request-0003")).toHaveLength(2);

		const cancelledIdle = await control.request(
			{ type: "wait_for_idle", activeSessionId: active(cancelled) },
			30_000,
		);
		expect(cancelledIdle.success).toBe(true);
		const cancelledMessages = await control.request({ type: "get_messages", activeSessionId: active(cancelled) });
		expect(JSON.stringify(cancelledMessages)).not.toContain("cancelled-root-content");
		// The provider saw a genuine status-429 request while fast completed;
		// no test code implements a permit, semaphore, or fabricated response.
		expect(upstream.entered).toContain("request-0003");

		const capturedTexts = [
			(supervisor as ChildProcess & { b00bStderr?: () => string }).b00bStderr?.() ?? "",
			...recursiveFiles(agentDir)
				.filter((path) => path !== join(agentDir, "models.json"))
				.map((path) => readFileSync(path, "utf8")),
		];
		assertNoFixtureKey(capturedTexts, "fixture-key-B00B-canary");
		const shutdown = await control.request({ type: "shutdown" }, 10_000);
		expect(shutdown.success).toBe(true);
		await Promise.all(concreteWorkerPids.map((pid) => waitForProcessGone(pid)));
		await eventually(() => !existsSync(socketPath), "B00B_SUPERVISOR_SOCKET_SURVIVED");
		expect(recursiveFiles(join(agentDir, "daemon-workers")).filter((path) => path.endsWith(".tmp"))).toEqual([]);
	}, 60_000);
});
