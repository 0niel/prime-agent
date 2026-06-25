import { describe, expect, test, vi } from "vitest";
import {
	DeferredAgentConnection,
	type DeferredAgentConnectionSeed,
} from "../src/modes/agent-connection/deferred-agent-connection.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionModel,
} from "../src/modes/agent-connection/types.js";

const MODEL = { provider: "anthropic", id: "claude-x" } as unknown as AgentConnectionModel;

const SEED: DeferredAgentConnectionSeed = {
	cwd: "/tmp/project",
	sessionDir: "/tmp/sessions",
	model: MODEL,
	thinkingLevel: "off",
	scopedModels: [],
	availableModels: () => [MODEL],
	steeringMode: "all",
	followUpMode: "all",
	autoCompactionEnabled: true,
};

class FakeRealConnection {
	readonly listeners = new Set<(event: AgentConnectionEvent) => void>();
	readonly beforeInvalidate = new Set<() => void>();
	readonly promptCalls: string[] = [];
	disposed = false;

	subscribe(listener: (event: AgentConnectionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onBeforeSessionInvalidate(listener: () => void): () => void {
		this.beforeInvalidate.add(listener);
		return () => this.beforeInvalidate.delete(listener);
	}
	emit(event: AgentConnectionEvent): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}
	async getState() {
		return { sessionId: "real-session", activeSessionId: "real-session", cwd: "/tmp/project" };
	}
	async getMessages() {
		return [{ role: "user", content: "hi" }];
	}
	async prompt(message: string) {
		this.promptCalls.push(message);
	}
	async dispose() {
		this.disposed = true;
	}
}

function makeFactory(fake = new FakeRealConnection()) {
	const factory = vi.fn(async () => ({
		connection: fake as unknown as AgentConnection,
		activeSessionId: "real-session",
	}));
	return { factory, fake };
}

describe("DeferredAgentConnection", () => {
	test("serves local catalog and creates nothing for reads or dispose", async () => {
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		const state = await conn.getState();
		expect(state.model).toBe(MODEL);
		expect(state.cwd).toBe("/tmp/project");
		expect(state.messageCount).toBe(0);
		expect(await conn.getCommands()).toEqual([]);
		expect(await conn.getMessages()).toEqual([]);
		expect(await conn.getAvailableModels()).toEqual([MODEL]);
		expect(await conn.getQueue()).toEqual({ steering: [], followUp: [] });
		expect((await conn.getSessionStats()).totalMessages).toBe(0);

		await conn.dispose();
		expect(factory).not.toHaveBeenCalled();
		expect(conn.created).toBe(false);
	});

	test("derives available thinking levels from the seed model before a session exists", async () => {
		const reasoningModel = {
			provider: "anthropic",
			id: "claude-opus",
			reasoning: true,
		} as unknown as AgentConnectionModel;
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, { ...SEED, model: reasoningModel });

		const state = await conn.getState();

		expect(state.availableThinkingLevels).toContain("high");
		expect(state.availableThinkingLevels.length).toBeGreaterThan(1);
		expect(factory).not.toHaveBeenCalled();
	});

	test("reports no thinking levels for a non-reasoning seed model", async () => {
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		const state = await conn.getState();

		expect(state.availableThinkingLevels).toEqual(["off"]);
	});

	test("re-evaluates availableModels on each read so login during onboarding shows models", async () => {
		const { factory } = makeFactory();
		let models: AgentConnectionModel[] = [];
		const conn = new DeferredAgentConnection(factory, { ...SEED, availableModels: () => models });

		expect(await conn.getAvailableModels()).toEqual([]);

		models = [MODEL];
		expect(await conn.getAvailableModels()).toEqual([MODEL]);
		expect(factory).not.toHaveBeenCalled();
	});

	test("creates the session on first prompt and delegates", async () => {
		const { factory, fake } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const events: AgentConnectionEvent[] = [];
		conn.subscribe((event) => {
			events.push(event);
		});

		await conn.prompt("do the thing");

		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.promptCalls).toEqual(["do the thing"]);
		expect(conn.created).toBe(true);
		expect(events.some((event) => event.type === "session_replaced")).toBe(true);
	});

