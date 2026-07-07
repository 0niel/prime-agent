import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isSessionAtRiskFromDaemonStop,
	isSessionRestorableAfterDaemonStop,
	probeRunningDaemonSessions,
	restoreDaemonSessionSummaries,
	shutdownDaemonAndWait,
} from "../src/cli/daemon-launch.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

interface FakeDaemonOptions {
	/** Sessions returned for a `list` command. */
	sessions?: Array<Record<string, unknown>>;
	/** When true, the `list` command responds with a failure. */
	failList?: boolean;
	/** When false, the server ignores `shutdown` and stays up. */
	respondToShutdown?: boolean;
	/** Captures `create` commands sent by restore helpers. */
	createCommands?: Array<Record<string, unknown>>;
	/** Session files whose restore should fail. */
	failCreateSessionFiles?: string[];
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
				const command = JSON.parse(line) as { type: string; id: string; sessionPath?: string } & Record<
					string,
					unknown
				>;
				if (command.type === "list") {
					send(socket, {
						type: "response",
						command: "list",
						id: command.id,
						...(options.failList
							? { success: false, error: "list failed" }
							: { success: true, data: { sessions: options.sessions ?? [] } }),
					});
				} else if (command.type === "create") {
					options.createCommands?.push(command);
					const shouldFail = command.sessionPath
						? (options.failCreateSessionFiles ?? []).includes(command.sessionPath)
						: false;
					send(socket, {
						type: "response",
						command: "create",
						id: command.id,
						...(shouldFail
							? { success: false, error: "restore failed" }
							: {
									success: true,
									data: {
										id: command.sessionPath ?? "created",
										activeSessionId: command.sessionPath ?? "created",
										isStreaming: false,
										isCompacting: false,
										pendingMessageCount: 0,
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

function sessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "session",
		lifecycle: "live",
		activity: "idle",
		runtimeKind: "top-level",
		activeSessionId: "active",
		sessionId: "session",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		pendingMessageCount: 0,
		...overrides,
	};
}

describe("daemon stop session classification", () => {
	function session(overrides: Partial<SessionSummary>): SessionSummary {
		return sessionSummary(overrides);
	}

	it("treats idle persisted top-level sessions as restorable", () => {
		const summary = session({ activeSessionId: "live-idle" });
		expect(isSessionRestorableAfterDaemonStop(summary)).toBe(true);
		expect(isSessionAtRiskFromDaemonStop(summary)).toBe(false);
	});

	it("protects live sessions that cannot be reopened", () => {
		expect(isSessionAtRiskFromDaemonStop(session({ activeSessionId: "sub", runtimeKind: "subagent" }))).toBe(true);
		expect(isSessionAtRiskFromDaemonStop(session({ activeSessionId: "missing-file", sessionFile: undefined }))).toBe(
			true,
		);
	});

	it("protects sessions with volatile in-memory work", () => {
		for (const overrides of [
			{ isStreaming: true },
			{ isCompacting: true },
			{ isBashRunning: true },
			{ pendingMessageCount: 1 },
		] satisfies Partial<SessionSummary>[]) {
			expect(isSessionAtRiskFromDaemonStop(session({ activeSessionId: "busy", ...overrides }))).toBe(true);
		}
	});

	it("does not protect saved-only idle sessions", () => {
		expect(isSessionAtRiskFromDaemonStop(session({ activeSessionId: undefined }))).toBe(false);
	});
});

describe("restoreDaemonSessionSummaries", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("reopens each distinct top-level session file", async () => {
		const createCommands: Array<Record<string, unknown>> = [];
		const daemon = await startFakeDaemon({ createCommands });
		cleanups.push(daemon.close);
		const firstSessionFile = join(tmpdir(), "pa-session-restore-a.jsonl");
		const secondSessionFile = join(tmpdir(), "pa-session-restore-b.jsonl");
		const busySessionFile = join(tmpdir(), "pa-session-restore-busy.jsonl");

		await expect(
			restoreDaemonSessionSummaries(daemon.socketPath, [
				sessionSummary({ activeSessionId: "a", sessionFile: firstSessionFile }),
				sessionSummary({ activeSessionId: "a-duplicate", sessionFile: firstSessionFile }),
				sessionSummary({ activeSessionId: "b", sessionFile: secondSessionFile }),
				sessionSummary({ activeSessionId: "busy", sessionFile: busySessionFile, isStreaming: true }),
				sessionSummary({
					activeSessionId: "sub",
					sessionFile: join(tmpdir(), "sub.jsonl"),
					runtimeKind: "subagent",
				}),
			]),
		).resolves.toEqual({ restored: 3, total: 3, failed: [] });

		expect(createCommands.map((command) => command.sessionPath)).toEqual([
			firstSessionFile,
			secondSessionFile,
			busySessionFile,
		]);
		expect(createCommands.map((command) => command.config)).toEqual([
			{ sessionDir: dirname(firstSessionFile) },
			{ sessionDir: dirname(secondSessionFile) },
			{ sessionDir: dirname(busySessionFile) },
		]);
	});

	it("reports restore failures and continues with later sessions", async () => {
		const createCommands: Array<Record<string, unknown>> = [];
		const failedSessionFile = join(tmpdir(), "pa-session-restore-fail.jsonl");
		const restoredSessionFile = join(tmpdir(), "pa-session-restore-ok.jsonl");
		const daemon = await startFakeDaemon({
			createCommands,
			failCreateSessionFiles: [failedSessionFile],
		});
		cleanups.push(daemon.close);

		await expect(
			restoreDaemonSessionSummaries(daemon.socketPath, [
				sessionSummary({ activeSessionId: "fail", sessionFile: failedSessionFile }),
				sessionSummary({ activeSessionId: "ok", sessionFile: restoredSessionFile }),
			]),
		).resolves.toEqual({
			restored: 1,
			total: 2,
			failed: [{ sessionFile: failedSessionFile, error: "restore failed" }],
		});
		expect(createCommands.map((command) => command.sessionPath)).toEqual([failedSessionFile, restoredSessionFile]);
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
