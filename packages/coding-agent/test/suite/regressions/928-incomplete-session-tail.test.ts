import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

describe("regression #928: incomplete session tails", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSession(): Promise<{ harness: Harness; path: string; content: Buffer }> {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("before crash")]);
		await harness.session.prompt("persist this turn");
		const path = harness.sessionManager.getSessionFile();
		if (!path) throw new Error("Expected a persisted session path");
		return { harness, path, content: readFileSync(path) };
	}

	it.each([
		["mid-JSON", Buffer.from('{"type":"message","id":"torn"')],
		["mid-UTF-8", Buffer.from('{"type":"message","content":"\u{1F642}').subarray(0, -1)],
	])("truncates an incomplete %s tail before the next append", async (_name, tail) => {
		const { path, content } = await createSession();
		appendFileSync(path, tail);
		const tornContent = readFileSync(path);

		const resumed = SessionManager.open(path);
		expect(readFileSync(path)).toEqual(tornContent);
		resumed.appendSessionInfo("recovered");

		expect(resumed.getFileRecovery()).toEqual({
			action: "truncate",
			originalSize: tornContent.length,
			repairedSize: content.length,
			discardedBytes: tail.length,
		});
		expect(readFileSync(path).subarray(0, content.length)).toEqual(content);
		expect(SessionManager.open(path).getSessionName()).toBe("recovered");
	});

	it("adds a delimiter after a complete final record without a newline", async () => {
		const { path, content } = await createSession();
		const unterminated = content.subarray(0, -1);
		writeFileSync(path, unterminated);

		const resumed = SessionManager.open(path);
		expect(readFileSync(path)).toEqual(unterminated);
		resumed.appendSessionInfo("after complete record");

		expect(resumed.getFileRecovery()).toEqual({
			action: "append-newline",
			originalSize: unterminated.length,
			repairedSize: content.length,
			discardedBytes: 0,
		});
		expect(SessionManager.open(path).getSessionName()).toBe("after complete record");
	});

	it("preserves malformed middle rows byte-for-byte while repairing only the tail", async () => {
		const { path, content } = await createSession();
		const firstNewline = content.indexOf(0x0a);
		const malformedMiddle = Buffer.from("malformed middle row\n");
		const preserved = Buffer.concat([
			content.subarray(0, firstNewline + 1),
			malformedMiddle,
			content.subarray(firstNewline + 1),
		]);
		const tornTail = Buffer.from('{"type":"message","id":');
		writeFileSync(path, Buffer.concat([preserved, tornTail]));

		const resumed = SessionManager.open(path);
		resumed.appendSessionInfo("kept raw bytes");

		expect(readFileSync(path).subarray(0, preserved.length)).toEqual(preserved);
		expect(resumed.getFileRecovery()?.discardedBytes).toBe(tornTail.length);
		expect(SessionManager.open(path).getSessionName()).toBe("kept raw bytes");
	});

	it("does not mutate empty or torn files during read-only loading", () => {
		const directory = mkdtempSync(join(tmpdir(), "session-tail-readonly-"));
		const path = join(directory, "session.jsonl");
		const torn = Buffer.from('{"type":"session"');
		writeFileSync(path, torn);
		try {
			expect(loadEntriesFromFile(path)).toEqual([]);
			expect(readFileSync(path)).toEqual(torn);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not repeat recovery after a repaired file is reopened", async () => {
		const { path } = await createSession();
		appendFileSync(path, '{"type":"message"');
		const firstResume = SessionManager.open(path);
		firstResume.appendSessionInfo("first recovery");

		const secondResume = SessionManager.open(path);
		expect(secondResume.getFileRecovery()).toBeUndefined();
		secondResume.appendSessionInfo("second append");

		expect(SessionManager.open(path).getSessionName()).toBe("second append");
	});
});
