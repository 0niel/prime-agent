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

function processStat(state: string) {
	const parsed = parseProcessStat(123, stat(state));
	expect(parsed).toEqual({ pid: 123, ppid: 17, pgid: 23, start: 456, state });
	return parsed!;
}

describe("Linux proc RSS records", () => {
	it.each(["S", "R"])("keeps a %s process with no mm at zero RSS", (state) => {
		const record = processRecordFromStatus(processStat(state), `Name:\tworker\nState:\t${state} (running)\n`);
		expect(record).toEqual({ pid: 123, ppid: 17, pgid: 23, start: 456, rssKiB: 0 });
		expect(record).not.toHaveProperty("state");
	});

	it("keeps a zombie without an mm at zero RSS", () => {
		expect(processRecordFromStatus(processStat("Z"), "Name:\tworker\nState:\tZ (zombie)\n")).toMatchObject({
			rssKiB: 0,
		});
	});

	it.each([
		["missing", "Name:\tworker\n"],
		["mismatched", "Name:\tworker\nState:\tR (running)\n"],
		["malformed", "Name:\tworker\nState:\tS not-a-linux-state\n"],
	])("fails closed for %s status state", (_case, status) => {
		expect(processRecordFromStatus(processStat("S"), status)).toBeUndefined();
	});

	it("fails closed when an mm field exists but VmRSS is absent", () => {
		const status = "Name:\tworker\nState:\tS (sleeping)\nVmSize:\t1024 kB\n";
		expect(processRecordFromStatus(processStat("S"), status)).toBeUndefined();
	});

	it("parses VmRSS from a state-validated status file", () => {
		const status = "Name:\tworker\nState:\tS (sleeping)\nVmSize:\t1024 kB\nVmRSS:\t512 kB\n";
		expect(processRecordFromStatus(processStat("S"), status)).toMatchObject({ rssKiB: 512 });
	});
});
