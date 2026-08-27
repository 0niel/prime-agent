import { spawn } from "node:child_process";

if (process.env.RPC_FIXTURE_HOLD_STDIO === "1") {
	// A grandchild inheriting the stdio pipes keeps them open after this process exits,
	// so the parent RpcClient never sees a "close" event for this child.
	const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
		stdio: "inherit",
		detached: true,
	});
	grandchild.unref();
	process.stdout.write(`${JSON.stringify({ type: "fixture_grandchild", pid: grandchild.pid })}\n`);
}

process.stdin.resume();
