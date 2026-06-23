import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	buildRlmChildSnapshots,
	buildSessionList,
	resolveAttachModelFallbackMessage,
	type SessionSummary,
} from "../src/modes/daemon/daemon-session-list.js";

describe("buildSessionList", () => {
	it("derives active session statuses", () => {
		const entries = buildSessionList(
			[
				makeState({ activeSessionId: "model", sessionFile: "/tmp/model.jsonl", isStreaming: true }),
				makeState({
					activeSessionId: "tool",
					sessionFile: "/tmp/tool.jsonl",
					isStreaming: true,
					pendingToolCalls: ["tool-1"],
				}),
				makeState({ activeSessionId: "needs-user", sessionFile: "/tmp/needs-user.jsonl", clients: 1 }),
				makeState({ activeSessionId: "done", sessionFile: "/tmp/done.jsonl" }),
			],
			[],
		);

		expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
			["model", "model"],
			["tool", "tool"],
			["needs-user", "user"],
			["done", "idle"],
		]);
	});

	it("merges active records with saved sessions and marks inactive sessions", () => {
		const activePath = resolve("/tmp/project/active.jsonl");
		const sleepingPath = resolve("/tmp/project/sleeping.jsonl");
		const crashedPath = resolve("/tmp/project/crashed.jsonl");
		const savedSessions = [
			makeSessionInfo({ path: activePath, id: "saved-active", name: "active saved" }),
			makeSessionInfo({ path: sleepingPath, id: "saved-sleeping", name: "sleeping saved" }),
			makeSessionInfo({ path: crashedPath, id: "saved-crashed", state: { status: "crash" } }),
		];

		const entries = buildSessionList(
			[makeState({ activeSessionId: "active-1", sessionFile: activePath, sessionId: "saved-active" })],
			savedSessions,
		);

		expect(entries).toHaveLength(3);
		expect(entries.map((entry) => [entry.id, entry.sessionId, entry.status])).toEqual([
			["active-1", "saved-active", "idle"],
			["saved-sleeping", "saved-sleeping", "sleep"],
			["saved-crashed", "saved-crashed", "crash"],
		]);
		expect(entries[0]!.sessionName).toBe("session active-1");
	});

	it("includes active subagent parent metadata", () => {
		const entries = buildSessionList(
			[
				makeState({ activeSessionId: "parent", sessionFile: "/tmp/parent.jsonl", sessionId: "parent-session" }),
				makeState({
					activeSessionId: "child",
					sessionFile: "/tmp/child.jsonl",
					sessionId: "child-session",
					metadata: {
						kind: "subagent",
						createdAt: 1,
						parentActiveSessionId: "parent",
						parentSessionId: "parent-session",
						parentSessionFile: "/tmp/parent.jsonl",
						rlmChildId: "rlm-child",
						rlmParentNodeId: "rlm-child",
						prompt: "Audit the   retry\nlogic for races",
					},
				}),
			],
			[],
		);

		expect(entries.find((entry) => entry.id === "child")).toMatchObject({
			runtimeKind: "subagent",
			parentActiveSessionId: "parent",
			parentSessionId: "parent-session",
			parentSessionPath: "/tmp/parent.jsonl",
			rlmChildId: "rlm-child",
			rlmParentNodeId: "rlm-child",
			// The spawn prompt doubles as the subagent's display title.
			firstMessage: "Audit the retry logic for races",
		});
	});
});

