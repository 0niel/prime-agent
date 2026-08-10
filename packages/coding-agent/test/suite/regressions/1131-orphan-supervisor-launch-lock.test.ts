import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const launchTestState = vi.hoisted(() => ({
	launchSpecCalls: 0,
	spawnCalls: 0,
	interceptSpawn: false,
	onSpawn: undefined as (() => void) | undefined,
}));

interface ChildProcessModule {
	spawn(...args: unknown[]): unknown;
}

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<ChildProcessModule>();
	return {
		...actual,
		spawn(...args: unknown[]) {
			if (!launchTestState.interceptSpawn) {
				return actual.spawn(...args);
			}
			launchTestState.spawnCalls++;
			launchTestState.onSpawn?.();
			return { unref() {} };
		},
	};
});

interface SubprocessLaunchModule {
	createCliSubprocessLaunchSpec(args: readonly string[]): unknown;
}

vi.mock("../../../src/cli/subprocess-launch.js", async (importOriginal) => {
	const actual = await importOriginal<SubprocessLaunchModule>();
	return {
		...actual,
		createCliSubprocessLaunchSpec(args: readonly string[]) {
			launchTestState.launchSpecCalls++;
			return actual.createCliSubprocessLaunchSpec(args);
		},
	};
});

import {
	AgentDaemon,
	readSupervisorLaunchLockGeneration,
	removeSupervisorLaunchLockGeneration,
} from "../../../src/modes/daemon/daemon-mode.js";

