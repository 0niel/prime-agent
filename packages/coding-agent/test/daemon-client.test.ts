import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, getDaemonSocketCloseReason } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonServerCapability } from "../src/modes/daemon/daemon-protocol.js";

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

function emitHello(
	socket: (typeof netMock.sockets)[number],
	version = DAEMON_PROTOCOL_VERSION,
	serverCapabilities: readonly DaemonServerCapability[] = [],
): void {
	socket.emit(
		"data",
		`${JSON.stringify({
			type: "daemon_hello",
			socketPath: "/tmp/prime-agent.sock",
			protocol: { name: "prime-agent.daemon", version },
			appVersion: "9.9.9",
			clientId: "client-1",
			serverCapabilities,
		})}\n`,
	);
}

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

		const firstError = await firstAttempt;
		expect(firstError.message).toContain("Failed to connect to the Prime Agent daemon: initial connect failed.");
		expect(firstError.message).toContain("Socket: /tmp/prime-agent-missing.sock.");
		expect(firstError.message).toContain("Daemon log:");
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect());
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({
			message: expect.stringContaining("Failed to connect to the Prime Agent daemon: retry reached socket."),
		});
	});

	it("allows connect retry after the initial connection times out", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent-slow.sock");

		const firstAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;

		const timeoutRejection = expect(firstAttempt).resolves.toMatchObject({
			message: expect.stringContaining("Timed out after 5ms connecting to the Prime Agent daemon."),
		});
		await vi.advanceTimersByTimeAsync(5);
		await timeoutRejection;

		expect(firstSocket.destroyed).toBe(true);
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({
			message: expect.stringContaining("Failed to connect to the Prime Agent daemon: retry reached socket."),
		});
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

	it("rejects unsupported optional commands without writing them to an older daemon", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, 3);

		expect(client.supportsServerCapability("heartbeat_catalog")).toBe(false);
		await expect(client.request({ type: "heartbeats_list" })).rejects.toThrow("does not support heartbeat_catalog");
		expect(socket.writes).toEqual([]);
		client.close();
	});

	it("isolates a message consumer failure from the rest of the client", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);
		let delivered = 0;
		client.onMessage(() => {
			throw new Error("broken optional consumer");
		});
		client.onMessage(() => delivered++);

		expect(() => socket.emit("data", `${JSON.stringify({ type: "heartbeats_changed" })}\n`)).not.toThrow();
		expect(delivered).toBe(1);
		client.close();
	});

	it("serializes activeSessionId for session commands", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "attach", activeSessionId: "active-1" });
		expect(socket.writes).toHaveLength(1);
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			clientId?: string;
			protocol?: { name?: string; version?: number };
			command?: { type?: string; activeSessionId?: string; daemonSessionId?: unknown };
		};

		expect(envelope).toMatchObject({
			type: "command",
			clientId: expect.any(String),
			protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
			command: { type: "attach", activeSessionId: "active-1" },
		});
		expect(envelope.command).not.toHaveProperty("daemonSessionId");

		socket.emit(
			"data",
			`${JSON.stringify({ id: envelope.id, type: "response", command: "attach", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });

		client.close();
	});

	it("serializes list commands with all sessions requested", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "list", all: true });
		expect(socket.writes).toHaveLength(1);
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			command?: { type?: string; all?: boolean };
		};

		expect(envelope).toMatchObject({ type: "command", command: { type: "list", all: true } });

		socket.emit("data", `${JSON.stringify({ id: envelope.id, type: "response", command: "list", success: true })}\n`);
		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });

		client.close();
	});

	it("includes command, socket, and log context when a request is made while disconnected", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const request = client.request({ type: "list", all: true });

		await expect(request).rejects.toMatchObject({
			message: expect.stringContaining(
				'Cannot send daemon command "list" because the Prime Agent daemon is not connected.',
			),
		});
		await expect(request).rejects.toMatchObject({
			message: expect.stringContaining("Socket: /tmp/prime-agent.sock."),
		});
		await expect(request).rejects.toMatchObject({
			message: expect.stringContaining("Daemon log:"),
		});
	});

	it("keeps a raw one-release request path for v1 daemon handoff", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const response = client.requestLegacy({ type: "prepare_update_restart" });
		const command = JSON.parse(socket.writes[0]!.trim()) as { id: string; type: string };
		expect(command.type).toBe("prepare_update_restart");
		expect(command).not.toHaveProperty("protocol");
		socket.emit(
			"data",
			`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ success: true });
		client.close();
	});

	it("uses legacy framing automatically after a v1 daemon hello", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, 1);

		const response = client.request({ type: "create" });
		const command = JSON.parse(socket.writes[0]!.trim()) as { id: string; type: string };
		expect(command.type).toBe("create");
		expect(command).not.toHaveProperty("protocol");
		socket.emit(
			"data",
			`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ success: true });
		client.close();
	});

	it("keeps durable command envelopes when connected to a v2 daemon", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, 2);

		const response = client.request({ type: "create" });
		const request = JSON.parse(socket.writes[0]!.trim()) as {
			id: string;
			protocol: { version: number };
		};
		expect(request.protocol.version).toBe(2);

		socket.emit(
			"data",
			`${JSON.stringify({ id: request.id, type: "response", command: "create", success: true })}\n`,
		);
		await response;

		const acknowledgement = JSON.parse(socket.writes[1]!.trim()) as {
			protocol: { version: number };
			command: { type: string; commandId: string };
		};
		expect(acknowledgement).toMatchObject({
			protocol: { version: 2 },
			command: { type: "ack_result", commandId: request.id },
		});
		client.close();
	});

	it("routes request progress by response id without notifying general listeners", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const progress: Array<[number, number]> = [];
		const discovered: string[] = [];
		let discoveredStatus: unknown;
		const listenerMessages: unknown[] = [];
		const unsubscribe = client.onMessage((message) => {
			listenerMessages.push(message);
		});
		const response = client.request(
			{ type: "list_saved_sessions", activeSessionId: "active-1", scope: "current" },
			30000,
			{
				onProgress: (message) => {
					if (message.type === "session_list_progress") {
						progress.push([message.loaded, message.total]);
					} else {
						discovered.push(message.session.id);
						discoveredStatus = message.session.agentStatus;
					}
				},
			},
		);
		expect(socket.writes).toHaveLength(1);
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			command?: { activeSessionId?: string; scope?: string };
		};

		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
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
				id: envelope.id,
				type: "session_list_item",
				command: "list_saved_sessions",
				activeSessionId: "active-1",
				session: {
					path: "/tmp/session-a.jsonl",
					id: "session-a",
					cwd: "/tmp",
					created: "2026-01-01T00:00:00.000Z",
					modified: "2026-01-02T00:00:00.000Z",
					messageCount: 1,
					firstMessage: "hello",
					allMessagesText: "hello",
					agentStatus: {
						summary: "Finished the task",
						taskState: "completed",
						basedOnMessageCount: 1,
					},
				},
			})}\n`,
		);
		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "response",
				command: "list_saved_sessions",
				success: true,
				data: { sessions: [] },
			})}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });
		expect(progress).toEqual([[1, 2]]);
		expect(discovered).toEqual(["session-a"]);
		expect(discoveredStatus).toEqual({
			summary: "Finished the task",
			taskState: "completed",
			basedOnMessageCount: 1,
		});
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
		emitHello(socket);

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
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			command?: {
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
		};

		expect(envelope).toMatchObject({
			type: "command",
			command: {
				type: "create",
				name: "configured",
				config: {
					cwd: "/tmp/project",
					model: "openai/gpt-4o-mini",
					tools: ["bash"],
				},
			},
		});
		expect(envelope.command).not.toHaveProperty("cwd");
		expect(envelope.command).not.toHaveProperty("model");

		socket.emit(
			"data",
			`${JSON.stringify({ id: envelope.id, type: "response", command: "create", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });

		client.close();
	});

	it("acknowledges durable mutating-command results on the current protocol", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "create" });
		const request = JSON.parse(socket.writes[0]!.trim()) as { id: string };
		socket.emit(
			"data",
			`${JSON.stringify({ id: request.id, type: "response", command: "create", success: true })}\n`,
		);
		await response;

		expect(socket.writes).toHaveLength(2);
		expect(JSON.parse(socket.writes[1]!.trim())).toMatchObject({
			type: "command",
			command: { type: "ack_result", commandId: request.id },
		});
		client.close();
	});

	it("notifies listeners when a connected daemon socket closes", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		expect(client.isConnected).toBe(false);

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		expect(client.isConnected).toBe(true);

		const closed: Error[] = [];
		const unsubscribe = client.onClose((error) => closed.push(error));

		socket.emit("close");

		expect(closed).toHaveLength(1);
		expect(closed[0]?.message).toContain("Connection to the Prime Agent daemon closed.");
		expect(closed[0]?.message).toContain("Socket: /tmp/prime-agent.sock.");
		expect(closed[0]?.message).toContain("Daemon log:");
		expect(client.isConnected).toBe(false);
		unsubscribe();
		client.close();
	});

	it.each(["shutdown", "update"] as const)("preserves the daemon %s reason on socket close", async (reason) => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const closed: Error[] = [];
		client.onClose((error) => closed.push(error));
		socket.emit("data", `${JSON.stringify({ type: "daemon_closing", reason })}\n`);
		socket.emit("close");

		expect(closed).toHaveLength(1);
		expect(getDaemonSocketCloseReason(closed[0]!)).toBe(reason);
		expect(closed[0]?.message).toContain(`Reason: ${reason}.`);
		client.close();
	});

	it("notifies every listener before disconnecting a shared client for update reconnect", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const firstClosed: Error[] = [];
		const secondClosed: Error[] = [];
		client.onClose((error) => firstClosed.push(error));
		client.onClose((error) => secondClosed.push(error));

		client.disconnectForReconnect("update");

		expect(client.isConnected).toBe(false);
		expect(firstClosed).toHaveLength(1);
		expect(secondClosed).toHaveLength(1);
		expect(getDaemonSocketCloseReason(firstClosed[0]!)).toBe("update");
		expect(getDaemonSocketCloseReason(secondClosed[0]!)).toBe("update");
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

	it("shares one reconnect attempt across concurrent callers", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		firstSocket.emit("close");

		const reconnectA = client.reconnect();
		const reconnectB = client.reconnect();
		expect(netMock.sockets).toHaveLength(2);
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");

		await expect(Promise.all([reconnectA, reconnectB])).resolves.toEqual([undefined, undefined]);
		client.close();
	});

	it("resends the same command envelope after a recoverable disconnect", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const response = client.request({ type: "prompt", activeSessionId: "active-1", message: "hello" });
		const firstWireData = firstSocket.writes[0]!;
		const firstEnvelope = JSON.parse(firstWireData) as { id: string };
		firstSocket.emit("close");

		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		expect(secondSocket.writes).toEqual([]);
		secondSocket.emit(
			"data",
			`${JSON.stringify({
				type: "daemon_hello",
				socketPath: "/tmp/prime-agent.sock",
				protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
				clientId: "server-client-2",
				serverCapabilities: [],
			})}\n`,
		);
		expect(secondSocket.writes).toEqual([firstWireData]);

		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: firstEnvelope.id, type: "response", command: "prompt", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: firstEnvelope.id, success: true });
		client.close();
	});

	it("queues commands created during a recoverable disconnect", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);
		firstSocket.emit("close");

		const response = client.request({
			type: "get_tool_definition",
			activeSessionId: "active-1",
			name: "bash",
		});
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		expect(secondSocket.writes).toEqual([]);
		emitHello(secondSocket);

		expect(secondSocket.writes).toHaveLength(1);
		const envelope = JSON.parse(secondSocket.writes[0]!) as { id: string; command: { type: string } };
		expect(envelope.command.type).toBe("get_tool_definition");
		secondSocket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "response",
				command: "get_tool_definition",
				success: true,
				data: {},
			})}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });
		client.close();
	});

	it("uses the last negotiated capabilities for commands queued during recovery", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket, DAEMON_PROTOCOL_VERSION, ["model_catalog"]);
		firstSocket.emit("close");

		const response = client.request({ type: "get_model_catalog", activeSessionId: "active-1" });
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket, DAEMON_PROTOCOL_VERSION, ["model_catalog"]);

		const envelope = JSON.parse(secondSocket.writes[0]!) as { id: string };
		secondSocket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "response",
				command: "get_model_catalog",
				success: true,
				data: { models: [], providers: [] },
			})}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });
		client.close();
	});

	it("rejects a queued command when the replacement daemon loses its required capability", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket, DAEMON_PROTOCOL_VERSION, ["model_catalog"]);
		firstSocket.emit("close");

		const response = client.request({ type: "get_model_catalog", activeSessionId: "active-1" });
		const rejection = expect(response).rejects.toThrow("does not support model_catalog");
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket, DAEMON_PROTOCOL_VERSION);

		await rejection;
		expect(secondSocket.writes).toEqual([]);
		client.close();
	});

	it("re-encodes a queued command for a replacement daemon with an older protocol", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);
		firstSocket.emit("close");

		const response = client.request({ type: "list" });
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket, 1);

		expect(secondSocket.writes).toHaveLength(1);
		const command = JSON.parse(secondSocket.writes[0]!.trim()) as { id: string; type: string };
		expect(command.type).toBe("list");
		expect(command).not.toHaveProperty("protocol");
		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: command.id, type: "response", command: "list", success: true })}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: command.id, success: true });
		client.close();
	});

	it("does not replay an in-flight mutation without durable envelopes", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const response = client.request({ type: "prompt", activeSessionId: "active-1", message: "hello" });
		const rejection = expect(response).rejects.toThrow("does not support durable command envelopes");
		firstSocket.emit("close");
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket, 1);

		await rejection;
		expect(secondSocket.writes).toEqual([]);
		client.close();
	});

	it("does not replay an in-flight mutation between legacy daemons", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket, 1);

		const response = client.request({ type: "prompt", activeSessionId: "active-1", message: "hello" });
		const rejection = expect(response).rejects.toThrow("does not support durable command envelopes");
		expect(firstSocket.writes).toHaveLength(1);
		firstSocket.emit("close");
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket, 1);

		await rejection;
		expect(secondSocket.writes).toEqual([]);
		client.close();
	});

	it("marks a mutation as sent before writing it to the socket", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket, 1);
		vi.spyOn(firstSocket, "write").mockImplementation((chunk) => {
			firstSocket.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			throw new Error("write failed after accepting data");
		});

		const response = client.request({ type: "prompt", activeSessionId: "active-1", message: "hello" });
		const rejection = expect(response).rejects.toThrow("write failed after accepting data");
		firstSocket.emit("close");
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket, 1);

		await rejection;
		expect(secondSocket.writes).toEqual([]);
		client.close();
	});

	it("sends a legacy mutation once when it was queued during recovery", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket, 1);
		firstSocket.emit("close");

		const response = client.request({ type: "prompt", activeSessionId: "active-1", message: "hello" });
		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket, 1);

		expect(secondSocket.writes).toHaveLength(1);
		const command = JSON.parse(secondSocket.writes[0]!.trim()) as { id: string; type: string };
		expect(command.type).toBe("prompt");
		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true })}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: command.id, success: true });
		client.close();
	});

	it("replays a restoration read when the worker closes during daemon teardown", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const response = client.request({ type: "get_messages", activeSessionId: "active-1" });
		const firstEnvelope = JSON.parse(firstSocket.writes[0]!) as { id: string };
		firstSocket.emit(
			"data",
			`${JSON.stringify({
				id: firstEnvelope.id,
				type: "response",
				command: "get_messages",
				success: false,
				error: "Daemon worker client closed",
			})}\n`,
		);
		firstSocket.emit("close");

		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket);
		const secondEnvelope = JSON.parse(secondSocket.writes[0]!) as { id: string };
		expect(secondEnvelope.id).toBe(firstEnvelope.id);
		secondSocket.emit(
			"data",
			`${JSON.stringify({
				id: secondEnvelope.id,
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [] },
			})}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: firstEnvelope.id, success: true });
		client.close();
	});

	it("surfaces a worker-close response when the daemon transport stays connected", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "get_messages", activeSessionId: "active-1" });
		const envelope = JSON.parse(socket.writes[0]!) as { id: string };
		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "response",
				command: "get_messages",
				success: false,
				error: "Daemon worker client closed",
			})}\n`,
		);
		let settled = false;
		void response.finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		await expect(response).resolves.toMatchObject({ id: envelope.id, success: false });
		client.close();
	});

	it("pauses the request timeout while waiting for a recoverable worker close", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "get_messages", activeSessionId: "active-1" }, 50);
		const envelope = JSON.parse(socket.writes[0]!) as { id: string };
		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "response",
				command: "get_messages",
				success: false,
				error: "Daemon worker client closed",
			})}\n`,
		);
		let settled = false;
		void response.finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		await expect(response).resolves.toMatchObject({ id: envelope.id, success: false });
		client.close();
	});

	it("does not time out a command queued for recoverable reconnection", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);
		firstSocket.emit("close");

		const response = client.request({ type: "list" }, 50);
		let settled = false;
		void response.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.advanceTimersByTimeAsync(500);
		expect(settled).toBe(false);

		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket);
		const envelope = JSON.parse(secondSocket.writes[0]!) as { id: string };
		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: envelope.id, type: "response", command: "list", success: true })}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });
		client.close();
	});

	it("pauses request timeouts while a recoverable connection is disconnected", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const response = client.request({ type: "list" }, 50);
		let settled = false;
		void response.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const firstEnvelope = JSON.parse(firstSocket.writes[0]!) as { id: string };
		firstSocket.emit("close");
		await vi.advanceTimersByTimeAsync(500);
		expect(settled).toBe(false);

		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket);
		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: firstEnvelope.id, type: "response", command: "list", success: true })}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: firstEnvelope.id, success: true });
		client.close();
	});

	it("reconnects raw clients and replays pending commands after supervisor replacement", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const statuses: string[] = [];
		const recoverDaemon = vi.fn(async () => {});
		client.enableAutoReconnect({
			recoverDaemon,
			onStatus: (status) => statuses.push(status.status),
		});
		const response = client.request({ type: "list" });
		const firstWireData = firstSocket.writes[0]!;
		const firstEnvelope = JSON.parse(firstWireData) as { id: string };

		firstSocket.emit("close");
		await vi.waitFor(() => expect(netMock.sockets).toHaveLength(2));
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await Promise.resolve();
		secondSocket.emit(
			"data",
			`${JSON.stringify({
				type: "daemon_hello",
				socketPath: "/tmp/prime-agent.sock",
				protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
				clientId: "server-client-2",
				serverCapabilities: [],
			})}\n`,
		);

		await vi.waitFor(() => expect(statuses).toEqual(["reconnecting", "connected"]));
		expect(recoverDaemon).toHaveBeenCalledOnce();
		expect(secondSocket.writes).toEqual([firstWireData]);

		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: firstEnvelope.id, type: "response", command: "list", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: firstEnvelope.id, success: true });
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
