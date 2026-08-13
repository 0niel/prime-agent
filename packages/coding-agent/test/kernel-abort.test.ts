import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	createHostRequestHandler,
	type HostRequestContext,
	KernelManager,
	type KernelSentAgentMessage,
} from "../src/core/kernel/index.js";

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (mock.mock.calls.length >= count) {
			return;
		}
		await Promise.resolve();
	}
	expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

describe("KernelManager abort handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not poison startup after a caller starts with an aborted signal", async () => {
		const manager = new KernelManager({ cwd: process.cwd() });
		let startCount = 0;
		Object.assign(
			manager as unknown as {
				doStart: () => Promise<void>;
			},
			{
				doStart: async () => {
					startCount++;
				},
			},
		);
		const controller = new AbortController();
		controller.abort();

		await expect(manager.start({ signal: controller.signal })).rejects.toThrow("Kernel startup aborted");
		await expect(manager.start()).resolves.toBeUndefined();
		expect(startCount).toBe(1);
	});

	it("does not cancel shared startup when one waiting caller aborts", async () => {
		const manager = new KernelManager({ cwd: process.cwd() });
		let releaseStart: () => void = () => {};
		let startCount = 0;
		Object.assign(
			manager as unknown as {
				doStart: () => Promise<void>;
			},
			{
				doStart: async () => {
					startCount++;
					await new Promise<void>((resolve) => {
						releaseStart = resolve;
					});
				},
			},
		);
		const controller = new AbortController();

		const firstStart = manager.start({ signal: controller.signal });
		const secondStart = manager.start();
		controller.abort();

		await expect(firstStart).rejects.toThrow("Kernel startup aborted");
		releaseStart();
		await expect(secondStart).resolves.toBeUndefined();
		expect(startCount).toBe(1);
	});

	it("settles an aborted execution when the kernel never reports idle", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		const shellSend = vi.fn(async (_frames: Buffer[]) => {});
		const controlSend = vi.fn(async (_frames: Buffer[]) => {});
		const kernelKill = vi.fn((_signal?: NodeJS.Signals | number) => true);
		Object.assign(
			manager as unknown as {
				state: "running";
				connection: {
					ip: "127.0.0.1";
					transport: "tcp";
					shell_port: number;
					iopub_port: number;
					stdin_port: number;
					control_port: number;
					hb_port: number;
					signature_scheme: "hmac-sha256";
					key: string;
					kernel_name: string;
				};
				shell: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				kernel: { kill: (signal?: NodeJS.Signals | number) => boolean };
				start: () => Promise<void>;
			},
			{
				state: "running",
				connection: {
					ip: "127.0.0.1",
					transport: "tcp",
					shell_port: 1,
					iopub_port: 2,
					stdin_port: 3,
					control_port: 4,
					hb_port: 5,
					signature_scheme: "hmac-sha256",
					key: "test-key",
					kernel_name: "python3",
				},
				shell: { send: shellSend, close: vi.fn() },
				control: { send: controlSend, close: vi.fn() },
				kernel: { kill: kernelKill },
				start: async () => {},
			},
		);
		const controller = new AbortController();
		const lateSentAgentMessages: KernelSentAgentMessage[] = [];

		const executePromise = manager.execute("while True: pass", {
			signal: controller.signal,
			onLateSentAgentMessage: (message) => lateSentAgentMessages.push(message),
		});
		await waitForCalls(shellSend, 1);
		expect(shellSend).toHaveBeenCalledTimes(1);

		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
		expect(controlSend).toHaveBeenCalled();
		expect(kernelKill).not.toHaveBeenCalled();

		const internals = manager as unknown as {
			activeExecution?: { requestMsgId: string };
			handleExecutionMessage: (incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}) => void;
		};
		const activeExecution = internals.activeExecution;
		expect(activeExecution).toBeDefined();
		if (!activeExecution) {
			throw new Error("Expected active execution to remain until kernel idle");
		}
		internals.handleExecutionMessage({
			header: { msg_type: "display_data" },
			parent_header: { msg_id: activeExecution.requestMsgId },
			metadata: {},
			content: {
				data: {
					[AGENT_MESSAGE_DISPLAY_MIME]: {
						id: "agentmsg-after-abort",
						message: "still sent",
						deliveryStatus: "delivered",
						target: { activeSessionId: "beta", sessionId: "session-beta" },
					},
				},
			},
		});
		expect(lateSentAgentMessages).toEqual([
			{
				id: "agentmsg-after-abort",
				message: "still sent",
				deliveryStatus: "delivered",
				target: { activeSessionId: "beta", sessionId: "session-beta" },
			},
		]);
		const secondExecutePromise = manager.execute("x = 1");
		await Promise.resolve();
		expect(shellSend).toHaveBeenCalledTimes(1);

		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: activeExecution.requestMsgId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await waitForCalls(shellSend, 2);
		expect(shellSend).toHaveBeenCalledTimes(2);

		const secondExecution = internals.activeExecution;
		expect(secondExecution).toBeDefined();
		if (!secondExecution) {
			throw new Error("Expected second execution to start after previous cell went idle");
		}
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: { msg_id: secondExecution.requestMsgId },
			metadata: {},
			content: { execution_state: "idle" },
		});
		await expect(secondExecutePromise).resolves.toMatchObject({ status: "ok" });

		manager.disposeSync();
		expect(kernelKill).toHaveBeenCalledWith("SIGTERM");
	});

	it("settles an aborted execution when shell send never resolves", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		const shellSend = vi.fn((_frames: Buffer[]) => new Promise<void>(() => {}));
		const controlSend = vi.fn(async (_frames: Buffer[]) => {});
		Object.assign(
			manager as unknown as {
				state: "running";
				connection: {
					ip: "127.0.0.1";
					transport: "tcp";
					shell_port: number;
					iopub_port: number;
					stdin_port: number;
					control_port: number;
					hb_port: number;
					signature_scheme: "hmac-sha256";
					key: string;
					kernel_name: string;
				};
				shell: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				start: () => Promise<void>;
			},
			{
				state: "running",
				connection: {
					ip: "127.0.0.1",
					transport: "tcp",
					shell_port: 1,
					iopub_port: 2,
					stdin_port: 3,
					control_port: 4,
					hb_port: 5,
					signature_scheme: "hmac-sha256",
					key: "test-key",
					kernel_name: "python3",
				},
				shell: { send: shellSend, close: vi.fn() },
				control: { send: controlSend, close: vi.fn() },
				start: async () => {},
			},
		);
		const controller = new AbortController();

		const executePromise = manager.execute("while True: pass", { signal: controller.signal });
		await waitForCalls(shellSend, 1);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);

		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });
		expect(controlSend).toHaveBeenCalled();
	});

	it("revokes a settled host-request context before a retained wrapper can replay it", async () => {
		let capturedContext: HostRequestContext | undefined;
		const implementation = vi.fn(async (_payload: Record<string, unknown>, context: HostRequestContext) => {
			capturedContext = context;
			return { ok: true };
		});
		const handler = createHostRequestHandler(implementation);
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			sendCommMessage: (_commId: string, data: Record<string, unknown>) => Promise<void>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		internals.state = "running";
		internals.connection = { key: "test" };
		internals.shell = { send: async () => {}, close: () => {} };
		internals.sendCommMessage = async () => {};
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "request", target_name: "host.request", data: { type: "test" } },
		});
		await vi.waitFor(() => expect(capturedContext).toBeDefined());
		await Promise.allSettled([...internals.inFlightHostRequests]);
		expect(capturedContext?.signal.aborted).toBe(true);
		if (!capturedContext) throw new Error("Expected genuine host request context");
		await expect(handler({ type: "test" }, capturedContext)).rejects.toThrow("host request authority was revoked");
		expect(implementation).toHaveBeenCalledTimes(1);
		manager.disposeSync();
	});

	it("revokes a comm-closed host-request context before a retained wrapper can replay it", async () => {
		let capturedContext: HostRequestContext | undefined;
		let resolveHandler: (() => void) | undefined;
		const implementation = vi.fn(async (_payload: Record<string, unknown>, context: HostRequestContext) => {
			capturedContext = context;
			await new Promise<void>((resolve) => {
				resolveHandler = resolve;
			});
			return { ok: true };
		});
		const handler = createHostRequestHandler(implementation);
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			sendCommMessage: (_commId: string, data: Record<string, unknown>) => Promise<void>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		internals.state = "running";
		internals.connection = { key: "test" };
		internals.shell = { send: async () => {}, close: () => {} };
		internals.sendCommMessage = async () => {};
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "request", target_name: "host.request", data: { type: "test" } },
		});
		await vi.waitFor(() => expect(capturedContext).toBeDefined());
		internals.handleCommMessage({ header: { msg_type: "comm_close" }, content: { comm_id: "request" } });
		expect(capturedContext?.signal.aborted).toBe(true);
		if (!capturedContext) throw new Error("Expected genuine host request context");
		await expect(handler({ type: "test" }, capturedContext)).rejects.toThrow("host request authority was revoked");
		expect(implementation).toHaveBeenCalledTimes(1);
		resolveHandler?.();
		await Promise.allSettled([...internals.inFlightHostRequests]);
		manager.disposeSync();
	});

	it("revokes host-request authority on comm close and never reads context from payload", async () => {
		let contextSignal: AbortSignal | undefined;
		let resolveHandler: (() => void) | undefined;
		const handler = createHostRequestHandler(async (_payload, context) => {
			contextSignal = context.signal;
			await new Promise<void>((resolve) => {
				resolveHandler = resolve;
			});
			return { current: !context.signal.aborted };
		});
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const sent: Record<string, unknown>[] = [];
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			sendCommMessage: (_commId: string, data: Record<string, unknown>) => Promise<void>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		internals.state = "running";
		internals.connection = { key: "test" };
		internals.shell = { send: async () => {}, close: () => {} };
		internals.sendCommMessage = async (_commId, data) => {
			sent.push(data);
		};
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: {
				comm_id: "request",
				target_name: "host.request",
				data: { type: "test", context: { forged: true } },
			},
		});
		await vi.waitFor(() => expect(contextSignal).toBeDefined());
		expect(contextSignal).toBeDefined();
		expect(contextSignal?.aborted).toBe(false);
		internals.handleCommMessage({ header: { msg_type: "comm_close" }, content: { comm_id: "request" } });
		expect(contextSignal?.aborted).toBe(true);
		resolveHandler?.();
		await Promise.allSettled([...internals.inFlightHostRequests]);
		expect(sent).toEqual([]);
		manager.disposeSync();
	});

	it("does not send a stale error to a reopened comm with the same id", async () => {
		let firstContext: HostRequestContext | undefined;
		let releaseFirst: (() => void) | undefined;
		const handler = createHostRequestHandler(async (_payload, context) => {
			if (!firstContext) {
				firstContext = context;
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
				throw new Error("first request failed after close");
			}
			return { request: "second" };
		});
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const sent: Record<string, unknown>[] = [];
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			sendCommMessage: (_commId: string, data: Record<string, unknown>) => Promise<void>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		internals.state = "running";
		internals.connection = { key: "test" };
		internals.shell = { send: async () => {}, close: () => {} };
		internals.sendCommMessage = async (_commId, data) => {
			sent.push(data);
		};
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "reused", target_name: "host.request", data: { type: "test" } },
		});
		await vi.waitFor(() => expect(firstContext).toBeDefined());
		internals.handleCommMessage({ header: { msg_type: "comm_close" }, content: { comm_id: "reused" } });
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "reused", target_name: "host.request", data: { type: "test" } },
		});
		await vi.waitFor(() => expect(sent).toContainEqual({ status: "ok", request: "second" }));
		releaseFirst?.();
		await Promise.allSettled([...internals.inFlightHostRequests]);
		expect(sent).toEqual([{ status: "ok", request: "second" }]);
		manager.disposeSync();
	});

	it("sends one error reply when a current host request throws", async () => {
		const handler = createHostRequestHandler(async () => {
			throw new Error("handler failed");
		});
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const sent: Record<string, unknown>[] = [];
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			sendCommMessage: (_commId: string, data: Record<string, unknown>) => Promise<void>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		internals.state = "running";
		internals.connection = { key: "test" };
		internals.shell = { send: async () => {}, close: () => {} };
		internals.sendCommMessage = async (_commId, data) => {
			sent.push(data);
		};
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "current", target_name: "host.request", data: { type: "test" } },
		});
		await Promise.allSettled([...internals.inFlightHostRequests]);
		expect(sent).toEqual([{ status: "error", error: "handler failed" }]);
		manager.disposeSync();
	});

	it("does not report handler failure or send an error reply when the ok reply fails", async () => {
		const implementation = vi.fn(async () => ({ completed: true }));
		const handler = createHostRequestHandler(implementation);
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const sendCommMessage = vi.fn(async () => {
			throw new Error("reply send failed");
		});
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			sendCommMessage: typeof sendCommMessage;
			inFlightHostRequests: Set<Promise<void>>;
			kernelStderr: string;
		};
		internals.state = "running";
		internals.connection = { key: "test" };
		internals.shell = { send: async () => {}, close: () => {} };
		internals.sendCommMessage = sendCommMessage;
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "ok-reply-fails", target_name: "host.request", data: { type: "test" } },
		});
		await Promise.allSettled([...internals.inFlightHostRequests]);
		expect(implementation).toHaveBeenCalledTimes(1);
		expect(sendCommMessage).toHaveBeenCalledTimes(1);
		expect(sendCommMessage).toHaveBeenCalledWith("ok-reply-fails", { status: "ok", completed: true });
		expect(internals.kernelStderr).toContain(
			"failed to send host request ok reply for comm ok-reply-fails: reply send failed",
		);
		expect(internals.kernelStderr).not.toContain("host request failed for comm ok-reply-fails");
		manager.disposeSync();
	});

	it("closes host-request admission before snapshot shutdown flushes", async () => {
		let capturedContext: HostRequestContext | undefined;
		let releaseHandler: (() => void) | undefined;
		let releaseFlush: (() => void) | undefined;
		let markFlushEntered: (() => void) | undefined;
		const flushEntered = new Promise<void>((resolve) => {
			markFlushEntered = resolve;
		});
		const implementation = vi.fn(async (_payload: Record<string, unknown>, context: HostRequestContext) => {
			capturedContext = context;
			await new Promise<void>((resolve) => {
				releaseHandler = resolve;
			});
			return { ok: true };
		});
		const handler = createHostRequestHandler(implementation);
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			flushSnapshotForDispose: () => Promise<void>;
			activeHostRequestControllers: Map<string, AbortController>;
			handledHostRequestCommIds: Set<string>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		Object.assign(internals, {
			state: "running",
			connection: { key: "test" },
			shell: { send: async () => {}, close: () => {} },
			flushSnapshotForDispose: async () => {
				markFlushEntered?.();
				await new Promise<void>((resolve) => {
					releaseFlush = resolve;
				});
			},
		});
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "existing", target_name: "host.request", data: { type: "test" } },
		});
		await vi.waitFor(() => expect(capturedContext).toBeDefined());

		const shutdownPromise = manager.shutdown({ snapshot: true });
		await flushEntered;
		expect(capturedContext?.signal.aborted).toBe(true);
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "late", target_name: "host.request", data: { type: "test" } },
		});
		expect(implementation).toHaveBeenCalledTimes(1);
		expect(internals.activeHostRequestControllers.has("late")).toBe(false);
		expect(internals.handledHostRequestCommIds.has("late")).toBe(false);

		releaseFlush?.();
		await shutdownPromise;
		releaseHandler?.();
		await Promise.allSettled([...internals.inFlightHostRequests]);
	});

	it("closes host-request admission before dispose flushes", async () => {
		let capturedContext: HostRequestContext | undefined;
		let releaseHandler: (() => void) | undefined;
		let releaseFlush: (() => void) | undefined;
		let markFlushEntered: (() => void) | undefined;
		const flushEntered = new Promise<void>((resolve) => {
			markFlushEntered = resolve;
		});
		const implementation = vi.fn(async (_payload: Record<string, unknown>, context: HostRequestContext) => {
			capturedContext = context;
			await new Promise<void>((resolve) => {
				releaseHandler = resolve;
			});
			return { ok: true };
		});
		const handler = createHostRequestHandler(implementation);
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const internals = manager as unknown as {
			state: "running";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			flushSnapshotForDispose: () => Promise<void>;
			activeHostRequestControllers: Map<string, AbortController>;
			handledHostRequestCommIds: Set<string>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		Object.assign(internals, {
			state: "running",
			connection: { key: "test" },
			shell: { send: async () => {}, close: () => {} },
			flushSnapshotForDispose: async () => {
				markFlushEntered?.();
				await new Promise<void>((resolve) => {
					releaseFlush = resolve;
				});
			},
		});
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "existing", target_name: "host.request", data: { type: "test" } },
		});
		await vi.waitFor(() => expect(capturedContext).toBeDefined());

		const disposePromise = manager.dispose();
		await flushEntered;
		expect(capturedContext?.signal.aborted).toBe(true);
		internals.handleCommMessage({
			header: { msg_type: "comm_open" },
			content: { comm_id: "late", target_name: "host.request", data: { type: "test" } },
		});
		expect(implementation).toHaveBeenCalledTimes(1);
		expect(internals.activeHostRequestControllers.has("late")).toBe(false);
		expect(internals.handledHostRequestCommIds.has("late")).toBe(false);

		releaseFlush?.();
		releaseHandler?.();
		await disposePromise;
	});

	it("restart reopens host-request admission only after shutdown settles", async () => {
		let capturedContext: HostRequestContext | undefined;
		let releaseShutdown: (() => void) | undefined;
		const shutdownSettled = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		const implementation = vi.fn(async (_payload: Record<string, unknown>, context: HostRequestContext) => {
			capturedContext = context;
			return { ok: true };
		});
		const handler = createHostRequestHandler(implementation);
		const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
		const internals = manager as unknown as {
			hostRequestsClosed: boolean;
			state: "idle" | "running" | "shutdown";
			connection: { key: string };
			shell: { send: () => Promise<void>; close: () => void };
			shutdownInternal: () => Promise<void>;
			start: () => Promise<void>;
			handleCommMessage: (message: { header: { msg_type: string }; content: Record<string, unknown> }) => void;
			sendCommMessage: (_commId: string, data: Record<string, unknown>) => Promise<void>;
			activeHostRequestControllers: Map<string, AbortController>;
			inFlightHostRequests: Set<Promise<void>>;
		};
		internals.hostRequestsClosed = true;
		internals.shutdownInternal = async () => {
			expect(internals.hostRequestsClosed).toBe(true);
			internals.state = "shutdown";
			await shutdownSettled;
		};
		internals.start = async () => {
			expect(internals.hostRequestsClosed).toBe(false);
			internals.state = "running";
			internals.connection = { key: "test" };
			internals.shell = { send: async () => {}, close: () => {} };
			internals.sendCommMessage = async () => {};
			internals.handleCommMessage({
				header: { msg_type: "comm_open" },
				content: { comm_id: "restarted-request", target_name: "host.request", data: { type: "test" } },
			});
		};

		const restartPromise = manager.restart();
		await Promise.resolve();
		expect(internals.hostRequestsClosed).toBe(true);
		releaseShutdown?.();
		await restartPromise;
		await Promise.allSettled([...internals.inFlightHostRequests]);

		expect(implementation).toHaveBeenCalledTimes(1);
		expect(capturedContext?.signal.aborted).toBe(true);
		expect(internals.activeHostRequestControllers.has("restarted-request")).toBe(false);
	});

	it("fails a later execution fast when the interrupted cell never idles", async () => {
		vi.useFakeTimers();
		const manager = new KernelManager({ cwd: process.cwd() });
		const shellSend = vi.fn(async (_frames: Buffer[]) => {});
		const controlSend = vi.fn(async (_frames: Buffer[]) => {});
		Object.assign(
			manager as unknown as {
				state: "running";
				connection: {
					ip: "127.0.0.1";
					transport: "tcp";
					shell_port: number;
					iopub_port: number;
					stdin_port: number;
					control_port: number;
					hb_port: number;
					signature_scheme: "hmac-sha256";
					key: string;
					kernel_name: string;
				};
				shell: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				start: () => Promise<void>;
			},
			{
				state: "running",
				connection: {
					ip: "127.0.0.1",
					transport: "tcp",
					shell_port: 1,
					iopub_port: 2,
					stdin_port: 3,
					control_port: 4,
					hb_port: 5,
					signature_scheme: "hmac-sha256",
					key: "test-key",
					kernel_name: "python3",
				},
				shell: { send: shellSend, close: vi.fn() },
				control: { send: controlSend, close: vi.fn() },
				start: async () => {},
			},
		);
		const controller = new AbortController();

		const executePromise = manager.execute("while True: pass", { signal: controller.signal });
		await waitForCalls(shellSend, 1);
		controller.abort();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(executePromise).resolves.toMatchObject({ status: "aborted" });

		const secondExecutePromise = manager.execute("x = 1");
		const secondExecuteExpectation = expect(secondExecutePromise).rejects.toThrow(
			"IPython kernel is still running the previously interrupted cell",
		);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(5000);

		await secondExecuteExpectation;
		expect(shellSend).toHaveBeenCalledTimes(1);
		expect(controlSend).toHaveBeenCalled();
		manager.disposeSync();
	});

	it("does not restart or reopen host-request admission when disposal races shutdown", async () => {
		let releaseShutdown: (() => void) | undefined;
		let markShutdownEntered: (() => void) | undefined;
		const shutdownEntered = new Promise<void>((resolve) => {
			markShutdownEntered = resolve;
		});
		const shutdownBlocked = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		const manager = new KernelManager({ cwd: process.cwd() });
		const start = vi.fn(async () => {});
		const internals = manager as unknown as {
			hostRequestsClosed: boolean;
			state: "idle" | "running" | "shutdown";
			shutdownInternal: () => Promise<void>;
			start: () => Promise<void>;
		};
		internals.shutdownInternal = async () => {
			markShutdownEntered?.();
			await shutdownBlocked;
		};
		internals.start = start;

		const restartPromise = manager.restart();
		await shutdownEntered;
		manager.disposeSync();
		expect(internals.hostRequestsClosed).toBe(true);
		releaseShutdown?.();

		await expect(restartPromise).rejects.toThrow("Kernel terminated during restart");
		expect(start).not.toHaveBeenCalled();
		expect(internals.hostRequestsClosed).toBe(true);
	});
});
