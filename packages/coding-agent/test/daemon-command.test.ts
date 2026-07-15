import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonClientMock = vi.hoisted(() => {
	type Listener = (message: { type: string; activeSessionId?: string; event?: { type: string } }) => void;
	type CloseListener = (error: Error) => void;
	type Command = {
		type: string;
		name?: string;
		activeSessionId?: string;
		targetActiveSessionId?: string;
		fromActiveSessionId?: string;
		deliveryMode?: string;
		message?: string;
		schedule?: string;
		prompt?: string;
		sessionPath?: string;
		config?: { extensionFlagValues?: Record<string, boolean | string> };
	};
	type Response =
		| { type: "response"; command: string; success: true }
		| { type: "response"; command: string; success: false; error: string };

	const instances: MockDaemonClient[] = [];
	const behavior = {
		promptSucceeds: false,
		emitStaleAgentEndOnAttach: false,
	};

	class MockDaemonClient {
		readonly messageListeners = new Set<Listener>();
		readonly closeListeners = new Set<CloseListener>();
		readonly requests: Command[] = [];
		messageListenerCountAtClose: number | undefined;
		closeListenerCountAtClose: number | undefined;

		constructor(readonly socketPath: string) {
			instances.push(this);
		}

		async connect(): Promise<void> {}

		async request(command: Command): Promise<Response> {
			this.requests.push(command);
			if (command.type === "attach" && behavior.emitStaleAgentEndOnAttach) {
				this.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_end" } });
			}
			if (command.type === "prompt") {
				if (behavior.promptSucceeds) {
					return { type: "response", command: command.type, success: true };
				}
				return { type: "response", command: command.type, success: false, error: "prompt failed" };
			}
			return { type: "response", command: command.type, success: true };
		}

		onMessage(listener: Listener): () => void {
			this.messageListeners.add(listener);
			return () => {
				this.messageListeners.delete(listener);
			};
		}

		onClose(listener: CloseListener): () => void {
			this.closeListeners.add(listener);
			return () => {
				this.closeListeners.delete(listener);
			};
		}

		emitMessage(message: Parameters<Listener>[0]): void {
			for (const listener of [...this.messageListeners]) {
				listener(message);
			}
		}

		close(): void {
			this.messageListenerCountAtClose = this.messageListeners.size;
			this.closeListenerCountAtClose = this.closeListeners.size;
			for (const listener of [...this.closeListeners]) {
				listener(new Error("closed"));
			}
		}
	}

	return { MockDaemonClient, behavior, instances };
});

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: daemonClientMock.MockDaemonClient,
}));

import { handleDaemonCommand } from "../src/cli/daemon-command.js";

describe("daemon command", () => {
	let consoleErrorMessages: unknown[];

	beforeEach(() => {
		daemonClientMock.instances.length = 0;
		daemonClientMock.behavior.promptSucceeds = false;
		daemonClientMock.behavior.emitStaleAgentEndOnAttach = false;
		consoleErrorMessages = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null | undefined) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation((...messages: unknown[]) => {
			consoleErrorMessages.push(...messages);
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("cleans prompt listeners when the prompt request fails", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "prompt", "active-1", "hello"]),
		).rejects.toThrow("exit 1");

		const client = daemonClientMock.instances[0];
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
		expect(
			consoleErrorMessages.some((message) => typeof message === "string" && message.includes("prompt failed")),
		).toBe(true);
	});

	it("ignores stale agent_end events before a daemon prompt starts", async () => {
		daemonClientMock.behavior.promptSucceeds = true;
		daemonClientMock.behavior.emitStaleAgentEndOnAttach = true;
		const command = handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"prompt",
			"active-1",
			"hello",
		]);

		await flushPromises();

		const client = daemonClientMock.instances[0];
		expect(client?.requests.map((request) => request.type)).toEqual(["attach", "prompt"]);

		let resolved = false;
		void command.then(() => {
			resolved = true;
		});
		await flushPromises();
		expect(resolved).toBe(false);

		client?.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_start" } });
		client?.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_end" } });

		await expect(command).resolves.toBe(true);
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
	});

	it("ends json attach when the session closes", async () => {
		const command = handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"--json",
			"attach",
			"active-1",
		]);

		await flushPromises();

		const client = daemonClientMock.instances[0];
		expect(client?.requests.map((request) => request.type)).toEqual(["attach"]);

		client?.emitMessage({ type: "session_closed", activeSessionId: "active-1" });

		await expect(command).resolves.toBe(true);
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
	});

	it("keeps create session name after an unknown boolean extension flag", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "--unknown-typo", "my-session"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "create",
			name: "my-session",
			config: {
				extensionFlagValues: {
					"unknown-typo": true,
				},
			},
			sessionPath: undefined,
			continueRecent: undefined,
		});
	});

	it("parses extension flag values with equals without consuming the create name", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "--ticket=123", "my-session"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "create",
			name: "my-session",
			config: {
				extensionFlagValues: {
					ticket: "123",
				},
			},
			sessionPath: undefined,
			continueRecent: undefined,
		});
	});

	it("keeps bare --resume values as session id selectors", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "--resume", "abc123"]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toMatchObject({
			type: "create",
			sessionPath: "abc123",
		});
	});

	it("honors send delivery-mode flags after the target", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"worker",
				"--steer",
				"stop",
				"and",
				"re-plan",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: undefined,
			deliveryMode: "steer",
			message: "stop and re-plan",
		});
	});

	it("rejects unknown send options instead of folding them into the message", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "send", "worker", "--bogus", "hello"]),
		).rejects.toThrow("exit 1");

		expect(daemonClientMock.instances[0]?.requests).toEqual([]);
		expect(
			consoleErrorMessages.some(
				(message) => typeof message === "string" && message.includes("Unknown option for daemon send: --bogus"),
			),
		).toBe(true);
	});

	it("supports send separator after the target for flag-like message text", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"--follow-up",
				"worker",
				"--",
				"--from",
				"literal",
				"--steer",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: undefined,
			deliveryMode: "follow_up",
			message: "--from literal --steer",
		});
	});

	it("supports send separator before a flag-like target or message", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"--",
				"--target-like",
				"--from",
				"literal",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toMatchObject({
			type: "send_message",
			targetActiveSessionId: "--target-like",
			message: "--from literal",
		});
	});

	it("rejects extra agent-messages status arguments", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "agent-messages", "pause", "active-1"]),
		).rejects.toThrow("exit 1");

		expect(daemonClientMock.instances[0]?.requests).toEqual([]);
		expect(
			consoleErrorMessages.some(
				(message) => typeof message === "string" && message.includes("Usage: daemon agent-messages pause"),
			),
		).toBe(true);
	});

	it("parses send message text from an explicit --message value", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"send",
				"--from",
				"planner",
				"worker",
				"--message",
				"please keep --from literal --steer",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "send_message",
			targetActiveSessionId: "worker",
			fromActiveSessionId: "planner",
			deliveryMode: undefined,
			message: "please keep --from literal --steer",
		});
	});

	it("preserves cron add separator before the scheduled prompt", async () => {
		await expect(
			handleDaemonCommand([
				"daemon",
				"--socket",
				"/tmp/prime-agent.sock",
				"cron",
				"add",
				"active-1",
				"in 5m",
				"--",
				"check status",
			]),
		).resolves.toBe(true);

		const client = daemonClientMock.instances[0];
		expect(client?.requests[0]).toEqual({
			type: "cron_add",
			activeSessionId: "active-1",
			schedule: "in 5m",
			prompt: "check status",
		});
	});
});

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