interface LaunchHarness {
	supervisorLaunchInProgress: boolean;
	shuttingDown: boolean;
	canConnectToSupervisor: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	options: { defaultSessionConfig: { cwd: string } };
	launchReplacementSupervisor(supervisorSocketPath: string): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	launchTestState.launchSpecCalls = 0;
	launchTestState.spawnCalls = 0;
	launchTestState.interceptSpawn = false;
	launchTestState.onSpawn = undefined;
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function launchLockPath(supervisorSocketPath: string): string {
	const key = createHash("sha256").update(supervisorSocketPath).digest("hex").slice(0, 12);
	return join(dirname(supervisorSocketPath), `.supervisor-launch-${key}.lock`);
}

function createHarness(canConnect: () => Promise<boolean> = async () => true): LaunchHarness {
	return Object.assign(Object.create(AgentDaemon.prototype), {
		supervisorLaunchInProgress: false,
		shuttingDown: false,
		canConnectToSupervisor: vi.fn(canConnect),
		log: vi.fn(),
		options: { defaultSessionConfig: { cwd: process.cwd() } },
	}) as LaunchHarness;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function writeGeneration(lockDirectory: string, token: string): void {
	mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(lockDirectory, `${token}.owner.json`),
		`${JSON.stringify({ version: 1, token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	);
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
	it("does not delete a successor generation discovered after stale inspection", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-generation-"));
		tempDirs.push(root);
		const lockDirectory = join(root, ".supervisor-launch-generation.lock");
		writeGeneration(lockDirectory, "generation-a");
		const observedGeneration = readSupervisorLaunchLockGeneration(lockDirectory);
		expect(observedGeneration).toBe("generation-a");
		rmSync(lockDirectory, { recursive: true, force: true });
		writeGeneration(lockDirectory, "generation-b");

		expect(removeSupervisorLaunchLockGeneration(lockDirectory, observedGeneration!, "stale")).toBe(false);
		expect(readSupervisorLaunchLockGeneration(lockDirectory)).toBe("generation-b");
	});

	it("renews a held launch lock so a second contender cannot expire it", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-renew-"));
		tempDirs.push(root);
		const supervisorSocketPath = join(root, "daemon.sock");
		const lockDirectory = launchLockPath(supervisorSocketPath);
		const firstProbe = deferred<boolean>();
		const first = createHarness(() => firstProbe.promise);
		const firstLaunch = first.launchReplacementSupervisor(supervisorSocketPath);
		await vi.advanceTimersByTimeAsync(0);
		const firstGeneration = readSupervisorLaunchLockGeneration(lockDirectory);
		expect(firstGeneration).toEqual(expect.any(String));

		await vi.advanceTimersByTimeAsync(60_000);
		const second = createHarness();
		await second.launchReplacementSupervisor(supervisorSocketPath);

		expect(second.canConnectToSupervisor).not.toHaveBeenCalled();
		expect(readSupervisorLaunchLockGeneration(lockDirectory)).toBe(firstGeneration);
		firstProbe.resolve(true);
		await firstLaunch;
		expect(existsSync(lockDirectory)).toBe(false);
	});

	it("catches a transient refresh guard error and retries without losing the lock", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-refresh-error-"));
		tempDirs.push(root);
		const supervisorSocketPath = join(root, "daemon.sock");
		const lockDirectory = launchLockPath(supervisorSocketPath);
		const firstProbe = deferred<boolean>();
		const first = createHarness(() => firstProbe.promise);
		const firstLaunch = first.launchReplacementSupervisor(supervisorSocketPath);
		await vi.advanceTimersByTimeAsync(0);
		const generation = readSupervisorLaunchLockGeneration(lockDirectory);
		expect(generation).toEqual(expect.any(String));

		await vi.advanceTimersByTimeAsync(4000);
		mkdirSync(`${lockDirectory}.guard`, { mode: 0o700 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(first.log).toHaveBeenCalledWith(expect.stringContaining("could not refresh supervisor launch lock"));
		expect(readSupervisorLaunchLockGeneration(lockDirectory)).toBe(generation);

		rmSync(`${lockDirectory}.guard`, { recursive: true, force: true });
		await vi.advanceTimersByTimeAsync(5000);
		const second = createHarness();
		await second.launchReplacementSupervisor(supervisorSocketPath);
		expect(second.canConnectToSupervisor).not.toHaveBeenCalled();
		expect(readSupervisorLaunchLockGeneration(lockDirectory)).toBe(generation);

		firstProbe.resolve(true);
		await firstLaunch;
		expect(existsSync(lockDirectory)).toBe(false);
	});

	it("holds the generation guard through the final fence and spawn action", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-atomic-spawn-"));
		tempDirs.push(root);
		const supervisorSocketPath = join(root, "daemon.sock");
		let firstProbeCount = 0;
		const first = createHarness(async () => {
			firstProbeCount++;
			return firstProbeCount > 1;
		});
		const contender = createHarness();
		let contenderLaunch: Promise<void> | undefined;
		launchTestState.interceptSpawn = true;
		launchTestState.onSpawn = () => {
			contenderLaunch = contender.launchReplacementSupervisor(supervisorSocketPath);
		};

		await first.launchReplacementSupervisor(supervisorSocketPath);
		await contenderLaunch;

		expect(launchTestState.spawnCalls).toBe(1);
		expect(contender.canConnectToSupervisor).not.toHaveBeenCalled();
		expect(contender.log).toHaveBeenCalledWith(expect.stringContaining("failed to launch replacement supervisor"));
		expect(existsSync(launchLockPath(supervisorSocketPath))).toBe(false);
	});

	it("a stalled old launcher cannot delete its successor lock when it resumes", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-regression-1131-successor-"));
		tempDirs.push(root);
		const supervisorSocketPath = join(root, "daemon.sock");
		const lockDirectory = launchLockPath(supervisorSocketPath);
		const firstProbe = deferred<boolean>();
		const first = createHarness(() => firstProbe.promise);
		const firstLaunch = first.launchReplacementSupervisor(supervisorSocketPath);
		await Promise.resolve();
		const firstGeneration = readSupervisorLaunchLockGeneration(lockDirectory);
		expect(firstGeneration).toEqual(expect.any(String));

		const realNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000);
		const secondProbe = deferred<boolean>();
		const second = createHarness(() => secondProbe.promise);
		const secondLaunch = second.launchReplacementSupervisor(supervisorSocketPath);
		await Promise.resolve();
		await Promise.resolve();
		const secondGeneration = readSupervisorLaunchLockGeneration(lockDirectory);
		expect(secondGeneration).toEqual(expect.any(String));
		expect(secondGeneration).not.toBe(firstGeneration);

		firstProbe.resolve(false);
		await firstLaunch;
		expect(launchTestState.launchSpecCalls).toBe(0);
		expect(readSupervisorLaunchLockGeneration(lockDirectory)).toBe(secondGeneration);
		secondProbe.resolve(true);
		await secondLaunch;
		expect(existsSync(lockDirectory)).toBe(false);
	});
});
