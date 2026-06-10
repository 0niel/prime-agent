import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import {
	createAgentsViewReplyHeadline,
	createAgentsViewResumeConfig,
	createAgentsViewSessionName,
	formatAgentsViewRelativeTime,
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

		expect(rows.map((row) => row.title)).toEqual(["Parent", "Other"]);
		expect(rows.map((row) => row.runningSubagentCount)).toEqual([2, 0]);
		expect(rows.map((row) => row.depth)).toEqual([0, 0]);
		expect(rows.map((row) => row.selectable)).toEqual([true, true]);
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

		expect(rows.map((row) => row.title)).toEqual(["Parent"]);
		expect(rows.map((row) => row.runningSubagentCount)).toEqual([1]);
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
		const inactiveHidden = makeSummary({ status: "hidden" });
		const inactiveSleep = makeSummary({ status: "sleep" });
		delete inactiveHidden.activeSessionId;
		delete inactiveSleep.activeSessionId;

		expect(shouldShowAgentsViewSession(inactiveHidden)).toBe(false);
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
