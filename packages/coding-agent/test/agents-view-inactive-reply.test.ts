import { describe, expect, it, vi } from "vitest";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function summary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "saved-1",
		lifecycle: "archived",
		activity: "idle",
		sessionId: "saved-1",
		cwd: process.cwd(),
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 3,
		pendingMessageCount: 0,
		...overrides,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	return Reflect.get(AgentsViewMode.prototype, method).call(self, ...args);
}

describe("agents view reply on inactive sessions", () => {
	const savedSummary = summary({
		sessionFile: "/tmp/sessions/saved-1.jsonl",
		cwd: process.cwd(),
		summary: "Persisted recap text",
		firstMessage: "opener",
	});

	it("arms the composer on a saved-only row using the persisted recap", async () => {
		const setReplyTarget = vi.fn();
		const requestRender = vi.fn();
		const self: Record<string, unknown> = {
			rows: [
				{ kind: "agent", selectable: true, identity: "file:/tmp/sessions/saved-1.jsonl", summary: savedSummary },
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			replyTarget: undefined,
			setReplyTarget,
			ui: { requestRender },
			requireClient: () => {
				throw new Error("saved rows must not hit the daemon for a preview");
			},
		};

		await invoke("toggleReplyTarget", self);

		expect(setReplyTarget).toHaveBeenCalledWith({ key: "saved-1", summary: savedSummary });
		expect(self.replyLastAssistantText).toBe("Persisted recap text");
	});

	it("ignores rows with neither a runtime nor a session file", async () => {
		const setReplyTarget = vi.fn();
		const self = {
			rows: [{ kind: "agent", selectable: true, identity: "session:saved-1", summary: summary({}) }],
			selectedIndex: 0,
			setReplyTarget,
		};

		await invoke("toggleReplyTarget", self);

		expect(setReplyTarget).not.toHaveBeenCalled();
	});

	it("resumes a saved session before delivering the reply", async () => {
		const request = vi.fn(async (command: { type: string }) => {
			if (command.type === "create") {
				return { success: true, data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" } };
			}
			return { success: true, data: {} };
		});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "saved-1", summary: savedSummary }, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith("active-9", "wake up", undefined);
		expect(self.selectSummary).toHaveBeenCalledWith(expect.objectContaining({ activeSessionId: "active-9" }));
		expect(self.setReplyTarget).toHaveBeenCalledWith(undefined);
	});

	it("replies to live sessions without resuming", async () => {
		const liveSummary = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn();
		const self: Record<string, unknown> = {
			options: { config: {} },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => liveSummary,
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-1", summary: liveSummary }, "hello");

		expect(request).not.toHaveBeenCalled();
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "hello", undefined);
		expect(self.selectSummary).not.toHaveBeenCalled();
	});
});
