import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { SessionManager } from "../src/core/session-manager.js";
import { type Settings, SettingsManager } from "../src/core/settings-manager.js";
import { assertLineageManifestInvariants } from "./lineage-invariants.js";
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

type ScriptedResponse = { text: string; errorMessage?: string };

describe("AgentSession lineage", () => {
	let tempDir: string;
	let sessions: AgentSession[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lineage-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessions = [];
	});

	afterEach(() => {
		for (const session of sessions) {
			session.dispose();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(options: { responses?: ScriptedResponse[]; settings?: Partial<Settings> } = {}) {
		const capturedHeaders: Array<Record<string, string> | undefined> = [];
		const responses = options.responses;
		const streamFn: StreamFn = (_model, _context, streamOptions) => {
			capturedHeaders.push(streamOptions?.headers);
			const next = responses?.shift() ?? { text: "ok" };
			const stream = createAssistantMessageEventStream();
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
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
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
		});
		sessions.push(session);
		return { session, sessionManager, capturedHeaders };
	}

	function ledgerFor(session: AgentSession): LineageEvent[] {
		const artifactDir = session.sessionManager.getSessionArtifactDir();
		if (!artifactDir) throw new Error("Missing session artifact dir");
		return readLineageLedger(join(artifactDir, "lineage.jsonl"));
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
		const ledgerRequestIds = events
			.filter((event) => event.type === "request_started")
			.map((event) => (event.type === "request_started" ? event.request_id : ""));
		expect(ledgerRequestIds).toEqual(requestIds);
		expect(events[0]).toMatchObject({ type: "session_registered", depth: 0 });
	});

	it("writes the request event before the provider call is made", async () => {
		const observed: Array<{ wireId: string | undefined; ledgerIds: string[] }> = [];
		const capturedHeaders: Array<Record<string, string> | undefined> = [];
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const streamFn: StreamFn = (_model, _context, streamOptions) => {
			capturedHeaders.push(streamOptions?.headers);
			const ledgerPath = join(sessionManager.getSessionArtifactDir() ?? "", "lineage.jsonl");
			observed.push({
				wireId: streamOptions?.headers?.[LINEAGE_REQUEST_ID_HEADER],
				ledgerIds: readLineageLedger(ledgerPath)
					.filter((event) => event.type === "request_started")
					.map((event) => (event.type === "request_started" ? event.request_id : "")),
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

	it("records a spawned child with parent ancestry and derives a valid manifest", async () => {
		const { session: root } = createSession();

		await root.prompt("parent turn");
		const spawned = await root.runRlmChild("child task");
		const childId = basename(spawned.session_dir);
		const deadline = Date.now() + 5000;
		while ((await root.listRlmSubagents()).subagents[0]?.status !== "completed") {
			if (Date.now() > deadline) throw new Error("Timed out waiting for child completion");
			await sleep(10);
		}

		const rootEvents = ledgerFor(root);
		const childLedgerPath = join(spawned.session_dir, "lineage.jsonl");
		expect(existsSync(childLedgerPath)).toBe(true);
		const childEvents = readLineageLedger(childLedgerPath);

		const rootRequestIds = rootEvents
			.filter((event) => event.type === "request_started")
			.map((event) => (event.type === "request_started" ? event.request_id : ""));
		const childRegistration = childEvents.find((event) => event.type === "session_registered");
		expect(childRegistration).toMatchObject({
			parent_session_id: root.sessionId,
			depth: 1,
			spawned_by_request_id: rootRequestIds[0],
		});
		expect(childEvents.some((event) => event.type === "session_status" && event.status === "completed")).toBe(true);

		const manifest = deriveLineageManifest([rootEvents, childEvents]);
		assertLineageManifestInvariants(manifest);
		expect(manifest.sessions).toHaveLength(2);
		expect(root.getRlmChildSession(childId)).toBeDefined();
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
});
