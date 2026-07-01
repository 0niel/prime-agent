import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PLAN_MODE_PROMPT } from "../src/core/prompts/plan-mode.js";
import {
	buildSessionContext,
	type PlanModeChangeEntry,
	type SessionEntry,
	SessionManager,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

function planModeEntry(id: string, parentId: string | null, enabled: boolean): PlanModeChangeEntry {
	return { type: "plan_mode_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", enabled };
}

function thinkingEntry(id: string, parentId: string | null, level: string): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

describe("buildSessionContext plan mode", () => {
	it("defaults to off", () => {
		const entries: SessionEntry[] = [thinkingEntry("t1", null, "medium")];
		expect(buildSessionContext(entries).planMode).toBe(false);
	});

	it("restores the last plan_mode_change on the branch", () => {
		const entries: SessionEntry[] = [
			thinkingEntry("t1", null, "medium"),
			planModeEntry("p1", "t1", true),
			planModeEntry("p2", "p1", false),
			planModeEntry("p3", "p2", true),
		];
		expect(buildSessionContext(entries).planMode).toBe(true);
	});
});

describe("AgentSession plan mode", () => {
	let tempDir: string;
	let runtimeHost: AgentSessionRuntime | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-plan-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await runtimeHost?.dispose();
		runtimeHost = undefined;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: {
		sessionManager?: SessionManager;
		planMode?: boolean;
	}): Promise<AgentSession> {
		const sessionManager = options?.sessionManager ?? SessionManager.create(tempDir, join(tempDir, "sessions"));
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				authStorage,
				cwd,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					planMode: options?.planMode,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		return runtimeHost.session;
	}

	it("toggles, emits, and persists a plan_mode_change entry", async () => {
		const session = await createSession();
		expect(session.planMode).toBe(false);

		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(event);
		});

		await session.setPlanMode(true);
		expect(session.planMode).toBe(true);
		expect(events).toContainEqual({ type: "plan_mode_changed", enabled: true });

		// No-op toggle appends nothing.
		await session.setPlanMode(true);
		const planEntries = session.sessionManager.getEntries().filter((e) => e.type === "plan_mode_change");
		expect(planEntries).toHaveLength(1);
		expect(planEntries[0]).toMatchObject({ enabled: true });
	});

	it("restores plan mode when resuming a session", async () => {
		const session = await createSession();
		const sessionFile = session.sessionFile!;
		// Entries only flush to disk once an assistant message exists.
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		await session.setPlanMode(true);
		await runtimeHost!.dispose();
		runtimeHost = undefined;

		const resumed = await createSession({ sessionManager: SessionManager.open(sessionFile) });
		expect(resumed.planMode).toBe(true);
	});

	it("starts in plan mode when configured and records an entry", async () => {
		const session = await createSession({ planMode: true });
		expect(session.planMode).toBe(true);
		const planEntries = session.sessionManager.getEntries().filter((e) => e.type === "plan_mode_change");
		expect(planEntries).toHaveLength(1);
	});

	it("appends the plan-mode prompt per turn, only while active", async () => {
		const seenSystemPrompts: string[] = [];
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [] },
			streamFn: () => {
				seenSystemPrompts.push(agent.state.systemPrompt);
				const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
					(event) => event.type === "done" || event.type === "error",
					(event) => {
						if (event.type === "done") return event.message;
						throw new Error("unexpected event");
					},
				);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "mock",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const mockSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			await mockSession.setPlanMode(true);
			await mockSession.prompt("first");
			await mockSession.setPlanMode(false);
			await mockSession.prompt("second");
		} finally {
			mockSession.dispose();
		}

		expect(seenSystemPrompts).toHaveLength(2);
		expect(seenSystemPrompts[0].endsWith(PLAN_MODE_PROMPT)).toBe(true);
		expect(seenSystemPrompts[1]).not.toContain("<plan_mode>");
	});

	it("blocks mutating side tools while active", async () => {
		const session = await createSession();
		const call = (name: string) =>
			session.agent.beforeToolCall?.(
				{
					toolCall: { type: "toolCall", id: "t1", name, arguments: {} },
					args: {},
				} as never,
				undefined,
			);

		await session.setPlanMode(true);
		for (const name of ["edit", "write", "bash"]) {
			const result = await call(name);
			expect(result?.block, name).toBe(true);
		}
		expect(await call("ipython")).toBeUndefined();

		await session.setPlanMode(false);
		expect(await call("edit")).toBeUndefined();
	});
});
