import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorHarness {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
}

describe("daemon supervisor side-question routing", () => {
	it("accepts start and abort commands before forwarding them to a worker", async () => {
		const handleCommand = vi.fn(
			async (_client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse> => ({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
			}),
		);
		const write = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			ownership: { assertCurrent: vi.fn(async () => undefined) },
			workers: new Map(),
			clients: new Set(),
			protocolClientIds: new WeakMap(),
			handleCommand,
			write,
			log: vi.fn(),
		}) as SupervisorHarness;
		const client = { id: "client-1" } as DaemonSocketClient;
		const commands = [
			{
				id: "start-1",
				type: "start_side_question",
				activeSessionId: "active-1",
				sideQuestionId: "question-1",
				question: "What changed?",
			},
			{
				id: "abort-1",
				type: "abort_side_question",
				activeSessionId: "active-1",
				sideQuestionId: "question-1",
			},
		] satisfies DaemonCommand[];

		for (const command of commands) {
			await supervisor.handleLine(client, JSON.stringify(command));
		}

		expect(handleCommand.mock.calls.map((call) => call[1])).toEqual(commands);
		expect(write.mock.calls.map((call) => call[1])).toEqual([
			expect.objectContaining({ command: "start_side_question", success: true }),
			expect.objectContaining({ command: "abort_side_question", success: true }),
		]);
	});
});
