import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { buildSessionList } from "../src/modes/daemon/daemon-session-list.js";

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
		});
	});
});

interface StateOptions {
	activeSessionId: string;
	sessionFile?: string;
	sessionId?: string;
	isStreaming?: boolean;
	pendingToolCalls?: string[];
	clients?: number;
	metadata?: {
		kind: "top-level" | "subagent";
		createdAt: number;
		parentActiveSessionId?: string;
		parentSessionId?: string;
		parentSessionFile?: string;
		rlmChildId?: string;
		rlmParentNodeId?: string;
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
				},
				messages: [] as AgentMessage[],
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
