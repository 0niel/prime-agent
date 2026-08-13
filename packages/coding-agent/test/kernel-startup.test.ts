import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";
let originalForkserver: string | undefined;

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		originalForkserver = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
	});

	afterEach(() => {
		if (originalForkserver === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		else process.env.PRIME_AGENT_KERNEL_FORKSERVER = originalForkserver;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fake kernel died before binding" >&2', "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("keeps a connection-resolution startup failure retryable", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", "sleep 30", ""].join("\n"));
		const manager = new KernelManager({ python, cwd: tempDir });
		let rejectRetry: (error: Error) => void = () => {};
		let markRetryEntered: () => void = () => {};
		const retryEntered = new Promise<void>((resolve) => {
			markRetryEntered = resolve;
		});
		let connectionAttempts = 0;
		const internals = manager as unknown as {
			state: "idle" | "starting" | "running" | "shutdown";
			terminal: boolean;
			hostRequestsClosed: boolean;
			waitForResolvedConnection: () => Promise<never>;
		};
		internals.waitForResolvedConnection = () => {
			connectionAttempts++;
			if (connectionAttempts === 1) return Promise.reject(new Error("connection unavailable"));
			return new Promise<never>((_resolve, reject) => {
				rejectRetry = reject;
				markRetryEntered();
			});
		};

		await expect(manager.start()).rejects.toThrow("connection unavailable");
		expect(internals.terminal).toBe(false);
		expect(internals.state).toBe("idle");

		const retry = manager.start();
		await retryEntered;
		expect(internals.hostRequestsClosed).toBe(false);
		manager.disposeSync();
		rejectRetry(new Error("connection unavailable"));
		await expect(retry).rejects.toThrow("connection unavailable");
	});

	it.each(["connection", "probe"] as const)(
		"does not make a %s failure retryable after concurrent disposal during cleanup",
		async (failurePoint) => {
			const python = join(tempDir, "python");
			writeExecutable(python, ["#!/bin/sh", "sleep 30", ""].join("\n"));
			const manager = new KernelManager({ python, cwd: tempDir });
			const failure = new Error(`${failurePoint} unavailable`);
			let releaseCleanup: () => void = () => {};
			const cleanupGate = new Promise<void>((resolve) => {
				releaseCleanup = resolve;
			});
			let cleanupStarted: () => void = () => {};
			const cleanupStartedGate = new Promise<void>((resolve) => {
				cleanupStarted = resolve;
			});
			const internals = manager as unknown as {
				state: "idle" | "starting" | "running" | "shutdown";
				terminal: boolean;
				waitForResolvedConnection: () => Promise<never>;
				probeReady: () => Promise<void>;
				shutdownInternal: () => Promise<void>;
			};
			if (failurePoint === "connection") {
				internals.waitForResolvedConnection = () => Promise.reject(failure);
			} else {
				internals.waitForResolvedConnection = async () =>
					({
						ip: "127.0.0.1",
						transport: "tcp" as const,
						shell_port: 1,
						iopub_port: 2,
						stdin_port: 3,
						control_port: 4,
						hb_port: 5,
						signature_scheme: "hmac-sha256" as const,
						key: "",
						kernel_name: "python3",
					}) as never;
				internals.probeReady = () => Promise.reject(failure);
			}
			internals.shutdownInternal = async () => {
				internals.state = "shutdown";
				cleanupStarted();
				await cleanupGate;
			};

			const start = manager.start();
			await cleanupStartedGate;
			manager.disposeSync();
			releaseCleanup();
			await expect(start).rejects.toBe(failure);
			expect(internals.terminal).toBe(true);
			expect(internals.state).toBe("shutdown");
			await expect(manager.start()).rejects.toThrow("Kernel was disposed");
		},
	);

	it("keeps disposal during startup terminal", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", "sleep 30", ""].join("\n"));
		const manager = new KernelManager({ python, cwd: tempDir });
		let rejectConnection: (error: Error) => void = () => {};
		let markConnectionWaitEntered: () => void = () => {};
		const connectionWaitEntered = new Promise<void>((resolve) => {
			markConnectionWaitEntered = resolve;
		});
		const internals = manager as unknown as {
			terminal: boolean;
			hostRequestsClosed: boolean;
			waitForResolvedConnection: () => Promise<never>;
		};
		internals.waitForResolvedConnection = () =>
			new Promise<never>((_resolve, reject) => {
				rejectConnection = reject;
				markConnectionWaitEntered();
			});

		const start = manager.start();
		await connectionWaitEntered;
		manager.disposeSync();
		rejectConnection(new Error("connection unavailable"));

		await expect(start).rejects.toThrow("connection unavailable");
		expect(internals.terminal).toBe(true);
		expect(internals.hostRequestsClosed).toBe(true);
		await expect(manager.start()).rejects.toThrow("Kernel was disposed");
	});

	it("rejects an external cell queued before terminal entry without dispatching it", async () => {
		const manager = new KernelManager({ cwd: tempDir });
		const firstEntered = vi.fn();
		let releaseFirst = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const executeInner = vi.fn(async (code: string) => {
			if (code === "first") {
				firstEntered();
				await firstGate;
			}
			return { stdout: "", stderr: "", status: "ok" as const, durationMs: 0 };
		});
		const internals = manager as unknown as {
			state: "idle" | "starting" | "running" | "shutdown";
			start(): Promise<void>;
			executeInner: typeof executeInner;
		};
		internals.state = "running";
		internals.start = async () => {};
		internals.executeInner = executeInner;

		const first = manager.execute("first");
		await vi.waitFor(() => expect(firstEntered).toHaveBeenCalledOnce());
		const secondRejection = expect(manager.execute("second")).rejects.toThrow("Kernel was disposed");
		const disposal = manager.dispose();
		releaseFirst();

		await expect(first).resolves.toMatchObject({ status: "ok" });
		await secondRejection;
		await disposal;
		expect(executeInner).toHaveBeenCalledTimes(1);
	});
});
