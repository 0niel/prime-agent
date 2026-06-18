import { describe, expect, test } from "vitest";
import type { CreateAgentSessionOptions } from "../src/core/sdk.js";
import {
	type AppMode,
	type DaemonInteractiveSessionManagerDecision,
	findActiveDaemonSessionSummaryForInteractiveStartup,
	findActiveDaemonSessionSummaryForSessionFile,
	type InteractiveDaemonStartupDecision,
	parseDaemonRichTuiAttachShortcut,
	resolveRuntimeSessionOptions,
	shouldEnsureDaemonBeforeActiveSessionLookup,
	shouldOpenAgentsViewForDaemonInteractive,
	shouldUseDaemonInteractive,
	shouldUseEphemeralSessionManagerForDaemonInteractive,
} from "../src/main.js";
import type { SessionSummary } from "../src/modes/index.js";

describe("interactive startup routing", () => {
	test("uses daemon-backed interactive mode for normal interactive startup", () => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
			}),
		).toBe(true);
	});

	const nonInteractiveModes: Array<[AppMode, string]> = [
		["print", "print mode"],
		["json", "json mode"],
		["rpc", "rpc mode"],
		["daemon", "daemon mode"],
	];

	test.each(nonInteractiveModes)("does not use daemon-backed interactive mode for %s", (appMode) => {
		expect(
			shouldUseDaemonInteractive({
				appMode,
				startupBenchmark: false,
			}),
		).toBe(false);
	});

	type InteractiveFallbackOverrides = Partial<
		Pick<InteractiveDaemonStartupDecision, "startupBenchmark" | "noSession" | "help" | "listModels">
	>;

	const fallbackCases: Array<[string, InteractiveFallbackOverrides]> = [
		["startup benchmark", { startupBenchmark: true }],
		["--no-session", { noSession: true }],
		["--help", { help: true }],
		["--list-models", { listModels: true }],
		["--list-models search", { listModels: "claude" }],
	];

	test.each(fallbackCases)("keeps %s on the non-daemon interactive path", (_label, overrides) => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
				...overrides,
			}),
		).toBe(false);
	});
});

describe("daemon-backed interactive session manager routing", () => {
	test("opens agents view for default daemon-backed interactive startup", () => {
		expect(
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: true,
				needsOnboarding: false,
			}),
		).toBe(true);
	});

	const directAttachCases: Array<[string, Parameters<typeof shouldOpenAgentsViewForDaemonInteractive>[0]]> = [
		["non-daemon interactive path", { useDaemonInteractive: false, needsOnboarding: false }],
		["pending onboarding", { useDaemonInteractive: true, needsOnboarding: true }],
		["explicit session", { useDaemonInteractive: true, needsOnboarding: false, session: "active-1" }],
		["resume picker", { useDaemonInteractive: true, needsOnboarding: false, resume: true }],
		["continue recent", { useDaemonInteractive: true, needsOnboarding: false, continue: true }],
		["fork", { useDaemonInteractive: true, needsOnboarding: false, fork: "source-session-id" }],
	];

	test.each(directAttachCases)("does not open agents view for %s", (_label, decision) => {
		expect(shouldOpenAgentsViewForDaemonInteractive(decision)).toBe(false);
	});

	test("ensures daemon is available before probing non-path session selectors", () => {
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				session: "active-1",
			}),
		).toBe(true);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				session: "/tmp/session.jsonl",
			}),
		).toBe(false);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: false,
				session: "active-1",
			}),
		).toBe(false);
	});

	test("falls back to local session lookup when daemon active-session probing fails", async () => {
		await expect(
			findActiveDaemonSessionSummaryForInteractiveStartup("/tmp/prime.sock", "saved-session-id", async () => {
				throw new Error("Daemon returned an invalid active session summary");
			}),
		).resolves.toBeUndefined();
	});

	test("uses daemon active-session summary when probing succeeds", async () => {
		await expect(
			findActiveDaemonSessionSummaryForInteractiveStartup("/tmp/prime.sock", "active-1", async () => ({
				id: "active-1",
				activeSessionId: "active-1",
				status: "idle",
				sessionId: "session-1",
				cwd: "/tmp/project",
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 0,
				pendingMessageCount: 0,
			})),
		).resolves.toMatchObject({ activeSessionId: "active-1" });
	});

	test("uses an ephemeral local session manager for fresh daemon-owned sessions", () => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive({})).toBe(true);
	});

	const persistentSelectionCases: Array<[string, DaemonInteractiveSessionManagerDecision]> = [
		["active daemon attach", { hasActiveDaemonSession: true }],
		["explicit saved session", { session: "saved-session-id" }],
		["resume picker", { resume: true }],
		["continue recent", { continue: true }],
		["fork", { fork: "source-session-id" }],
	];

	test.each(persistentSelectionCases)("keeps %s on a concrete local session manager", (_label, decision) => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive(decision)).toBe(false);
	});

	test("finds an active daemon session by resolved session file", () => {
		const inactiveSummary = makeSessionSummary({
			id: "saved-1",
			activeSessionId: undefined,
			sessionFile: "/tmp/project/session.jsonl",
		});
		const activeSummary = makeSessionSummary({
			id: "active-1",
			activeSessionId: "active-1",
			sessionFile: "/tmp/project/session.jsonl",
		});

		expect(
			findActiveDaemonSessionSummaryForSessionFile(
				[inactiveSummary, activeSummary],
				"/tmp/project/../project/session.jsonl",
			),
		).toBe(activeSummary);
	});
});

describe("daemon rich TUI attach shortcut parsing", () => {
	test("recognizes daemon active-session shorthand", () => {
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "d5c1e83e2182"])).toMatchObject({
			selector: "d5c1e83e2182",
		});
	});

	test("preserves explicit daemon client commands", () => {
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "attach", "d5c1e83e2182"])).toBeUndefined();
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "list"])).toBeUndefined();
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "create", "scratch"])).toBeUndefined();
	});

	test("carries daemon socket option into shorthand attach", () => {
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "--socket", "/tmp/prime.sock", "d5c1e83e2182"])).toEqual({
			socketPath: "/tmp/prime.sock",
			selector: "d5c1e83e2182",
		});
	});
});

describe("runtime session option resolution", () => {
	test("preserves daemon-provided RLM heartbeat controller when creating sessions", () => {
		const preparedModel = { id: "prepared-model" } as unknown as CreateAgentSessionOptions["model"];
		const runtimeModel = { id: "runtime-model" } as unknown as CreateAgentSessionOptions["model"];
		const rlmHeartbeatController: NonNullable<CreateAgentSessionOptions["rlmHeartbeatController"]> = {
			listRlmHeartbeats: () => [],
			createRlmHeartbeat: () => {
				throw new Error("not used");
			},
			updateRlmHeartbeat: () => undefined,
			deleteRlmHeartbeat: () => undefined,
		};

		const resolved = resolveRuntimeSessionOptions(
			{
				model: preparedModel,
				tools: ["ipython"],
				customTools: [],
			},
			{
				model: runtimeModel,
				rlmHeartbeatController,
				rlmDepth: 1,
				rlmSessionDir: "/tmp/rlm-session",
			},
		);

		expect(resolved).toMatchObject({
			model: runtimeModel,
			tools: ["ipython"],
			customTools: [],
			rlmHeartbeatController,
			rlmDepth: 1,
			rlmSessionDir: "/tmp/rlm-session",
		});
	});
});

function makeSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "session-1",
		status: "idle",
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		pendingMessageCount: 0,
		...overrides,
	};
}
