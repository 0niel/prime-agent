import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";

export interface KernelProcess {
	pid: number;
	ppid: number;
	connectionPath: string;
	tempDir: string;
}

export interface KernelFindings {
	strays: KernelProcess[];
	owned: KernelProcess[];
	staleTempDirs: string[];
	leakedTestDaemons: number[];
	psUnavailable: boolean;
}

export interface KernelFixResult {
	killedStrays: number[];
	removedTempDirs: number;
	skipped: Array<{ pid?: number; path?: string; reason: string }>;
	leakedTestDaemons: number[];
	psUnavailable: boolean;
}

const KERNEL_TEMP_DIR_PREFIX = "prime-agent-kernel-";
// Anchored full-argv match so wrappers merely mentioning ipykernel_launcher are never treated as kernels.
const KERNEL_COMMAND_PATTERN = /^(\S+) -m ipykernel_launcher -f (\S+\/connection\.json)$/;
const PYTHON_BINARY_PATTERN = /^python[\d.]*$/;
// Below this age a missing live reference may just be a kernel mid-startup.
const STALE_TEMP_DIR_AGE_MS = 60 * 60 * 1000;

function parseKernelCommand(command: string): { connectionPath: string; tempDir: string } | undefined {
	const match = command.match(KERNEL_COMMAND_PATTERN);
	if (!match || !PYTHON_BINARY_PATTERN.test(basename(match[1]!))) {
		return undefined;
	}
	const connectionPath = match[2]!;
	const tempDir = dirname(connectionPath);
	return basename(tempDir).startsWith(KERNEL_TEMP_DIR_PREFIX) ? { connectionPath, tempDir } : undefined;
}

/** Parse `ps -axo pid=,ppid=,args=` output into prime-agent IPython kernel processes. */
export function parseKernelProcesses(stdout: string): KernelProcess[] {
	const kernels: KernelProcess[] = [];
	for (const line of stdout.split("\n")) {
		const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (!fields) {
			continue;
		}
		const command = parseKernelCommand(fields[3]!.trim());
		if (!command) {
			continue;
		}
		kernels.push({
			pid: Number.parseInt(fields[1]!, 10),
			ppid: Number.parseInt(fields[2]!, 10),
			connectionPath: command.connectionPath,
			tempDir: command.tempDir,
		});
	}
	return kernels;
}

/** Report-only: leaked eng-4600 test daemon fixtures orphaned to init. */
export function parseLeakedTestDaemons(stdout: string): number[] {
	const pids: number[] = [];
	for (const line of stdout.split("\n")) {
		const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (!fields) {
			continue;
		}
		if (Number.parseInt(fields[2]!, 10) === 1 && fields[3]!.includes("eng-4600-supervisor-fixture")) {
			pids.push(Number.parseInt(fields[1]!, 10));
		}
	}
	return pids;
}

/** A kernel is stray only when orphaned to init; any live parent means owned. */
export function classifyStrayKernels(kernels: KernelProcess[]): { strays: KernelProcess[]; owned: KernelProcess[] } {
	const strays: KernelProcess[] = [];
	const owned: KernelProcess[] = [];
	for (const kernel of kernels) {
		(kernel.ppid === 1 ? strays : owned).push(kernel);
	}
	return { strays, owned };
}

export function classifyStaleTempDirs(
	dirs: ReadonlyArray<{ path: string; mtimeMs: number }>,
	psStdout: string,
	nowMs: number,
): string[] {
	// Loose substring match: any live command mentioning the connection path protects the dir, kernel or not.
	return dirs
		.filter(
			(dir) => !psStdout.includes(join(dir.path, "connection.json")) && nowMs - dir.mtimeMs > STALE_TEMP_DIR_AGE_MS,
		)
		.map((dir) => dir.path);
}

export interface KernelScanProbes {
	/** Full `ps -axo pid=,ppid=,args=` output, or undefined when ps failed. */
	runPs: () => string | undefined;
	listTempDirs: () => Array<{ path: string; mtimeMs: number }>;
	now: () => number;
}

