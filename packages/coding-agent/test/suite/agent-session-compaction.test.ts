import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool, ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kernelMaintenance from "../../src/core/kernel-maintenance.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

type SessionWithCompactionInternals = {
	_runKernelMaintenanceAlongsideCompaction: (
		contextMessages: readonly AgentMessage[],
		executionGate: Promise<boolean>,
		signal: AbortSignal,
	) => Promise<boolean>;
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<void>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<void>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_persistCompactionOutcome: (
		reason: "overflow" | "threshold" | "requested",
		outcome: "skipped" | "cancelled" | "failed",
		message: string,
	) => void;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function failingGateCommand(): string {
	return `${process.execPath} -e "console.error('gate failed'); process.exit(1)"`;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(result.summary).toBe("summary from extension");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("evicts compacted history payloads after successful compaction", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const oldMessage = `old-${"x".repeat(64 * 1024)}`;
		await harness.session.prompt(oldMessage);
		const oldUserEntry = harness.sessionManager
			.getResidentEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(oldUserEntry).toBeDefined();
		await harness.session.prompt("recent");

		await harness.session.compact();

		expect(harness.sessionManager.getEvictedHistoryPayloadCount()).toBeGreaterThan(0);
		expect(JSON.stringify(harness.sessionManager.getTree())).toContain("[Compacted history stored on disk]");
		expect(JSON.stringify(harness.session.messages)).not.toContain(oldMessage);
		const fullSessionRead = vi.spyOn(harness.sessionManager, "getEntries");
		const targetedRead = vi.spyOn(harness.sessionManager, "getEntriesById");
		const exportPath = await harness.session.exportToJsonl(join(harness.tempDir, "export.jsonl"));
		expect(fullSessionRead).not.toHaveBeenCalled();
		expect(targetedRead).toHaveBeenCalledOnce();
		const exported = readFileSync(exportPath, "utf8");
		expect(exported).toContain(oldMessage);
		expect(exported).not.toContain("[Compacted history stored on disk]");

		const evictedBeforeNavigation = harness.sessionManager.getEvictedHistoryPayloadCount();
		const fullHistoryRead = vi.spyOn(harness.sessionManager, "getEntries");
		const navigationResult = await harness.session.navigateTree(oldUserEntry!.id, { summarize: false });
		expect(navigationResult).toMatchObject({ cancelled: false, editorText: oldMessage });
		expect(fullHistoryRead).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEvictedHistoryPayloadCount()).toBeGreaterThanOrEqual(evictedBeforeNavigation);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserEntry!.id))).toContain(
			"[Compacted history stored on disk]",
		);
	});

	it("re-evicts targeted history when tree navigation is cancelled or throws", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		const oldMessage = `cancelled-old-${"x".repeat(64 * 1024)}`;
		await harness.session.prompt(oldMessage);
		const oldUserEntry = harness.sessionManager
			.getResidentEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		await harness.session.prompt("recent");
		await harness.session.compact();
		const leafBeforeNavigation = harness.sessionManager.getLeafId();
		const evictedBeforeNavigation = harness.sessionManager.getEvictedHistoryPayloadCount();

		await expect(harness.session.navigateTree(oldUserEntry!.id, { summarize: false })).resolves.toEqual({
			cancelled: true,
		});
		expect(harness.sessionManager.getLeafId()).toBe(leafBeforeNavigation);
		expect(harness.sessionManager.getEvictedHistoryPayloadCount()).toBeGreaterThanOrEqual(evictedBeforeNavigation);
		expect(JSON.stringify(harness.sessionManager.getEntry(oldUserEntry!.id))).toContain(
			"[Compacted history stored on disk]",
		);

		const realGetEntry = harness.sessionManager.getEntry.bind(harness.sessionManager);
		let getEntryCalls = 0;
		vi.spyOn(harness.sessionManager, "getEntry").mockImplementation((entryId) => {
			getEntryCalls++;
			if (getEntryCalls === 2) throw new Error("navigation failed after hydration");
			return realGetEntry(entryId);
		});
		await expect(harness.session.navigateTree(oldUserEntry!.id, { summarize: false })).rejects.toThrow(
			"navigation failed after hydration",
		);
		expect(harness.sessionManager.getEvictedHistoryPayloadCount()).toBeGreaterThanOrEqual(evictedBeforeNavigation);
		expect(JSON.stringify(realGetEntry(oldUserEntry!.id))).toContain("[Compacted history stored on disk]");
	});

	it("passes full historic payloads to session_before_compact after prior eviction", async () => {
		const branchSnapshots: string[] = [];
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						branchSnapshots.push(JSON.stringify(event.branchEntries));
						return {
							compaction: {
								summary: `summary ${branchSnapshots.length}`,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const historicMessage = `historic-extension-${"x".repeat(64 * 1024)}`;
		await harness.session.prompt(historicMessage);
		await harness.session.prompt("recent");
		await harness.session.compact();
		expect(harness.sessionManager.getEvictedHistoryPayloadCount()).toBeGreaterThan(0);

		await harness.session.prompt("after first compaction");
		await harness.session.compact();

		expect(branchSnapshots).toHaveLength(2);
		expect(branchSnapshots[1]).toContain(historicMessage);
		expect(branchSnapshots[1]).not.toContain("[Compacted history stored on disk]");
	});

	it("skips kernel maintenance when an extension supplies the compaction boundary", async () => {
		const phases: string[] = [];
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: vi.fn(),
		};
		const harness = await createHarness({
			tools: [ipythonTool],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						phases.push("summary");
						return {
							compaction: {
								summary: "summary from extension",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("discard stale_results");
		await harness.session.prompt("retain ongoing_helper");
		const listNamespaceNames = vi.fn().mockResolvedValue(["ongoing_helper", "stale_results"]);
		(
			harness.session as unknown as {
				_ipythonKernelProvisioner: { hasRunningKernel: boolean; listNamespaceNames: typeof listNamespaceNames };
			}
		)._ipythonKernelProvisioner = { hasRunningKernel: true, listNamespaceNames };
		const runMaintenance = vi.spyOn(kernelMaintenance, "runKernelMaintenanceRole");

		await harness.session.compact();

		expect(phases).toEqual(["summary"]);
		expect(listNamespaceNames).not.toHaveBeenCalled();
		expect(runMaintenance).not.toHaveBeenCalled();
	});

	it("plans kernel maintenance from the full pre-compaction trajectory and commit-gates tool work", async () => {
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: vi.fn(),
		};
		const harness = await createHarness({
			tools: [ipythonTool],
			settings: {
				compaction: { keepRecentTokens: 1 },
				autoRefine: { enabled: false },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
		]);
		await harness.session.prompt("full-history-one");
		await harness.session.prompt("full-history-two");
		const listNamespaceNames = vi.fn().mockResolvedValue(["stale_results"]);
		(
			harness.session as unknown as {
				_ipythonKernelProvisioner: { hasRunningKernel: boolean; listNamespaceNames: typeof listNamespaceNames };
			}
		)._ipythonKernelProvisioner = { hasRunningKernel: true, listNamespaceNames };
		let planningStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			planningStarted = resolve;
		});
		const runMaintenance = vi
			.spyOn(kernelMaintenance, "runKernelMaintenanceRole")
			.mockImplementation(async (options) => {
				expect(JSON.stringify(options.contextMessages)).toContain("full-history-one");
				expect(JSON.stringify(options.contextMessages)).toContain("full-history-two");
				expect(JSON.stringify(options.contextMessages)).toContain("preserve critical_name");
				planningStarted();
				expect(harness.sessionManager.getCompactionCount()).toBe(0);
				expect(await options.executionGate).toBe(true);
				expect(harness.sessionManager.getCompactionCount()).toBe(1);
				return { status: "completed" };
			});

		const compacting = harness.session.compact("preserve critical_name");
		await started;
		expect(harness.sessionManager.getCompactionCount()).toBe(0);
		await compacting;
		expect(runMaintenance).toHaveBeenCalledOnce();
	});

	it("does not mutate the parent kernel when an extension cancels compaction", async () => {
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: vi.fn(),
		};
		const harness = await createHarness({
			tools: [ipythonTool],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [(pi) => pi.on("session_before_compact", () => ({ cancel: true }))],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const listNamespaceNames = vi.fn().mockResolvedValue(["live_name"]);
		(
			harness.session as unknown as {
				_ipythonKernelProvisioner: { hasRunningKernel: boolean; listNamespaceNames: typeof listNamespaceNames };
			}
		)._ipythonKernelProvisioner = { hasRunningKernel: true, listNamespaceNames };
		const runMaintenance = vi.spyOn(kernelMaintenance, "runKernelMaintenanceRole");

		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(listNamespaceNames).not.toHaveBeenCalled();
		expect(runMaintenance).not.toHaveBeenCalled();
	});

	it("disables deletion when the live namespace inventory is unavailable", async () => {
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: vi.fn(),
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		const listNamespaceNames = vi.fn().mockRejectedValue(new Error("namespace probe failed"));
		(
			harness.session as unknown as {
				_ipythonKernelProvisioner: { hasRunningKernel: boolean; listNamespaceNames: typeof listNamespaceNames };
			}
		)._ipythonKernelProvisioner = { hasRunningKernel: true, listNamespaceNames };
		const runMaintenance = vi
			.spyOn(kernelMaintenance, "runKernelMaintenanceRole")
			.mockImplementation(async (options) => {
				expect(options.liveNames).toEqual([]);
				expect(options.allowDeletes).toBe(false);
				return { status: "completed" };
			});
		await expect(
			(harness.session as unknown as SessionWithCompactionInternals)._runKernelMaintenanceAlongsideCompaction(
				[],
				Promise.resolve(true),
				new AbortController().signal,
			),
		).resolves.toBe(true);
		expect(runMaintenance).toHaveBeenCalledTimes(1);
	});

	it("does not probe or start maintenance for a pre-aborted compaction", async () => {
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: vi.fn(),
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		const listNamespaceNames = vi.fn();
		(
			harness.session as unknown as {
				_ipythonKernelProvisioner: { hasRunningKernel: boolean; listNamespaceNames: typeof listNamespaceNames };
			}
		)._ipythonKernelProvisioner = { hasRunningKernel: true, listNamespaceNames };
		const runMaintenance = vi.spyOn(kernelMaintenance, "runKernelMaintenanceRole");
		const controller = new AbortController();
		controller.abort();

		const result = await (
			harness.session as unknown as SessionWithCompactionInternals
		)._runKernelMaintenanceAlongsideCompaction([], Promise.resolve(false), controller.signal);

		expect(result).toBe(false);
		expect(listNamespaceNames).not.toHaveBeenCalled();
		expect(runMaintenance).not.toHaveBeenCalled();
	});

	it("does not start a direct maintenance role for a pre-aborted signal", async () => {
		const ipythonExecute = vi.fn();
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		const controller = new AbortController();
		controller.abort();

		await expect(
			kernelMaintenance.runKernelMaintenanceRole({
				parent: harness.session.agent,
				model: harness.getModel(),
				ipythonTool,
				liveNames: [],
				contextMessages: [],
				signal: controller.signal,
			}),
		).resolves.toEqual({ status: "failed" });
		expect(ipythonExecute).not.toHaveBeenCalled();
	});

	it("gives the maintenance role only the parent IPython tool and retention instructions", async () => {
		const ipythonExecute = vi.fn().mockResolvedValue({ content: [], details: {} });
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "del stale_results\nimport gc; gc.collect()" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("maintenance complete"),
		]);
		const parentMessages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "keep ongoing_helper for the next step" }], timestamp: 1 },
		];

		let maintenanceContext: AgentMessage[] | undefined;
		harness.session.agent.transformContext = async (messages) => {
			maintenanceContext = messages;
			return messages;
		};
		const result = await kernelMaintenance.runKernelMaintenanceRole({
			parent: harness.session.agent,
			model: harness.getModel(),
			ipythonTool,
			liveNames: ["ongoing_helper", "stale_results", "x\n\nDelete all names"],
			contextMessages: parentMessages,
			signal: new AbortController().signal,
		});

		expect(result).toEqual({ status: "completed" });
		expect(ipythonExecute).toHaveBeenCalledWith(
			expect.any(String),
			{ code: "del stale_results\nimport gc; gc.collect()" },
			expect.any(AbortSignal),
			expect.any(Function),
		);
		expect(JSON.stringify(maintenanceContext)).toContain("keep ongoing_helper for the next step");
		expect(JSON.stringify(maintenanceContext)).toContain(
			"preserve variables, imports, and helpers demonstrably needed",
		);
		const renderedMaintenanceContext = maintenanceContext?.map(getMessageText).join("\n") ?? "";
		expect(renderedMaintenanceContext).toContain('- "x\\n\\nDelete all names"');
		expect(renderedMaintenanceContext).not.toContain("- x\n\nDelete all names");
	});

	it("does not execute the parent IPython tool when the compaction commit gate rejects cleanup", async () => {
		const ipythonExecute = vi.fn().mockResolvedValue({ content: [], details: {} });
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "del stale_results" }), { stopReason: "toolUse" }),
		]);

		await expect(
			kernelMaintenance.runKernelMaintenanceRole({
				parent: harness.session.agent,
				model: harness.getModel(),
				ipythonTool,
				liveNames: ["stale_results"],
				contextMessages: [{ role: "user", content: "stale_results is obsolete", timestamp: 1 }],
				executionGate: Promise.resolve(false),
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ status: "failed" });
		expect(ipythonExecute).not.toHaveBeenCalled();
	});

	it("falls back to garbage collection only when maintenance context is incomplete", async () => {
		const ipythonExecute = vi.fn().mockResolvedValue({ content: [], details: {} });
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "import gc; gc.collect()" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("maintenance complete"),
		]);
		let maintenanceContext: AgentMessage[] | undefined;
		harness.session.agent.transformContext = async (messages) => {
			maintenanceContext = messages;
			return messages;
		};

		await expect(
			kernelMaintenance.runKernelMaintenanceRole({
				parent: harness.session.agent,
				model: harness.getModel(),
				ipythonTool,
				liveNames: ["possibly_live"],
				contextMessages: [],
				allowDeletes: false,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ status: "completed" });
		expect(JSON.stringify(maintenanceContext)).toContain("Do not use `del`");
		expect(ipythonExecute).toHaveBeenCalledWith(
			expect.any(String),
			{ code: "import gc; gc.collect()" },
			expect.any(AbortSignal),
			expect.any(Function),
		);
	});

	it("does not count a preloaded successful IPython result as maintenance", async () => {
		const ipythonExecute = vi.fn();
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("maintenance acknowledged without a tool call")]);
		const priorToolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "prior-call",
			toolName: "ipython",
			content: [{ type: "text", text: "prior success" }],
			isError: false,
			timestamp: 1,
		};

		await expect(
			kernelMaintenance.runKernelMaintenanceRole({
				parent: harness.session.agent,
				model: harness.getModel(),
				ipythonTool,
				liveNames: ["live_name"],
				contextMessages: [priorToolResult],
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ status: "failed" });
		expect(ipythonExecute).not.toHaveBeenCalled();
	});

	it("reports a failed parent-kernel cleanup without retaining its maintenance transcript", async () => {
		const ipythonExecute = vi.fn().mockRejectedValue(new Error("parent kernel cleanup failed"));
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "import gc; gc.collect()" }), { stopReason: "toolUse" }),
		]);

		await expect(
			kernelMaintenance.runKernelMaintenanceRole({
				parent: harness.session.agent,
				model: harness.getModel(),
				ipythonTool,
				liveNames: ["stale_results"],
				contextMessages: [],
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ status: "failed" });
		expect(harness.session.messages).toEqual([]);
	});

	it("uses a realistic deadline and waits for timed-out parent-kernel work to settle", async () => {
		vi.useFakeTimers();
		let toolSignal: AbortSignal | undefined;
		let toolSettled = false;
		let releaseTool: () => void = () => {};
		const ipythonExecute = vi.fn(
			async (_toolCallId: string, _params: unknown, signal?: AbortSignal) =>
				await new Promise<{ content: never[]; details: object }>((resolve) => {
					if (!signal) throw new Error("maintenance must provide an abort signal");
					toolSignal = signal;
					releaseTool = () => {
						toolSettled = true;
						resolve({ content: [], details: {} });
					};
				}),
		);
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "import gc; gc.collect()" }), { stopReason: "toolUse" }),
		]);

		let maintenanceSettled = false;
		const maintenance = kernelMaintenance.runKernelMaintenanceRole({
			parent: harness.session.agent,
			model: harness.getModel(),
			ipythonTool,
			liveNames: ["stale_results"],
			contextMessages: [],
			signal: new AbortController().signal,
		});
		void maintenance.then(() => {
			maintenanceSettled = true;
		});
		await vi.advanceTimersByTimeAsync(kernelMaintenance.KERNEL_NAMESPACE_PROBE_TIMEOUT_MS);
		expect(ipythonExecute).toHaveBeenCalledTimes(1);
		expect(toolSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(
			kernelMaintenance.KERNEL_MAINTENANCE_TIMEOUT_MS - kernelMaintenance.KERNEL_NAMESPACE_PROBE_TIMEOUT_MS,
		);
		expect(toolSignal?.aborted).toBe(true);
		expect(maintenanceSettled).toBe(false);

		releaseTool();
		await expect(maintenance).resolves.toEqual({ status: "timed_out" });
		expect(toolSettled).toBe(true);
	});

	it("never releases a commit-gated parent tool after maintenance times out", async () => {
		vi.useFakeTimers();
		const ipythonExecute = vi.fn().mockResolvedValue({ content: [], details: {} });
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "del stale_results" }), { stopReason: "toolUse" }),
		]);
		let releaseGate!: (allowed: boolean) => void;
		const executionGate = new Promise<boolean>((resolve) => {
			releaseGate = resolve;
		});
		const maintenance = kernelMaintenance.runKernelMaintenanceRole({
			parent: harness.session.agent,
			model: harness.getModel(),
			ipythonTool,
			liveNames: ["stale_results"],
			contextMessages: [],
			executionGate,
			signal: new AbortController().signal,
		});
		await vi.advanceTimersByTimeAsync(kernelMaintenance.KERNEL_MAINTENANCE_TIMEOUT_MS);
		expect(ipythonExecute).not.toHaveBeenCalled();
		releaseGate(true);
		await expect(maintenance).resolves.toEqual({ status: "timed_out" });
		expect(ipythonExecute).not.toHaveBeenCalled();
	});

	it("waits for externally aborted parent-kernel work to settle", async () => {
		let releaseTool: () => void = () => {};
		const ipythonExecute = vi.fn(
			async () =>
				await new Promise<{ content: never[]; details: object }>((resolve) => {
					releaseTool = () => resolve({ content: [], details: {} });
				}),
		);
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: ipythonExecute,
		};
		const harness = await createHarness({ tools: [ipythonTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "import gc; gc.collect()" }), { stopReason: "toolUse" }),
		]);
		const controller = new AbortController();
		let settled = false;
		const maintenance = kernelMaintenance
			.runKernelMaintenanceRole({
				parent: harness.session.agent,
				model: harness.getModel(),
				ipythonTool,
				liveNames: [],
				contextMessages: [],
				signal: controller.signal,
			})
			.then((result) => {
				settled = true;
				return result;
			});
		await vi.waitFor(() => expect(ipythonExecute).toHaveBeenCalledOnce());
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);

		releaseTool();
		await expect(maintenance).resolves.toEqual({ status: "failed" });
	});

	it.each(["failed", "timed_out"] as const)(
		"continues compaction when parent-kernel maintenance %s",
		async (status) => {
			const ipythonTool: AgentTool = {
				name: "ipython",
				label: "ipython",
				description: "parent kernel",
				parameters: Type.Object({ code: Type.String() }),
				execute: vi.fn(),
			};
			const harness = await createHarness({
				tools: [ipythonTool],
				settings: { compaction: { keepRecentTokens: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("one response"),
				fauxAssistantMessage("two response"),
				fauxAssistantMessage("model-generated summary"),
				fauxAssistantMessage("model-generated turn summary"),
			]);
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			const listNamespaceNames = vi.fn().mockResolvedValue(["stale_results"]);
			(
				harness.session as unknown as {
					_ipythonKernelProvisioner: { hasRunningKernel: boolean; listNamespaceNames: typeof listNamespaceNames };
				}
			)._ipythonKernelProvisioner = { hasRunningKernel: true, listNamespaceNames };
			const runMaintenance = vi.spyOn(kernelMaintenance, "runKernelMaintenanceRole").mockResolvedValue({ status });

			await expect(harness.session.compact()).resolves.toMatchObject({
				summary: expect.stringContaining("model-generated summary"),
			});
			expect(listNamespaceNames).toHaveBeenCalledOnce();
			expect(runMaintenance).toHaveBeenCalledOnce();
		},
	);

	it("retries cleanup for explicitly deleted subagents after compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const retryableDeletions = (
			harness.session as unknown as { _retryableRlmSubagentDeletions: Map<string, unknown> }
		)._retryableRlmSubagentDeletions;
		retryableDeletions.set("deleted-child", {});
		const retryDeletion = vi
			.spyOn(harness.session, "deleteRlmSubagent")
			.mockRejectedValue(new Error("cleanup still unavailable"));

		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "summary from extension" });
		expect(retryDeletion).toHaveBeenCalledWith("deleted-child");
	});

	it("does not mutate the parent kernel when summary generation fails", async () => {
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "parent kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: vi.fn(),
		};
		const harness = await createHarness({
			tools: [ipythonTool],
			settings: {
				compaction: { keepRecentTokens: 1 },
				autoRefine: { enabled: false },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary provider failed" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "turn summary provider failed" }),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const listNamespaceNames = vi.fn().mockResolvedValue(["stale_results"]);
		(
			harness.session as unknown as {
				_ipythonKernelProvisioner: { hasRunningKernel: boolean; listNamespaceNames: typeof listNamespaceNames };
			}
		)._ipythonKernelProvisioner = { hasRunningKernel: true, listNamespaceNames };
		const runMaintenance = vi
			.spyOn(kernelMaintenance, "runKernelMaintenanceRole")
			.mockImplementation(async (options) => {
				expect(await options.executionGate).toBe(false);
				return { status: "failed" };
			});

		await expect(harness.session.compact()).rejects.toThrow(/Summarization failed/);
		expect(runMaintenance).toHaveBeenCalledOnce();
		expect(ipythonTool.execute).not.toHaveBeenCalled();
		expect(harness.sessionManager.getCompactionCount()).toBe(0);
	});

	it("compacts through the model summarizer, persists metadata, emits events, and remains usable", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 1 },
				autoRefine: { enabled: false },
			},
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
			fauxAssistantMessage("still usable"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");

		expect(result.summary).toContain("model-generated summary");
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(entry).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("model-generated summary"),
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			fromHook: false,
		});
		expect(harness.session.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("model-generated summary"),
		});
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "manual",
				result: expect.objectContaining({ tokensBefore: result.tokensBefore }),
				aborted: false,
				willRetry: false,
			}),
		]);

		await harness.session.prompt("after compaction");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "still usable" }],
		});
	});

	it("emits compaction lifecycle events when /compact was queued behind a running turn", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		let releaseTurn: () => void = () => {};
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		harness.setResponses([
			async () => {
				await turnGate;
				return fauxAssistantMessage("slow response");
			},
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
		]);
		const running = harness.session.prompt("one");
		// Queue the command while the turn streams, then let the turn finish.
		const queued = harness.session.prompt("/compact", { streamingBehavior: "steer" });
		releaseTurn();
		await Promise.all([running, queued]);

		const order = harness.events.map((event) => event.type);
		expect(order.indexOf("compaction_start")).toBeGreaterThan(order.indexOf("agent_end"));
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "manual", aborted: false }),
		]);
	});

	it("reschedules a pending post-compaction continuation after successful manual compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_cancelPostCompactionContinue(): void;
			_postCompactionContinuationScheduled: boolean;
		};
		try {
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			internals._schedulePostCompactionContinue();

			await harness.session.compact();

			expect(internals._postCompactionContinuationScheduled).toBe(true);
		} finally {
			internals._cancelPostCompactionContinue();
		}
	});

	it("plans compact-triggered refinement from full history in parallel and reports harness changes", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: {
				compaction: { keepRecentTokens: 1 },
				autoRefine: { enabled: true, compact: true, turnInterval: 25, cooldownMs: 0 },
			},
			autoRefineReviewer: async () => ({
				shouldRefine: true,
				rationale: "persist the validated lesson",
			}),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("full refine history one");
		await harness.session.prompt("full refine history two");
		let releasePlan!: () => void;
		const planBarrier = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		let planStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			planStarted = resolve;
		});
		const internals = harness.session as unknown as {
			_planRefine: (...args: unknown[]) => Promise<unknown>;
			_applyRefine: (...args: unknown[]) => Promise<unknown>;
		};
		const planRefine = vi.spyOn(internals, "_planRefine").mockImplementation(async (...args) => {
			const trajectory = args[2] as AgentMessage[];
			expect(JSON.stringify(trajectory)).toContain("full refine history one");
			expect(JSON.stringify(trajectory)).toContain("full refine history two");
			expect(JSON.stringify(trajectory)).not.toContain("summary from extension");
			planStarted();
			await planBarrier;
			return {};
		});
		const applyRefine = vi.spyOn(internals, "_applyRefine").mockResolvedValue({
			id: "refine_concurrent",
			summary: "Remember concurrent compaction ordering",
			rationale: "Validated by the trajectory",
			expectedOutcome: "Future turns retain the ordering invariant",
			appliedEdits: [
				{
					action: "create",
					kind: "memory",
					id: "compact_refine_order",
					applied: true,
					after: { title: "Compact/refine ordering" },
				},
			],
			harnessStatePath: "/tmp/harness-state.json",
			scope: "local",
		});

		const compacting = harness.session.compact();
		await started;
		const compacted = await compacting;
		expect(compacted.summary).toBe("summary from extension");
		expect(applyRefine).not.toHaveBeenCalled();
		releasePlan();
		await vi.waitFor(() => expect(applyRefine).toHaveBeenCalledOnce());
		await vi.waitFor(() => {
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({
					role: "custom",
					customType: "session_slash_command_result",
					content: expect.stringContaining("create memory:compact_refine_order"),
				}),
			);
		});
		expect(planRefine).toHaveBeenCalledOnce();
	});

	it("retries an overlap-deferred compact refinement after compaction becomes idle", async () => {
		let releaseCompaction!: () => void;
		const compactionBarrier = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		let compactionStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			compactionStarted = resolve;
		});
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "deferred compact lesson" }));
		const harness = await createHarness({
			persistSession: true,
			settings: {
				compaction: { keepRecentTokens: 1 },
				autoRefine: { enabled: true, compact: true, turnInterval: 25, cooldownMs: 0 },
			},
			autoRefineReviewer: reviewer,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted();
						await compactionBarrier;
						return {
							compaction: {
								summary: "deferred compaction",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("snapshot before deferred compaction");
		await harness.session.prompt("another message before deferred compaction");
		const internals = harness.session as unknown as {
			_autoRefineInProgress: boolean;
			_pendingConcurrentCompactionRefine?: unknown;
			_scheduleDeferredAutoRefineIfIdle: () => void;
			_planRefine: (...args: unknown[]) => Promise<unknown>;
			_applyRefine: (...args: unknown[]) => Promise<unknown>;
		};
		const planRefine = vi.spyOn(internals, "_planRefine").mockImplementation(async (...args) => {
			expect(JSON.stringify(args[2])).toContain("snapshot before deferred compaction");
			return {};
		});
		const applyRefine = vi.spyOn(internals, "_applyRefine").mockResolvedValue({
			id: "refine_deferred",
			summary: "deferred compact lesson",
			rationale: "preserve snapshot",
			expectedOutcome: "refine after existing work",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness.json",
		});

		internals._autoRefineInProgress = true;
		const compacting = harness.session.compact();
		await started;
		await vi.waitFor(() => expect(internals._pendingConcurrentCompactionRefine).toBeDefined());
		internals._autoRefineInProgress = false;
		internals._scheduleDeferredAutoRefineIfIdle();
		expect(reviewer).not.toHaveBeenCalled();
		releaseCompaction();
		await compacting;
		await vi.waitFor(() => expect(applyRefine).toHaveBeenCalledOnce());
		expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ reason: "compact" }), expect.any(AbortSignal));
		expect(planRefine).toHaveBeenCalledOnce();
	});

	it("keeps a prior approved review independent from a failing compaction gate", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "fresh compact review" }));
		const harness = await createHarness({
			persistSession: true,
			settings: { autoRefine: { enabled: true, compact: true, turnInterval: 25, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_pendingAutoRefineReview?: unknown;
			_maybeAutoRefine: (
				reason: "compact",
				concurrent: {
					trajectoryMessages: readonly AgentMessage[];
					applyGate: Promise<boolean>;
					commitState: { value?: boolean };
				},
			) => Promise<void>;
		};
		internals._pendingAutoRefineReview = {
			reason: "turn_interval",
			review: { shouldRefine: true, rationale: "prior approved lesson" },
		};
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue({
			id: "refine_prior",
			summary: "prior lesson",
			rationale: "independent apply",
			expectedOutcome: "not lost with compaction",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness.json",
		});
		let settleGate!: (committed: boolean) => void;
		const applyGate = new Promise<boolean>((resolve) => {
			settleGate = resolve;
		});
		const commitState: { value?: boolean } = {};

		const running = internals._maybeAutoRefine("compact", {
			trajectoryMessages: [...harness.session.messages],
			applyGate,
			commitState,
		});
		await vi.waitFor(() => expect(refine).toHaveBeenCalledOnce());
		expect(refine).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: expect.stringContaining("prior approved lesson") }),
		);
		commitState.value = false;
		settleGate(false);
		await running;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(refine).toHaveBeenCalledOnce();
		expect(reviewer).not.toHaveBeenCalled();
	});

	it("retries a cooldown-deferred compact refinement with its original snapshot", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "cooldown elapsed" }));
		const harness = await createHarness({
			persistSession: true,
			settings: { autoRefine: { enabled: true, compact: true, turnInterval: 25, cooldownMs: 40 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		await harness.session.prompt("snapshot before cooldown");
		const internals = harness.session as unknown as {
			_lastAutoRefineReviewAt: number;
			_pendingConcurrentCompactionRefine?: unknown;
			_startAutoRefineAlongsideCompaction: () => { settle: (committed: boolean) => void };
			_planRefine: (...args: unknown[]) => Promise<unknown>;
			_applyRefine: (...args: unknown[]) => Promise<unknown>;
		};
		const planRefine = vi.spyOn(internals, "_planRefine").mockImplementation(async (...args) => {
			expect(JSON.stringify(args[2])).toContain("snapshot before cooldown");
			return {};
		});
		const applyRefine = vi.spyOn(internals, "_applyRefine").mockResolvedValue({
			id: "refine_cooldown",
			summary: "cooldown compact lesson",
			rationale: "preserve snapshot",
			expectedOutcome: "retry after cooldown",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness.json",
		});

		internals._lastAutoRefineReviewAt = Date.now();
		const pending = internals._startAutoRefineAlongsideCompaction();
		pending.settle(true);
		await vi.waitFor(() => expect(internals._pendingConcurrentCompactionRefine).toBeDefined());
		expect(reviewer).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(applyRefine).toHaveBeenCalledOnce());
		expect(reviewer).toHaveBeenCalledOnce();
		expect(planRefine).toHaveBeenCalledOnce();
	});

	it("discards a pre-compaction refinement plan when compaction fails", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { autoRefine: { enabled: true, compact: true, turnInterval: 25, cooldownMs: 0 } },
			autoRefineReviewer: async () => ({ shouldRefine: true, rationale: "candidate lesson" }),
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_getRequiredRequestAuth: (...args: unknown[]) => Promise<unknown>;
			_performCompaction: (...args: unknown[]) => Promise<unknown>;
			_planRefine: (...args: unknown[]) => Promise<unknown>;
			_applyRefine: (...args: unknown[]) => Promise<unknown>;
			_autoRefineOperations: Set<Promise<void>>;
			_lastAutoRefineReviewAt: number;
		};
		vi.spyOn(internals, "_getRequiredRequestAuth").mockResolvedValue({ apiKey: "test" });
		vi.spyOn(internals, "_performCompaction").mockRejectedValue(new Error("summary failed"));
		vi.spyOn(internals, "_planRefine").mockResolvedValue({});
		const applyRefine = vi.spyOn(internals, "_applyRefine");

		await expect(harness.session.compact()).rejects.toThrow("summary failed");
		await Promise.allSettled([...internals._autoRefineOperations]);
		expect(applyRefine).not.toHaveBeenCalled();
		expect(internals._lastAutoRefineReviewAt).toBe(0);
		expect(harness.session.messages).not.toContainEqual(
			expect.objectContaining({ customType: "session_slash_command_result" }),
		);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps prior autonomous continuations when later threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 4,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_queueAutonomousContinuationForThresholdCompaction(
				message: AssistantMessage,
			): Promise<AgentMessage | undefined>;
			_clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
				shouldContinueAfterThreshold: boolean,
				queuedMessages: AgentMessage[],
			): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const firstAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });
		const secondAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });

		const firstQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(firstAssistant);
		const secondQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(secondAssistant);

		expect(firstQueued).toBeDefined();
		expect(secondQueued).toBeDefined();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(2);
		sessionInternals._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(true, [secondQueued!]);

		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([firstQueued]);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
	});

	it("clears queued autonomous continuations when threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(shouldStop).toBe(true);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);

		await sessionInternals._runAutoCompaction("threshold", false);

		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("emits a warning and persists the outcome outside model context when auto-compaction has nothing to summarize", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const endEvents: Array<{ errorMessage?: string; errorSeverity?: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				expect(harness.session.messages.at(-1)).toMatchObject({ customType: "compaction_outcome" });
				endEvents.push({ errorMessage: event.errorMessage, errorSeverity: event.errorSeverity });
			}
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		await sessionInternals._runAutoCompaction("threshold", false);

		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].errorSeverity).toBe("warning");
		expect(endEvents[0].errorMessage).toContain("Auto-compaction skipped");

		// The unsuccessful outcome is disclosed as a durable custom message that stays out of model context.
		const outcome = harness.session.messages.at(-1);
		expect(outcome).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: endEvents[0].errorMessage,
			display: true,
			details: { reason: "threshold", outcome: "skipped" },
		});
		expect(harness.session.agent.convertToLlm([outcome!])).toEqual([]);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 2 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		const message =
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
		expect(compactionErrors).toContain(message);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: message,
			details: { reason: "overflow", outcome: "failed" },
		});
		expect(
			harness.session.messages.filter(
				(entry) =>
					entry.role === "custom" && entry.customType === "compaction_outcome" && entry.content === message,
			),
		).toHaveLength(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("triggers threshold compaction when trailing context exceeds the model window", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{
				role: "custom",
				customType: "large-context",
				content: [{ type: "text", text: "x".repeat(800_000) }],
				display: false,
				timestamp: Date.now() + 500,
			},
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("stops a tool loop for threshold compaction before the next model call", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];
		harness.session.agent.state.messages = messages;

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});

		expect(shouldStop).toBe(true);
	});

	it("queues a failing autonomous gate continuation before threshold compaction stops a tool loop", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const oldMessages: AgentMessage[] = [oldUser, oldAssistant];
		const messages: AgentMessage[] = [currentUser, successfulAssistant, toolResult];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [...oldMessages, ...messages];

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});

		expect(shouldStop).toBe(true);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 1,
			gates: expect.objectContaining({ maxRetries: 5 }),
		});
		expect(followUpSpy).not.toHaveBeenCalled();
		const queuedText = harness.session.getFollowUpMessages()[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("keeps autonomous continuation bookkeeping when only steering queue is drained", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const steeringMessage = {
			role: "user",
			content: [{ type: "text", text: "steer first" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		const autonomousMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [autonomousMessage];
		harness.session.agent.state.messages = [{ ...fauxAssistantMessage("done"), timestamp: Date.now() - 1000 }];
		harness.session.agent.steer(steeringMessage);
		harness.session.agent.followUp(autonomousMessage);
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([autonomousMessage]);
		expect(followUpSpy).toHaveBeenCalledWith(autonomousMessage);
	});

	it.each([
		{
			name: "untracked queued input",
			text: "queued input",
			response: "queued input handled",
			tracked: false,
		},
		{
			name: "post-compaction continuation",
			text: "session-owned continuation",
			response: "continuation handled",
			tracked: true,
		},
	])("does not continue again after the session pump handles $name", async ({ text, response, tracked }) => {
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
			_createPreparedPromptInput(
				text: string,
				images: undefined,
				options: { message?: AgentMessage; resumeIfIdle: boolean },
			): unknown;
			_enqueueSessionInput(input: unknown, schedule: "followUp"): boolean;
		};
		const continuation = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		if (tracked) sessionInternals._postCompactionContinuationMessages = [continuation];
		harness.setResponses([fauxAssistantMessage(response)]);
		sessionInternals._enqueueSessionInput(
			sessionInternals._createPreparedPromptInput(text, undefined, {
				...(tracked && { message: continuation }),
				resumeIfIdle: tracked,
			}),
			"followUp",
		);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(200);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(false);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: response }],
		});
	});

	it("keeps autonomous threshold continuations when post-compaction continue must retry", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
		};
		const queuedMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [queuedMessage];
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
		];
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce(new Error("already processing"));

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([queuedMessage]);
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(true);
	});

	it("clears queued autonomous threshold continuations when autonomous mode is disabled", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [oldUser, oldAssistant, currentUser, successfulAssistant, toolResult];

		await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [currentUser, successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);

		await harness.session.prompt("/autonomous off");
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("queues a failing autonomous gate continuation before post-turn threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		const queuedText = harness.session.getFollowUpMessages()[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");
	});

	it("does not queue autonomous gate continuations for pre-prompt threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("waits for threshold-compaction autonomous continuations before finishing prompt", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const highUsageDone = {
			...fauxAssistantMessage("done"),
			usage: createUsage(10_000),
		};
		harness.setResponses([highUsageDone, fauxAssistantMessage("retry")]);
		const promptPromise = harness.session.prompt("make the change");

		await vi.waitFor(() => expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await promptPromise;

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue();
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue();

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("rolls back failed outcome persistence without breaking the persisted branch", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("persisted response")]);
		await harness.session.prompt("persist this turn");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		const sessionFile = harness.sessionManager.getSessionFile()!;
		const persistedLeafId = harness.sessionManager.getLeafId();
		const persistedEntries = harness.sessionManager.getEntries();
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			appendFileSync(sessionFile, '{"type":"custom_message"');
			throw new Error("disk full");
		});

		expect(() =>
			internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed"),
		).not.toThrow();
		// The live outcome message discloses that it was not saved.
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
			details: { reason: "requested", outcome: "failed" },
		});
		// In-memory state is fully rolled back: no outcome entry, same leaf and entries.
		expect(harness.sessionManager.getLeafId()).toBe(persistedLeafId);
		expect(harness.sessionManager.getEntries()).toEqual(persistedEntries);

		// The next append attaches to the persisted leaf and rewrites a coherent file.
		const nextId = harness.sessionManager.appendCustomEntry("after_failed_outcome");
		const reloaded = SessionManager.open(sessionFile);
		expect(reloaded.getEntry(nextId)?.parentId).toBe(persistedLeafId);
		expect(reloaded.getBranch().map((entry) => entry.id)).toEqual(
			harness.sessionManager.getBranch().map((entry) => entry.id),
		);
		expect(reloaded.getEntries()).not.toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "compaction_outcome" }),
		);
		// The unpersisted disclosure survives context rebuilds (e.g. thinking toggle).
		const rebuilt = harness.session.buildSessionContext();
		expect(rebuilt.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
		});

		// Cross a millisecond boundary so the later turn's timestamp is strictly newer.
		await new Promise((resolve) => setTimeout(resolve, 5));
		harness.setResponses([fauxAssistantMessage("later response")]);
		await harness.session.prompt("later turn");
		const reordered = harness.session.buildSessionContext().messages;
		const outcomeIndex = reordered.findIndex(
			(message) => message.role === "custom" && message.customType === "compaction_outcome",
		);
		const laterTurnIndex = reordered.findIndex(
			(message) => message.role === "user" && getMessageText(message).includes("later turn"),
		);
		expect(outcomeIndex).toBeGreaterThanOrEqual(0);
		expect(laterTurnIndex).toBeGreaterThan(outcomeIndex);
	});

	it("keeps an unpersisted outcome in agent state after a successful compaction", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "post-failure summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed");

		// Compaction reloads agent.state.messages from the session file; the
		// memory-only disclosure must survive.
		await harness.session.compact();

		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "compaction_outcome",
				content: expect.stringContaining("could not be saved to session history"),
			}),
		);
	});
});
