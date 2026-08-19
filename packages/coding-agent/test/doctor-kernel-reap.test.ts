import { describe, expect, it } from "vitest";
import {
	classifyStaleTempDirs,
	classifyStrayKernels,
	confirmsStrayKernel,
	forceKillKernel,
	type KernelFindings,
	type KernelProcess,
	type KernelReapHooks,
	parseForkedKernelRows,
	parseKernelProcesses,
	parseLeakedTestDaemons,
	reapKernelFindings,
	scanKernelFindings,
} from "../src/cli/doctor-kernel-reap.js";

const HOUR_MS = 60 * 60 * 1000;

function kernel(pid: number, ppid: number, tempDir: string): KernelProcess {
	return { pid, ppid, connectionPath: `${tempDir}/connection.json`, tempDir };
}

function findings(partial: Partial<KernelFindings>): KernelFindings {
	return {
		strays: [],
		owned: [],
		staleTempDirs: [],
		leakedTestDaemons: [],
		forkedKernelsPresent: 0,
		orphanedForkedKernels: [],
		psUnavailable: false,
		...partial,
	};
}

const FORK_SERVER_ROW = (pid: number, ppid: number): string =>
	`  ${pid}   ${ppid} /home/u/.prime/agent/kernel-venv/bin/python -c import gc,os,sys /tmp/prime-agent-forkserver-ab12/control.sock`;

describe("parseKernelProcesses", () => {
	const stdout = [
		"  111     1 /home/u/.venv/bin/python -m ipykernel_launcher -f /tmp/prime-agent-kernel-abc123/connection.json",
		"  222   500 /usr/bin/python3 -m ipykernel_launcher -f /tmp/jupyter-runtime/connection.json",
		"  333     1 /usr/bin/python3 scripts/train.py",
		"  444     1 prime-agent --mode daemon",
		"",
	].join("\n");

	it("extracts only prime-agent kernel processes with pid, ppid, and temp dir", () => {
		expect(parseKernelProcesses(stdout)).toEqual([
			{
				pid: 111,
				ppid: 1,
				connectionPath: "/tmp/prime-agent-kernel-abc123/connection.json",
				tempDir: "/tmp/prime-agent-kernel-abc123",
			},
		]);
	});

	it("rejects lookalike commands that only mention ipykernel_launcher", () => {
		const lookalikes = [
			"  111     1 node wrapper -m ipykernel_launcher -f /tmp/prime-agent-kernel-x/connection.json",
			"  222     1 /usr/bin/python -m ipykernel_launcher -f /tmp/prime-agent-kernel-x/connection.json --extra",
			"  333     1 sh -c 'python -m ipykernel_launcher -f /tmp/prime-agent-kernel-x/connection.json'",
			"  444     1 /opt/pythonish -m ipykernel_launcher -f /tmp/prime-agent-kernel-x/connection.json",
			"",
		].join("\n");
		expect(parseKernelProcesses(lookalikes)).toEqual([]);
	});
});

describe("parseLeakedTestDaemons", () => {
	it("reports eng-4600 fixture processes only when orphaned to init", () => {
		const stdout = [
			"  555     1 node test/eng-4600-supervisor-fixture.ts --daemon",
			"  666   777 node test/eng-4600-supervisor-fixture.ts --daemon",
			"  888     1 node unrelated.js",
			"",
		].join("\n");
		expect(parseLeakedTestDaemons(stdout)).toEqual([555]);
	});
});

describe("parseForkedKernelRows", () => {
	it("matches only rows referencing a forkserver socket dir", () => {
		const stdout = [
			FORK_SERVER_ROW(900, 1),
			"  111     1 /home/u/.venv/bin/python -m ipykernel_launcher -f /tmp/prime-agent-kernel-abc/connection.json",
			"  333     1 node unrelated.js",
			"",
		].join("\n");
		expect(parseForkedKernelRows(stdout)).toEqual([{ pid: 900, ppid: 1 }]);
	});
});

