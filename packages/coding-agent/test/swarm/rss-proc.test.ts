import { describe, expect, it } from "vitest";
import { parseProcessStat, processRecordFromStatus } from "./rss-proc.js";

function stat(state: string): string {
	const fields = Array.from({ length: 20 }, () => "0");
	fields[0] = state;
	fields[1] = "17";
	fields[2] = "23";
	fields[19] = "456";
	return `123 (worker name) ${fields.join(" ")}`;
}

describe("Linux proc RSS records", () => {
	it("parses the stat state field and keeps a zombie without VmRSS at zero RSS", () => {
		const zombie = parseProcessStat(123, stat("Z"));
		expect(zombie).toEqual({ pid: 123, ppid: 17, pgid: 23, start: 456, state: "Z" });
		const record = processRecordFromStatus(zombie!, "Name:\tworker\nState:\tZ (zombie)\n");
		expect(record).toEqual({ pid: 123, ppid: 17, pgid: 23, start: 456, rssKiB: 0 });
		expect(record).not.toHaveProperty("state");
	});

	it("fails closed when a non-zombie lacks VmRSS", () => {
		const running = parseProcessStat(123, stat("S"));
		expect(processRecordFromStatus(running!, "Name:\tworker\nState:\tS (sleeping)\n")).toBeUndefined();
	});
});
