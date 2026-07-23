import { describe, expect, it, vi } from "vitest";
import type {
	AgentConnection,
	AgentConnectionSavedSessionInfo,
	AgentConnectionState,
} from "../src/modes/agent-connection/index.js";
import { createLocalSessionViewAdapter } from "../src/modes/interactive/interactive-mode.js";

const saved = {
	path: "/tmp/saved.jsonl",
	id: "saved",
	cwd: "/tmp",
	created: new Date(),
	modified: new Date(),
	messageCount: 1,
	firstMessage: "hello",
	allMessagesText: "hello",
} satisfies AgentConnectionSavedSessionInfo;

describe("local session view adapter", () => {
	it("uses the connection catalog and process-local session operations", async () => {
		const listSavedSessions = vi.fn(async (_scope, callbacks) => {
			callbacks?.onSession?.(saved);
			return [saved];
		});
		const state = {
			sessionId: "current",
			sessionFile: "/tmp/current.jsonl",
			cwd: "/tmp",
			sessionName: "Current",
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			pendingMessageCount: 0,
			messageCount: 2,
			recap: "working locally",
		} as AgentConnectionState;
		const connection = {
			listSavedSessions,
			getState: vi.fn(async () => state),
			renameSavedSession: vi.fn(async () => {}),
			setSessionName: vi.fn(async () => {}),
			deleteSavedSession: vi.fn(async () => ({ ok: true as const, method: "unlink" as const })),
		} as unknown as AgentConnection;
		const open = vi.fn(async () => ({ cancelled: false }));
		const adapter = createLocalSessionViewAdapter(connection, open);
		const streamed: AgentConnectionSavedSessionInfo[] = [];
		expect(await adapter.loadSavedSessions({ onSession: (session) => streamed.push(session) })).toEqual([saved]);
		expect(streamed).toEqual([saved]);
		expect(listSavedSessions).toHaveBeenCalledWith("all", expect.any(Object));
		const current = await adapter.getCurrentSession();
		expect(current).toMatchObject({
			sessionId: "current",
			sessionFile: "/tmp/current.jsonl",
			activeSessionId: "local:current",
		});
		await adapter.open({ ...current!, sessionFile: saved.path });
		expect(open).toHaveBeenCalledWith(saved.path);
		await adapter.rename(
			{ ...current!, sessionId: "saved", activeSessionId: undefined, sessionFile: saved.path },
			"Renamed",
		);
		expect(connection.renameSavedSession).toHaveBeenCalledWith(saved.path, "Renamed");
		await adapter.delete({ ...current!, activeSessionId: undefined, sessionFile: saved.path });
		expect(connection.deleteSavedSession).toHaveBeenCalledWith(saved.path);
	});
});
