import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	getModel,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	deriveLineageManifest,
	IDEMPOTENCY_KEY_HEADER,
	LINEAGE_REQUEST_ID_HEADER,
	type LineageEvent,
	readLineageLedger,
} from "../src/core/lineage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { type Settings, SettingsManager } from "../src/core/settings-manager.js";
import { assertLineageManifestInvariants } from "./lineage-invariants.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(): Usage {
	return {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
	};
}

function assistantMessage(text: string, options: { errorMessage?: string } = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: options.errorMessage ? "error" : "stop",
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	return "";
}

type ScriptedResponse = { text: string; errorMessage?: string };

async function waitForAsync(condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await sleep(10);
	}
}

describe("AgentSession lineage", () => {
	let tempDir: string;
	let sessions: AgentSession[];
	let harnesses: Harness[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lineage-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessions = [];
		harnesses = [];
	});

	afterEach(() => {
		for (const session of sessions) {
			session.dispose();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		options: {
			responses?: ScriptedResponse[];
			settings?: Partial<Settings>;
			sessionManager?: SessionManager;
			rlmSessionDir?: string;
			subagentRuntimeHost?: SubagentRuntimeHost;
			hangMarker?: string;
			onChildCallStarted?: () => void;
		} = {},
	) {
		const capturedHeaders: Array<Record<string, string> | undefined> = [];
		const responses = options.responses;
		const streamFn: StreamFn = (_model, context, streamOptions) => {
			capturedHeaders.push(streamOptions?.headers);
			const stream = createAssistantMessageEventStream();
			if (options.hangMarker && lastUserText(context).includes(options.hangMarker)) {
				options.onChildCallStarted?.();
				return stream;
			}
			const next = responses?.shift() ?? { text: "ok" };
			queueMicrotask(() => {
				const message = assistantMessage(next.text, { errorMessage: next.errorMessage });
				if (next.errorMessage) {
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		};

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = options.sessionManager ?? SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = options.settings
			? SettingsManager.inMemory(options.settings)
			: SettingsManager.create(tempDir, tempDir);

		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			rlmSessionDir: options.rlmSessionDir,
			subagentRuntimeHost: options.subagentRuntimeHost,
		});
		sessions.push(session);
		return { session, sessionManager, capturedHeaders };
	}

	function ledgerFor(session: AgentSession): LineageEvent[] {
		const artifactDir = session.sessionManager.getSessionArtifactDir();
		if (!artifactDir) throw new Error("Missing session artifact dir");
		return readLineageLedger(join(artifactDir, "lineage.jsonl"));
	}

	function turnRequestIds(events: LineageEvent[]): string[] {
		return events
			.filter((event) => event.type === "request_started" && event.kind === "turn")
			.map((event) => (event.type === "request_started" ? event.request_id : ""));
	}

	function sessionStatuses(events: LineageEvent[]): string[] {
		return events
			.filter((event) => event.type === "session_status")
			.map((event) => (event.type === "session_status" ? event.status : ""));
	}

	it("sends one ledger-backed request ID per turn on both wire headers", async () => {
		const { session, capturedHeaders } = createSession();

		await session.prompt("first");
		await session.prompt("second");

		expect(capturedHeaders).toHaveLength(2);
		const requestIds = capturedHeaders.map((headers) => headers?.[LINEAGE_REQUEST_ID_HEADER]);
		expect(requestIds[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(requestIds[1]).toMatch(/^[0-9a-f]{32}$/);
		expect(requestIds[0]).not.toBe(requestIds[1]);
		for (const headers of capturedHeaders) {
			expect(headers?.[IDEMPOTENCY_KEY_HEADER]).toBe(headers?.[LINEAGE_REQUEST_ID_HEADER]);
		}

		// Every wire request ID was written to the durable ledger before the call.
		const events = ledgerFor(session);
		expect(turnRequestIds(events)).toEqual(requestIds);
		expect(events[0]).toMatchObject({ type: "session_registered", depth: 0 });
	});

	it("writes the request event before the provider call is made", async () => {
		const observed: Array<{ wireId: string | undefined; ledgerIds: string[] }> = [];
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const streamFn: StreamFn = (_model, _context, streamOptions) => {
			const ledgerPath = join(sessionManager.getSessionArtifactDir() ?? "", "lineage.jsonl");
			observed.push({
				wireId: streamOptions?.headers?.[LINEAGE_REQUEST_ID_HEADER],
				ledgerIds: turnRequestIds(readLineageLedger(ledgerPath)),
			});
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage("ok") });
			});
			return stream;
		};
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		await session.prompt("prove ordering");

		expect(observed).toHaveLength(1);
		expect(observed[0]?.wireId).toBeDefined();
		expect(observed[0]?.ledgerIds).toContain(observed[0]?.wireId);
	});

	it("reuses the same request ID across auto-retry attempts of one call", async () => {
		const { session, capturedHeaders } = createSession({
			responses: [{ text: "", errorMessage: "overloaded_error" }, { text: "recovered" }],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});

		await session.prompt("retry me");

		expect(capturedHeaders).toHaveLength(2);
		expect(capturedHeaders[0]?.[LINEAGE_REQUEST_ID_HEADER]).toBeDefined();
		expect(capturedHeaders[1]?.[LINEAGE_REQUEST_ID_HEADER]).toBe(capturedHeaders[0]?.[LINEAGE_REQUEST_ID_HEADER]);

		const requestEvents = ledgerFor(session).filter((event) => event.type === "request_started");
		expect(requestEvents).toHaveLength(1);
	});

	it("records spawned-child ancestry from the latest turn and terminal status only at release", async () => {
		const { session: root, capturedHeaders } = createSession();

		await root.prompt("parent turn one");
		await root.prompt("parent turn two");
		const spawned = await root.runRlmChild("child task");
		const childId = basename(spawned.session_dir);
		await waitForAsync(async () => (await root.listRlmSubagents()).subagents[0]?.status === "completed");

		const rootEvents = ledgerFor(root);
		const childLedgerPath = join(spawned.session_dir, "lineage.jsonl");
		expect(existsSync(childLedgerPath)).toBe(true);
		let childEvents = readLineageLedger(childLedgerPath);

		// Ancestry points at the latest parent request at spawn time, not the first.
		// (The parent may have run an extra turn since, for the child's terminal notice.)
		const rootRequestIds = turnRequestIds(rootEvents);
		expect(rootRequestIds.length).toBeGreaterThanOrEqual(2);
		expect(childEvents.find((event) => event.type === "session_registered")).toMatchObject({
			parent_session_id: root.sessionId,
			depth: 1,
			spawned_by_request_id: rootRequestIds[1],
		});

		// Exactly one child turn request, minted in the child ledger only, and on the wire.
		const childRequestIds = turnRequestIds(childEvents);
		expect(childRequestIds).toHaveLength(1);
		expect(rootRequestIds).not.toContain(childRequestIds[0]);
		expect(capturedHeaders.map((headers) => headers?.[LINEAGE_REQUEST_ID_HEADER])).toContain(childRequestIds[0]);

		// A reusable child stays running across follow-up runs until it is released.
		expect(sessionStatuses(childEvents)).toEqual([]);
		assertLineageManifestInvariants(deriveLineageManifest([rootEvents, childEvents]));

		const retained = root.getRlmChildSession(childId);
		if (!retained) throw new Error("Missing retained child session");
		await retained.prompt("follow-up work");
		expect(sessionStatuses(readLineageLedger(childLedgerPath))).toEqual([]);

		await root.deleteRlmSubagent(childId);
		childEvents = readLineageLedger(childLedgerPath);
		expect(sessionStatuses(childEvents)).toEqual(["completed"]);
		assertLineageManifestInvariants(deriveLineageManifest([ledgerFor(root), childEvents]));
	});

	it("restores spawn attribution from the ledger after a resume", async () => {
		const { session: first } = createSession();
		await first.prompt("turn before resume");
		const requestBeforeResume = turnRequestIds(ledgerFor(first))[0];
		const sessionFile = first.sessionFile;
		if (!sessionFile) throw new Error("Missing session file");
		first.dispose();

		const resumedManager = SessionManager.open(sessionFile, join(tempDir, "sessions"));
		const { session: resumed } = createSession({ sessionManager: resumedManager });
		const spawned = await resumed.runRlmChild("child after resume");
		await waitForAsync(async () => (await resumed.listRlmSubagents()).subagents[0]?.status === "completed");

		const childEvents = readLineageLedger(join(spawned.session_dir, "lineage.jsonl"));
		expect(childEvents.find((event) => event.type === "session_registered")).toMatchObject({
			parent_session_id: resumed.sessionId,
			spawned_by_request_id: requestBeforeResume,
		});
		assertLineageManifestInvariants(deriveLineageManifest([ledgerFor(resumed), childEvents]));
	});

	it("records failed for a child whose run errors", async () => {
		let child: AgentSession | undefined;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				const childManager = SessionManager.create(tempDir, options.sessionDir);
				const created = createSession({ sessionManager: childManager, rlmSessionDir: options.sessionDir }).session;
				vi.spyOn(created, "promptAndWait").mockRejectedValue(new Error("child run failed"));
				child = created;
				options.onSessionPublished?.(created);
				return { session: created };
			},
			deleteRlmSubagentRuntime: async (_childId, session) => {
				await session?.disposeAsync();
			},
		};
		const { session: root } = createSession({ subagentRuntimeHost: host });

		await root.prompt("parent turn");
		const spawned = await root.runRlmChild("doomed child");
		await waitForAsync(
			async () => sessionStatuses(readLineageLedger(join(spawned.session_dir, "lineage.jsonl"))).length > 0,
		);

		expect(child).toBeDefined();
		expect(sessionStatuses(readLineageLedger(join(spawned.session_dir, "lineage.jsonl")))).toEqual(["failed"]);
	});

	it("records cancelled for a cancelled child run", async () => {
		let childStarted = false;
		const { session: root } = createSession({
			hangMarker: "hang-task",
			onChildCallStarted: () => {
				childStarted = true;
			},
		});

		await root.prompt("parent turn");
		const spawned = await root.runRlmChild("hang-task");
		await waitForAsync(async () => childStarted);
		expect(root.cancelRlmChildRun(basename(spawned.session_dir))).toBe(true);
		await waitForAsync(
			async () => sessionStatuses(readLineageLedger(join(spawned.session_dir, "lineage.jsonl"))).length > 0,
		);

		expect(sessionStatuses(readLineageLedger(join(spawned.session_dir, "lineage.jsonl")))).toEqual(["cancelled"]);
	});

	it("opens a new context epoch on completed compaction and keeps it on cancel", async () => {
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi: any) => {
					pi.on("session_before_compact", async (event: any) => {
						if (event.customInstructions === "cancel-me") {
							return { cancel: true };
						}
						return {
							compaction: {
								summary: "summarized",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
			tempDir,
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("answer") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		sessions.push(session);

		await session.prompt("one");
		await session.prompt("two");

		await expect(session.compact("cancel-me")).rejects.toThrow("Compaction cancelled");
		let events = ledgerFor(session);
		expect(events.filter((event) => event.type === "compaction_begun")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "compaction_finished", status: "cancelled" });

		await session.compact();
		events = ledgerFor(session);
		const finished = events.filter((event) => event.type === "compaction_finished");
		expect(finished.at(-1)).toMatchObject({ status: "completed" });

		// The next turn runs on the new context epoch created by the completed compaction.
		await session.prompt("three");
		const manifest = deriveLineageManifest([ledgerFor(session)]);
		assertLineageManifestInvariants(manifest);
		expect(manifest.contexts).toHaveLength(2);
		const newContext = manifest.contexts.find((context) => context.transition === "compact");
		const lastTurn = manifest.requests.filter((request) => request.kind === "turn").at(-1);
		expect(lastTurn?.context_id).toBe(newContext?.context_id);
	});

	it("stamps lineage headers on the real compaction summary call without dropping auth headers", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const fauxModel = harness.getModel();
		harness.session.modelRegistry.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: harness.faux.api,
			headers: { "x-lineage-sentinel": "keep-me" },
			models: harness.faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		const ledgerPath = join(harness.sessionManager.getSessionArtifactDir() ?? "", "lineage.jsonl");

		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const captured: Array<Record<string, string> | undefined> = [];
		let ledgerAtCall: LineageEvent[] = [];
		const summaryStep = (_context: unknown, streamOptions: { headers?: Record<string, string> } | undefined) => {
			captured.push(streamOptions?.headers);
			ledgerAtCall = readLineageLedger(ledgerPath);
			return fauxAssistantMessage("the summary");
		};
		// A split-turn compaction makes two summary calls; both share the one request ID.
		harness.setResponses([summaryStep, summaryStep]);
		await harness.session.compact();

		expect(captured.length).toBeGreaterThanOrEqual(1);
		const wireId = captured[0]?.[LINEAGE_REQUEST_ID_HEADER];
		expect(wireId).toMatch(/^[0-9a-f]{32}$/);
		for (const headers of captured) {
			expect(headers?.["x-lineage-sentinel"]).toBe("keep-me");
			expect(headers?.[LINEAGE_REQUEST_ID_HEADER]).toBe(wireId);
			expect(headers?.[IDEMPOTENCY_KEY_HEADER]).toBe(wireId);
		}
		// The compaction request event was durable before the provider call went out.
		expect(ledgerAtCall).toContainEqual(
			expect.objectContaining({ type: "request_started", kind: "compaction", request_id: wireId }),
		);
		const events = readLineageLedger(ledgerPath);
		expect(events.filter((event) => event.type === "compaction_finished").at(-1)).toMatchObject({
			status: "completed",
		});
	});
});
