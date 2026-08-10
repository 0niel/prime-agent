import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getDaemonLogPath } from "../src/config.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../tsconfig.json");
const fauxExtensionPath = resolve(__dirname, "fixtures/eng-4600-faux-extension.ts");
const children = new Set<ChildProcess>();
const tempRoots = new Set<string>();
const daemonSockets = new Set<string>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(1000);
			await client.request({ type: "shutdown" }, 10_000);
		} catch {
			// A failed smoke may stop before the supervisor is reachable.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
	tempRoots.clear();
});

async function runRpcSmoke(
	agentDir: string,
	socketPath: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(
		process.execPath,
		[
			tsxPath,
			cliPath,
			"--mode",
			"rpc",
			"--daemon-socket",
			socketPath,
			"--model",
			"faux/faux",
			"--extension",
			fauxExtensionPath,
			"--no-tools",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
		],
		{
			env: {
				...process.env,
				TSX_TSCONFIG_PATH: repoTsconfigPath,
				[ENV_AGENT_DIR]: agentDir,
				PI_SKIP_VERSION_CHECK: "1",
				PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "0",
				PRIME_AGENT_INTERNAL_DAEMON_WORKER: undefined,
				PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: undefined,
				PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: undefined,
				PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: undefined,
				PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: undefined,
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdin?.end('{"id":"state","type":"get_state"}\n');
	const code = await new Promise<number | null>((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectExit(new Error(`Windows daemon smoke timed out\n${stderr}`));
		}, 60_000);
		child.once("exit", (exitCode) => {
			clearTimeout(timeout);
			resolveExit(exitCode);
		});
	});
	children.delete(child);
	return { code, stdout, stderr };
}

async function verifyCatalogAfterStartupDeadline(socketPath: string, cwd: string, agentDir: string): Promise<void> {
	// The catalog's startup timeout is five seconds. Waiting past it makes the
	// subsequent list and log checks authoritative for the original child.
	await delay(6000);
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(2000);
		const response = await client.request({ type: "list", all: true, cwd }, 10_000);
		expect(response.success, response.success ? undefined : response.error).toBe(true);
	} finally {
		client.close();
	}
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	try {
		const daemonLog = readFileSync(getDaemonLogPath(socketPath), "utf8");
		expect(daemonLog).not.toContain("Timed out starting daemon catalog");
		expect(daemonLog).not.toContain("Could not start daemon catalog");
	} finally {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
	}
}

describe.skipIf(process.platform !== "win32")("Windows daemon native smoke", () => {
	it("serves worker RPC and catalog operations over a named-pipe supervisor", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-windows-daemon-"));
		tempRoots.add(root);
		const socketPath = `\\\\.\\pipe\\prime-agent-ci-${process.pid}-${Date.now()}`;
		daemonSockets.add(socketPath);

		const agentDir = join(root, "agent dir");
		const result = await runRpcSmoke(agentDir, socketPath);

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain('"command":"get_state","success":true');
		await verifyCatalogAfterStartupDeadline(socketPath, root, agentDir);
	}, 90_000);
});
