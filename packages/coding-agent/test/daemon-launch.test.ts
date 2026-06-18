import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeRunningDaemonSessions, shutdownDaemonAndWait } from "../src/cli/daemon-launch.js";

interface FakeDaemonOptions {
	/** Sessions returned for a `list` command. */
	sessions?: Array<Record<string, unknown>>;
	/** When true, the `list` command responds with a failure. */
	failList?: boolean;
	/** When false, the server ignores `shutdown` and stays up. */
	respondToShutdown?: boolean;
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
		send(socket, { type: "daemon_hello", socketPath, protocol: { name: "prime-agent-daemon", version: 1 } });
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
				const command = JSON.parse(line) as { type: string; id: string };
				if (command.type === "list") {
					send(socket, {
						type: "response",
						command: "list",
						id: command.id,
						...(options.failList
							? { success: false, error: "list failed" }
							: { success: true, data: { sessions: options.sessions ?? [] } }),
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
});
