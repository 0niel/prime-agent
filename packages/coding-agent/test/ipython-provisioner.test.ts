import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

let tempDir = "";

function writeFakePython(opts: { sleepSeconds?: number } = {}): { python: string; countRuns: () => number } {
	const python = join(tempDir, "python");
	const countFile = join(tempDir, "runs");
	writeFileSync(
		python,
		[
			"#!/bin/sh",
			`echo run >> "${countFile}"`,
			...(opts.sleepSeconds ? [`sleep ${opts.sleepSeconds}`] : []),
			"exit 42",
			"",
		].join("\n"),
	);
	chmodSync(python, 0o755);
	const countRuns = () => {
		try {
			return readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
		} catch {
			return 0;
		}
	};
	return { python, countRuns };
}

describe("IpythonKernelProvisioner", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-provisioner-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("memoizes concurrent ensure() calls into one startup", async () => {
		const { python, countRuns } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, { python });

		const [a, b] = await Promise.allSettled([provisioner.ensure(), provisioner.ensure()]);
		expect(a.status).toBe("rejected");
		expect(b.status).toBe("rejected");
		expect(countRuns()).toBe(1);
	});

	it("retries after a failed startup instead of caching the rejection", async () => {
		const { python, countRuns } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, { python });

		await expect(provisioner.ensure()).rejects.toThrow(/Kernel exited before resolving ports/);
		await expect(provisioner.ensure()).rejects.toThrow(/Kernel exited before resolving ports/);
		expect(countRuns()).toBe(2);
	});

	it("prewarm() swallows the failure and the next ensure() starts fresh", async () => {
		const { python, countRuns } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, { python });

		provisioner.prewarm();
		expect(provisioner.manager).toBeUndefined();

		// Once the prewarm startup settles, ensure() must launch a second attempt.
		await vi.waitFor(async () => {
			await expect(provisioner.ensure()).rejects.toThrow();
			expect(countRuns()).toBeGreaterThanOrEqual(2);
		});
	});

	it("replays the current startup stage to listeners attaching mid-flight", async () => {
		const { python } = writeFakePython({ sleepSeconds: 1 });
		const provisioner = new IpythonKernelProvisioner(tempDir, { python });

		provisioner.prewarm();
		const messages: string[] = [];
		const joined = provisioner.ensure((message) => messages.push(message));
		expect(messages).toContain("Starting IPython kernel...");
		await expect(joined).rejects.toThrow();
	});

	it("dispose() settles a startup that is still in flight", async () => {
		const { python } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, { python });

		provisioner.prewarm();
		await provisioner.dispose();
		expect(provisioner.manager).toBeUndefined();
	});
});

describe("KernelManager session cleanup during startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-cleanup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("disposes a kernel that is still booting when its session is cleaned up", async () => {
		const python = join(tempDir, "python");
		// Never writes connection ports - stays in the booting phase until killed.
		writeFileSync(python, ["#!/bin/sh", "sleep 30", ""].join("\n"));
		chmodSync(python, 0o755);
		const sessionId = `provisioner-test-${Date.now()}`;
		const manager = new KernelManager({ python, cwd: tempDir, sessionId });

		try {
			const startup = manager.start();
			cleanupSessionResources(sessionId);
			await expect(startup).rejects.toThrow(/Kernel exited before resolving ports|disposed during startup/);
			expect(manager.isRunning).toBe(false);
		} finally {
			await manager.dispose();
		}
	});
});