const defaultScanProbes: KernelScanProbes = {
	runPs: () => {
		const ps = spawnSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" });
		return !ps.error && ps.status === 0 && typeof ps.stdout === "string" ? ps.stdout : undefined;
	},
	listTempDirs: scanKernelTempDirs,
	now: Date.now,
};

export async function scanKernelFindings(probes: KernelScanProbes = defaultScanProbes): Promise<KernelFindings> {
	const empty: KernelFindings = {
		strays: [],
		owned: [],
		staleTempDirs: [],
		leakedTestDaemons: [],
		psUnavailable: false,
	};
	if (process.platform === "win32") {
		return empty;
	}
	const stdout = probes.runPs();
	if (stdout === undefined) {
		// Without a process list liveness can't be established; fail closed and report nothing.
		return { ...empty, psUnavailable: true };
	}
	const { strays, owned } = classifyStrayKernels(parseKernelProcesses(stdout));
	return {
		strays,
		owned,
		staleTempDirs: classifyStaleTempDirs(probes.listTempDirs(), stdout, probes.now()),
		leakedTestDaemons: parseLeakedTestDaemons(stdout),
		psUnavailable: false,
	};
}

function scanKernelTempDirs(): Array<{ path: string; mtimeMs: number }> {
	const dirs: Array<{ path: string; mtimeMs: number }> = [];
	let entries: string[];
	try {
		entries = readdirSync(tmpdir());
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.startsWith(KERNEL_TEMP_DIR_PREFIX)) {
			continue;
		}
		const path = join(tmpdir(), entry);
		try {
			const stats = statSync(path);
			if (stats.isDirectory()) {
				dirs.push({ path, mtimeMs: stats.mtimeMs });
			}
		} catch {
			// Entry vanished between readdir and stat; ignore.
		}
	}
	return dirs;
}

export interface KernelReapHooks {
	recheckStray: (kernel: KernelProcess) => boolean;
	/** Resolves true only when the process is confirmed gone. */
	killProcess: (pid: number) => Promise<boolean>;
	removeDir: (path: string) => void;
	/** Only direct prime-agent-kernel-* children of this root may be removed. */
	tempRoot: string;
}

/** Pure recheck: the ps line must still show the same init-parented kernel command. */
export function confirmsStrayKernel(psLine: string, kernel: KernelProcess): boolean {
	const fields = psLine.trim().match(/^(\d+)\s+(.+)$/);
	if (!fields) {
		return false;
	}
	const command = parseKernelCommand(fields[2]!.trim());
	return Number.parseInt(fields[1]!, 10) === 1 && command?.connectionPath === kernel.connectionPath;
}

// Guards pid reuse between scan and kill: the pid must still show the same orphaned kernel command.
function recheckStrayKernel(kernel: KernelProcess): boolean {
	const ps = spawnSync("ps", ["-o", "ppid=,args=", "-p", String(kernel.pid)], { encoding: "utf8" });
	if (ps.error || ps.status !== 0 || typeof ps.stdout !== "string") {
		return false;
	}
	return confirmsStrayKernel(ps.stdout, kernel);
}

async function forceKillKernel(pid: number): Promise<boolean> {
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		// ESRCH means already gone; anything else (e.g. EPERM) is a failure.
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	if (await waitForExit(pid, 1000)) {
		return true;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	return waitForExit(pid, 1000);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) {
			return false;
		}
		await delay(50);
	}
	return true;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultReapHooks: KernelReapHooks = {
	recheckStray: recheckStrayKernel,
	killProcess: forceKillKernel,
	removeDir: (path) => rmSync(path, { recursive: true, force: true }),
	tempRoot: tmpdir(),
};

