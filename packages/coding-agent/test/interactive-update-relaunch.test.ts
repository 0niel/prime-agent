import { describe, expect, it } from "vitest";
import { buildUpdateRelaunchArgs } from "../src/modes/interactive/interactive-mode.js";

describe("buildUpdateRelaunchArgs", () => {
	it("relaunches the current session with the supported resume flag", () => {
		expect(buildUpdateRelaunchArgs(["--model", "gpt-5"], "/tmp/session.jsonl")).toEqual([
			"--model",
			"gpt-5",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});

	it("keeps an existing resume selection", () => {
		expect(buildUpdateRelaunchArgs(["--resume", "/tmp/other.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--resume",
			"/tmp/other.jsonl",
		]);
	});

	it("does not treat the unsupported session flag as an existing selection", () => {
		expect(buildUpdateRelaunchArgs(["--session", "/tmp/old.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--session",
			"/tmp/old.jsonl",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});
});
