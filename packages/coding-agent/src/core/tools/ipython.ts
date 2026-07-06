// TODO: reconsider whether the persistent kernel is needed once RLM-1 weights land.
import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
	type HostRequestHandlers,
	type KernelAttachment,
	type KernelDiffDisplay,
	KernelManager,
} from "../kernel/index.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const RLM_BOOTSTRAP_BASE_CODE = `
import asyncio

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
			"Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

export type IpythonToolInput = Static<typeof ipythonSchema>;

export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Diffs streamed from file edits, rendered by the IPython cell. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface IpythonToolOptions {
	/** Python override. Must have `ipykernel` installed. */
	python?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Optional explicit shell path for bare %%bash cells. */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/** Filled with the live KernelManager after the first kernel start; cleared on construction. */
	kernelManagerRef?: { current?: KernelManager };
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	/** Shared provisioner owning the kernel lifecycle. When provided, the remaining options are ignored. */
	provisioner?: IpythonKernelProvisioner;
}

function quoteScriptMagicArgument(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function applyShellSettingsToBashMagicCell(
	code: string,
	options: Pick<IpythonToolOptions, "commandPrefix" | "shellPath"> | undefined,
): string {
	const commandPrefix = options?.commandPrefix;
	const shellPath = options?.shellPath?.trim();
	if (!commandPrefix && !shellPath) return code;

	const match = /^([ \t]*)%%bash\b([^\r\n]*)(\r?\n|$)/.exec(code);
	if (!match) return code;

	const [, indent, rest, lineBreak] = match;
	const body = code.slice(match[0].length);
	const firstLine =
		shellPath && rest.trim().length === 0
			? `${indent}%%script ${quoteScriptMagicArgument(shellPath)}`
			: `${indent}%%bash${rest}`;
	const nextBody = commandPrefix ? `${commandPrefix}${body ? `\n${body}` : ""}` : body;
	return `${firstLine}${lineBreak || "\n"}${nextBody}`;
}

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's IPython kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IpythonKernelProvisioner {
	private managerPromise?: Promise<KernelManager>;
	private startedManager?: KernelManager;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<IpythonToolOptions, "provisioner">,
	) {
		if (options?.kernelManagerRef) {
			options.kernelManagerRef.current = undefined;
		}
	}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelManager | undefined {
		return this.startedManager;
	}

	/** Result of reviving a prior session's namespace on the last kernel start, if any. */
	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	/** Start the kernel in the background. Failures are swallowed here and surface on the next ensure(). */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(): Promise<void> {
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.dispose();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler): Promise<KernelManager> {
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			// Joining an in-flight startup: replay the current stage.
			if (this.managerPromise && this.lastStartupMessage) {
				onProgress(this.lastStartupMessage);
			}
		}
		if (!this.managerPromise) {
			const startup = this.startKernel();
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
					this.settleStartup();
				},
				() => {
					// Clear the memo so the next ensure() retries instead of
					// rethrowing a cached rejection forever.
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
					this.settleStartup();
				},
			);
		}
		return this.managerPromise;
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of [...this.startupListeners]) {
			listener(message);
		}
	}

	private async startKernel(): Promise<KernelManager> {
		// Wait for a previous provisioner (e.g. on /reload) to finish disposing — and
		// flushing its final snapshot — before we read that snapshot back, so the two
		// kernels can't race over the same on-disk file. Guarded so the common
		// no-gate path stays synchronous (callers rely on prompt startup progress).
		if (this.options?.readyGate) {
			await this.options.readyGate.catch(() => {});
		}
		const snapshotDir = this.options?.snapshotDir;
		const m = new KernelManager({
			python: this.options?.python,
			cwd: this.cwd,
			env: this.options?.env,
			sessionId: this.options?.sessionId,
			hostHandlers: this.options?.hostHandlers,
			pythonSkills: this.options?.pythonSkills,
			// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
			snapshot: snapshotDir
				? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
				: undefined,
		});
		// Emitted synchronously (before the permit await) so a listener attaching
		// mid-flight can replay the current stage.
		this.emitStartupProgress("Starting IPython kernel...");
		// Only the process spawn + port resolve contends for OS resources under a
		// fan-out, and it is bounded by start()'s own timeouts — so the permit
		// covers only start(). Restore/bootstrap run per-kernel afterwards and are
		// unbounded execute()s; holding the global permit across them could pin it
		// forever on a wedged bootstrap and starve every other session's boot.
		const signal = this.disposeController.signal;
		await withKernelBootPermit(() => {
			// Disposed while queued for the permit — don't spawn a kernel nobody wants.
			if (signal.aborted) throw new Error("Kernel provisioner disposed before start");
			return m.start({ onBootstrapProgress: (message) => this.emitStartupProgress(message) });
		}, signal);
		let pendingRestore: RestoreResult | undefined;
		try {
			// Revive a prior session's namespace before the bootstrap, so the bootstrap
			// then overwrites live handles (rlm, skills) on top of anything restored.
			if (snapshotDir) {
				const snapshotExisted = existsSync(snapshotPathIn(snapshotDir));
				this.emitStartupProgress("Restoring IPython state...");
				const restore = await m.restoreState();
				if (snapshotExisted) {
					pendingRestore = restore ?? { restored: [], failed: [], path: snapshotPathIn(snapshotDir) };
				}
			}
			this.emitStartupProgress("Preparing IPython runtime...");
			const bootstrap = await m.execute(buildRlmBootstrapCode(this.options?.pythonSkills));
			if (bootstrap.status !== "ok") {
				const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
				throw new Error(`Failed to initialize rlm runtime in the IPython kernel:\n${details}`);
			}
		} catch (error) {
			// Never leak the kernel's ZMQ sockets / temp dir if startup fails after spawn.
			void m.dispose();
			throw error;
		}
		// Only tell the model what was revived once the kernel is actually usable —
		// a notice claiming restored state must never outlive a failed bootstrap.
		if (pendingRestore) {
			this._lastRestore = pendingRestore;
			this.options?.onRestore?.(pendingRestore);
		}
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = m;
		}
		return m;
	}
}