describe("classifyStrayKernels", () => {
	it("treats only exactly init-parented kernels as stray", () => {
		const orphan = kernel(111, 1, "/tmp/prime-agent-kernel-a");
		const attached = kernel(222, 4321, "/tmp/prime-agent-kernel-b");
		const kernelParent = kernel(333, 0, "/tmp/prime-agent-kernel-c");
		expect(classifyStrayKernels([orphan, attached, kernelParent])).toEqual({
			strays: [orphan],
			owned: [attached, kernelParent],
		});
	});
});

describe("classifyStaleTempDirs", () => {
	const now = 10 * HOUR_MS;
	const psStdout =
		"  111     1 /usr/bin/python3 -m ipykernel_launcher -f /tmp/prime-agent-kernel-live/connection.json\n";

	it("marks old unreferenced dirs stale", () => {
		expect(
			classifyStaleTempDirs([{ path: "/tmp/prime-agent-kernel-old", mtimeMs: now - 2 * HOUR_MS }], psStdout, now),
		).toEqual(["/tmp/prime-agent-kernel-old"]);
	});

	it("keeps dirs referenced by a live kernel", () => {
		expect(
			classifyStaleTempDirs([{ path: "/tmp/prime-agent-kernel-live", mtimeMs: now - 2 * HOUR_MS }], psStdout, now),
		).toEqual([]);
	});

	it("keeps old dirs referenced by any live command, even non-killable lookalikes", () => {
		const lookalike =
			"  111     1 node wrapper -m ipykernel_launcher -f /tmp/prime-agent-kernel-wrapped/connection.json\n";
		expect(
			classifyStaleTempDirs(
				[{ path: "/tmp/prime-agent-kernel-wrapped", mtimeMs: now - 2 * HOUR_MS }],
				lookalike,
				now,
			),
		).toEqual([]);
	});

	it("keeps fresh dirs even when unreferenced", () => {
		expect(
			classifyStaleTempDirs([{ path: "/tmp/prime-agent-kernel-new", mtimeMs: now - HOUR_MS / 2 }], psStdout, now),
		).toEqual([]);
	});
});

describe("scanKernelFindings", () => {
	it("fails closed when ps is unavailable: reports nothing fixable", async () => {
		const result = await scanKernelFindings({
			runPs: () => undefined,
			listTempDirs: () => [{ path: "/tmp/prime-agent-kernel-old", mtimeMs: 0 }],
			now: () => 10 * HOUR_MS,
		});
		expect(result).toEqual(findings({ psUnavailable: true }));
	});

	it("classifies stale dirs against the live kernel set when ps succeeds", async () => {
		const result = await scanKernelFindings({
			runPs: () =>
				"  111     1 /usr/bin/python3 -m ipykernel_launcher -f /tmp/prime-agent-kernel-live/connection.json\n",
			listTempDirs: () => [
				{ path: "/tmp/prime-agent-kernel-live", mtimeMs: 0 },
				{ path: "/tmp/prime-agent-kernel-old", mtimeMs: 0 },
			],
			now: () => 10 * HOUR_MS,
		});
		expect(result.strays).toEqual([kernel(111, 1, "/tmp/prime-agent-kernel-live")]);
		expect(result.staleTempDirs).toEqual(["/tmp/prime-agent-kernel-old"]);
		expect(result.psUnavailable).toBe(false);
	});

	it("skips stale temp dir classification entirely while forkserver-backed kernels run", async () => {
		const withForkServer = await scanKernelFindings({
			runPs: () => `${FORK_SERVER_ROW(900, 800)}\n`,
			listTempDirs: () => [{ path: "/tmp/prime-agent-kernel-old", mtimeMs: 0 }],
			now: () => 10 * HOUR_MS,
		});
		expect(withForkServer.staleTempDirs).toEqual([]);
		expect(withForkServer.forkedKernelsPresent).toBe(1);
		const control = await scanKernelFindings({
			runPs: () => "  900   800 /usr/bin/python3 unrelated.py\n",
			listTempDirs: () => [{ path: "/tmp/prime-agent-kernel-old", mtimeMs: 0 }],
			now: () => 10 * HOUR_MS,
		});
		expect(control.staleTempDirs).toEqual(["/tmp/prime-agent-kernel-old"]);
		expect(control.forkedKernelsPresent).toBe(0);
	});

	it("reports orphaned forkserver-backed kernels without ever classifying them as strays", async () => {
		const result = await scanKernelFindings({
			runPs: () => `${FORK_SERVER_ROW(901, 1)}\n${FORK_SERVER_ROW(902, 800)}\n`,
			listTempDirs: () => [],
			now: () => 10 * HOUR_MS,
		});
		expect(result.strays).toEqual([]);
		expect(result.forkedKernelsPresent).toBe(2);
		expect(result.orphanedForkedKernels).toEqual([901]);
	});

	it("protects an old dir referenced by a live command the kill classifier rejects", async () => {
		const result = await scanKernelFindings({
			runPs: () =>
				"  111     1 node wrapper -m ipykernel_launcher -f /tmp/prime-agent-kernel-wrapped/connection.json\n",
			listTempDirs: () => [{ path: "/tmp/prime-agent-kernel-wrapped", mtimeMs: 0 }],
			now: () => 10 * HOUR_MS,
		});
		expect(result.strays).toEqual([]);
		expect(result.staleTempDirs).toEqual([]);
	});
});