describe("buildRlmChildSnapshots", () => {
	it("collects children and grandchildren with event-compatible parent ids", () => {
		const parent = makeState({ activeSessionId: "parent", sessionFile: "/tmp/parent.jsonl" });
		const child = makeState({
			activeSessionId: "child",
			isStreaming: true,
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-aaa",
				rlmParentNodeId: "sub-aaa",
				prompt: "Summarize   the repo\nlayout",
				sessionDir: "/tmp/artifacts/sub-aaa",
			},
			messages: [
				{ role: "user", content: "Summarize the repo layout" },
				{ role: "assistant", content: [{ type: "text", text: "The repo is an npm workspace." }] },
			] as AgentMessage[],
		});
		const grandchild = makeState({
			activeSessionId: "grandchild",
			metadata: {
				kind: "subagent",
				createdAt: 2,
				parentActiveSessionId: "child",
				rlmChildId: "sub-bbb",
				rlmParentNodeId: "sub-bbb",
				prompt: "Read the docs",
				sessionDir: "/tmp/artifacts/sub-aaa/sub-bbb",
			},
		});
		const unrelated = makeState({
			activeSessionId: "unrelated-child",
			metadata: {
				kind: "subagent",
				createdAt: 3,
				parentActiveSessionId: "someone-else",
				rlmChildId: "sub-ccc",
			},
		});

		const snapshots = buildRlmChildSnapshots("parent", [parent, child, grandchild, unrelated]);

		expect(snapshots.map((snapshot) => [snapshot.id, snapshot.parentId, snapshot.status])).toEqual([
			["sub-aaa", undefined, "running"],
			["sub-bbb", "sub-aaa", "done"],
		]);
		expect(snapshots[0]).toMatchObject({
			label: "Summarize the repo layout",
			answerPreview: "The repo is an npm workspace.",
			sessionDir: "/tmp/artifacts/sub-aaa",
			transcript: [
				{ role: "user", text: "Summarize the repo layout" },
				{ role: "assistant", text: "The repo is an npm workspace." },
			],
		});
	});

	it("prefers the parent's run status over the streaming heuristic", () => {
		// An idle child session is still part of an active run; only the parent's
		// run tracker knows that.
		const parent = makeState({
			activeSessionId: "parent",
			sessionFile: "/tmp/parent.jsonl",
			childRunStatuses: { "sub-aaa": "running" },
		});
		const idleChild = makeState({
			activeSessionId: "child",
			isStreaming: false,
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-aaa",
				rlmParentNodeId: "sub-aaa",
				prompt: "Slow task",
				sessionDir: "/tmp/artifacts/sub-aaa",
			},
		});

		const snapshots = buildRlmChildSnapshots("parent", [parent, idleChild]);

		expect(snapshots.map((snapshot) => [snapshot.id, snapshot.status])).toEqual([["sub-aaa", "running"]]);
	});

	it("returns no snapshots for sessions without children", () => {
		const solo = makeState({ activeSessionId: "solo" });
		expect(buildRlmChildSnapshots("solo", [solo])).toEqual([]);
	});
});

describe("resolveAttachModelFallbackMessage", () => {
	const startupMessage = "No models available. Use /login...";

	function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
		return {
			id: "active-1",
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

	it("prefers the daemon's own fallback message", () => {
		const summary = makeSummary({ modelFallbackMessage: "Could not restore model a/b. Using c/d" });

		expect(resolveAttachModelFallbackMessage(summary, startupMessage)).toBe("Could not restore model a/b. Using c/d");
	});

	it("ignores the attaching process's snapshot when the session has a model", () => {
		const summary = makeSummary({ model: { provider: "prime-inference", id: "gpt-5.5" } as SessionSummary["model"] });

		expect(resolveAttachModelFallbackMessage(summary, startupMessage)).toBeUndefined();
	});

	it("falls back to the attaching process's snapshot when the session has no model", () => {
		expect(resolveAttachModelFallbackMessage(makeSummary({}), startupMessage)).toBe(startupMessage);
	});
});

interface StateOptions {
	activeSessionId: string;
	sessionFile?: string;
	sessionId?: string;
	isStreaming?: boolean;
	pendingToolCalls?: string[];
	clients?: number;
	messages?: AgentMessage[];
	childRunStatuses?: Record<string, "queued" | "running" | "done" | "error" | "cancelled">;
	metadata?: {
		kind: "top-level" | "subagent";
		createdAt: number;
		parentActiveSessionId?: string;
		parentSessionId?: string;
		parentSessionFile?: string;
		rlmChildId?: string;
		rlmParentNodeId?: string;
		prompt?: string;
		sessionDir?: string;
	};
}

function makeState(options: StateOptions): ActiveSessionState {
	const clients = new Set<DaemonSocketClient>();
	for (let index = 0; index < (options.clients ?? 0); index++) {
		clients.add({ id: `client-${index}` } as unknown as DaemonSocketClient);
	}

	return {
		activeSessionId: options.activeSessionId,
		clients,
		lastEventSequence: 0,
		runtime: {
			metadata: options.metadata ?? { kind: "top-level", createdAt: 1 },
			diagnostics: [],
			session: {
				model: undefined,
				thinkingLevel: "off",
				isStreaming: options.isStreaming ?? false,
				isCompacting: false,
				sessionFile: options.sessionFile,
				sessionId: options.sessionId ?? `session-${options.activeSessionId}`,
				sessionName: `session ${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
					getSessionDir: () => "/tmp/sessions",
				},
				messages: options.messages ?? ([] as AgentMessage[]),
				getRlmChildRunStatus: (childId: string) => options.childRunStatuses?.[childId],
				pendingMessageCount: 0,
				state: {
					streamingMessage: undefined,
					pendingToolCalls: new Set(options.pendingToolCalls ?? []),
				},
			},
		},
	} as unknown as ActiveSessionState;
}

function makeSessionInfo(overrides: Pick<SessionInfo, "path" | "id"> & Partial<SessionInfo>): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: "/tmp/project",
		name: overrides.name,
		state: overrides.state,
		created: new Date("2026-05-01T00:00:00.000Z"),
		modified: new Date("2026-05-02T00:00:00.000Z"),
		messageCount: 2,
		firstMessage: "hello",
		allMessagesText: "hello world",
	};
}
