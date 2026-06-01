// TODO: reconsider whether the persistent kernel is needed once RLM-1 weights land.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { KernelManager } from "../kernel/index.js";
import type { RlmRunHandler } from "../rlm-runtime.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const RLM_BOOTSTRAP_BASE_CODE = `
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

export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return RLM_BOOTSTRAP_BASE_CODE;
	}

	return `
${RLM_BOOTSTRAP_BASE_CODE}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

class _PrimeAgentCallableSkillModule(_prime_agent_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prime_agent_inspect.isawaitable(result):
            return await result
        return result

class _PrimeAgentUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prime_agent_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this IPython kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prime_agent_import_error}>"

def _prime_agent_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    if isinstance(module, _PrimeAgentCallableSkillModule):
        return module
    wrapped = _PrimeAgentCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _prime_agent_inspect.signature(run)
    except Exception:
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prime_agent_sys.modules[module.__name__] = wrapped
    return wrapped

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {}

for _prime_agent_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = str(_prime_agent_skill_error)
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            str(_prime_agent_skill_error),
        )
`.trim();
}

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
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
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
					pythonSkills: options?.pythonSkills,
				});
				await m.start();
				const bootstrap = await m.execute(buildRlmBootstrapCode(options?.pythonSkills));
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