describe("confirmsStrayKernel", () => {
	const stray = kernel(111, 1, "/tmp/prime-agent-kernel-a");

	it("confirms the same init-parented kernel command", () => {
		expect(
			confirmsStrayKernel(
				"    1 /usr/bin/python3 -m ipykernel_launcher -f /tmp/prime-agent-kernel-a/connection.json",
				stray,
			),
		).toBe(true);
	});

	it("rejects lookalikes, reparented kernels, and other connection files", () => {
		for (const line of [
			"    1 node wrapper -m ipykernel_launcher -f /tmp/prime-agent-kernel-a/connection.json",
			" 4321 /usr/bin/python3 -m ipykernel_launcher -f /tmp/prime-agent-kernel-a/connection.json",
			"    1 /usr/bin/python3 -m ipykernel_launcher -f /tmp/prime-agent-kernel-b/connection.json",
			"",
		]) {
			expect(confirmsStrayKernel(line, stray)).toBe(false);
		}
	});
});

describe("reapKernelFindings", () => {
	function fakeHooks(
		recheck: (kernel: KernelProcess) => boolean,
		killOutcome = true,
	): { hooks: KernelReapHooks; killed: number[]; removed: string[] } {
		const killed: number[] = [];
		const removed: string[] = [];
		return {
			hooks: {
				recheckStray: recheck,
				killProcess: async (target) => {
					killed.push(target.pid);
					return killOutcome;
				},
				removeDir: (path) => {
					removed.push(path);
				},
				tempRoot: "/tmp",
			},
			killed,
			removed,
		};
	}

	it("kills confirmed strays and removes their dirs plus stale dirs", async () => {
		const { hooks, killed, removed } = fakeHooks(() => true);
		const result = await reapKernelFindings(
			findings({
				strays: [kernel(111, 1, "/tmp/prime-agent-kernel-a")],
				staleTempDirs: ["/tmp/prime-agent-kernel-stale"],
			}),
			hooks,
		);
		expect(killed).toEqual([111]);
		expect(removed).toEqual(["/tmp/prime-agent-kernel-a", "/tmp/prime-agent-kernel-stale"]);
		expect(result).toEqual({
			killedStrays: [111],
			removedTempDirs: 2,
			skipped: [],
			leakedTestDaemons: [],
			forkedKernelsPresent: 0,
			orphanedForkedKernels: [],
			psUnavailable: false,
		});
	});

	it("declines to kill a kernel whose recheck shows a live parent", async () => {
		const { hooks, killed, removed } = fakeHooks(() => false);
		const result = await reapKernelFindings(
			findings({ strays: [kernel(111, 1, "/tmp/prime-agent-kernel-a")] }),
			hooks,
		);
		expect(killed).toEqual([]);
		expect(removed).toEqual([]);
		expect(result.killedStrays).toEqual([]);
		expect(result.skipped).toEqual([{ pid: 111, reason: "no longer an orphaned kernel; not killing" }]);
	});

	it("keeps the temp dir and reports a skip when the kill is not confirmed", async () => {
		const { hooks, killed, removed } = fakeHooks(() => true, false);
		const result = await reapKernelFindings(
			findings({ strays: [kernel(111, 1, "/tmp/prime-agent-kernel-a")] }),
			hooks,
		);
		expect(killed).toEqual([111]);
		expect(removed).toEqual([]);
		expect(result.killedStrays).toEqual([]);
		expect(result.skipped).toEqual([{ pid: 111, reason: "could not confirm kernel exit; keeping its temp dir" }]);
	});

	it("kills a stray in a foreign temp root but leaves its directory untouched", async () => {
		const { hooks, killed, removed } = fakeHooks(() => true);
		const result = await reapKernelFindings(
			findings({ strays: [kernel(111, 1, "/var/other-tmp/prime-agent-kernel-a")] }),
			hooks,
		);
		expect(killed).toEqual([111]);
		expect(removed).toEqual([]);
		expect(result.killedStrays).toEqual([111]);
		expect(result.skipped).toEqual([
			{ path: "/var/other-tmp/prime-agent-kernel-a", reason: "outside current temp root; not removing" },
		]);
	});

	it("keeps the dir and records a skip when the pre-SIGKILL identity recheck shows a different command", async () => {
		const stray = kernel(111, 1, "/tmp/prime-agent-kernel-a");
		const signals: NodeJS.Signals[] = [];
		const removed: string[] = [];
		const result = await reapKernelFindings(findings({ strays: [stray] }), {
			recheckStray: () => true,
			killProcess: (target) =>
				forceKillKernel(target, {
					kill: (_pid, signal) => {
						signals.push(signal);
					},
					pidIdentity: () => "other",
					waitForExit: async () => false,
				}),
			removeDir: (path) => {
				removed.push(path);
			},
			tempRoot: "/tmp",
		});
		expect(signals).toEqual(["SIGTERM"]);
		expect(removed).toEqual([]);
		expect(result.killedStrays).toEqual([]);
		expect(result.skipped).toEqual([{ pid: 111, reason: "could not confirm kernel exit; keeping its temp dir" }]);
	});

	it("never touches owned kernels and passes leaked test daemons through for reporting", async () => {
		const { hooks, killed, removed } = fakeHooks(() => true);
		const result = await reapKernelFindings(
			findings({ owned: [kernel(222, 4321, "/tmp/prime-agent-kernel-b")], leakedTestDaemons: [555] }),
			hooks,
		);
		expect(killed).toEqual([]);
		expect(removed).toEqual([]);
		expect(result.leakedTestDaemons).toEqual([555]);
	});
});

