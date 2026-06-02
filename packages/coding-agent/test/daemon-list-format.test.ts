import type { Api, Model } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { formatSessionListTable } from "../src/cli/daemon-list-format.js";
import type { SessionStatus, SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

describe("formatSessionListTable", () => {
	it("sorts sessions by status and renders compact suffix ids", () => {
		const nowMs = Date.parse("2026-05-29T12:00:00.000Z");
		const table = stripAnsi(
			formatSessionListTable(
				[
					makeSummary({ name: "sleep", id: "019e71ec-e08a-75a9-b573-fc10e9f8380f", status: "sleep" }),
					makeSummary({ name: "tool", id: "ccccddddeeee", status: "tool" }),
					makeSummary({ name: "crash", id: "019e71ec-e08a-75a9-b573-abcdef123456", status: "crash" }),
					makeSummary({ name: "idle", id: "bbbbccccdddd", status: "idle" }),
					makeSummary({ name: "model", id: "ddddeeeeffff", status: "model" }),
					makeSummary({
						name: "user",
						id: "aaaabbbbcccc",
						status: "user",
						model: { provider: "openai-codex", id: "gpt-5.5" } as Model<Api>,
					}),
				],
				nowMs,
			),
		);

		const lines = table.split("\n");
		expect(lines[0]!.trim().split(/\s+/)).toEqual(["name", "id", "status", "age", "model", "messages", "clients"]);
		expect(lines.slice(1).map((line) => line.trim().split(/\s+/).slice(0, 3))).toEqual([
			["user", "aaaabbbbcccc", "user"],
			["idle", "bbbbccccdddd", "idle"],
			["tool", "ccccddddeeee", "tool"],
			["model", "ddddeeeeffff", "model"],
			["sleep", "fc10e9f8380f", "sleep"],
			["crash", "abcdef123456", "crash"],
		]);
		expect(table).toContain("openai-codex/gpt-5.5");
		expect(table).not.toContain("/tmp/project");
		expect(table).not.toContain("019e71ec-e08a");
	});
});

function makeSummary(options: { name: string; id: string; status: SessionStatus; model?: Model<Api> }): SessionSummary {
	return {
		id: options.id,
		status: options.status,
		sessionId: options.id,
		sessionName: options.name,
		cwd: "/tmp/project",
		model: options.model,
		isStreaming: options.status === "tool" || options.status === "model",
		isCompacting: false,
		attachedClients: options.status === "user" ? 1 : 0,
		messageCount: 2,
		pendingMessageCount: 0,
		modified: "2026-05-29T10:00:00.000Z",
	};
}
