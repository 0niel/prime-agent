import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningDaemonProbe } from "../src/cli/daemon-launch.js";
import {
	confirmDaemonSessionLoss,
	type DaemonSessionLossCopy,
	pluralizeSessions,
} from "../src/cli/daemon-stop-confirm.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const COPY: DaemonSessionLossCopy = {
	atRiskDetail: (count) => `at-risk:${count}`,
	unlistableDetail: "unlistable",
	question: "Continue?",
	nonTtyHint: "hint",
};

function session(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "session",
		lifecycle: "live",
		activity: "idle",
		runtimeKind: "top-level",
		activeSessionId: "active",
		sessionId: "session",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		pendingMessageCount: 0,
		...overrides,
	};
}

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function setTTY(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("confirmDaemonSessionLoss", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (ttyDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
		}
	});

	it("proceeds without prompting when the daemon is unreachable", async () => {
		setTTY(true);
		const probe: RunningDaemonProbe = { reachable: false };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(true);
	});

	it("proceeds without prompting when force is set", async () => {
		setTTY(true);
		const probe: RunningDaemonProbe = { reachable: true, activeSessions: [session({ isStreaming: true })] };
		expect(await confirmDaemonSessionLoss(probe, { force: true, copy: COPY })).toBe(true);
	});

	it("proceeds without prompting when there are no live active sessions", async () => {
		setTTY(true);
		const probe: RunningDaemonProbe = { reachable: true, activeSessions: [] };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(true);
	});

	it("proceeds without prompting when a live active session can be restored", async () => {
		setTTY(false);
		const probe: RunningDaemonProbe = {
			reachable: true,
			activeSessions: [session({ activeSessionId: "live-idle", isStreaming: false, pendingMessageCount: 0 })],
		};
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(true);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("aborts without prompting when not at a TTY and a live active session cannot be restored", async () => {
		setTTY(false);
		const probe: RunningDaemonProbe = {
			reachable: true,
			activeSessions: [session({ activeSessionId: "live-idle", runtimeKind: "subagent" })],
		};
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("hint"));
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("at-risk:1"));
	});

	it("aborts without prompting when not at a TTY and a session has queued work", async () => {
		setTTY(false);
		const probe: RunningDaemonProbe = { reachable: true, activeSessions: [session({ pendingMessageCount: 2 })] };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("hint"));
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("at-risk:1"));
	});

	it("aborts without prompting when not at a TTY and sessions cannot be listed", async () => {
		setTTY(false);
		const probe: RunningDaemonProbe = { reachable: true };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("unlistable"));
	});

	it("treats compacting, pending-message, streaming, and bash-running sessions as at risk", async () => {
		setTTY(false);
		for (const overrides of [
			{ isCompacting: true },
			{ pendingMessageCount: 1 },
			{ isStreaming: true },
			{ isBashRunning: true },
		] satisfies Partial<SessionSummary>[]) {
			vi.mocked(console.error).mockClear();
			const probe: RunningDaemonProbe = { reachable: true, activeSessions: [session(overrides)] };
			expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		}
	});
});

describe("pluralizeSessions", () => {
	it("uses singular for one and plural otherwise", () => {
		expect(pluralizeSessions(1)).toEqual({ noun: "session", pronoun: "it" });
		expect(pluralizeSessions(2)).toEqual({ noun: "sessions", pronoun: "them" });
	});
});
