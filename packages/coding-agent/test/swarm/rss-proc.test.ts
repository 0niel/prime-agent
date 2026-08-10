import { describe, expect, it } from "vitest";
import { hasStableProcessIdentity, parseProcessStat, processRecordFromStatus } from "./rss-proc.js";

function stat(state: string, ppid = 17, pgid = 23, start = 456): string {
	const fields = Array.from({ length: 20 }, () => "0");
	fields[0] = state;
	fields[1] = String(ppid);
	fields[2] = String(pgid);
	fields[19] = String(start);
	return `123 (worker name) ${fields.join(" ")}`;
}

function processStat(state: string, ppid = 17, pgid = 23, start = 456, pid = 123) {
	const parsed = parseProcessStat(pid, stat(state, ppid, pgid, start));
	expect(parsed).toEqual({ pid, ppid, pgid, start, state });
	return parsed!;
}

function recordFromStatus(initial: ReturnType<typeof processStat>, status: string, confirmation = initial) {
	return processRecordFromStatus(initial, status, confirmation);
}

describe("Linux proc RSS records", () => {
	it.each(["S", "R"])("keeps a %s process with no mm at zero RSS", (state) => {
		const initial = processStat(state);
		const record = recordFromStatus(initial, `Name:\tworker\nState:\t${state} (running)\n`);
		expect(record).toEqual({ pid: 123, ppid: 17, pgid: 23, start: 456, rssKiB: 0 });
		expect(record).not.toHaveProperty("state");
	});

	it("accepts a legitimate R-to-S state change after confirming stable external identity", () => {
		const initial = processStat("R", 17, 23, 456);
		const confirmation = processStat("S", 99, 23, 456);
		expect(recordFromStatus(initial, "Name:\tworker\nState:\tS (sleeping)\n", confirmation)).toEqual({
			pid: 123,
			ppid: 17,
			pgid: 23,
			start: 456,
			rssKiB: 0,
		});
	});

	it("keeps a zombie without an mm at zero RSS", () => {
		expect(recordFromStatus(processStat("Z"), "Name:\tworker\nState:\tZ (zombie)\n")).toMatchObject({
			rssKiB: 0,
		});
	});

	it.each([
		["missing", "Name:\tworker\n"],
		["malformed", "Name:\tworker\nState:\tS not-a-linux-state\n"],
		["invalid Linux state", "Name:\tworker\nState:\tQ (not a task state)\n"],
	])("fails closed for %s status state", (_case, status) => {
		expect(recordFromStatus(processStat("S"), status)).toBeUndefined();
	});

	it.each([
		["PID", processStat("S", 17, 23, 456, 124)],
		["start time", processStat("S", 17, 23, 457)],
		["process group", processStat("S", 17, 24, 456)],
	])("fails the scan when the confirmation has a mismatched %s", (_case, confirmation) => {
		const initial = processStat("S");
		expect(hasStableProcessIdentity(initial, confirmation)).toBe(false);
		expect(recordFromStatus(initial, "Name:\tworker\nState:\tS (sleeping)\n", confirmation)).toBeUndefined();
	});

	it("fails closed when an mm field exists but VmRSS is absent", () => {
		const status = "Name:\tworker\nState:\tS (sleeping)\nVmSize:\t1024 kB\n";
		expect(recordFromStatus(processStat("S"), status)).toBeUndefined();
	});

	it("parses VmRSS from a status file with stable external identity", () => {
		const status = "Name:\tworker\nState:\tS (sleeping)\nVmSize:\t1024 kB\nVmRSS:\t512 kB\n";
		expect(recordFromStatus(processStat("S"), status)).toMatchObject({ rssKiB: 512 });
	});
});
