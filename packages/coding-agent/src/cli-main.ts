import { enableCompileCache } from "node:module";
import { maybeStartDaemonEarly, shouldUseLegacyOwnedSessionWorkerFrontend } from "./cli/daemon-launch.js";
import {
	classifyOwnedSessionWorkerInvocation,
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.js";
import { APP_NAME } from "./config.js";
import { defaultDaemonSocketPath } from "./modes/daemon/daemon-socket.js";

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	installOwnedSessionWorkerOwnerWatch();

	const args = process.argv.slice(2);
	const ownedWorkerProfile = classifyOwnedSessionWorkerInvocation(args, process.stdin.isTTY);
	const useLegacyOwnedWorker =
		process.env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND !== "1" &&
		ownedWorkerProfile !== undefined &&
		(await shouldUseLegacyOwnedSessionWorkerFrontendFromArgs(args));
	const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(args, useLegacyOwnedWorker);
	if (!handledByOwnedWorker) {
		if (!isOwnedSessionWorkerProcess()) {
			// Boot a cold daemon concurrently with this process's heavy imports.
			maybeStartDaemonEarly(process.argv.slice(2));
		}
		const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
			import("undici"),
			import("./main.js"),
		]);

		// undici's 300s body/headers timeouts abort long local-LLM SSE stalls; provider
		// SDKs enforce their own deadlines via retry.provider.timeoutMs.
		setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

		try {
			await main(process.argv.slice(2));
		} finally {
			closeOwnedSessionWorkerOwnerWatch();
		}
	}
}

async function shouldUseLegacyOwnedSessionWorkerFrontendFromArgs(args: readonly string[]): Promise<boolean> {
	const socketIndex = args.indexOf("--daemon-socket");
	const socketPath =
		socketIndex !== -1 && args[socketIndex + 1] ? (args[socketIndex + 1] as string) : defaultDaemonSocketPath();
	return shouldUseLegacyOwnedSessionWorkerFrontend(socketPath);
}
