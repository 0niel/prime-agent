import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import {
	createAgentsViewListCommand,
	createAgentsViewReplyHeadline,
	createAgentsViewResumeConfig,
	createAgentsViewSessionName,
	formatAgentsViewRelativeTime,
	formatAgentsViewStatusLine,
	resolveAgentsViewSessionUiServices,
} from "../src/modes/agents-view/agents-view-mode.js";
import {
	buildAgentsViewRows,
	classifyAgentsViewSession,
	type SessionSummary,
	shouldShowAgentsViewSession,
} from "../src/modes/index.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

describe("agents view state", () => {
	test("classifies active daemon sessions into coarse fleet sections", () => {
		expect(classifyAgentsViewSession(makeSummary({ isStreaming: true, status: "model" }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ pendingMessageCount: 1 }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ status: "tool" }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ status: "user", messageCount: 2 }))).toBe("completed");
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", messageCount: 0 }))).toBe("completed");
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", messageCount: 4 }))).toBe("completed");
	});

	test("idle sessions split by the summarizer's completion verdict", () => {
		// Working is heuristic and ignores taskState.
		expect(classifyAgentsViewSession(makeSummary({ isStreaming: true, taskState: "completed" }))).toBe("working");
		// Idle sessions follow the verdict; absent one they stay completed.
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", taskState: "needs_input" }))).toBe("needs-input");
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", taskState: "completed" }))).toBe("completed");
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", taskState: undefined }))).toBe("completed");
	});

	test("defaults an idle session with no verdict to completed", () => {
		// A slow, failed, or absent classification never lingers in Working; only
		// an explicit needs_input verdict moves an idle session out of completed.
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", taskState: undefined }))).toBe("completed");
	});

	test("sorts rows by section and most recent modified time", () => {
		const rows = buildAgentsViewRows([
			makeSummary({ sessionName: "completed", status: "idle", messageCount: 2, modified: "2026-01-01T00:00:00Z" }),
			makeSummary({ sessionName: "older working", isStreaming: true, modified: "2026-01-01T00:00:00Z" }),
			makeSummary({ sessionName: "newer working", isStreaming: true, modified: "2026-01-02T00:00:00Z" }),
		]);

		expect(rows.map((row) => row.title)).toEqual(["newer working", "older working", "completed"]);
		expect(rows.map((row) => row.section)).toEqual(["working", "working", "completed"]);
	});

	test("summarizes subagents on their parent and omits subagent rows", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				isStreaming: true,
				status: "model",
			}),
			makeSummary({
				id: "second-child-active",
				activeSessionId: "second-child-active",
				sessionId: "second-child-session",
				sessionName: "Second child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				status: "tool",
			}),
			makeSummary({
				id: "completed-child-active",
				activeSessionId: "completed-child-active",
				sessionId: "completed-child-session",
				sessionName: "Completed child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				status: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				status: "tool",
			}),
			makeSummary({
				id: "other-active",
				activeSessionId: "other-active",
				sessionId: "other-session",
				sessionName: "Other",
				status: "idle",
				messageCount: 2,
			}),
		]);

		expect(rows.map((row) => [row.title, row.kind])).toEqual([
			["Parent", "agent"],
			["2 subagents running", "subagent-summary"],
			["Other", "agent"],
		]);
		expect(rows.map((row) => row.runningSubagentCount)).toEqual([2, 2, 0]);
		expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
		expect(rows.map((row) => row.selectable)).toEqual([true, true, true]);
		expect(rows[1]?.parentIdentity).toBe(rows[0]?.identity);
		expect(rows[1]?.identity).not.toBe(rows[0]?.identity);
	});

	test("expands subagent rows for expanded parents and collapses otherwise", () => {
		const summaries = [
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionFile: "/tmp/child.jsonl",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				isStreaming: true,
				status: "model",
			}),
			makeSummary({
				id: "completed-child-active",
				activeSessionId: "completed-child-active",
				sessionId: "completed-child-session",
				sessionFile: "/tmp/completed-child.jsonl",
				sessionName: "Completed child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				status: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionFile: "/tmp/parent.jsonl",
				sessionName: "Parent",
				isStreaming: true,
				status: "tool",
			}),
		];

		const collapsed = buildAgentsViewRows(summaries);
		expect(collapsed.map((row) => row.kind)).toEqual(["agent", "subagent-summary"]);
		expect(collapsed[1]?.title).toBe("1 subagent running");

		const parentIdentity = collapsed[0]?.identity;
		const expanded = buildAgentsViewRows(summaries, new Set([parentIdentity ?? ""]));
		expect(expanded.map((row) => [row.title, row.kind, row.depth])).toEqual([
			["Parent", "agent", 0],
			["Child", "subagent", 1],
			["Completed child", "subagent", 1],
		]);
		expect(expanded.slice(1).every((row) => row.selectable && row.parentIdentity === parentIdentity)).toBe(true);
	});

	test("keeps finished subagents reachable via the summary row", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "done-child",
				activeSessionId: "done-child",
				sessionId: "done-child-session",
				sessionFile: "/tmp/done-child.jsonl",
				sessionName: "Done child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				status: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionFile: "/tmp/parent.jsonl",
				sessionName: "Parent",
				status: "idle",
				messageCount: 4,
			}),
		]);

		expect(rows.map((row) => [row.title, row.kind])).toEqual([
			["Parent", "agent"],
			["1 subagent", "subagent-summary"],
		]);
		expect(rows[1]?.selectable).toBe(true);
	});

	test("treats parent-linked summaries without runtimeKind as subagents", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "legacy-child",
				activeSessionId: "legacy-child",
				sessionId: "legacy-child-session",
				sessionName: "Legacy child",
				parentActiveSessionId: "parent-active",
				isStreaming: true,
				status: "model",
			}),
			makeSummary({
				id: "legacy-rlm-child",
				activeSessionId: "legacy-rlm-child",
				sessionId: "legacy-rlm-session",
				sessionName: "Legacy rlm child",
				rlmChildId: "node-1",
				status: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				status: "tool",
			}),
		]);

		expect(rows.map((row) => [row.title, row.kind])).toEqual([
			["Parent", "agent"],
			["1 subagent running", "subagent-summary"],
		]);
		expect(rows[0]?.runningSubagentCount).toBe(1);
	});

	test("groups expanded subagents by spawn code and reveals the program", () => {
		const codeA = "task = sleep(60)\nfor i in range(2):\n    run_subagent(i, task)";
		const codeB = ["a = 1", "b = 2", "c = 3", "d = 4", "e = 5", "f = 6"].join("\n");
		const summaries = [
			makeSummary({
				id: "a1",
				activeSessionId: "a1",
				sessionId: "a1-session",
				sessionName: "A1",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: codeA,
				modified: "2026-01-01T00:00:04Z",
			}),
			makeSummary({
				id: "a2",
				activeSessionId: "a2",
				sessionId: "a2-session",
				sessionName: "A2",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: codeA,
				modified: "2026-01-01T00:00:03Z",
			}),
			makeSummary({
				id: "b1",
				activeSessionId: "b1",
				sessionId: "b1-session",
				sessionName: "B1",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: codeB,
				modified: "2026-01-01T00:00:02Z",
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				status: "tool",
			}),
		];

		const collapsed = buildAgentsViewRows(summaries);
		expect(collapsed[1]?.kind).toBe("subagent-summary");
		expect(collapsed[1]?.hasSpawnCode).toBe(true);

		const parentIdentity = collapsed[0]?.identity ?? "";
		const expandedNoProgram = buildAgentsViewRows(summaries, new Set([parentIdentity]));
		// Without the program toggle, only the grouped subagent rows render.
		expect(expandedNoProgram.map((row) => row.kind)).toEqual(["agent", "subagent", "subagent", "subagent"]);

		const expanded = buildAgentsViewRows(summaries, new Set([parentIdentity]), new Set([parentIdentity]));
		// Each spawn cell renders in full, once, directly above the subagents it
		// launched — padded with a blank panel line above and below, no truncation.
		expect(expanded.map((row) => [row.kind, row.code ?? row.title])).toEqual([
			["agent", "Parent"],
			["subagent-code", ""],
			["subagent-code", "task = sleep(60)"],
			["subagent-code", "for i in range(2):"],
			["subagent-code", "    run_subagent(i, task)"],
			["subagent-code", ""],
			["subagent", "A1"],
			["subagent", "A2"],
			["subagent-code", ""],
			["subagent-code", "a = 1"],
			["subagent-code", "b = 2"],
			["subagent-code", "c = 3"],
			["subagent-code", "d = 4"],
			["subagent-code", "e = 5"],
			["subagent-code", "f = 6"],
			["subagent-code", ""],
			["subagent", "B1"],
		]);
		expect(expanded.every((row) => row.kind !== "subagent-code" || !row.selectable)).toBe(true);
	});

	test("caps spawn code at 10 lines with a remainder note", () => {
		const longCode = Array.from({ length: 25 }, (_, i) => `line_${i}`).join("\n");
		const summaries = [
			makeSummary({
				id: "c1",
				activeSessionId: "c1",
				sessionId: "c1-session",
				sessionName: "C1",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: longCode,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				status: "tool",
			}),
		];
		const parentIdentity = buildAgentsViewRows(summaries)[0]?.identity ?? "";
		const rows = buildAgentsViewRows(summaries, new Set([parentIdentity]), new Set([parentIdentity]));
		const codeLines = rows.filter((row) => row.kind === "subagent-code").map((row) => row.code);
		// 10 capped body lines + the "more" note + two blank pad lines.
		const bodyLines = codeLines.filter((line) => line !== "");
		expect(bodyLines).toHaveLength(11);
		expect(bodyLines.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `line_${i}`));
		expect(bodyLines[10]).toBe("… +15 more lines");
	});

	test("omits subagents when their parent is not visible", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "removed-parent-active",
				parentSessionId: "removed-parent-session",
				isStreaming: true,
				status: "model",
			}),
			makeSummary({
				id: "other-active",
				activeSessionId: "other-active",
				sessionId: "other-session",
				sessionName: "Other",
				status: "idle",
				messageCount: 2,
			}),
		]);

		expect(rows.map((row) => row.title)).toEqual(["Other"]);
	});

	test("shows daemon-resident sessions only", () => {
		const inactiveSleep = makeSummary({ status: "sleep" });
		delete inactiveSleep.activeSessionId;

		expect(shouldShowAgentsViewSession(inactiveSleep)).toBe(false);
		expect(shouldShowAgentsViewSession(makeSummary({ status: "idle" }))).toBe(true);
		expect(shouldShowAgentsViewSession(makeSummary({ status: "idle" }), true)).toBe(false);
	});

	test("does not override saved session cwd when reopening inactive agents", () => {
		const config: AgentSessionRuntimeConfig = {
			cwd: "/tmp/dashboard",
			agentDir: "/tmp/agents",
			sessionDir: "/tmp/sessions",
			model: "openai/gpt-5",
		};

		const resumeConfig = createAgentsViewResumeConfig(config);

		expect("cwd" in resumeConfig).toBe(false);
		expect(resumeConfig.agentDir).toBe("/tmp/agents");
		expect(resumeConfig.sessionDir).toBe("/tmp/sessions");
		expect(resumeConfig.model).toBe("openai/gpt-5");
		expect(config.cwd).toBe("/tmp/dashboard");
	});

	test("requests only daemon-resident sessions for the agents view refresh", () => {
		expect(createAgentsViewListCommand({ cwd: "/tmp/project" })).toEqual({ type: "list" });
		expect(createAgentsViewListCommand({ cwd: "/tmp/project", sessionDir: "/tmp/sessions" })).toEqual({
			type: "list",
			sessionDir: "/tmp/sessions",
		});
	});

	test("derives the reply headline from the first line of the latest assistant text", () => {
		expect(createAgentsViewReplyHeadline("  Done.\nNext step?  ")).toBe("Done.");
		expect(createAgentsViewReplyHeadline("\n\n  spread   over \nlines")).toBe("spread over");
		expect(createAgentsViewReplyHeadline("   \n  ")).toBeUndefined();
		expect(createAgentsViewReplyHeadline(undefined)).toBeUndefined();
	});

	test("formats relative timestamps for the reply header", () => {
		const now = Date.parse("2026-01-02T12:00:00Z");
		expect(formatAgentsViewRelativeTime("2026-01-02T11:59:30Z", now)).toBe("30s");
		expect(formatAgentsViewRelativeTime("2026-01-02T11:15:00Z", now)).toBe("45m");
		expect(formatAgentsViewRelativeTime("2026-01-02T06:00:00Z", now)).toBe("6h");
		expect(formatAgentsViewRelativeTime("2025-12-30T12:00:00Z", now)).toBe("3d");
		expect(formatAgentsViewRelativeTime(undefined, now)).toBe("");
		expect(formatAgentsViewRelativeTime("not a timestamp", now)).toBe("");
	});

	test("flattens multiline status messages so they fit the single-row hint slot", () => {
		expect(formatAgentsViewStatusLine("Failed to send reply: connection lost\nat Socket.emit\nat process")).toBe(
			"Failed to send reply: connection lost at Socket.emit at process",
		);
		expect(formatAgentsViewStatusLine('Failed:\r\n\t{\r\n\t"error": "boom"\r\n}')).toBe(
			'Failed: { "error": "boom" }',
		);
		expect(formatAgentsViewStatusLine("  already   flat  ")).toBe("already flat");
		expect(formatAgentsViewStatusLine("\n \r\n ")).toBe("");
	});

	test("caps generated session names at the configured limit", () => {
		expect(createAgentsViewSessionName("x".repeat(120))).toHaveLength(80);
		expect(createAgentsViewSessionName("short")).toBe("short");
	});

	test("uses session-specific UI services when opening an agent", async () => {
		const dashboardServices = makeUiServices("/tmp/dashboard");
		const sessionServices = makeUiServices("/tmp/project");
		const summary = makeSummary({ cwd: "/tmp/project", sessionFile: "/tmp/project/session.jsonl" });
		const createUiServicesForSession = vi.fn(async () => sessionServices);

		await expect(
			resolveAgentsViewSessionUiServices(
				{
					uiServices: dashboardServices,
					createUiServicesForSession,
				},
				summary,
			),
		).resolves.toBe(sessionServices);
		expect(createUiServicesForSession).toHaveBeenCalledWith(summary);
	});
});

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		status: "idle",
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		pendingMessageCount: 0,
		...overrides,
	};
}

function makeUiServices(cwd: string): InteractiveModeUiServices {
	return {
		settingsManager: {} as SettingsManager,
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => cwd,
		getInitialSessionName: () => undefined,
		getThemes: (): Theme[] => [],
	};
}
