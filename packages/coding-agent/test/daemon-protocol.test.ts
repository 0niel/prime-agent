import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDaemonCommandEnvelope,
	createDaemonEventEnvelope,
	createDaemonEventMeta,
	createDaemonReplayInfo,
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonOutbound,
	isDaemonCommandEnvelope,
	isDaemonMutatingCommand,
} from "../src/modes/daemon/daemon-protocol.js";

describe("daemon protocol helpers", () => {
	it("keeps the advertised schema identity synchronized with wire type shapes", () => {
		const source = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-protocol.ts"), "utf8");
		const commandSource = source.slice(
			source.indexOf("export type DaemonCommand ="),
			source.indexOf("type DaemonCommandName"),
		);
		const outboundSource = source.slice(
			source.indexOf("export type DaemonOutbound ="),
			source.indexOf("export const DAEMON_OUTBOUND_COMPATIBILITY"),
		);
		const digest = createHash("sha256").update(`${commandSource}\n${outboundSource}`).digest("hex").slice(0, 12);
		expect(DAEMON_SCHEMA_ID).toBe(`protocol-${DAEMON_PROTOCOL_VERSION}-schema-${DAEMON_SCHEMA_REVISION}-${digest}`);
	});

	it("requires compatibility metadata for the heartbeat protocol surface", () => {
		expect(DAEMON_PROTOCOL_VERSION).toBe(4);
		expect(DAEMON_SCHEMA_ID).toContain(`protocol-${DAEMON_PROTOCOL_VERSION}`);
		expect(DAEMON_COMMAND_COMPATIBILITY.heartbeats_list).toEqual({
			minProtocol: 3,
			capability: "heartbeat_catalog",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.heartbeat_manage).toEqual({
			minProtocol: 3,
			capability: "heartbeat_management",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.complete_owned_session).toEqual({
			minProtocol: DAEMON_PROTOCOL_VERSION,
			capability: "client_owned_sessions",
		});
		expect(DAEMON_OUTBOUND_COMPATIBILITY.heartbeats_changed).toEqual({
			minProtocol: 3,
			capability: "heartbeat_catalog",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toEqual(
			expect.arrayContaining(["heartbeat_catalog", "heartbeat_management"]),
		);
	});

	it("capability-gates the optional model catalog surface", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_model_catalog).toEqual({
			minProtocol: 4,
			capability: "model_catalog",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("model_catalog");
	});

	it("keeps refine failure events backward-compatible on the existing session event channel", () => {
		const event: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "refine_failed", error: "disk full" },
		};

		expect(DAEMON_SCHEMA_REVISION).toBe(3);
		expect(DAEMON_OUTBOUND_COMPATIBILITY.session_event).toEqual({ minProtocol: 1 });
		expect(event).toMatchObject({ event: { type: "refine_failed", error: "disk full" } });
	});

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
			cursor: { generation: "active-1", sequence: 3 },
			emittedAt: "2026-01-01T00:00:00.000Z",
			event,
		});
		expect(eventMeta.cursor).toEqual({ generation: "active-1", sequence: 3 });
	});

	it("accepts command envelopes from the compatible v2 protocol", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;

		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 2))).toBe(true);
		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 1))).toBe(false);
	});

	it("keeps attachment routing out of the durable mutation journal", () => {
		expect(isDaemonMutatingCommand({ type: "attach" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "reattach" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "wait_for_headless_completion" })).toBe(true);
		expect(isDaemonMutatingCommand({ type: "switch_session" })).toBe(true);
	});

	it("reports replay availability from resume cursors", () => {
		expect(createDaemonReplayInfo(undefined, 5, "generation-1")).toEqual({
			status: "complete",
			toSequence: 5,
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(
			createDaemonReplayInfo(
				{ activeSessionId: "active-1", generation: "generation-1", sequence: 5 },
				5,
				"generation-1",
			),
		).toEqual({
			status: "complete",
			fromSequence: 5,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 5 },
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 10 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 10,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 10 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "resume_cursor_ahead_of_session",
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 2 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 2,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 2 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "event_replay_not_available",
		});
		expect(createDaemonReplayInfo({ generation: "old", sequence: 5 }, 0, "new")).toMatchObject({
			status: "unavailable",
			reason: "event_generation_changed",
			fromCursor: { generation: "old", sequence: 5 },
			toCursor: { generation: "new", sequence: 0 },
		});
	});
});
