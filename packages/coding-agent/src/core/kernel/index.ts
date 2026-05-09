// TODO: reconsider persistent kernel vs stateless `python -c` once RLM-1 weights land.
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { v4 as uuid } from "uuid";
import { Dealer, Subscriber } from "zeromq";
import type { RlmRunHandler, RlmRunResult } from "../rlm-runtime.js";
import { ensureKernelPython } from "./bootstrap.js";

const DELIM = Buffer.from("<IDS|MSG>");
const PROTOCOL_VERSION = "5.3";
const STARTUP_DELAY_MS = 500;
const READY_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const RLM_DISPOSE_TIMEOUT_MS = 5000;

export interface KernelManagerOptions {
	/** Python interpreter that has `ipykernel` available. Defaults to the auto-bootstrapped kernel. */
	python?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	rlmRunHandler?: RlmRunHandler;
	/** Default: "prime-agent". */
	username?: string;
}

export interface ExecuteOptions {
	/** Aborting interrupts the kernel via the control channel. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Last `execute_result` payload (text/plain), if the cell produced one. */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

interface ConnectionInfo {
	ip: string;
	transport: "tcp";
	shell_port: number;
	iopub_port: number;
	stdin_port: number;
	control_port: number;
	hb_port: number;
	signature_scheme: "hmac-sha256";
	key: string;
	kernel_name: "python3";
}

interface JupyterMessage {
	header: {
		msg_id: string;
		session: string;
		username: string;
		date: string;
		msg_type: string;
		version: string;
	};
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---- wire format ---------------------------------------------------------

function buildMessage(
	msgType: string,
	content: Record<string, unknown>,
	session: string,
	username: string,
): JupyterMessage {
	return {
		header: {
			msg_id: uuid(),
			session,
			username,
			date: new Date().toISOString(),
			msg_type: msgType,
			version: PROTOCOL_VERSION,
		},
		parent_header: {},
		metadata: {},
		content,
	};
}

function sign(parts: Buffer[], key: string): Buffer {
	const hmac = createHmac("sha256", key);
	for (const p of parts) hmac.update(p);
	return Buffer.from(hmac.digest("hex"));
}

function encode(msg: JupyterMessage, key: string): Buffer[] {
	const parts = [
		Buffer.from(JSON.stringify(msg.header)),
		Buffer.from(JSON.stringify(msg.parent_header)),
		Buffer.from(JSON.stringify(msg.metadata)),
		Buffer.from(JSON.stringify(msg.content)),
	];
	return [DELIM, sign(parts, key), ...parts];
}

function decode(frames: Buffer[]): JupyterMessage | null {
	let i = 0;
	while (i < frames.length && !frames[i].equals(DELIM)) i++;
	if (i + 5 >= frames.length) return null;
	try {
		return {
			header: JSON.parse(frames[i + 2].toString()),
			parent_header: JSON.parse(frames[i + 3].toString()),
			metadata: JSON.parse(frames[i + 4].toString()),
			content: JSON.parse(frames[i + 5].toString()),
		};
	} catch {
		return null;
	}
}

// ---- connection setup ----------------------------------------------------

function pickPorts(n: number): number[] {
	// Bind-to-0 + zeromq across all five sockets is fiddly. Random high
	// ports are sufficient given kernel sessions are local and short-lived.
	// Collisions surface on socket connect.
	const start = 50000 + Math.floor(Math.random() * 5000);
	return Array.from({ length: n }, (_, i) => start + i);
}

function makeConnection(): { info: ConnectionInfo; path: string; tempDir: string } {
	const [shell_port, iopub_port, stdin_port, control_port, hb_port] = pickPorts(5);
	const info: ConnectionInfo = {
		ip: "127.0.0.1",
		transport: "tcp",
		shell_port,
		iopub_port,
		stdin_port,
		control_port,
		hb_port,
		signature_scheme: "hmac-sha256",
		key: randomBytes(16).toString("hex"),
		kernel_name: "python3",
	};
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-"));
	const path = join(tempDir, "connection.json");
	writeFileSync(path, JSON.stringify(info, null, 2));
	return { info, path, tempDir };
}

// ---- process-wide cleanup -----------------------------------------------

const liveKernels = new Set<KernelManager>();
let signalHandlersInstalled = false;

registerSessionResourceCleanup((sessionId) => {
	for (const k of liveKernels) {
		if (!sessionId || k.ownerSessionId === sessionId) {
			void k.dispose();
		}
	}
});

function installSignalHandlersOnce(): void {
	if (signalHandlersInstalled) return;
	signalHandlersInstalled = true;

	const asyncShutdown = async (): Promise<void> => {
		await Promise.allSettled([...liveKernels].map((k) => k.shutdown()));
	};

	// `beforeExit` and signal handlers can await async cleanup. `exit`
	// can only do sync work (Node won't run pending microtasks past it),
	// so it falls back to `disposeSync()` which kills the child synchronously.
	process.on("beforeExit", () => {
		void asyncShutdown();
	});
	process.on("SIGINT", () => {
		void asyncShutdown().finally(() => process.exit(130));
	});
	process.on("SIGTERM", () => {
		void asyncShutdown().finally(() => process.exit(143));
	});
	process.on("exit", () => {
		for (const k of liveKernels) k.disposeSync();
	});
}

// ---- kernel manager ------------------------------------------------------

export class KernelManager {
	private readonly options: Pick<KernelManagerOptions, "python" | "cwd" | "env" | "sessionId" | "rlmRunHandler"> &
		Required<Pick<KernelManagerOptions, "username">>;
	private readonly session = uuid();
	private readonly commTargets = new Map<string, string>();
	private readonly handledRlmCommIds = new Set<string>();
	private kernel?: ChildProcess;
	private shell?: Dealer;
	private iopub?: Subscriber;
	private control?: Dealer;
	private connection?: ConnectionInfo;
	private tempDir?: string;
	private kernelStderr = "";
	/** Serializes execute() calls — Jupyter shell channel is request/reply. */
	private executionQueue: Promise<unknown> = Promise.resolve();
	private readonly inFlightRlmRuns = new Set<Promise<void>>();
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	/** Memoized so concurrent callers all await the same in-flight startup. */
	private startPromise?: Promise<void>;

