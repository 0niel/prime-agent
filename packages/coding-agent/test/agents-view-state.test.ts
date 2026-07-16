import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import {
	createAgentsViewAutocompleteProvider,
	createAgentsViewListCommand,
	createAgentsViewReplyHeadline,
	createAgentsViewResumeConfig,
	createAgentsViewSessionName,
	formatAgentsViewRelativeTime,
	formatAgentsViewStatusLine,
	resolveAgentsViewActiveSummaryForPath,
	resolveAgentsViewAutocompleteCwd,
	resolveAgentsViewOpenCwd,
	resolveAgentsViewResumeSummary,
	resolveAgentsViewSessionUiServices,
	shouldReconnectAgentsViewDaemon,
} from "../src/modes/agents-view/agents-view-mode.js";
import {
	buildAgentsViewRows,
	classifyAgentsViewSession,
	getAgentsViewSelectionKey,
	resolveAgentsViewSelectionIndex,
	type SessionSummary,
	sectionTitle,
	shouldShowAgentsViewSession,
} from "../src/modes/index.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

describe("agents view state", () => {
	test("classifies active daemon sessions into coarse fleet sections", () => {
		expect(classifyAgentsViewSession(makeSummary({ isStreaming: true, activity: "working" }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ pendingMessageCount: 1, activity: "working" }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ activity: "working" }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", messageCount: 2 }))).toBe("needs-input");
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", messageCount: 0 }))).toBe("needs-input");
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", messageCount: 4 }))).toBe("needs-input");
	});

	test("idle sessions split by the summarizer's completion verdict", () => {
		// Working is heuristic and ignores taskState.
		expect(
			classifyAgentsViewSession(makeSummary({ isStreaming: true, activity: "working", taskState: "completed" })),
		).toBe("working");
		// Idle sessions follow the verdict; absent one they default to needs-input.
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: "needs_input" }))).toBe(
			"needs-input",
		);
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: "completed" }))).toBe("completed");
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: undefined }))).toBe("needs-input");
	});

	test("active heartbeats use their own section regardless of current activity", () => {
		expect(classifyAgentsViewSession(makeSummary({ activity: "working", hasActiveHeartbeat: true }))).toBe(
			"heartbeats",
		);
		expect(
			classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: "completed", hasActiveHeartbeat: true })),
		).toBe("heartbeats");

		const [row] = buildAgentsViewRows([makeSummary({ activity: "idle", hasActiveHeartbeat: true })]);
		expect(row).toMatchObject({ section: "heartbeats", statusLabel: "heartbeat active" });
		const [busyRow] = buildAgentsViewRows([
			makeSummary({ activity: "working", hasActiveHeartbeat: true, isStreaming: true, isRunningTools: true }),
		]);
		expect(busyRow).toMatchObject({ section: "heartbeats", statusLabel: "running tools" });
		expect(sectionTitle("heartbeats")).toBe("Heartbeats");
	});

	test("defaults an idle session with no verdict to needs-input", () => {
		// A slow, failed, or absent classification never lingers in Working; only
		// an explicit completed verdict moves an idle session out of needs-input.
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: undefined }))).toBe("needs-input");
	});

	test("sorts rows by section and creation time", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "completed",
				sessionId: "completed",
				sessionName: "completed",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
				created: "2026-01-03T00:00:00Z",
			}),
			makeSummary({
				id: "older-working",
				sessionId: "older-working",
				sessionName: "older working",
				activity: "working",
				isStreaming: true,
				created: "2026-01-01T00:00:00Z",
			}),
			makeSummary({
				id: "newer-working",
				sessionId: "newer-working",
				sessionName: "newer working",
				activity: "working",
				isStreaming: true,
				created: "2026-01-02T00:00:00Z",
			}),
			makeSummary({
				sessionName: "heartbeat",
				activity: "idle",
				hasActiveHeartbeat: true,
				modified: "2026-01-03T00:00:00Z",
			}),
		]);

		expect(rows.map((row) => row.title)).toEqual(["newer working", "older working", "heartbeat", "completed"]);
		expect(rows.map((row) => row.section)).toEqual(["working", "working", "heartbeats", "completed"]);
	});

	test("keeps row order stable when modification times and daemon input order change", () => {
		const older = makeSummary({
			id: "older",
			sessionId: "older",
			sessionName: "older",
			activity: "working",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-04T00:00:00Z",
		});
		const newer = makeSummary({
			id: "newer",
			sessionId: "newer",
			sessionName: "newer",
			activity: "working",
			created: "2026-01-02T00:00:00Z",
			modified: "2026-01-03T00:00:00Z",
		});

		const initialOrder = buildAgentsViewRows([older, newer]).map((row) => row.summary.sessionId);
		const refreshedOrder = buildAgentsViewRows([
			{ ...newer, modified: "2026-01-05T00:00:00Z" },
			{ ...older, modified: "2026-01-06T00:00:00Z" },
		]).map((row) => row.summary.sessionId);

		expect(initialOrder).toEqual(["newer", "older"]);
		expect(refreshedOrder).toEqual(initialOrder);
	});

	test("uses deterministic fallbacks when creation times are unavailable", () => {
		const rows = buildAgentsViewRows([
			makeSummary({ id: "beta-2", sessionId: "beta-2", sessionName: "beta", modified: "2026-01-03T00:00:00Z" }),
			makeSummary({ id: "alpha", sessionId: "alpha", sessionName: "alpha", modified: "2026-01-02T00:00:00Z" }),
			makeSummary({ id: "beta-1", sessionId: "beta-1", sessionName: "beta", modified: "2026-01-01T00:00:00Z" }),
		]);

		expect(rows.map((row) => row.summary.sessionId)).toEqual(["alpha", "beta-1", "beta-2"]);
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
				activity: "working",
			}),
			makeSummary({
				id: "second-child-active",
				activeSessionId: "second-child-active",
				sessionId: "second-child-session",
				sessionName: "Second child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				hasActiveHeartbeat: true,
				activity: "working",
			}),
			makeSummary({
				id: "completed-child-active",
				activeSessionId: "completed-child-active",
				sessionId: "completed-child-session",
				sessionName: "Completed child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				activity: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "other-active",
				activeSessionId: "other-active",
				sessionId: "other-session",
				sessionName: "Other",
				activity: "idle",
				taskState: "completed",
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
				activity: "working",
			}),
			makeSummary({
				id: "completed-child-active",
				activeSessionId: "completed-child-active",
				sessionId: "completed-child-session",
				sessionFile: "/tmp/completed-child.jsonl",
				sessionName: "Completed child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionFile: "/tmp/parent.jsonl",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
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

	test("reveals a nested subagent only after its parent is also expanded", () => {
		const summaries = [
			makeSummary({
				id: "grandchild-active",
				activeSessionId: "grandchild-active",
				sessionId: "grandchild-session",
				sessionName: "Grandchild",
				runtimeKind: "subagent",
				parentActiveSessionId: "child-active",
				parentSessionId: "child-session",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "root-active",
				parentSessionId: "root-session",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionName: "Root",
				isStreaming: true,
				activity: "working",
			}),
		];

		const rootIdentity = buildAgentsViewRows(summaries)[0]?.identity ?? "";
		// Expanding only the root reveals the child but not the grandchild.
		const oneLevel = buildAgentsViewRows(summaries, new Set([rootIdentity]));
		expect(oneLevel.map((row) => [row.title, row.kind])).toEqual([
			["Root", "agent"],
			["Child", "subagent"],
			["1 subagent running", "subagent-summary"],
		]);

		const childIdentity = oneLevel.find((row) => row.title === "Child")?.identity ?? "";
		const twoLevel = buildAgentsViewRows(summaries, new Set([rootIdentity, childIdentity]));
		expect(twoLevel.map((row) => [row.title, row.kind, row.depth])).toEqual([
			["Root", "agent", 0],
			["Child", "subagent", 1],
			["Grandchild", "subagent", 2],
		]);
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
				activity: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionFile: "/tmp/parent.jsonl",
				sessionName: "Parent",
				activity: "idle",
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
				activity: "working",
			}),
			makeSummary({
				id: "legacy-rlm-child",
				activeSessionId: "legacy-rlm-child",
				sessionId: "legacy-rlm-session",
				sessionName: "Legacy rlm child",
				rlmChildId: "node-1",
				activity: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
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
				activity: "working",
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
				activity: "working",
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
				activity: "working",
			}),
			makeSummary({
				id: "other-active",
				activeSessionId: "other-active",
				sessionId: "other-session",
				sessionName: "Other",
				activity: "idle",
				messageCount: 2,
			}),
		]);

		expect(rows.map((row) => row.title)).toEqual(["Other"]);
	});

	test("shows daemon-resident sessions only", () => {
		const inactiveSleep = makeSummary({ lifecycle: "archived", activity: "idle" });
		delete inactiveSleep.activeSessionId;

		expect(shouldShowAgentsViewSession(inactiveSleep)).toBe(false);
		expect(shouldShowAgentsViewSession(makeSummary({ lifecycle: "live", activity: "idle" }))).toBe(true);
		expect(shouldShowAgentsViewSession(makeSummary({ lifecycle: "live", activity: "idle" }), true)).toBe(false);
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

	test("opens an existing-cwd session in its own directory with no override or notice", () => {
		const dir = mkdtempSync(join(tmpdir(), "agents-view-cwd-"));
		try {
			expect(resolveAgentsViewOpenCwd(makeSummary({ cwd: dir }), "/tmp/launch")).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to the launch cwd and explains it when the stored cwd is gone", () => {
		const missing = join(tmpdir(), "agents-view-missing-worktree-does-not-exist");
		const { overrideCwd, notice } = resolveAgentsViewOpenCwd(makeSummary({ cwd: missing }), "/tmp/launch");
		expect(overrideCwd).toBe("/tmp/launch");
		expect(notice).toContain(missing);
		expect(notice).toContain("/tmp/launch");
	});

	test("does not override when there is no fallback cwd to use", () => {
		const missing = join(tmpdir(), "agents-view-missing-worktree-does-not-exist");
		expect(resolveAgentsViewOpenCwd(makeSummary({ cwd: missing }), undefined)).toEqual({});
	});

	test("passes the override cwd through the resume config when the stored cwd is missing", () => {
		const config: AgentSessionRuntimeConfig = { cwd: "/tmp/launch", agentDir: "/tmp/agents" };
		const resumeConfig = createAgentsViewResumeConfig(config, "/tmp/launch");
		expect(resumeConfig.cwd).toBe("/tmp/launch");
	});

	test("requests only daemon-resident sessions for the agents view refresh", () => {
		expect(createAgentsViewListCommand()).toEqual({ type: "list" });
	});

	test("uses the active-chat file autocomplete for new-agent prompts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agents-view-autocomplete-"));
		const fdPath = join(dir, "fd");
		writeFileSync(
			fdPath,
			`#!/bin/sh
printf 'src/referenced.ts\n'
`,
		);
		chmodSync(fdPath, 0o755);

		try {
			const provider = createAgentsViewAutocompleteProvider(dir, fdPath, () => []);
			const suggestions = await provider.getSuggestions(["review @refer"], 0, 13, {
				signal: new AbortController().signal,
			});

			expect(suggestions).toEqual({
				prefix: "@refer",
				items: [{ value: "@src/referenced.ts", label: "referenced.ts", description: "src/referenced.ts" }],
				kind: "file",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("uses the reply target cwd for file autocomplete", () => {
		const missing = mkdtempSync(join(tmpdir(), "agents-view-autocomplete-missing-"));
		rmSync(missing, { recursive: true, force: true });

		expect(resolveAgentsViewAutocompleteCwd("/launch", makeSummary({ cwd: tmpdir() }))).toBe(tmpdir());
		expect(resolveAgentsViewAutocompleteCwd("/launch")).toBe("/launch");
		expect(resolveAgentsViewAutocompleteCwd("/launch", makeSummary({ cwd: missing }))).toBe("/launch");
		expect(resolveAgentsViewAutocompleteCwd("/launch", makeSummary({ cwd: "" }))).toBe("/launch");
	});

	test("reads current models for each autocomplete request", async () => {
		let completions: AutocompleteItem[] | null = null;
		const provider = createAgentsViewAutocompleteProvider("/tmp", undefined, () => completions);

		expect(
			await provider.getSuggestions(["/model fresh"], 0, 12, { signal: new AbortController().signal }),
		).toBeNull();

		completions = [{ value: "test-provider/fresh-model", label: "fresh-model", description: "test-provider" }];
		expect(await provider.getSuggestions(["/model fresh"], 0, 12, { signal: new AbortController().signal })).toEqual({
			prefix: "fresh",
			items: [{ value: "test-provider/fresh-model", label: "fresh-model", description: "test-provider" }],
		});
	});

	test("creates an inactive summary for a saved session selected from resume", () => {
		const savedSession = makeSessionInfo({
			path: "/tmp/sessions/saved.jsonl",
			id: "saved",
			name: "Saved session",
			cwd: "/tmp/project",
			messageCount: 2,
			agentStatus: {
				summary: "Finished the task",
				taskState: "completed",
				basedOnMessageCount: 2,
			},
		});

		const summary = resolveAgentsViewResumeSummary(savedSession.path, [savedSession], []);

		expect(summary).toMatchObject({
			id: "saved",
			activity: "idle",
			sessionId: "saved",
			sessionFile: savedSession.path,
			sessionName: "Saved session",
			cwd: "/tmp/project",
			summary: "Finished the task",
			taskState: "completed",
		});
		expect(summary?.activeSessionId).toBeUndefined();
		expect(summary?.lifecycle).toBe("live");
	});

	test("reuses the live daemon summary when resuming an already-active saved session", () => {
		const savedSession = makeSessionInfo({
			path: "/tmp/sessions/active.jsonl",
			id: "saved-active",
			cwd: "/tmp/project",
		});
		const activeSummary = makeSummary({
			id: "active-runtime",
			activeSessionId: "active-runtime",
			sessionId: "saved-active",
			sessionFile: savedSession.path,
			sessionName: "Running",
		});

		expect(resolveAgentsViewResumeSummary(savedSession.path, [savedSession], [activeSummary])).toBe(activeSummary);
	});

	test("resolves active summaries by session file path", () => {
		const activeSummary = makeSummary({
			id: "active-runtime",
			activeSessionId: "active-runtime",
			sessionId: "saved-active",
			sessionFile: "/tmp/sessions/active.jsonl",
			sessionName: "Running",
		});
		const inactiveSummary = makeSummary({
			id: "inactive",
			activeSessionId: undefined,
			sessionId: "inactive",
			sessionFile: "/tmp/sessions/inactive.jsonl",
		});

		expect(
			resolveAgentsViewActiveSummaryForPath("/tmp/sessions/active.jsonl", [inactiveSummary, activeSummary]),
		).toBe(activeSummary);
		expect(resolveAgentsViewActiveSummaryForPath("/tmp/sessions/inactive.jsonl", [inactiveSummary])).toBeUndefined();
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

	test("reconnects daemon restarts and crashes but stops after an intentional shutdown", () => {
		expect(shouldReconnectAgentsViewDaemon("update")).toBe(true);
		expect(shouldReconnectAgentsViewDaemon(undefined)).toBe(true);
		expect(shouldReconnectAgentsViewDaemon("shutdown")).toBe(false);
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

	describe("restores selection to the previously open session", () => {
		const opened = makeSummary({
			id: "active-open",
			activeSessionId: "active-open",
			sessionId: "session-open",
			sessionFile: "/tmp/project/open.jsonl",
			sessionName: "open",
		});
		const other = makeSummary({
			id: "active-other",
			activeSessionId: "active-other",
			sessionId: "session-other",
			sessionFile: "/tmp/project/other.jsonl",
			sessionName: "other",
		});
		const identity = `file:${opened.sessionFile}`;
		const key = getAgentsViewSelectionKey(opened);

		test("re-finds the session after a section change reorders the list", () => {
			const rows = buildAgentsViewRows([{ ...opened, activity: "working" }, other]);
			expect(rows[1]?.summary.sessionId).toBe("session-open");
			expect(resolveAgentsViewSelectionIndex(rows, identity, key)).toBe(1);
		});

		test("falls back to activeSessionId when the row identity changed", () => {
			// Selected before the session had a file, so the stored identity is active:...
			const rows = buildAgentsViewRows([other, opened]);
			const staleIdentity = "active:active-open";
			expect(resolveAgentsViewSelectionIndex(rows, staleIdentity, key)).toBe(
				rows.findIndex((row) => row.summary.sessionId === "session-open"),
			);
		});

		test("falls back to sessionId after a daemon re-attach regenerates the active id", () => {
			// Re-attach gives a fresh activeSessionId, so only the sessionId still matches.
			const reattached = { ...opened, id: "active-open-2", activeSessionId: "active-open-2" };
			const rows = buildAgentsViewRows([other, reattached]);
			expect(resolveAgentsViewSelectionIndex(rows, identity, key)).toBe(
				rows.findIndex((row) => row.summary.sessionId === "session-open"),
			);
		});

		test("returns -1 when the session is gone so callers pick a default", () => {
			const rows = buildAgentsViewRows([other]);
			expect(resolveAgentsViewSelectionIndex(rows, identity, key)).toBe(-1);
		});

		test("returns -1 with no stored selection", () => {
			const rows = buildAgentsViewRows([opened, other]);
			expect(resolveAgentsViewSelectionIndex(rows, undefined, undefined)).toBe(-1);
		});
	});
});

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		lifecycle: "live",
		activity: "idle",
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

function makeSessionInfo(overrides: Partial<SessionInfo> & { path: string; id: string }): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: overrides.cwd ?? "/tmp/project",
		name: overrides.name,
		state: overrides.state,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date("2026-01-01T00:00:00Z"),
		modified: overrides.modified ?? new Date("2026-01-01T00:00:00Z"),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
		agentStatus: overrides.agentStatus,
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
