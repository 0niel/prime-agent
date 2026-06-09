import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const netMock = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	type TrackedListener = Listener & { originalListener?: Listener };

	class MockSocket {
		private readonly listeners = new Map<string, Set<TrackedListener>>();
		readonly writes: string[] = [];
		destroyed = false;

		constructor(readonly path: string) {}

		on(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event) ?? new Set<TrackedListener>();
			listeners.add(listener as TrackedListener);
			this.listeners.set(event, listeners);
			return this;
		}

		once(event: string, listener: Listener): this {
			const onceListener: TrackedListener = (...args) => {
				this.off(event, onceListener);
				listener(...args);
			};
			onceListener.originalListener = listener;
			return this.on(event, onceListener);
		}

		off(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event);
			if (!listeners) {
				return this;
			}
			for (const registered of [...listeners]) {
				if (registered === listener || registered.originalListener === listener) {
					listeners.delete(registered);
				}
			}
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners) {
				return false;
			}
			for (const listener of [...listeners]) {
				listener(...args);
			}
			return true;
		}

		destroy(): this {
			this.destroyed = true;
			return this;
		}

		end(): this {
			return this;
		}

		write(chunk: string | Buffer): boolean {
			this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			return true;
		}

		listenerCount(event: string): number {
			return this.listeners.get(event)?.size ?? 0;
		}
	}

	const sockets: MockSocket[] = [];
	const createConnection = vi.fn((path: string) => {
		const socket = new MockSocket(path);
		sockets.push(socket);
		return socket;
	});

	return { createConnection, sockets };
});

vi.mock("node:net", () => ({
	createConnection: netMock.createConnection,
}));

describe("DaemonClient", () => {
	beforeEach(() => {
		netMock.sockets.length = 0;
		netMock.createConnection.mockClear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("allows connect retry after the socket emits an error before connecting", async () => {
		const client = new DaemonClient("/tmp/prime-agent-missing.sock");

		const firstAttempt = captureRejection(client.connect());
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;
		expect(firstSocket.listenerCount("data")).toBe(1);

		firstSocket.emit("error", new Error("initial connect failed"));

		await expect(firstAttempt).resolves.toMatchObject({ message: "initial connect failed" });
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect());
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({ message: "retry reached socket" });
	});

	it("allows connect retry after the initial connection times out", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent-slow.sock");

		const firstAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;

		const timeoutRejection = expect(firstAttempt).resolves.toMatchObject({
			message: "Timed out connecting to daemon socket: /tmp/prime-agent-slow.sock",
		});
		await vi.advanceTimersByTimeAsync(5);
		await timeoutRejection;

		expect(firstSocket.destroyed).toBe(true);
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({ message: "retry reached socket" });
	});

	it("captures the daemon hello greeting for version checks", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		expect(client.hello).toBeUndefined();
		const waited = client.waitForHello();
		const hello = {
			type: "daemon_hello",
			socketPath: "/tmp/prime-agent.sock",
			protocol: { name: "prime-agent.daemon", version: 1 },
			appVersion: "9.9.9",
			clientId: "client-1",
			serverCapabilities: [],
		};
		socket.emit("data", `${JSON.stringify(hello)}\n`);

		await expect(waited).resolves.toMatchObject({ appVersion: "9.9.9" });
		expect(client.hello).toMatchObject({ protocol: { version: 1 }, appVersion: "9.9.9" });
		await expect(client.waitForHello()).resolves.toMatchObject({ appVersion: "9.9.9" });

		client.close();
	});

	it("serializes activeSessionId for session commands", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const response = client.request({ type: "attach", activeSessionId: "active-1" });
		expect(socket.writes).toHaveLength(1);
		const command = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			activeSessionId?: string;
			daemonSessionId?: unknown;
		};

		expect(command).toMatchObject({ type: "attach", activeSessionId: "active-1" });
		expect(command).not.toHaveProperty("daemonSessionId");

		socket.emit(
			"data",
			`${JSON.stringify({ id: command.id, type: "response", command: "attach", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: command.id, success: true });

		client.close();
	});

	it("serializes list commands with all sessions requested", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const response = client.request({ type: "list", all: true });
		expect(socket.writes).toHaveLength(1);
		const command = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			all?: boolean;
		};

		expect(command).toMatchObject({ type: "list", all: true });

		socket.emit("data", `${JSON.stringify({ id: command.id, type: "response", command: "list", success: true })}\n`);
		await expect(response).resolves.toMatchObject({ id: command.id, success: true });

		client.close();
	});

	it("routes request progress by response id without notifying general listeners", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const progress: Array<[number, number]> = [];
		const listenerMessages: unknown[] = [];
		const unsubscribe = client.onMessage((message) => {
			listenerMessages.push(message);
		});
		const response = client.request(
			{ type: "list_saved_sessions", activeSessionId: "active-1", scope: "current" },
			30000,
			{
				onProgress: (message) => {
					progress.push([message.loaded, message.total]);
				},
			},
		);
		expect(socket.writes).toHaveLength(1);
		const command = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			activeSessionId?: string;
			scope?: string;
		};

		socket.emit(
			"data",
			`${JSON.stringify({
				id: command.id,
				type: "session_list_progress",
				command: "list_saved_sessions",
				activeSessionId: "active-1",
				loaded: 1,
				total: 2,
			})}\n`,
		);
		socket.emit(
			"data",
			`${JSON.stringify({
				id: command.id,
				type: "response",
				command: "list_saved_sessions",
				success: true,
				data: { sessions: [] },
			})}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: command.id, success: true });
		expect(progress).toEqual([[1, 2]]);
		expect(listenerMessages).toEqual([]);

		unsubscribe();
		client.close();
	});

	it("serializes per-session config for create commands", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const response = client.request({
			type: "create",
			name: "configured",
			config: {
				cwd: "/tmp/project",
				model: "openai/gpt-4o-mini",
				tools: ["bash"],
			},
		});
		expect(socket.writes).toHaveLength(1);
		const command = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			name?: string;
			config?: {
				cwd?: string;
				model?: string;
				tools?: string[];
			};
			cwd?: unknown;
			model?: unknown;
		};

		expect(command).toMatchObject({
			type: "create",
			name: "configured",
			config: {
				cwd: "/tmp/project",
				model: "openai/gpt-4o-mini",
				tools: ["bash"],
			},
		});
		expect(command).not.toHaveProperty("cwd");
		expect(command).not.toHaveProperty("model");

		socket.emit(
			"data",
			`${JSON.stringify({ id: command.id, type: "response", command: "create", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: command.id, success: true });

		client.close();
	});

	it("notifies listeners when a connected daemon socket closes", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const closed: Error[] = [];
		const unsubscribe = client.onClose((error) => closed.push(error));

		socket.emit("close");

		expect(closed.map((error) => error.message)).toEqual(["Daemon socket closed"]);
		unsubscribe();
		client.close();
	});

	it("notifies listeners once when a socket error is followed by close", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const closed: Error[] = [];
		client.onClose((error) => closed.push(error));

		socket.emit("error", new Error("daemon crashed"));
		socket.emit("close");

		expect(closed.map((error) => error.message)).toEqual(["daemon crashed"]);
		client.close();
	});

	it("allows connect retry after a connected daemon socket closes", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const firstConnect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;

		firstSocket.emit("close");
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondConnect = client.connect();
		expect(netMock.sockets).toHaveLength(2);
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;

		client.close();
	});
});

async function captureRejection(promise: Promise<void>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw new Error("Expected daemon client to reject with an Error");
	}
	throw new Error("Expected daemon client connect attempt to reject");
}
