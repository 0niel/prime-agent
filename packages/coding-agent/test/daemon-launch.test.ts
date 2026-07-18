import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureInteractiveDaemonRunning,
	probeDaemonVersion,
	probeRunningDaemonSessions,
	shouldStartDaemonEarly,
	shouldUseLegacyOwnedSessionWorkerFrontend,
	shutdownDaemonAndWait,
} from "../src/cli/daemon-launch.js";
import { VERSION } from "../src/config.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";

interface FakeDaemonOptions {
	/** Sessions returned for a `list` command. */
	sessions?: Array<Record<string, unknown>>;
	busyClientOwnedSessionCount?: number;
	/** When true, the `list` command responds with a failure. */
	failList?: boolean;
	/** When false, the server ignores `shutdown` and stays up. */
	respondToShutdown?: boolean;
	protocolVersion?: number;
	appVersion?: string;
	schemaId?: string;
	serverCapabilities?: string[];
	onCommand?: (command: { type: string }) => void;
}

interface FakeDaemon {
	socketPath: string;
	close: () => Promise<void>;
}

function send(socket: Socket, message: unknown): void {
	socket.write(`${JSON.stringify(message)}\n`);
}

async function startFakeDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
	const dir = mkdtempSync(join(tmpdir(), "pa-launch-"));
	const socketPath = join(dir, "d.sock");
	const server: Server = createServer((socket) => {
		socket.on("error", () => undefined);
		send(socket, {
			type: "daemon_hello",
			socketPath,
			protocol: { name: "prime-agent-daemon", version: options.protocolVersion ?? 1 },
			appVersion: options.appVersion,
			schemaId: options.schemaId,
			clientId: "fake-client",
			serverCapabilities: options.serverCapabilities ?? [],
		});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) {
					continue;
				}
				const wire = JSON.parse(line) as {
					type: string;
					id: string;
					command?: { type: string; id: string };
				};
				const command = wire.type === "command" && wire.command ? wire.command : wire;
				options.onCommand?.(command);
				if (command.type === "list") {
					send(socket, {
						type: "response",
						command: "list",
						id: command.id,
						...(options.failList
							? { success: false, error: "list failed" }
							: {
									success: true,
									data: {
										sessions: options.sessions ?? [],
										busyClientOwnedSessionCount: options.busyClientOwnedSessionCount ?? 0,
									},
								}),
					});
				} else if (command.type === "shutdown") {
					if (options.respondToShutdown === false) {
						continue;
					}
					send(socket, { type: "response", command: "shutdown", id: command.id, success: true });
					server.close();
					socket.end();
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				rmSync(dir, { recursive: true, force: true });
			}),
	};
}

