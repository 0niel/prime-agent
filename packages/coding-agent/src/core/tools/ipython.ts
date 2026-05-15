// TODO: reconsider whether the persistent kernel is needed once RLM-1 weights land.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { KernelManager } from "../kernel/index.js";
import type { RlmRunHandler } from "../rlm-runtime.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const RLM_BOOTSTRAP_CODE = `
try:
    import nest_asyncio as _prime_agent_nest_asyncio
    _prime_agent_nest_asyncio.apply()
except Exception:
    pass

try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
except Exception as _prime_agent_rlm_error:
    _PRIME_AGENT_RLM_IMPORT_ERROR = str(_prime_agent_rlm_error)

    class _PrimeAgentMissingRlm:
        async def run(self, prompt, **kwargs):
            raise RuntimeError(
                "prime-agent-runtime is not installed in this IPython kernel. "
                "Remove ~/.prime/agent/kernel-venv so prime-agent can rebuild it, or set "
                "PRIME_AGENT_KERNEL_PYTHON to a kernel environment with prime-agent-runtime installed. "
                f"Import error: {_PRIME_AGENT_RLM_IMPORT_ERROR}"
            )

        async def __call__(self, prompt, **kwargs):
            return await self.run(prompt, **kwargs)

    rlm = _PrimeAgentMissingRlm()
`.trim();

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python or IPython shell code to execute. State (variables, imports, loaded data) persists across calls. " +
			"Prefer `!cmd` for ordinary single-line shell commands and `%%bash` for multi-line shell scripts.",
	}),
});

export type IpythonToolInput = Static<typeof ipythonSchema>;

export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted";
	errorEname?: string;
}

export interface IpythonToolOptions {
	/** Python override. Must have `ipykernel` installed. */
	python?: string;
	env?: Record<string, string>;
	sessionId?: string;
	rlmRunHandler?: RlmRunHandler;
	/** Filled after the first kernel start so the owning session can restart it after compaction. */
	kernelManagerRef?: { current?: KernelManager };
}

export function createIpythonToolDefinition(
	cwd: string,
	options?: IpythonToolOptions,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	// Memoize the entire create+start so concurrent first calls all await the
	// same in-flight startup instead of creating two managers or skipping the
	// not-yet-finished start().
	let managerPromise: Promise<KernelManager> | undefined;
	if (options?.kernelManagerRef) {
		options.kernelManagerRef.current = undefined;
	}

	function getManager(): Promise<KernelManager> {
		if (!managerPromise) {
			managerPromise = (async () => {
				const m = new KernelManager({
					python: options?.python,
					cwd,
					env: options?.env,
					sessionId: options?.sessionId,
					rlmRunHandler: options?.rlmRunHandler,
				});
				await m.start();
				const bootstrap = await m.execute(RLM_BOOTSTRAP_CODE);
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the IPython kernel:\n${details}`);
				}
				if (options?.kernelManagerRef) {
					options.kernelManagerRef.current = m;
				}
				return m;
			})();
		}
		return managerPromise;
	}

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python and shell commands in a persistent IPython kernel. Variables, imports, and loaded data " +
			"persist across calls. Prefer `!cmd` for ordinary single-line shell commands and `%%bash` " +
			"for multi-line shell scripts.",
		promptSnippet:
			"ipython - execute Python and shell commands in a persistent kernel; prefer `!cmd` and `%%bash` for shell work",
		// The kernel is single-threaded — pi must not run two ipython calls in parallel within a batch.
		executionMode: "sequential",
		parameters: ipythonSchema,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const m = await getManager();
			const r = await m.execute(params.code, {
				signal,
				onStream: (chunk) => {
					onUpdate?.({
						content: [{ type: "text", text: chunk }],
						details: { status: "ok" },
					});
				},
			});

			let text = r.stdout;
			if (r.stderr) text += (text ? "\n" : "") + r.stderr;
			if (r.result) text += (text ? "\n" : "") + r.result;
			if (r.status === "error" && r.error) {
				text += (text ? "\n" : "") + r.error.traceback.join("\n");
			}

			return {
				content: [{ type: "text", text: text || "" }],
				details: {
					durationMs: r.durationMs,
					status: r.status,
					errorEname: r.error?.ename,
				},
				isError: r.status === "error" || r.status === "aborted",
			};
		},
	};
}

export function createIpythonTool(cwd: string, options?: IpythonToolOptions): AgentTool<typeof ipythonSchema> {
	return wrapToolDefinition(createIpythonToolDefinition(cwd, options));
}