describe("forceKillKernel", () => {
	const stray = kernel(111, 1, "/tmp/prime-agent-kernel-a");

	it("does not send SIGKILL when the pid now belongs to a different process", async () => {
		const signals: NodeJS.Signals[] = [];
		const confirmed = await forceKillKernel(stray, {
			kill: (_pid, signal) => {
				signals.push(signal);
			},
			// Survives SIGTERM, but by SIGKILL time the pid shows a different command.
			pidIdentity: () => "other",
			waitForExit: async () => false,
		});
		expect(signals).toEqual(["SIGTERM"]);
		expect(confirmed).toBe(false);
	});

	it("treats a pid that vanished after SIGTERM as a confirmed exit", async () => {
		const signals: NodeJS.Signals[] = [];
		const confirmed = await forceKillKernel(stray, {
			kill: (_pid, signal) => {
				signals.push(signal);
			},
			pidIdentity: () => "gone",
			waitForExit: async () => false,
		});
		expect(signals).toEqual(["SIGTERM"]);
		expect(confirmed).toBe(true);
	});

	it("escalates to SIGKILL only when the pid still shows the same orphaned kernel", async () => {
		const signals: NodeJS.Signals[] = [];
		let waits = 0;
		const confirmed = await forceKillKernel(stray, {
			kill: (_pid, signal) => {
				signals.push(signal);
			},
			pidIdentity: () => "stray-kernel",
			waitForExit: async () => ++waits > 1,
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(confirmed).toBe(true);
	});
});
