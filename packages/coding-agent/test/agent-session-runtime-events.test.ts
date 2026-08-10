import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionFactory } from "../src/index.js";

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		vi.unstubAllEnvs();
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("releases a replacement lease when current-session teardown fails", async () => {
		vi.stubEnv(SESSION_LEASES_ENABLED_ENV, "1");
		vi.stubEnv(SESSION_LEASE_OWNER_ID_ENV, "runtime-events");
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		runtimeHost.setBeforeSessionInvalidate(() => {
			throw new Error("teardown failed");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("teardown failed");
		runtimeHost.setBeforeSessionInvalidate(undefined);
		const leaseRoot = join(runtimeHost.services.agentDir, "session-leases");
		expect(readdirSync(leaseRoot).filter((entry) => entry.endsWith(".lock"))).toHaveLength(1);
	});
});

describe("AgentSession RLM child update ownership", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		vi.useRealTimers();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createSession(responses: FauxResponseStep[] = [fauxAssistantMessage("child response")]) {
		const tempDir = join(tmpdir(), `pi-c02-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses(responses);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			agentDir: tempDir,
			authStorage,
			cwd: tempDir,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const session = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			model: faux.getModel(),
			rlmDepth: 0,
			rlmMaxDepth: 2,
		});
		cleanups.push(async () => {
			session.session.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		return session.session as any;
	}

	async function waitFor(condition: () => boolean, description: string): Promise<void> {
		const deadline = Date.now() + 2_000;
		while (!condition()) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
	}

	function afterMacrotask(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	function update(id: string, status: "queued" | "running" | "done" | "error" | "cancelled", preview?: string) {
		return {
			type: "rlm_child_update" as const,
			child: { id, label: `child-${id}`, status, sessionDir: `/tmp/${id}`, answerPreview: preview },
		};
	}

	it("coalesces 64 latest activity snapshots, retains status edges, and clears zero-delay work on dispose", async () => {
		vi.useFakeTimers();
		const session = await createSession();
		const observed: Array<{ id: string; status: string; preview?: string }> = [];
		session.subscribe((event: any) => {
			if (event.type === "rlm_child_update")
				observed.push({ id: event.child.id, status: event.child.status, preview: event.child.answerPreview });
		});
		for (let i = 0; i < 64; i++) session._queueRlmChildUpdate(update(String(i), "queued"), () => true, true);
		for (let i = 0; i < 64; i++) session._queueRlmChildUpdate(update(String(i), "running"), () => true, true);
		for (let i = 0; i < 64; i++) {
			const id = String(i);
			session._queueRlmChildUpdate(update(id, "running", "x".repeat(160)), () => true, false);
			session._queueRlmChildUpdate(update(id, "running", `latest-${id}`), () => true, false);
		}
		expect(session._pendingRlmChildUpdates.size).toBe(64);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(session._pendingRlmChildUpdates.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		for (let i = 0; i < 64; i++) {
			const child = observed.filter((entry) => entry.id === String(i));
			expect(child.map((entry) => entry.status)).toEqual(["queued", "running", "running"]);
			expect(child.at(-1)?.preview).toBe(`latest-${i}`);
		}
		session._queueRlmChildUpdate(update("teardown", "running"), () => true, false);
		expect(vi.getTimerCount()).toBe(1);
		session.dispose();
		expect(session._pendingRlmChildUpdates.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(observed.some((entry) => entry.id === "teardown")).toBe(false);
	});

	it("rechecks the C01 assignment fence at enqueue and flush, so stale A cannot publish over B", async () => {
		vi.useFakeTimers();
		const session = await createSession();
		const observed: string[] = [];
		session.subscribe((event: any) => {
			if (event.type === "rlm_child_update") observed.push(event.child.answerPreview);
		});
		let aCurrent = true;
		let bCurrent = true;
		session._queueRlmChildUpdate(update("same-id", "running", "A"), () => aCurrent, false);
		aCurrent = false;
		session._queueRlmChildUpdate(update("same-id", "running", "B"), () => bCurrent, false);
		await vi.advanceTimersByTimeAsync(0);
		expect(observed).toEqual(["B"]);
		bCurrent = false;
		session._queueRlmChildUpdate(update("same-id", "running", "stale-B"), () => bCurrent, false);
		await vi.advanceTimersByTimeAsync(0);
		expect(observed).toEqual(["B"]);
	});

	it("uses the public child lifecycle for synchronous first-running, coalesced activity, and ordering", async () => {
		let releaseAnswer!: () => void;
		const answerGate = new Promise<void>((resolve) => {
			releaseAnswer = resolve;
		});
		const session = await createSession([
			async () => {
				await answerGate;
				return fauxAssistantMessage("child completed");
			},
		]);
		let releaseRuntime!: () => void;
		const runtimeGate = new Promise<void>((resolve) => {
			releaseRuntime = resolve;
		});
		const createInlineRuntime = session._createInlineRlmSubagentRuntime.bind(session);
		session.setSubagentRuntimeHost({
			assignmentIdentityFenced: true,
			createRlmSubagentRuntime: async (options: any) => {
				await runtimeGate;
				return createInlineRuntime(options);
			},
			deleteRlmSubagentRuntime: async (_id: string, child: any) => child?.disposeAsync(),
		});
		const observed: Array<{ type: string; status?: string; recap?: string }> = [];
		session.subscribe((event: any) => {
			observed.push({ type: event.type, status: event.child?.status, recap: event.child?.recap });
		});

		const spawned = await session.runRlmChild("hold for lifecycle assertions");
		// This C01 host gate makes the public admission boundary deterministic:
		// queued is synchronous, then the first running edge is emitted immediately
		// when the real runtime is published, before activity can be coalesced.
		expect(observed.map((event) => event.status).filter(Boolean)).toEqual(["queued"]);
		releaseRuntime();
		await waitFor(
			() => observed.filter((event) => event.status === "running").length === 1,
			"the first running child update",
		);
		const child = session.getRlmChildSession(spawned.rlm_child_id);
		expect(child).toBeDefined();

		child?.setCurrentRecap("first active snapshot");
		child?.setCurrentRecap("latest active snapshot");
		expect(observed.filter((event) => event.status === "running")).toHaveLength(1);
		await afterMacrotask();
		expect(observed.filter((event) => event.status === "running")).toHaveLength(2);
		expect(observed.at(-1)).toMatchObject({ status: "running", recap: "latest active snapshot" });

		child?.setCurrentRecap("before structural transition");
		session.setSessionName("structural transition");
		const structuralIndex = observed.findIndex((event) => event.type === "session_info_changed");
		expect(observed[structuralIndex - 1]).toMatchObject({
			status: "running",
			recap: "before structural transition",
		});

		child?.setCurrentRecap("before terminal transition");
		releaseAnswer();
		await waitFor(() => observed.some((event) => event.status === "done"), "the terminal child update");
		const terminalIndex = observed.findIndex((event) => event.status === "done");
		const pendingBeforeTerminal = observed.findIndex(
			(event) => event.status === "running" && event.recap === "before terminal transition",
		);
		expect(pendingBeforeTerminal).toBeGreaterThanOrEqual(0);
		expect(pendingBeforeTerminal).toBeLessThan(terminalIndex);
		expect(observed.slice(terminalIndex + 1).some((event) => event.status === "running")).toBe(false);
	});

	it("uses the C01 assignment ownership fence when a real A child is replaced by B", async () => {
		let releaseAnswer!: () => void;
		const answerGate = new Promise<void>((resolve) => {
			releaseAnswer = resolve;
		});
		const session = await createSession([
			async () => {
				await answerGate;
				return fauxAssistantMessage("A completed");
			},
		]);
		const observed: Array<{ status: string; recap?: string }> = [];
		session.subscribe((event: any) => {
			if (event.type === "rlm_child_update") observed.push({ status: event.child.status, recap: event.child.recap });
		});
		const spawned = await session.runRlmChild("A must not publish after replacement");
		await waitFor(() => observed.some((event) => event.status === "running"), "A running");
		const childA = session.getRlmChildSession(spawned.rlm_child_id);
		expect(childA).toBeDefined();

		// This is the C01-owned selector replacement state: B has the same public
		// selector but a new immutable assignment and session. Trigger A through its
		// public child event path, rather than calling the queue helper directly.
		const childB = await createSession();
		const internals = session as any;
		internals._activeRlmChildRuns.delete(spawned.rlm_child_id);
		expect(session.registerRlmChildSession(spawned.rlm_child_id, childB, undefined, "assignment-B")).toBe(true);
		const beforeAActivity = observed.length;
		childA?.setCurrentRecap("stale A activity");
		await afterMacrotask();
		expect(observed).toHaveLength(beforeAActivity);
		expect(internals._rlmChildSessions.get(spawned.rlm_child_id)).toBe(childB);
		expect(internals._rlmChildSessionAssignments.get(spawned.rlm_child_id)).toBe("assignment-B");
		releaseAnswer();
	});

	it("cancels real pending child activity on abort, update restart, and dispose", async () => {
		for (const teardown of [
			{ name: "abort", run: async (session: any) => session.abort() },
			{ name: "update restart", run: async (session: any) => session.abortForUpdateRestart() },
			{ name: "dispose", run: async (session: any) => session.dispose() },
		]) {
			let releaseAnswer!: () => void;
			const answerGate = new Promise<void>((resolve) => {
				releaseAnswer = resolve;
			});
			const session = await createSession([
				async () => {
					await answerGate;
					return fauxAssistantMessage("unreachable");
				},
			]);
			const observed: Array<{ status: string; recap?: string }> = [];
			session.subscribe((event: any) => {
				if (event.type === "rlm_child_update")
					observed.push({ status: event.child.status, recap: event.child.recap });
			});
			const spawned = await session.runRlmChild(`pending ${teardown.name}`);
			await waitFor(() => observed.some((event) => event.status === "running"), `${teardown.name} running`);
			session.getRlmChildSession(spawned.rlm_child_id)?.setCurrentRecap(`stale ${teardown.name}`);
			expect(session._pendingRlmChildUpdates.size).toBe(1);
			await teardown.run(session);
			await afterMacrotask();
			expect(session._pendingRlmChildUpdates.size, teardown.name).toBe(0);
			expect(session._rlmChildUpdateFlushTimer, teardown.name).toBeUndefined();
			expect(observed.some((event) => event.status === "running" && event.recap === `stale ${teardown.name}`)).toBe(
				false,
			);
			releaseAnswer();
		}
	});

	it("bounds a real child assistant preview at 160 characters", async () => {
		const session = await createSession([fauxAssistantMessage("x".repeat(200))]);
		const previews: string[] = [];
		session.subscribe((event: any) => {
			if (event.type === "rlm_child_update" && event.child.answerPreview) previews.push(event.child.answerPreview);
		});
		await session.runRlmChild("produce a long preview");
		await waitFor(() => previews.some((preview) => preview.endsWith("...")), "a compacted child preview");
		const preview = previews.find((entry) => entry.endsWith("..."));
		expect(preview).toHaveLength(160);
		expect(preview).toBe(`${"x".repeat(157)}...`);
	});

	it("isolates a throwing afterToolCall hook while preserving beforeToolCall vetoes", async () => {
		const session = await createSession();
		const runner = session._extensionRunner;
		vi.spyOn(runner as any, "hasHandlers").mockImplementation(
			(...args: unknown[]) => args[0] === "tool_result" || args[0] === "tool_call",
		);
		vi.spyOn(runner, "emitToolResult").mockRejectedValue(new Error("tool output must not leak"));
		vi.spyOn(runner, "emitToolCall").mockRejectedValue(new Error("veto"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = { content: [{ type: "text", text: "original" }], details: undefined };
		await expect(
			session.agent.afterToolCall?.({
				toolCall: { id: "id", name: "tool", arguments: {} },
				args: {},
				result,
				isError: false,
			}),
		).resolves.toBeUndefined();
		expect(session._afterToolHookFailureDiagnostics).toBe(1);
		expect(warning.mock.calls.join(" ")).not.toContain("tool output must not leak");
		await expect(
			session.agent.beforeToolCall?.({ toolCall: { id: "id", name: "tool", arguments: {} }, args: {} }),
		).rejects.toThrow("veto");
		warning.mockRestore();
	});

	it("isolates throwing observers without leaking content-bearing diagnostics", async () => {
		const session = await createSession();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const received: string[] = [];
		session.subscribe(() => {
			throw new Error("secret prompt must not be logged");
		});
		session.subscribe((event: any) => {
			if (event.type === "rlm_child_update") received.push(event.child.id);
		});
		session._queueRlmChildUpdate(update("terminal", "done"), () => true, true);
		expect(received).toEqual(["terminal"]);
		expect(session._observerFailureDiagnostics).toBe(1);
		expect(warning.mock.calls.join(" ")).not.toContain("secret prompt");
		warning.mockRestore();
	});
});
