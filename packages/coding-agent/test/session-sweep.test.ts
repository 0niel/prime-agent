import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEmptySessionFile, sweepEmptySessionFiles } from "../src/core/session-file-actions.js";
import { canonicalSessionPath, hasLiveSessionLease } from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-session-sweep-test-"));
	tempDirs.push(directory);
	return directory;
}

function writeSessionFile(dir: string, name: string, entries: object[]): string {
	const path = join(dir, name);
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

const header = { type: "session", id: "s1", timestamp: new Date(0).toISOString(), cwd: "/tmp" };
const ghostEntries = [
	header,
	{ type: "model_change", model: "m" },
	{ type: "thinking_level_change", level: "medium" },
	{ type: "service_tier_change", tier: "default" },
	{ type: "session_state", state: { status: "active" } },
];

function writeLease(agentDir: string, sessionPath: string, pid: number): string {
	const key = createHash("sha256").update(canonicalSessionPath(sessionPath)).digest("hex");
	const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
	mkdirSync(lockDirectory, { recursive: true });
	writeFileSync(
		join(lockDirectory, "owner.json"),
		JSON.stringify({
			version: 1,
			token: "t",
			pid,
			sessionPath,
			createdAt: new Date(0).toISOString(),
		}),
	);
	return lockDirectory;
}

describe("isEmptySessionFile", () => {
	it("detects a ghost draft with only bootstrap entries and session_state", () => {
		const dir = createTempDir();
		expect(isEmptySessionFile(writeSessionFile(dir, "ghost.jsonl", ghostEntries))).toBe(true);
	});

	it("keeps sessions with messages or user content", () => {
		const dir = createTempDir();
		const withMessage = writeSessionFile(dir, "msg.jsonl", [
			...ghostEntries,
			{ type: "message", message: { role: "user", content: "hi" } },
		]);
		const named = writeSessionFile(dir, "named.jsonl", [...ghostEntries, { type: "session_info", name: "kept" }]);
		expect(isEmptySessionFile(withMessage)).toBe(false);
		expect(isEmptySessionFile(named)).toBe(false);
	});

	it("keeps files without a session header or with unparseable lines", () => {
		const dir = createTempDir();
		const headerless = writeSessionFile(dir, "headerless.jsonl", [
			{ type: "session_state", state: { status: "active" } },
		]);
		const garbled = join(dir, "garbled.jsonl");
		writeFileSync(garbled, "not json\n");
		expect(isEmptySessionFile(headerless)).toBe(false);
		expect(isEmptySessionFile(garbled)).toBe(false);
	});
});

describe("sweepEmptySessionFiles", () => {
	it("removes ghosts, keeps real sessions, and honors shouldSkip", async () => {
		const dir = createTempDir();
		const ghost = writeSessionFile(dir, "ghost.jsonl", ghostEntries);
		const skipped = writeSessionFile(dir, "skipped.jsonl", ghostEntries);
		const real = writeSessionFile(dir, "real.jsonl", [
			...ghostEntries,
			{ type: "message", message: { role: "user", content: "hi" } },
		]);

		const removed = await sweepEmptySessionFiles(dir, (path) => path === skipped);

		expect(removed).toEqual([ghost]);
		expect(existsSync(ghost)).toBe(false);
		expect(existsSync(skipped)).toBe(true);
		expect(existsSync(real)).toBe(true);
	});
});

describe("hasLiveSessionLease", () => {
	it("is false without a lease", () => {
		const agentDir = createTempDir();
		expect(hasLiveSessionLease(join(agentDir, "s.jsonl"), agentDir)).toBe(false);
	});

	it("is true while the owner process is alive", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "s.jsonl");
		writeLease(agentDir, sessionPath, process.pid);
		expect(hasLiveSessionLease(sessionPath, agentDir)).toBe(true);
	});

	it("reclaims a dead-owner lease and reports it as not live", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "s.jsonl");
		const lockDirectory = writeLease(agentDir, sessionPath, 2_147_483_647);
		expect(hasLiveSessionLease(sessionPath, agentDir)).toBe(false);
		expect(existsSync(lockDirectory)).toBe(false);
	});
});
