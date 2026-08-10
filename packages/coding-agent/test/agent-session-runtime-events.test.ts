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
		// Terminal delivery is a hard barrier: it follows the last retained
		// activity for that child rather than replacing it.
		session._queueRlmChildUpdate(update("terminal", "running", "last-progress"), () => true, false);
		session._queueRlmChildUpdate(update("terminal", "done"), () => true, true);
		const terminalEvents = observed.filter((entry) => entry.id === "terminal");
		expect(terminalEvents.map((entry) => [entry.status, entry.preview])).toEqual([
			["running", "last-progress"],
			["done", undefined],
		]);

		session._queueRlmChildUpdate(update("teardown", "running"), () => true, false);
		expect(vi.getTimerCount()).toBe(1);
		session.dispose();
		expect(session._pendingRlmChildUpdates.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(observed.some((entry) => entry.id === "teardown")).toBe(false);
	});

	it("keeps same child ids from different parents scoped, with activity before each terminal", async () => {
		vi.useFakeTimers();
		const session = await createSession();
		const observed: string[] = [];
		session.subscribe((event: any) => {
			if (event.type === "rlm_child_update") {
				observed.push(`${event.child.label}:${event.child.status}:${event.child.answerPreview ?? ""}`);
			}
		});
		const sameChildUnder = (parent: string, status: "running" | "done", preview?: string) => ({
			type: "rlm_child_update" as const,
			child: {
				id: "same-child-id",
				parentId: "same-parent-local-id",
				label: "same child",
				status,
				sessionDir: `/private/internal/${parent}/sub-same-child-id`,
				answerPreview: preview,
			},
		});

		// These simulate sibling/nested parent sessions reusing the same local id.
		// Session paths remain internal map keys; assertions use UI-safe labels only.
		session._queueRlmChildUpdate(sameChildUnder("parent-a", "running", "A activity"), () => true, false);
		session._queueRlmChildUpdate(sameChildUnder("parent-b", "running", "B activity"), () => true, false);
		expect(session._pendingRlmChildUpdates.size).toBe(2);
		session._queueRlmChildUpdate(sameChildUnder("parent-a", "done"), () => true, true);
		session._queueRlmChildUpdate(sameChildUnder("parent-b", "done"), () => true, true);

		expect(observed).toEqual([
			"same child:running:A activity",
			"same child:running:B activity",
			"same child:done:",
			"same child:done:",
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rechecks the ownership fence at enqueue and flush, so stale A cannot publish over B", async () => {
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
		// This host gate makes the public admission boundary deterministic:
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

});
