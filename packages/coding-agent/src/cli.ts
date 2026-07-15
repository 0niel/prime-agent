#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { enableCompileCache } from "node:module";
import { maybeStartInteractiveDaemonEarly } from "./cli/daemon-launch.js";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.js";
import { APP_NAME } from "./config.js";

// Persist V8 compile caches across runs (~10-15% off module-graph load time).
try {
	enableCompileCache?.();
} catch {
	// Unsupported Node version or read-only cache dir; startup just skips the cache.
}

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Kick off the interactive daemon spawn/probe before importing the heavy main
// module graph (~1.5s), so a cold daemon boots concurrently with this
// process's own imports instead of serially after them.
maybeStartInteractiveDaemonEarly(process.argv.slice(2));

installOwnedSessionWorkerOwnerWatch();

const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(process.argv.slice(2));
if (!handledByOwnedWorker) {
	const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
		import("undici"),
		import("./main.js"),
	]);

	// bodyTimeout/headersTimeout default to 300s in undici; long local-LLM stalls
	// (e.g. vLLM buffering a large tool call) exceed that and abort the SSE stream
	// with UND_ERR_BODY_TIMEOUT. Disable both — provider SDKs enforce their own
	// AbortController-based deadlines via retry.provider.timeoutMs.
	setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

	try {
		await main(process.argv.slice(2));
	} finally {
		closeOwnedSessionWorkerOwnerWatch();
	}
}
