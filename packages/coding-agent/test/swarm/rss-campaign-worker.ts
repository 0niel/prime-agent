/**
 * Disposable, test-only child supervisor for the PR-B00B RSS campaign.
 * It deliberately has no provider imports, network client, daemon listener, or
 * persistent state.  The parent owns this process group and measures it.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

interface WorkerOptions {
	fanout: number;
	allocationMiB: number;
	scratch: string;
	fixtureCommand?: string;
	fixtureArgs: readonly string[];
}

type WorkerMessage =
	| { type: "boundary"; phase: "started" | "barrier-held" | "terminals" | "cleanup"; allocatedBytes: number }
	| { type: "result"; completed: number; failed: number; allocatedBytes: number };

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function positiveInteger(name: string, fallback?: number): number {
	const value = option(name) ?? (fallback === undefined ? undefined : String(fallback));
	const parsed = value === undefined ? Number.NaN : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid_${name.slice(2)}`);
	return parsed;
}

function options(): WorkerOptions {
	const fanout = positiveInteger("--fanout");
	const allocationMiB = positiveInteger("--allocation-mib", 1);
	const scratch = option("--scratch") ?? join(tmpdir(), "b00b-rss");
	const fixtureCommand = option("--fixture-command");
	const fixtureArgs: string[] = [];
	for (let index = 0; index < process.argv.length; index += 1) {
		if (process.argv[index] === "--fixture-arg") {
			const value = process.argv[index + 1];
			if (value === undefined) throw new Error("invalid_fixture_arg");
			fixtureArgs.push(value);
			index += 1;
		}
	}
	return { fanout, allocationMiB, scratch, fixtureCommand, fixtureArgs };
}

function safeEnvironment(worker: number, fanout: number, allocationBytes: number): NodeJS.ProcessEnv {
	const inherited = process.env;
	const environment: NodeJS.ProcessEnv = {
		B00B_WORKER_INDEX: String(worker),
		B00B_FANOUT: String(fanout),
		B00B_FIXTURE_ALLOCATION_BYTES: String(allocationBytes),
		LANG: "C",
		LC_ALL: "C",
	};
	for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec"]) {
		if (inherited[key]) environment[key] = inherited[key];
	}
	return environment;
}

// This fixture is intentionally local and deterministic. An integration can
// replace it with --fixture-command/--fixture-arg without the launcher ever
// serializing that command, its arguments, or its output into campaign data.
const BUILTIN_FIXTURE = [
	"const bytes=Number(process.env.B00B_FIXTURE_ALLOCATION_BYTES||0);",
	"const b=Buffer.allocUnsafe(bytes);for(let i=0;i<b.length;i+=4096)b[i]=1;",
	"setTimeout(()=>process.exit(0),50);",
].join("");

function runFixture(config: WorkerOptions, worker: number, allocationBytes: number): Promise<boolean> {
	const command = config.fixtureCommand ?? process.execPath;
	const args = config.fixtureCommand ? [...config.fixtureArgs] : ["-e", BUILTIN_FIXTURE];
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd: process.cwd(),
				detached: false,
				env: safeEnvironment(worker, config.fanout, allocationBytes),
				stdio: "ignore",
			});
		} catch {
			resolve(false);
			return;
		}
		child.once("error", () => resolve(false));
		child.once("exit", (code, signal) => resolve(code === 0 && signal === null));
	});
}

function send(message: WorkerMessage): void {
	process.send?.(message);
}

function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
	const config = options();
	const allocationBytes = config.allocationMiB * 1024 * 1024;
	// The supervisor allocation and each fixture allocation are touched so RSS
	// has a deliberate, numeric-only allocation proof.
	let allocation = Buffer.allocUnsafe(allocationBytes);
	for (let index = 0; index < allocation.length; index += 4096) allocation[index] = 1;
	const runtimeRoot = await mkdtemp(join(config.scratch, "b00b-rss-"));
	try {
		await Promise.all([mkdir(join(runtimeRoot, "agent")), mkdir(join(runtimeRoot, "socket")), mkdir(join(runtimeRoot, "output"))]);
		send({ type: "boundary", phase: "started", allocatedBytes: allocationBytes });
		const fixtures = Array.from({ length: config.fanout }, (_, index) => runFixture(config, index + 1, allocationBytes));
		// All fixture entries are dispatched before this boundary. This is an
		// observation boundary, never a permit, queue, or admission limiter.
		send({ type: "boundary", phase: "barrier-held", allocatedBytes: allocationBytes * (config.fanout + 1) });
		const results = await Promise.all(fixtures);
		const completed = results.filter(Boolean).length;
		send({ type: "boundary", phase: "terminals", allocatedBytes: allocationBytes * (config.fanout + 1) });
		// Hold the terminal boundary long enough for the 20 Hz parent sampler to
		// capture it; this is post-terminal observation only, not admission.
		await pause(100);
		allocation = Buffer.alloc(0);
		global.gc?.();
		await rm(runtimeRoot, { force: true, recursive: true });
		send({ type: "boundary", phase: "cleanup", allocatedBytes: 0 });
		send({ type: "result", completed, failed: config.fanout - completed, allocatedBytes: 0 });
	} finally {
		await rm(runtimeRoot, { force: true, recursive: true });
	}
}

await main();