	constructor(options: KernelManagerOptions) {
		this.options = {
			python: options.python,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			rlmRunHandler: options.rlmRunHandler,
			username: options.username ?? "prime-agent",
		};
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	async start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.doStart();
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		if (this.state !== "idle") return;
		this.state = "starting";
		installSignalHandlersOnce();

		let python: string;
		try {
			python = this.options.python ?? (await ensureKernelPython());
			this.options.python = python;
		} catch (error) {
			this.state = "idle";
			throw error;
		}

		const { info, path: connectionPath, tempDir } = makeConnection();
		this.connection = info;
		this.tempDir = tempDir;

		const kernel = spawn(python, ["-m", "ipykernel_launcher", "-f", connectionPath], {
			cwd: this.options.cwd,
			env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.kernel = kernel;

		kernel.stderr?.on("data", (buf: Buffer) => {
			const s = buf.toString();
			this.kernelStderr += s;
			process.stderr.write(`[kernel] ${s}`);
		});

		kernel.on("error", (err) => {
			if (this.kernel !== kernel) return;
			console.error(`[kernel] spawn error: ${err.message}`);
			this.state = "shutdown";
			liveKernels.delete(this);
		});

		kernel.on("exit", (code, signal) => {
			if (this.kernel !== kernel) return;
			if (this.state !== "shutdown") {
				console.error(`[kernel] unexpected exit code=${code} signal=${signal}`);
			}
			this.state = "shutdown";
			liveKernels.delete(this);
		});

		this.shell = new Dealer();
		this.iopub = new Subscriber();
		this.control = new Dealer();
		this.shell.connect(`${info.transport}://${info.ip}:${info.shell_port}`);
		this.iopub.connect(`${info.transport}://${info.ip}:${info.iopub_port}`);
		this.control.connect(`${info.transport}://${info.ip}:${info.control_port}`);
		this.iopub.subscribe("");

		// ZMQ slow-joiner: give the kernel time to bind ports before publishing.
		await sleep(STARTUP_DELAY_MS);

		try {
			await this.probeReady();
		} catch (e) {
			await this.shutdown();
			this.state = "idle";
			throw e;
		}

		liveKernels.add(this);
		this.state = "running";
	}

	private async probeReady(): Promise<void> {
		const conn = this.connection!;
		const shell = this.shell!;

		const msg = buildMessage("kernel_info_request", {}, this.session, this.options.username);
		const requestMsgId = msg.header.msg_id;
		await shell.send(encode(msg, conn.key));

		const startedAt = Date.now();
		while (Date.now() - startedAt < READY_TIMEOUT_MS) {
			if ((this.state as string) === "shutdown") {
				const tail = this.kernelStderr.slice(-1024);
				throw new Error(`Kernel exited during startup. stderr:\n${tail || "(empty)"}`);
			}

			const remaining = READY_TIMEOUT_MS - (Date.now() - startedAt);
			const winner = await Promise.race([
				shell.receive().then((frames) => ({ kind: "frames" as const, frames })),
				sleep(remaining).then(() => ({ kind: "timeout" as const })),
			]);
			if (winner.kind === "timeout") break;

			const incoming = decode(winner.frames);
			if (
				incoming?.header.msg_type === "kernel_info_reply" &&
				(incoming.parent_header as { msg_id?: string }).msg_id === requestMsgId
			) {
				return;
			}
		}
		const tail = this.kernelStderr.slice(-1024);
		throw new Error(
			`Kernel did not respond to kernel_info_request within ${READY_TIMEOUT_MS}ms. stderr tail:\n${tail || "(empty)"}`,
		);
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		await this.start();
		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel has been shut down");
		}

		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		const started = Date.now();
		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
			}
			if ((this.state as string) === "shutdown") {
				throw new Error("Kernel has been shut down");
			}
			return await this.executeInner(code, opts, started);
		} finally {
			resolveNext();
		}
	}