	test("is single-flight when actions race the first creation", async () => {
		const { factory, fake } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		await Promise.all([conn.prompt("a"), conn.prompt("b")]);

		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.promptCalls.sort()).toEqual(["a", "b"]);
	});

	test("pipes real connection events through after promotion", async () => {
		const { fake, factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const events: AgentConnectionEvent[] = [];
		conn.subscribe((event) => {
			events.push(event);
		});

		await conn.prompt("go");
		const replacedCount = events.filter((event) => event.type === "session_replaced").length;
		fake.emit({ type: "session_status", recap: "working" });

		expect(events.at(-1)).toEqual({ type: "session_status", recap: "working" });
		// Promotion emits exactly one session_replaced; later events are not re-replays.
		expect(replacedCount).toBe(1);
	});

	test("buffers onBeforeSessionInvalidate listeners until promotion", async () => {
		const { fake, factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const listener = vi.fn();
		conn.onBeforeSessionInvalidate(listener);

		expect(fake.beforeInvalidate.size).toBe(0);
		await conn.prompt("go");
		expect(fake.beforeInvalidate.has(listener)).toBe(true);
	});

	test("dispose after creation tears down the real connection", async () => {
		const { fake, factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const events: AgentConnectionEvent[] = [];
		conn.subscribe((event) => {
			events.push(event);
		});
		await conn.prompt("go");

		await conn.dispose();
		expect(fake.disposed).toBe(true);

		const countAfterDispose = events.length;
		fake.emit({ type: "session_status", recap: "late" });
		expect(events.length).toBe(countAfterDispose);
	});

	test("read-only stop actions never create a session", async () => {
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		await conn.abort();
		await conn.waitForIdle();
		await conn.abortBash();
		expect(await conn.cancelRlmChild("child")).toBe(false);

		expect(factory).not.toHaveBeenCalled();
		expect(conn.created).toBe(false);
	});

	test("disposes a session created while teardown was in flight", async () => {
		const fake = new FakeRealConnection();
		const discarded: string[] = [];
		type FactoryResult = { connection: AgentConnection; activeSessionId: string };
		let resolveFactory: (result: FactoryResult) => void = () => {};
		const factory = vi.fn(
			() =>
				new Promise<FactoryResult>((resolve) => {
					resolveFactory = resolve;
				}),
		);
		const conn = new DeferredAgentConnection(factory, SEED, async (id) => {
			discarded.push(id);
		});

		// Start promotion, then dispose before the factory resolves.
		const prompting = conn.prompt("go").catch(() => undefined);
		const disposing = conn.dispose();
		resolveFactory({ connection: fake as unknown as AgentConnection, activeSessionId: "real-session" });
		await Promise.all([prompting, disposing]);

		expect(fake.disposed).toBe(true);
		// The session the factory created during teardown is dropped, not orphaned.
		expect(discarded).toEqual(["real-session"]);
		// The aborted promotion never wires events through.
		const events: AgentConnectionEvent[] = [];
		conn.subscribe((event) => {
			events.push(event);
		});
		fake.emit({ type: "session_status", recap: "late" });
		expect(events).toEqual([]);
	});

	test("finishes the session_replaced handler before sending the triggering action", async () => {
		const order: string[] = [];
		const fake = new FakeRealConnection();
		const originalPrompt = fake.prompt.bind(fake);
		fake.prompt = async (message: string) => {
			order.push("prompt");
			return originalPrompt(message);
		};
		const conn = new DeferredAgentConnection(
			async () => ({ connection: fake as unknown as AgentConnection, activeSessionId: "real-session" }),
			SEED,
		);
		conn.subscribe(async (event) => {
			if (event.type === "session_replaced") {
				// Simulate the UI's async rebind work.
				await Promise.resolve();
				order.push("replaced");
			}
		});

		await conn.prompt("hi");

		// The action must not be sent until the UI has rebound, or its events
		// would double-render against the rebind.
		expect(order).toEqual(["replaced", "prompt"]);
	});

	test("discards an abandoned promoted session on dispose", async () => {
		const discarded: string[] = [];
		const conn = new DeferredAgentConnection(
			async () => ({
				connection: new FakeRealConnection() as unknown as AgentConnection,
				activeSessionId: "real-session",
			}),
			SEED,
			async (id) => {
				discarded.push(id);
			},
		);

		await conn.prompt("go"); // promotes the session
		await conn.dispose();

		expect(discarded).toEqual(["real-session"]);
	});

	test("does not attempt discard when never promoted", async () => {
		const discarded: string[] = [];
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED, async (id) => {
			discarded.push(id);
		});

		await conn.dispose();

		expect(factory).not.toHaveBeenCalled();
		expect(discarded).toEqual([]);
	});

	test("does not half-promote when the initial state fetch fails", async () => {
		const fake = new FakeRealConnection();
		fake.getState = async () => {
			throw new Error("state fetch failed");
		};
		const discarded: string[] = [];
		const conn = new DeferredAgentConnection(
			async () => ({ connection: fake as unknown as AgentConnection, activeSessionId: "real-session" }),
			SEED,
			async (id) => {
				discarded.push(id);
			},
		);

		await expect(conn.prompt("go")).rejects.toThrow("state fetch failed");
		// The uncommitted connection was torn down and its orphaned daemon session
		// discarded, leaving nothing half-wired.
		expect(fake.disposed).toBe(true);
		expect(conn.created).toBe(false);
		expect(discarded).toEqual(["real-session"]);
	});

	test("getContextTree does not create a session", async () => {
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		const tree = await conn.getContextTree();
		expect(tree.children).toEqual([]);
		expect(factory).not.toHaveBeenCalled();
		expect(conn.created).toBe(false);
	});

	test("retries promotion after a failed first attempt", async () => {
		const fake = new FakeRealConnection();
		let attempt = 0;
		const factory = vi.fn(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("daemon unavailable");
			}
			return { connection: fake as unknown as AgentConnection, activeSessionId: "real-session" };
		});
		const conn = new DeferredAgentConnection(factory, SEED);

		await expect(conn.prompt("first")).rejects.toThrow("daemon unavailable");
		await conn.prompt("second");

		expect(factory).toHaveBeenCalledTimes(2);
		expect(fake.promptCalls).toEqual(["second"]);
	});

	test("rolls back a partial commit so a later action retries", async () => {
		const fakes: FakeRealConnection[] = [];
		let attempt = 0;
		const factory = vi.fn(async () => {
			const fake = new FakeRealConnection();
			attempt += 1;
			if (attempt === 1) {
				// Throw after this.real is already assigned in promote().
				fake.subscribe = () => {
					throw new Error("subscribe failed");
				};
			}
			fakes.push(fake);
			return { connection: fake as unknown as AgentConnection, activeSessionId: "real-session" };
		});
		const conn = new DeferredAgentConnection(factory, SEED);

		await expect(conn.prompt("first")).rejects.toThrow("subscribe failed");
		expect(conn.created).toBe(false);
		expect(fakes[0].disposed).toBe(true);

		await conn.prompt("second");
		expect(factory).toHaveBeenCalledTimes(2);
		expect(conn.created).toBe(true);
		expect(fakes[1].promptCalls).toEqual(["second"]);
	});

	test("unsubscribing a before-invalidate listener after promotion detaches it from the real connection", async () => {
		const { fake, factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const listener = vi.fn();
		const unsubscribe = conn.onBeforeSessionInvalidate(listener);

		await conn.prompt("go");
		expect(fake.beforeInvalidate.has(listener)).toBe(true);

		unsubscribe();
		expect(fake.beforeInvalidate.has(listener)).toBe(false);
	});
});

describe("DeferredAgentConnection with a real-style saved-session lister", () => {
	test("delegates saved-session listing once promoted", async () => {
		const saved = [{ id: "s1" }] as unknown as Awaited<ReturnType<AgentConnection["listSavedSessions"]>>;
		const fake = Object.assign(new FakeRealConnection(), {
			listSavedSessions: async () => saved,
		});
		const conn = new DeferredAgentConnection(
			async () => ({ connection: fake as unknown as AgentConnection, activeSessionId: "real-session" }),
			SEED,
		);

		await conn.prompt("go");
		expect(await conn.listSavedSessions("current")).toBe(saved);
	});
});