export async function reapKernelFindings(
	findings: KernelFindings,
	hooks: KernelReapHooks = defaultReapHooks,
): Promise<KernelFixResult> {
	const killedStrays: number[] = [];
	const skipped: Array<{ pid?: number; path?: string; reason: string }> = [];
	let removedTempDirs = 0;
	const removeDir = (path: string): void => {
		// Never delete outside the bounded sweep, even for paths parsed from system-wide ps rows.
		if (dirname(path) !== hooks.tempRoot || !basename(path).startsWith(KERNEL_TEMP_DIR_PREFIX)) {
			skipped.push({ path, reason: "outside current temp root; not removing" });
			return;
		}
		try {
			hooks.removeDir(path);
			removedTempDirs++;
		} catch {
			skipped.push({ path, reason: "could not remove temp dir" });
		}
	};
	for (const kernel of findings.strays) {
		if (!hooks.recheckStray(kernel)) {
			skipped.push({ pid: kernel.pid, reason: "no longer an orphaned kernel; not killing" });
			continue;
		}
		if (!(await hooks.killProcess(kernel.pid))) {
			// Keep the temp dir: the kernel may still be alive and using it.
			skipped.push({ pid: kernel.pid, reason: "could not confirm kernel exit; keeping its temp dir" });
			continue;
		}
		killedStrays.push(kernel.pid);
		removeDir(kernel.tempDir);
	}
	for (const path of findings.staleTempDirs) {
		removeDir(path);
	}
	return {
		killedStrays,
		removedTempDirs,
		skipped,
		leakedTestDaemons: findings.leakedTestDaemons,
		psUnavailable: findings.psUnavailable,
	};
}

export function formatKernelReport(findings: KernelFindings): string | undefined {
	const lines: string[] = [];
	if (findings.psUnavailable) {
		lines.push(chalk.dim("! could not scan processes (ps failed); skipping kernel checks"));
	}
	if (findings.strays.length > 0) {
		const pids = findings.strays.map((kernel) => kernel.pid).join(", ");
		lines.push(
			chalk.yellow(
				`! ${findings.strays.length} stray IPython kernel(s) (orphaned): pids ${pids} — run "prime-agent doctor --fix"`,
			),
		);
	}
	if (findings.staleTempDirs.length > 0) {
		lines.push(
			chalk.yellow(
				`! ${findings.staleTempDirs.length} stale kernel temp dir(s) in $TMPDIR — run "prime-agent doctor --fix"`,
			),
		);
	}
	if (findings.leakedTestDaemons.length > 0) {
		lines.push(formatLeakedTestDaemonWarning(findings.leakedTestDaemons));
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatLeakedTestDaemonWarning(pids: number[]): string {
	return chalk.dim(
		`! ${pids.length} leaked test daemon(s) (eng-4600 fixture, pids ${pids.join(", ")}) — not auto-fixed`,
	);
}

export function formatKernelFixResult(result: KernelFixResult): string | undefined {
	const lines: string[] = [];
	if (result.psUnavailable) {
		lines.push(chalk.dim("! could not scan processes (ps failed); skipping kernel checks"));
	}
	if (result.killedStrays.length > 0 || result.removedTempDirs > 0 || result.skipped.length > 0) {
		lines.push(
			chalk.green(
				`reaped kernels: killed ${result.killedStrays.length} stray kernel(s)` +
					(result.killedStrays.length > 0 ? ` (pids ${result.killedStrays.join(", ")})` : "") +
					`, removed ${result.removedTempDirs} temp dir(s)`,
			),
		);
	}
	for (const skip of result.skipped) {
		lines.push(chalk.dim(`kept   ${skip.pid !== undefined ? `pid ${skip.pid}` : skip.path}: ${skip.reason}`));
	}
	if (result.leakedTestDaemons.length > 0) {
		lines.push(formatLeakedTestDaemonWarning(result.leakedTestDaemons));
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

export function kernelJsonSummary(findings: KernelFindings): {
	strays: number;
	staleTempDirs: number;
	leakedTestDaemons: number;
	psUnavailable: boolean;
} {
	return {
		strays: findings.strays.length,
		staleTempDirs: findings.staleTempDirs.length,
		leakedTestDaemons: findings.leakedTestDaemons.length,
		psUnavailable: findings.psUnavailable,
	};
}