async function startCrashingDaemon(): Promise<FakeDaemon> {
	const dir = mkdtempSync(join(tmpdir(), "pa-launch-crash-"));
	const socketPath = join(dir, "d.sock");
	const child = spawn(
		process.execPath,
		[
			"-e",
			`const { createServer } = require("node:net");
const socketPath = process.argv[1];
const send = (socket, message) => socket.write(JSON.stringify(message) + "\\n");
const server = createServer((socket) => {
	send(socket, { type: "daemon_hello", socketPath, protocol: { name: "prime-agent-daemon", version: 1 } });
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		const newline = buffer.indexOf("\\n");
		if (newline === -1) return;
		const command = JSON.parse(buffer.slice(0, newline));
		if (command.type !== "shutdown") return;
		send(socket, { type: "response", command: "shutdown", id: command.id, success: true });
		socket.end(() => process.kill(process.pid, "SIGKILL"));
	});
});
server.listen(socketPath, () => process.stdout.write("ready\\n"));`,
			socketPath,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("error", reject);
		child.once("exit", (code, signal) => reject(new Error(`Daemon exited before listening: ${code ?? signal}`)));
	});
	return {
		socketPath,
		close: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await new Promise<void>((resolve) => child.once("close", () => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("probeRunningDaemonSessions", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("reports unreachable when no daemon is running", async () => {
		const result = await probeRunningDaemonSessions(join(tmpdir(), "pa-launch-missing.sock"));
		expect(result).toEqual({ reachable: false });
	});

	it("returns only sessions that have an activeSessionId", async () => {
		const daemon = await startFakeDaemon({
			sessions: [
				{ id: "a", activeSessionId: "a", isStreaming: true },
				{ id: "b" }, // saved-only, no activeSessionId
				{ id: "c", activeSessionId: "c", isStreaming: false },
			],
		});
		cleanups.push(daemon.close);
		const result = await probeRunningDaemonSessions(daemon.socketPath);
		expect(result.reachable).toBe(true);
		expect(result.reachable ? result.activeSessions?.map((session) => session.activeSessionId) : undefined).toEqual([
			"a",
			"c",
		]);
	});

	it("returns an empty list when the daemon is reachable but idle", async () => {
		const daemon = await startFakeDaemon({ sessions: [] });
		cleanups.push(daemon.close);
		expect(await probeRunningDaemonSessions(daemon.socketPath)).toEqual({ reachable: true, activeSessions: [] });
	});

	it("leaves activeSessions undefined when reachable but the list fails", async () => {
		const daemon = await startFakeDaemon({ failList: true });
		cleanups.push(daemon.close);
		expect(await probeRunningDaemonSessions(daemon.socketPath)).toEqual({ reachable: true });
	});
});

describe("shouldStartDaemonEarly", () => {
	it.each([
		["interactive", []],
		["print", ["--print", "hello"]],
		["json", ["--mode", "json", "hello"]],
		["rpc", ["--mode", "rpc"]],
		["no-session", ["--no-session"]],
	])("starts early for the %s client", (_label, args) => {
		expect(shouldStartDaemonEarly(args, false)).toBe(true);
	});

	it.each([
		["daemon process", ["--mode", "daemon"]],
		["help", ["--help"]],
		["version", ["--version"]],
		["model listing", ["--list-models"]],
		["management command after global flags", ["--daemon-socket", "/tmp/prime.sock", "status"]],
		["startup benchmark", []],
	])("does not start early for %s", (label, args) => {
		expect(shouldStartDaemonEarly(args, label === "startup benchmark")).toBe(false);
	});
});

describe("ensureInteractiveDaemonRunning", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("keeps a compatible protocol-3 daemon serving busy work instead of bricking startup", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			protocolVersion: 3,
			appVersion: VERSION,
			sessions: [{ id: "active-1", activeSessionId: "active-1", isStreaming: true }],
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).resolves.toBeUndefined();
		expect(commands).toContain("list");
		expect(commands).not.toContain("shutdown");
	});

	it("does not replace a stale daemon with busy private client sessions", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: "stale-schema",
			busyClientOwnedSessionCount: 1,
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(shouldUseLegacyOwnedSessionWorkerFrontend(daemon.socketPath)).resolves.toBe(true);
		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).rejects.toThrow("stale");
		expect(commands).toContain("list");
		expect(commands).not.toContain("shutdown");
	});

	it("routes owned clients through the legacy frontend while a compatible legacy daemon is busy", async () => {
		const daemon = await startFakeDaemon({
			protocolVersion: 3,
			appVersion: VERSION,
			sessions: [{ id: "active-1", activeSessionId: "active-1", isStreaming: true }],
		});
		cleanups.push(daemon.close);

		await expect(shouldUseLegacyOwnedSessionWorkerFrontend(daemon.socketPath)).resolves.toBe(true);
	});

	it("does not treat a live daemon as absent when cold startup delays the first connection", async () => {
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: DAEMON_SCHEMA_ID,
		});
		cleanups.push(daemon.close);

		const probe = probeDaemonVersion(daemon.socketPath);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);

		await expect(probe).resolves.toMatchObject({ status: "current" });
	});
});

describe("shutdownDaemonAndWait", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("returns true immediately when no daemon is running", async () => {
		expect(await shutdownDaemonAndWait(join(tmpdir(), "pa-launch-missing2.sock"))).toBe(true);
	});

	it("stops a running daemon and returns true", async () => {
		const daemon = await startFakeDaemon({ sessions: [{ id: "a", activeSessionId: "a", isStreaming: false }] });
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath)).toBe(true);
	});

	it("accepts an exited daemon that leaves a stale socket behind", async () => {
		if (process.platform === "win32") {
			return;
		}

		const daemon = await startCrashingDaemon();
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath, 100)).toBe(true);
		expect(existsSync(daemon.socketPath)).toBe(true);
	});
});