	private async executeInner(code: string, opts: ExecuteOptions, started: number): Promise<ExecuteResult> {
		const conn = this.connection!;
		const shell = this.shell!;
		const iopub = this.iopub!;
		const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

		const msg = buildMessage(
			"execute_request",
			{
				code,
				silent: false,
				store_history: true,
				user_expressions: {},
				allow_stdin: false,
				stop_on_error: true,
			},
			this.session,
			this.options.username,
		);
		const requestMsgId = msg.header.msg_id;

		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
		}
		await shell.send(encode(msg, conn.key));

		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let result: string | undefined;
		let error: ExecuteResult["error"];
		let status: ExecuteResult["status"] = "ok";

		const onAbort = () => {
			this.interrupt().catch(() => {});
		};
		opts.signal?.addEventListener("abort", onAbort);

		try {
			for await (const frames of iopub) {
				const incoming = decode(frames);
				if (!incoming) continue;
				const t = incoming.header.msg_type;
				if (t === "comm_open" || t === "comm_msg" || t === "comm_close") {
					this.handleCommMessage(incoming);
					continue;
				}
				if ((incoming.parent_header as { msg_id?: string }).msg_id !== requestMsgId) continue;

				if (t === "stream") {
					const c = incoming.content as { name: "stdout" | "stderr"; text: string };
					if (c.name === "stdout") {
						if (stdout.length < maxChars) {
							stdout += c.text;
							if (stdout.length > maxChars) {
								stdout = stdout.slice(0, maxChars);
								stdoutTruncated = true;
							}
						}
					} else {
						if (stderr.length < maxChars) {
							stderr += c.text;
							if (stderr.length > maxChars) {
								stderr = stderr.slice(0, maxChars);
								stderrTruncated = true;
							}
						}
					}
					opts.onStream?.(c.text, c.name);
				} else if (t === "execute_result") {
					const c = incoming.content as { data: Record<string, string> };
					if (c.data["text/plain"]) result = c.data["text/plain"];
				} else if (t === "error") {
					const c = incoming.content as { ename: string; evalue: string; traceback: string[] };
					error = c;
					status = "error";
				} else if (t === "status") {
					const c = incoming.content as { execution_state: string };
					if (c.execution_state === "idle") break;
				}
			}
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
		}

