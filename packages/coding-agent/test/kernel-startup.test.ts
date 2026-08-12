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
});
