import { describe, expect, it } from "vitest";
import {
	createDaemonCommandEnvelope,
	createDaemonEventEnvelope,
	createDaemonEventMeta,
	createDaemonReplayInfo,
	DAEMON_PROTOCOL_INFO,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";

describe("daemon protocol helpers", () => {
	it("creates versioned command and event envelopes", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;
		const commandEnvelope = createDaemonCommandEnvelope(command, "cmd-1", "client-1");
		const eventMeta = createDaemonEventMeta("active-1", 3, "2026-01-01T00:00:00.000Z");
		const event: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "agent_end", messages: [] },
			meta: eventMeta,
		};

		expect(commandEnvelope).toEqual({
			type: "command",
			id: "cmd-1",
			protocol: DAEMON_PROTOCOL_INFO,
			clientId: "client-1",
			command,
		});
		expect(createDaemonEventEnvelope(event, eventMeta)).toEqual({
			type: "event",
			id: "active-1:3",
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: "active-1",
			sequence: 3,
			emittedAt: "2026-01-01T00:00:00.000Z",
			event,
		});
	});

	it("reports replay availability from resume cursors", () => {
		expect(createDaemonReplayInfo(undefined, 5)).toEqual({
			status: "complete",
			toSequence: 5,
		});
		expect(createDaemonReplayInfo({ activeSessionId: "active-1", eventSequence: 5 }, 5)).toEqual({
			status: "complete",
			fromSequence: 5,
			toSequence: 5,
		});
		expect(createDaemonReplayInfo({ activeSessionId: "active-1", eventSequence: 10 }, 5)).toEqual({
			status: "unavailable",
			fromSequence: 10,
			toSequence: 5,
			reason: "resume_cursor_ahead_of_session",
		});
		expect(createDaemonReplayInfo({ activeSessionId: "active-1", eventSequence: 2 }, 5)).toEqual({
			status: "unavailable",
			fromSequence: 2,
			toSequence: 5,
			reason: "event_replay_not_available",
		});
	});
});