		if (stdoutTruncated) stdout += `\n[... output truncated at ${maxChars} chars ...]`;
		if (stderrTruncated) stderr += `\n[... output truncated at ${maxChars} chars ...]`;
		if (result !== undefined && result.length > maxChars) {
			result = `${result.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
		}

		if (opts.signal?.aborted) status = "aborted";

		return { stdout, stderr, result, error, status, durationMs: Date.now() - started };
	}

	private handleCommMessage(incoming: JupyterMessage): void {
		const msgType = incoming.header.msg_type;
		const content = incoming.content;
		const commId = content.comm_id;
		if (typeof commId !== "string") {
			return;
		}

		if (msgType === "comm_close") {
			this.commTargets.delete(commId);
			this.handledRlmCommIds.delete(commId);
			return;
		}

		if (msgType === "comm_open") {
			const targetName = content.target_name;
			if (typeof targetName !== "string") {
				return;
			}
			this.commTargets.set(commId, targetName);
			if (targetName === "rlm.run") {
				this.startRlmRunFromComm(commId, content.data);
			}
			return;
		}

		const targetName = this.commTargets.get(commId);
		if (msgType === "comm_msg" && targetName === "rlm.run") {
			this.startRlmRunFromComm(commId, content.data);
		}
	}

	private startRlmRunFromComm(commId: string, data: unknown): void {
		if (this.handledRlmCommIds.has(commId)) {
			return;
		}
		this.handledRlmCommIds.add(commId);

		const task = (async () => {
			try {
				const result = await this.handleRlmRunRequest(data);
				try {
					await this.sendCommMessage(commId, { status: "ok", ...result });
				} catch (replyError) {
					console.error(
						`[kernel] failed to send rlm.run ok reply for comm ${commId}: ${errorMessage(replyError)}`,
					);
				}
			} catch (error) {
				console.error(`[kernel] rlm.run failed for comm ${commId}: ${errorMessage(error)}`);
				try {
					await this.sendCommMessage(commId, { status: "error", error: errorMessage(error) });
				} catch (replyError) {
					console.error(
						`[kernel] failed to send rlm.run error reply for comm ${commId}: ${errorMessage(replyError)}`,
					);
				}
			}
		})();
		this.inFlightRlmRuns.add(task);
		void task.finally(() => {
			this.inFlightRlmRuns.delete(task);
		});
	}

	private async handleRlmRunRequest(data: unknown): Promise<RlmRunResult> {
		const handler = this.options.rlmRunHandler;
		if (!handler) {
			throw new Error("rlm.run is not available in this session");
		}
		if (!isRecord(data)) {
			throw new Error("rlm.run comm payload must be an object");
		}
		if (data.type !== "run") {
			throw new Error("rlm.run comm payload must have type 'run'");
		}
		if (typeof data.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(data.kwargs) ? data.kwargs : {};
		return handler({ prompt: data.prompt, kwargs });
	}

	private async sendCommMessage(commId: string, data: Record<string, unknown>): Promise<void> {
		const channel = this.control ?? this.shell;
		if (!channel || !this.connection) {
			throw new Error("Kernel channel is not connected");
		}
		const msg = buildMessage("comm_msg", { comm_id: commId, data }, this.session, this.options.username);
		await channel.send(encode(msg, this.connection.key));
	}

	private async interrupt(): Promise<void> {
		if (!this.control || !this.connection) return;
		const msg = buildMessage("interrupt_request", {}, this.session, this.options.username);
		await this.control.send(encode(msg, this.connection.key));
	}

	private cleanupResources(): void {
		this.shell?.close();
		this.iopub?.close();
		this.control?.close();
		this.shell = undefined;
		this.iopub = undefined;
		this.control = undefined;
		try {
			this.kernel?.kill("SIGTERM");
		} catch {}
		this.kernel = undefined;
		this.connection = undefined;
		if (this.tempDir) {
			try {
				rmSync(this.tempDir, { recursive: true, force: true });
			} catch {}
		}
		this.tempDir = undefined;
		this.startPromise = undefined;
	}

	private async waitForRlmRunsToSettle(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			timeout = globalThis.setTimeout(() => resolve("timeout"), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});

		const result = await Promise.race([Promise.allSettled(tasks).then(() => "settled" as const), timeoutPromise]);
		if (timeout) {
			globalThis.clearTimeout(timeout);
		}
		if (result === "timeout") {
			console.error(`[kernel] timed out waiting ${timeoutMs}ms for ${tasks.length} rlm.run task(s) during dispose`);
		}
	}

	async shutdown(): Promise<void> {
		if (this.state === "shutdown") {
			liveKernels.delete(this);
			this.cleanupResources();
			return;
		}
		this.state = "shutdown";
		liveKernels.delete(this);

		try {
			if (this.control && this.connection) {
				const msg = buildMessage("shutdown_request", { restart: false }, this.session, this.options.username);
				await this.control.send(encode(msg, this.connection.key));
				await sleep(200);
			}
		} catch {}

		this.cleanupResources();
	}

	async restart(): Promise<void> {
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		try {
			await this.shutdown();
			this.state = "idle";
			this.kernelStderr = "";
			await this.start();
		} finally {
			resolveNext();
		}
	}

	/** Graceful cleanup. Waits briefly for in-flight rlm.run handlers before closing sockets. */
	dispose(): Promise<void> {
		this.state = "shutdown";
		liveKernels.delete(this);
		const inFlightRlmRuns = [...this.inFlightRlmRuns];
		if (inFlightRlmRuns.length === 0) {
			this.cleanupResources();
			return Promise.resolve();
		}

		return (async () => {
			// TODO: plumb AbortSignal through AgentSession.prompt so disposal can cancel long-running child loops.
			try {
				await this.waitForRlmRunsToSettle(inFlightRlmRuns, RLM_DISPOSE_TIMEOUT_MS);
			} finally {
				this.cleanupResources();
			}
		})();
	}

	/** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
	disposeSync(): void {
		this.state = "shutdown";
		liveKernels.delete(this);
		// TODO: replace this best-effort hard-exit path if Node exposes an awaitable process-exit cleanup hook.
		this.cleanupResources();
	}

	get isRunning(): boolean {
		return this.state === "running";
	}
}
