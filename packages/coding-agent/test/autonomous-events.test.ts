import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AutonomousEvent,
	addAutonomousContinuation,
	autonomousLimitReason,
	autonomousLimitUsage,
	createAutonomousRuntimeState,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
} from "../src/core/autonomous.js";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createCwd(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-autonomous-events-"));
	tempRoots.push(root);
	return root;
}

function createState(gateCommands: string[]) {
	return createAutonomousRuntimeState({
		enabled: true,
		gates: { commands: gateCommands, maxRetries: 3, timeoutMs: 30_000 },
	});
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
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
}

describe("autonomous events", () => {
	it("emits a start/end pair when a gate passes", async () => {
		const cwd = createCwd();
		const state = createState(["exit 0"]);
		const events: AutonomousEvent[] = [];

		await refreshAutonomousQualityGates(state, { cwd, onEvent: (event) => events.push(event) });

		expect(events.map((event) => event.type)).toEqual(["autonomous_gate_start", "autonomous_gate_end"]);
		expect(events[1]).toMatchObject({ command: "exit 0", passed: true, attempt: 1, maxRetries: 3 });
	});

	it("reports the failing command, attempt, and output when a gate fails", async () => {
		const cwd = createCwd();
		const state = createState(["echo boom >&2; exit 3"]);
		const events: AutonomousEvent[] = [];

		await refreshAutonomousQualityGates(state, { cwd, onEvent: (event) => events.push(event) });

		const end = events.find((event) => event.type === "autonomous_gate_end");
		expect(end).toMatchObject({ passed: false, attempt: 1, maxRetries: 3 });
		expect(end && "exitText" in end ? end.exitText : "").toContain("3");
		expect(end && "output" in end ? end.output : "").toContain("boom");
	});

	it("marks the workspace-unchanged short circuit as skipped", async () => {
		// The short circuit compares git worktree snapshots, so it needs a real repo.
		const cwd = createCwd();
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, "file.txt"), "one");
		execFileSync("git", ["add", "-A"], { cwd });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"], { cwd });
		const state = createState(["exit 3"]);

		await refreshAutonomousQualityGates(state, { cwd });
		const events: AutonomousEvent[] = [];
		await refreshAutonomousQualityGates(state, { cwd, onEvent: (event) => events.push(event) });

		// The rerun is short-circuited, so no gate_start is emitted for it.
		expect(events.map((event) => event.type)).toEqual(["autonomous_gate_end"]);
		expect(events[0]).toMatchObject({ passed: false, skipped: true, attempt: 2 });
	});

	it("emits a continuation with its reason when a gate fails", async () => {
		const cwd = createCwd();
		const state = createState(["exit 3"]);
		const events: AutonomousEvent[] = [];

		await nextAutonomousContinuation(state, assistantMessage(), {
			cwd,
			onEvent: (event) => events.push(event),
		});

		expect(events.at(-1)).toMatchObject({
			type: "autonomous_continuation",
			reason: "gate_failed",
			continuationsUsed: 1,
		});
	});

	it("emits autonomous_limit_reached with the binding limit", async () => {
		const cwd = createCwd();
		// No gates: the run settles on limits alone.
		const state = createState([]);
		state.limits = { ...state.limits, maxContinuations: 1 };
		state.continuationsUsed = 1;
		const events: AutonomousEvent[] = [];

		await nextAutonomousContinuation(state, assistantMessage(), {
			cwd,
			onEvent: (event) => events.push(event),
		});

		expect(events).toEqual([{ type: "autonomous_limit_reached", reason: "maxContinuations", used: 1, limit: 1 }]);
	});

	it("reports host-driven continuations and limits, which bypass in-session evaluation", async () => {
		const cwd = createCwd();
		const state = createState([]);
		state.limits = { ...state.limits, maxContinuations: 2 };
		const events: AutonomousEvent[] = [];

		// Mirrors AgentSession.recordHostAutonomousContinuation + reportAutonomousLimitReached,
		// the path waitForHeadlessCompletion drives with suppressAutonomousContinuation.
		addAutonomousContinuation(state);
		events.push({
			type: "autonomous_continuation",
			reason: "gate_failed",
			continuationsUsed: state.continuationsUsed,
			maxContinuations: state.limits.maxContinuations,
		});
		addAutonomousContinuation(state);
		const reason = autonomousLimitReason(state);
		expect(reason).toBe("maxContinuations");
		if (reason) {
			events.push({ type: "autonomous_limit_reached", reason, ...autonomousLimitUsage(state, reason) });
		}

		expect(events).toEqual([
			{ type: "autonomous_continuation", reason: "gate_failed", continuationsUsed: 1, maxContinuations: 2 },
			{ type: "autonomous_limit_reached", reason: "maxContinuations", used: 2, limit: 2 },
		]);
		void cwd;
	});

	it("reports one stop once when both paths observe the same limit", async () => {
		// Mirrors AgentSession._emitAutonomousEvent: the in-session decision and the
		// host loop both see the stop, but clients get a single frame.
		const emitted: AutonomousEvent[] = [];
		let reported: string | undefined;
		const funnel = (event: AutonomousEvent) => {
			if (event.type === "autonomous_limit_reached") {
				if (reported === event.reason) return;
				reported = event.reason;
			}
			emitted.push(event);
		};

		const state = createState([]);
		state.limits = { ...state.limits, maxContinuations: 1 };
		state.continuationsUsed = 1;

		// In-session evaluation reports the limit...
		await nextAutonomousContinuation(state, assistantMessage(), { cwd: createCwd(), onEvent: funnel });
		// ...then the host loop observes the same stop on exit.
		const reason = autonomousLimitReason(state);
		if (reason) funnel({ type: "autonomous_limit_reached", reason, ...autonomousLimitUsage(state, reason) });

		expect(emitted).toEqual([{ type: "autonomous_limit_reached", reason: "maxContinuations", used: 1, limit: 1 }]);
	});

	it("does not let a throwing listener break the control loop", async () => {
		const cwd = createCwd();
		const state = createState(["exit 0"]);

		await expect(
			refreshAutonomousQualityGates(state, {
				cwd,
				onEvent: () => {
					throw new Error("listener exploded");
				},
			}),
		).resolves.toBe("passed");
	});
});
