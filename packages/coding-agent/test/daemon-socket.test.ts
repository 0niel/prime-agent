import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	cleanupDaemonSocketPath,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

describe("defaultDaemonSocketPath", () => {
	it("uses a fixed Windows named pipe path", () => {
		if (process.platform !== "win32") {
			return;
		}

		expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-daemon");
	});

	it("uses a per-user Unix socket directory", () => {
		if (process.platform === "win32") {
			return;
		}

		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		const socketPath = defaultDaemonSocketPath();

		expect(dirname(socketPath)).toBe(join(tmpdir(), `prime-agent-${suffix}`));
		expect(basename(socketPath)).toBe("daemon.sock");
	});

	it("checks a live daemon before acquiring the socket path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-live-"));
		const socketPath = join(dir, "daemon.sock");
		let observedLock: boolean | undefined;
		const server = createServer((socket) => {
			observedLock = existsSync(`${socketPath}.lock`);
			socket.destroy();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(/socket already in use/i);
			expect(observedLock).toBe(false);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not wait on a stale lock when no socket path exists", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-stale-lock-"));
		const socketPath = join(dir, "daemon.sock");
		mkdirSync(`${socketPath}.lock`);
		let prepared = false;
		try {
			await Promise.race([
				prepareDaemonSocketPath(socketPath).then(() => {
					prepared = true;
				}),
				new Promise<void>((resolve) => setTimeout(resolve, 250)),
			]);
			expect(prepared).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a replacement daemon's socket during delayed cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-ownership-"));
		const socketPath = join(dir, "daemon.sock");
		const oldServer = createServer();
		const replacementServer = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				oldServer.once("error", reject);
				oldServer.listen(socketPath, resolve);
			});
			const oldIdentity = getDaemonSocketIdentity(socketPath);
			if (!oldIdentity) {
				throw new Error("Expected a Unix daemon socket identity");
			}

			unlinkSync(socketPath);
			await new Promise<void>((resolve, reject) => {
				replacementServer.once("error", reject);
				replacementServer.listen(socketPath, resolve);
			});

			cleanupDaemonSocketPath(socketPath, oldIdentity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await Promise.all(
				[oldServer, replacementServer].map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				),
			);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a socket while another daemon owns the path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-lock-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const identity = getDaemonSocketIdentity(socketPath);
			if (!identity) {
				throw new Error("Expected a Unix daemon socket identity");
			}
			releaseLock = await lockfile.lock(socketPath, { realpath: false });

			cleanupDaemonSocketPath(socketPath, identity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await releaseLock?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not remove a replacement socket that appears while stale cleanup is pending", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-startup-"));
		const socketPath = join(dir, "daemon.sock");
		const staleOwner = spawn(
			process.execPath,
			[
				"-e",
				"const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
				socketPath,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const replacementServer = createServer();
		let replacementTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				staleOwner.stdout?.once("data", () => resolve());
				staleOwner.once("error", reject);
				staleOwner.once("exit", (code) => {
					if (code !== null && code !== 0) {
						reject(new Error(`Stale socket owner exited before listening: ${code}`));
					}
				});
			});
			staleOwner.kill("SIGKILL");
			await new Promise<void>((resolve) => staleOwner.once("close", () => resolve()));
			expect(existsSync(socketPath)).toBe(true);

			const replacementListening = new Promise<void>((resolve, reject) => {
				replacementTimer = setTimeout(() => {
					try {
						if (existsSync(socketPath)) {
							unlinkSync(socketPath);
						}
						replacementServer.once("error", reject);
						replacementServer.listen(socketPath, resolve);
					} catch (error) {
						reject(error);
					}
				}, 50);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(
				/socket (already in use|changed ownership)/i,
			);
			await replacementListening;
			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			if (replacementTimer) {
				clearTimeout(replacementTimer);
			}
			if (staleOwner.exitCode === null && staleOwner.signalCode === null) {
				staleOwner.kill("SIGKILL");
			}
			if (replacementServer.listening) {
				await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function attachmentClient(id: string): DaemonSocketClient {
	return {
		id,
		socket: new PassThrough() as unknown as Socket,
		attachedActiveSessionIds: new Set(["active-c02"]),
		catchupActiveSessionIds: new Set(),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

describe("attachment-local catch-up scheduling", () => {
	it("coalesces drain and cache triggers while preserving replacement precedence", async () => {
		const supervisor = new DaemonSupervisor("/tmp/c02-catchup.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/c02-catchup-state",
		});
		const client = attachmentClient("slow-c02");
		const catchUpClient = vi.fn(async () => {});
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			queueCatchup(client: DaemonSocketClient, activeSessionId: string, purpose?: "replacement" | "resync"): void;
			scheduleClientCatchup(client: DaemonSocketClient): void;
			catchUpClient: typeof catchUpClient;
		};
		internals.clients.add(client);
		internals.catchUpClient = catchUpClient;

		internals.queueCatchup(client, "active-c02", "resync");
		internals.scheduleClientCatchup(client);
		internals.queueCatchup(client, "active-c02", "replacement");
		internals.scheduleClientCatchup(client);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(catchUpClient).toHaveBeenCalledTimes(1);
		expect(client.catchupPurposes?.get("active-c02")).toBe("replacement");
		expect(client.catchupDrainScheduled).toBe(false);
		client.socket.destroy();
	});

	it("makes a queued callback inert on close/cleanup without affecting a healthy peer", async () => {
		const supervisor = new DaemonSupervisor("/tmp/c02-close.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/c02-close-state",
		});
		const closedClient = attachmentClient("closed-c02");
		const healthyClient = attachmentClient("healthy-c02");
		const catchUpClient = vi.fn(async () => {});
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			queueCatchup(client: DaemonSocketClient, activeSessionId: string): void;
			scheduleClientCatchup(client: DaemonSocketClient): void;
			cancelClientCatchup(client: DaemonSocketClient): void;
			catchUpClient: typeof catchUpClient;
		};
		internals.clients.add(closedClient);
		internals.clients.add(healthyClient);
		internals.catchUpClient = catchUpClient;
		internals.queueCatchup(closedClient, "active-c02");
		internals.scheduleClientCatchup(closedClient);
		internals.queueCatchup(healthyClient, "active-c02");
		internals.scheduleClientCatchup(healthyClient);

		internals.cancelClientCatchup(closedClient);
		closedClient.socket.destroy();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(catchUpClient).toHaveBeenCalledTimes(1);
		expect(catchUpClient).toHaveBeenCalledWith(healthyClient);
		expect(closedClient.catchupDrainScheduled).toBe(false);
		expect(closedClient.catchupActiveSessionIds?.size).toBe(0);
		expect(closedClient.catchupPurposes?.size).toBe(0);
		healthyClient.socket.destroy();
	});
});
