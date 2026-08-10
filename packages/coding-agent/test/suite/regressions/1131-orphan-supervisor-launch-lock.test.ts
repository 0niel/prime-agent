import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";

interface LaunchHarness {
	supervisorLaunchInProgress: boolean;
	shuttingDown: boolean;
	canConnectToSupervisor: ReturnType<typeof vi.fn>;
	launchReplacementSupervisor(supervisorSocketPath: string): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function launchLockPath(supervisorSocketPath: string): string {
	const key = createHash("sha256").update(supervisorSocketPath).digest("hex").slice(0, 12);
	return join(dirname(supervisorSocketPath), `.supervisor-launch-${key}.lock`);
}

function createHarness(): LaunchHarness {
	return Object.assign(Object.create(AgentDaemon.prototype), {
		supervisorLaunchInProgress: false,
		shuttingDown: false,
		canConnectToSupervisor: vi.fn(async () => true),
	}) as LaunchHarness;
}

describe("#1131 orphan supervisor launch lock recovery", () => {
	it("reclaims an empty lock directory left by an interrupted launch", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-empty-"));
		tempDirs.push(root);
		const supervisorSocketPath = join(root, "daemon.sock");
		const lockDirectory = launchLockPath(supervisorSocketPath);
		mkdirSync(lockDirectory, { mode: 0o700 });
		const daemon = createHarness();

		await daemon.launchReplacementSupervisor(supervisorSocketPath);

		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
		expect(existsSync(lockDirectory)).toBe(false);
	});

	it("reclaims an expired legacy lock even when its pid has been reused", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-"));
		tempDirs.push(root);
		const supervisorSocketPath = join(root, "daemon.sock");
		const lockDirectory = launchLockPath(supervisorSocketPath);
		mkdirSync(lockDirectory, { mode: 0o700 });
		writeFileSync(join(lockDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
		const expired = new Date(Date.now() - 60_000);
		utimesSync(lockDirectory, expired, expired);
		const daemon = createHarness();

		await daemon.launchReplacementSupervisor(supervisorSocketPath);

		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
		expect(existsSync(lockDirectory)).toBe(false);
		expect(daemon.supervisorLaunchInProgress).toBe(false);
	});

	it("does not steal a fresh lock from a live launcher", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-live-"));
		tempDirs.push(root);
		const supervisorSocketPath = join(root, "daemon.sock");
		const lockDirectory = launchLockPath(supervisorSocketPath);
		mkdirSync(lockDirectory, { mode: 0o700 });
		writeFileSync(join(lockDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
		const daemon = createHarness();

		await daemon.launchReplacementSupervisor(supervisorSocketPath);

		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
		expect(existsSync(lockDirectory)).toBe(true);
		expect(daemon.supervisorLaunchInProgress).toBe(false);
	});
});