/** Turn kernel image attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

export function createIpythonToolDefinition(
	cwd: string,
	options?: IpythonToolOptions,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const provisioner = options?.provisioner ?? new IpythonKernelProvisioner(cwd, options);

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
		promptSnippet: "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration",
		// The kernel is single-threaded — pi must not run two ipython calls in parallel within a batch.
		executionMode: "sequential",
		parameters: ipythonSchema,
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			// Cosmetic; ctx.ui can throw on a stale ctx, but must never fail the cell.
			const setWorkingMessage = (message?: string) => {
				try {
					ctx?.ui.setWorkingMessage(message);
				} catch {
					// Stale ctx; cosmetic only.
				}
			};
			let reportedStartupProgress = false;
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				reportedStartupProgress = true;
				setWorkingMessage(message);
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { status: "starting" },
				});
			};

			try {
				const m = await provisioner.ensure(reportStartupProgress);
				const code = applyShellSettingsToBashMagicCell(params.code, options);
				const r = await m.execute(code, {
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

				const imageBlocks = imageBlocksFromAttachments(r.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						errorEname: r.error?.ename,
						stdout: r.stdout,
						stderr: r.stderr,
						result: r.result,
						diffs: r.diffs,
						attachments: r.attachments,
						error: r.error,
					},
					isError: r.status === "error" || r.status === "aborted",
				};
			} finally {
				if (reportedStartupProgress) {
					setWorkingMessage();
				}
			}
		},
	};
}

export function createIpythonTool(cwd: string, options?: IpythonToolOptions): AgentTool<typeof ipythonSchema> {
	return wrapToolDefinition(createIpythonToolDefinition(cwd, options));
}
