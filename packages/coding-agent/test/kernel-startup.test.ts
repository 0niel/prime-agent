import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
	});

	afterEach(() => {
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
		const internals = manager as unknown as {
			doStart: () => Promise<void>;
			state: "idle" | "starting" | "running" | "shutdown";
			terminal: boolean;
			waitForResolvedConnection: () => Promise<never>;
		};
		internals.waitForResolvedConnection = async () => {
			throw new Error("connection unavailable");
		};

		await expect(manager.start()).rejects.toThrow("connection unavailable");
		expect(internals.terminal).toBe(false);
		expect(internals.state).toBe("idle");

		const retryStart = vi.fn(async () => {});
		internals.doStart = retryStart;
		await expect(manager.start()).resolves.toBeUndefined();
		expect(retryStart).toHaveBeenCalledOnce();
		manager.disposeSync();
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
		await expect(manager.start()).rejects.toThrow("Kernel was disposed");
	});
});
