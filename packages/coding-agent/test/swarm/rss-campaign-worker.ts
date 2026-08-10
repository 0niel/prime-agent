/**
 * Disposable, test-only child supervisor for the B00B RSS campaign.
 * It deliberately has no provider imports, network client, daemon listener, or
 * persistent state. The parent owns this process group and measures it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface WorkerOptions {
	fanout: number;
	allocationMiB: number;
	scratch: string;
	fixtureCommand?: string;
	fixtureArgs: readonly string[];
	testIgnoreTerm: boolean;
}

type WorkerMessage =
	| {
			type: "boundary";
			phase: "started" | "barrier-held" | "terminals" | "cleanup";
			allocatedBytes: number;
			memberPids: readonly number[];
	  }
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
	return {
		fanout,
		allocationMiB,
		scratch,
		fixtureCommand,
		fixtureArgs,
		testIgnoreTerm: process.argv.includes("--test-ignore-term"),
	};
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

const BUILTIN_FIXTURE = [
	"const bytes=Number(process.env.B00B_FIXTURE_ALLOCATION_BYTES||0);",
	"const b=Buffer.allocUnsafe(bytes);for(let i=0;i<b.length;i+=4096)b[i]=1;",
	"setTimeout(()=>process.exit(0),50);",
].join("");

interface Fixture {
	pid: number;
	exit: Promise<boolean>;
}

function launchFixture(config: WorkerOptions, worker: number, allocationBytes: number): Fixture | undefined {
	const command = config.fixtureCommand ?? process.execPath;
	const args = config.fixtureCommand ? [...config.fixtureArgs] : ["-e", BUILTIN_FIXTURE];
	try {
		const child: ChildProcess = spawn(command, args, {
			cwd: process.cwd(),
			detached: false,
			env: safeEnvironment(worker, config.fanout, allocationBytes),
			stdio: "ignore",
		});
		if (!child.pid) return undefined;
		return {
			pid: child.pid,
			exit: new Promise((resolve) => {
				child.once("error", () => resolve(false));
				child.once("exit", (code, signal) => resolve(code === 0 && signal === null));
			}),
		};
	} catch {
		return undefined;
	}
}

function send(message: WorkerMessage): void {
	process.send?.(message);
}

function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function awaitRelease(): Promise<void> {
	return new Promise((resolve) => {
		process.once("message", (message: unknown) => {
			if ((message as { type?: unknown })?.type === "release") resolve();
		});
	});
}

async function main(): Promise<void> {
	const config = options();
	// No allocation, fixture, or descendant may exist before the parent has
	// authenticated this leader's PID/start/PGID and explicitly releases us.
	await awaitRelease();
	if (config.testIgnoreTerm) process.on("SIGTERM", () => {});
	const allocationBytes = config.allocationMiB * 1024 * 1024;
	let allocation = Buffer.allocUnsafe(allocationBytes);
	for (let index = 0; index < allocation.length; index += 4096) allocation[index] = 1;
	const runtimeRoot = await mkdtemp(join(config.scratch, "b00b-rss-"));
	try {
		await Promise.all([
			mkdir(join(runtimeRoot, "agent")),
			mkdir(join(runtimeRoot, "socket")),
			mkdir(join(runtimeRoot, "output")),
		]);
		const fixtures = Array.from({ length: config.fanout }, (_, index) =>
			launchFixture(config, index + 1, allocationBytes),
		);
		const memberPids = fixtures.flatMap((fixture) => (fixture ? [fixture.pid] : []));
		send({ type: "boundary", phase: "started", allocatedBytes: allocationBytes, memberPids });
		// Every fixture is dispatched before this observation boundary. It is never
		// a permit, queue, semaphore, or admission limiter.
		send({
			type: "boundary",
			phase: "barrier-held",
			allocatedBytes: allocationBytes * (config.fanout + 1),
			memberPids,
		});
		const results = await Promise.all(fixtures.map((fixture) => fixture?.exit ?? Promise.resolve(false)));
		const completed = results.filter(Boolean).length;
		send({ type: "boundary", phase: "terminals", allocatedBytes: allocationBytes * (config.fanout + 1), memberPids });
		await pause(100);
		allocation = Buffer.alloc(0);
		global.gc?.();
		await rm(runtimeRoot, { force: true, recursive: true });
		send({ type: "boundary", phase: "cleanup", allocatedBytes: 0, memberPids });
		send({ type: "result", completed, failed: config.fanout - completed, allocatedBytes: 0 });
	} finally {
		await rm(runtimeRoot, { force: true, recursive: true });
	}
}

await main();
