import {
	appendFileSync,
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	WorkerRecoveryJournal,
	type WorkerRecoveryJournalFileSystem,
} from "../src/modes/daemon/worker-recovery-journal.js";

const generationA = "11111111-1111-4111-8111-111111111111";
const generationB = "22222222-2222-4222-8222-222222222222";
const operationA = "33333333-3333-4333-8333-333333333333";
const operationB = "44444444-4444-4444-8444-444444444444";
const operationC = "55555555-5555-4555-8555-555555555555";

function recordingFileSystem(
	events: string[],
	{
		failTempFsync = false,
		maximumWriteLength,
		zeroTempWrite = false,
	}: {
		failTempFsync?: boolean | number;
		maximumWriteLength?: number;
		zeroTempWrite?: boolean;
	} = {},
): WorkerRecoveryJournalFileSystem {
	const descriptors = new Map<number, string>();
	let remainingTempFsyncFailures =
		typeof failTempFsync === "number" ? failTempFsync : failTempFsync ? Number.POSITIVE_INFINITY : 0;
	return {
		mkdirSync,
		readFileSync,
		openSync(path, flags, mode) {
			const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
			descriptors.set(
				fd,
				path.endsWith(".tmp") ? "temp" : path.includes("worker.recovery") ? "journal" : "directory",
			);
			events.push(`open:${flags}:${descriptors.get(fd)}:${mode?.toString(8) ?? ""}`);
			return fd;
		},
		writeSync(fd, data, offset, length) {
			events.push(`write:${descriptors.get(fd)}`);
			if (zeroTempWrite && descriptors.get(fd) === "temp") return 0;
			return writeSync(
				fd,
				data,
				offset,
				maximumWriteLength === undefined ? length : Math.min(length, maximumWriteLength),
			);
		},
		fsyncSync(fd) {
			events.push(`fsync:${descriptors.get(fd)}`);
			if (remainingTempFsyncFailures > 0 && descriptors.get(fd) === "temp") {
				remainingTempFsyncFailures--;
				const error = new Error("injected temporary-file fsync failure") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			fsyncSync(fd);
		},
		closeSync(fd) {
			events.push(`close:${descriptors.get(fd)}`);
			closeSync(fd);
		},
		chmodSync,
		renameSync(oldPath, newPath) {
			events.push("rename");
			renameSync(oldPath, newPath);
		},
		unlinkSync(path) {
			events.push("unlink");
			unlinkSync(path);
		},
	};
}

describe("WorkerRecoveryJournal C01 identities", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function path(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-worker-recovery-"));
		roots.push(root);
		return join(root, "worker.recovery.jsonl");
	}

	const base = {
		activeSessionId: "active",
		sessionId: "session",
		operation: "prompt" as const,
		generation: generationA,
		operationId: operationA,
	};

	it("allows only the operation that began a v2 checkpoint to clear it", () => {
		const journal = new WorkerRecoveryJournal(path());
		journal.record({ ...base, busy: true });
		journal.record({ ...base, busy: false });
		expect(journal.getLatest()).toEqual([]);
	});

	it("allows an exact completion after session materialization changes checkpoint metadata", () => {
		const journal = new WorkerRecoveryJournal(path());
		// The operation begins before its in-memory session has a file. The daemon
		// reconstructs session metadata at completion, after materialization changes it.
		journal.record({ ...base, busy: true, sessionId: "draft" });

		// Operation equality remains an authority fence even when the payload changes.
		journal.record({
			...base,
			busy: false,
			operation: "tool_execution",
			sessionId: "materialized",
			sessionFile: "/sessions/materialized.jsonl",
		});
		expect(journal.getLatest()).toEqual([expect.objectContaining({ busy: true, operation: "prompt" })]);

		journal.record({
			...base,
			busy: false,
			sessionId: "materialized",
			sessionFile: "/sessions/materialized.jsonl",
		});
		expect(journal.getLatest()).toEqual([]);
	});

	it("retains a busy operation across restart when a different allowed operation replays its terminal token", () => {
		const file = path();
		const journal = new WorkerRecoveryJournal(file);
		journal.record({ ...base, busy: true });

		// The token values match exactly; only the allowed operation differs.
		journal.record({ ...base, busy: false, operation: "tool_execution" });
		expect(journal.getLatest()).toEqual([
			expect.objectContaining({
				busy: true,
				operation: "prompt",
				activeSessionId: base.activeSessionId,
				generation: generationA,
				operationId: operationA,
			}),
		]);

		// Replay after a crash/restart must remain unable to erase the original evidence.
		const restarted = new WorkerRecoveryJournal(file);
		restarted.record({ ...base, busy: false, operation: "tool_execution" });
		expect(restarted.getLatest()).toEqual([
			expect.objectContaining({ busy: true, operation: "prompt", operationId: operationA }),
		]);
		restarted.record({ ...base, busy: false });
		expect(restarted.getLatest()).toEqual([]);
	});

	it("does not let an unstarted v2 completion manufacture a clear", () => {
		const journal = new WorkerRecoveryJournal(path());
		journal.record({ ...base, busy: false });
		expect(journal.getLatest()).toEqual([]);
	});

	it("does not let overlapping same-family A complete B", () => {
		const journal = new WorkerRecoveryJournal(path());
		journal.record({ ...base, busy: true });
		journal.record({ ...base, busy: true, operationId: operationB });
		journal.record({ ...base, busy: false, operationId: operationA });
		expect(journal.getLatest()).toEqual([expect.objectContaining({ busy: true, operationId: operationB })]);
	});

	it("refuses a stale operation completion while retaining another generation", () => {
		const journal = new WorkerRecoveryJournal(path());
		journal.record({ ...base, busy: true });
		journal.record({ ...base, busy: false, operationId: operationB });
		journal.record({ ...base, busy: true, generation: generationB });
		journal.record({ ...base, busy: false, generation: generationB });
		expect(journal.getLatest()).toEqual([
			expect.objectContaining({ busy: true, operationId: operationA, generation: generationA }),
		]);
	});

	it("keeps v1 uncertain and malformed tails recoverable without letting them replace v2", () => {
		const file = path();
		appendFileSync(
			file,
			`${JSON.stringify({ version: 1, activeSessionId: "old", sessionId: "old", busy: true, operation: "unknown", recordedAt: new Date().toISOString() })}\n{truncated`,
		);
		const journal = new WorkerRecoveryJournal(file);
		journal.record({ ...base, busy: true });
		expect(journal.getLatest()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ version: 1, activeSessionId: "old", busy: true }),
				expect.objectContaining({ version: 2, operationId: operationA }),
			]),
		);
		expect(journal.hasUnreadableRecords()).toBe(true);
	});
	it("retains B after A completes and clears only B's exact terminal token across restart", () => {
		const file = path();
		const journal = new WorkerRecoveryJournal(file);
		// Same session, generation and operation family: only the UUID separates
		// overlapping queued turns. This is the daemon scheduler's A/B ordering.
		journal.record({ ...base, busy: true, operationId: operationA });
		journal.record({ ...base, busy: true, operationId: operationB });
		journal.record({ ...base, busy: false, operationId: operationA });
		expect(journal.getLatest()).toEqual([expect.objectContaining({ busy: true, operationId: operationB })]);

		// A restart reads B as crash evidence. A's stale callback cannot clear B.
		const restarted = new WorkerRecoveryJournal(file);
		restarted.record({ ...base, busy: false, operationId: operationA });
		expect(restarted.getLatest()).toEqual([expect.objectContaining({ busy: true, operationId: operationB })]);
		restarted.record({ ...base, busy: false, operationId: operationB });
		expect(restarted.getLatest()).toEqual([]);
	});

	it("prunes completed v2 history inherited from an older journal on restart", () => {
		const file = path();
		for (let index = 0; index < 128; index++) {
			const operationId = `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
			appendFileSync(
				file,
				`${JSON.stringify({ version: 2, ...base, busy: false, operationId, recordedAt: new Date().toISOString() })}\n`,
			);
		}
		const restarted = new WorkerRecoveryJournal(file);
		expect(restarted.getLatest()).toEqual([]);
		expect(WorkerRecoveryJournal.readLatest(file)).toEqual([]);
	});

	it("bounds completed v2 history while retaining all busy operations and legacy uncertainty", () => {
		const file = path();
		const journal = new WorkerRecoveryJournal(file);
		const busyOperation = "55555555-5555-4555-8555-555555555555";
		journal.record({ ...base, busy: true, operationId: busyOperation });
		for (let index = 0; index < 128; index++) {
			const operationId = `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`;
			journal.record({ ...base, busy: true, operationId });
			journal.record({ ...base, busy: false, operationId });
		}
		appendFileSync(
			file,
			`${JSON.stringify({ version: 1, activeSessionId: "legacy", sessionId: "old", busy: true, operation: "unknown", recordedAt: new Date().toISOString() })}\n`,
		);
		const restarted = new WorkerRecoveryJournal(file);
		expect(restarted.getLatest()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ version: 2, operationId: busyOperation, busy: true }),
				expect.objectContaining({ version: 1, activeSessionId: "legacy", busy: true }),
			]),
		);
		expect(restarted.getLatest()).toHaveLength(2);
	});
	it("fsyncs a restrictive replacement before rename and its parent directory after rename", () => {
		const file = path();
		const tempPath = `${file}.fixed.tmp`;
		const events: string[] = [];
		const journal = new WorkerRecoveryJournal(file, {
			fileSystem: recordingFileSystem(events),
			makeTempPath: () => tempPath,
		});
		journal.record({ ...base, busy: true });
		events.splice(0);
		journal.record({ ...base, busy: false });
		expect(events).toEqual([
			"open:a:journal:600",
			"write:journal",
			"fsync:journal",
			"close:journal",
			"open:wx:temp:600",
			"fsync:temp",
			"close:temp",
			"rename",
			"open:r:directory:",
			"fsync:directory",
			"close:directory",
		]);
	});

	it("keeps a durably appended completion after compaction fails, then never resurrects it", () => {
		const file = path();
		const tempPath = `${file}.failed.tmp`;
		const journal = new WorkerRecoveryJournal(file, {
			fileSystem: recordingFileSystem([], { failTempFsync: 1 }),
			makeTempPath: () => tempPath,
		});
		journal.record({ ...base, busy: true, operationId: operationA });
		journal.record({ ...base, busy: true, operationId: operationB });

		// The terminal append commits before replacement. A replacement failure is
		// reported to the caller, but must not restore A's old busy checkpoint.
		expect(() => journal.record({ ...base, busy: false, operationId: operationA })).toThrow(
			"injected temporary-file fsync failure",
		);
		expect(journal.getLatest()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ busy: false, operationId: operationA }),
				expect.objectContaining({ busy: true, operationId: operationB }),
			]),
		);

		// A completion replay is a no-op because A remains terminal in memory.
		journal.record({ ...base, busy: false, operationId: operationA });
		expect(journal.getLatest()).toEqual(
			expect.arrayContaining([expect.objectContaining({ busy: false, operationId: operationA })]),
		);

		// A later healthy compaction retains B while omitting the durable terminals.
		// It must never rebuild A from the stale busy record; the same holds on restart.
		journal.record({ ...base, busy: true, operationId: operationC });
		journal.record({ ...base, busy: false, operationId: operationC });
		expect(journal.getLatest()).toEqual([expect.objectContaining({ busy: true, operationId: operationB })]);
		const restarted = new WorkerRecoveryJournal(file);
		expect(restarted.getLatest()).toEqual([expect.objectContaining({ busy: true, operationId: operationB })]);
	});

	it("never compacts malformed raw history, including terminal records, across restarts", () => {
		const file = path();
		const received = { version: 2, ...base, busy: true, recordedAt: new Date().toISOString() };
		const completed = { version: 2, ...base, busy: false, recordedAt: new Date().toISOString() };
		const malformed = "{malformed raw recovery evidence}";
		const contents = `${JSON.stringify(received)}\n${malformed}\n${JSON.stringify(completed)}\n`;
		appendFileSync(file, contents);

		const first = new WorkerRecoveryJournal(file);
		expect(first.hasUnreadableRecords()).toBe(true);
		expect(first.getLatest()).toEqual([expect.objectContaining({ busy: false, operationId: operationA })]);
		expect(readFileSync(file, "utf8")).toBe(contents);

		// Both constructor auto-compaction and a completion-triggered compaction
		// must fail closed by retaining the exact raw corruption for future recovery.
		first.record({ ...base, busy: true, operationId: operationB });
		first.record({ ...base, busy: false, operationId: operationB });
		expect(readFileSync(file, "utf8")).toContain(malformed);
		const second = new WorkerRecoveryJournal(file);
		expect(second.hasUnreadableRecords()).toBe(true);
		expect(second.getLatest()).toEqual(
			expect.arrayContaining([expect.objectContaining({ busy: false, operationId: operationA })]),
		);
		expect(readFileSync(file, "utf8")).toContain(malformed);
		const third = new WorkerRecoveryJournal(file);
		expect(third.hasUnreadableRecords()).toBe(true);
		expect(readFileSync(file, "utf8")).toContain(malformed);
	});

	it("fails closed on replacement sync failure without removing a busy sibling journal record", () => {
		const file = path();
		const tempPath = `${file}.fixed.tmp`;
		const events: string[] = [];
		const journal = new WorkerRecoveryJournal(file, {
			fileSystem: recordingFileSystem(events, { failTempFsync: true }),
			makeTempPath: () => tempPath,
		});
		journal.record({ ...base, busy: true });
		journal.record({ ...base, busy: true, operationId: operationB });
		expect(() => journal.record({ ...base, busy: false })).toThrow("injected temporary-file fsync failure");
		expect(events).toContain("unlink");
		expect(events).not.toContain("rename");
		expect(() => readFileSync(tempPath, "utf8")).toThrow();
		expect(WorkerRecoveryJournal.readLatest(file)).toEqual(
			expect.arrayContaining([expect.objectContaining({ busy: true, operationId: operationB })]),
		);
		// The failed compaction also keeps the live instance conservative.
		expect(journal.getLatest()).toEqual(
			expect.arrayContaining([expect.objectContaining({ busy: true, operationId: operationB })]),
		);
	});
	it("writes every byte when the filesystem reports partial writes", () => {
		const file = path();
		const events: string[] = [];
		const journal = new WorkerRecoveryJournal(file, {
			fileSystem: recordingFileSystem(events, { maximumWriteLength: 1 }),
			makeTempPath: (journalPath) => `${journalPath}.partial.tmp`,
		});
		journal.record({ ...base, busy: true, operationId: operationA });
		journal.record({ ...base, busy: true, operationId: operationB, sessionFile: "é".repeat(4096) });
		journal.record({ ...base, busy: false, operationId: operationA });
		expect(events.filter((event) => event === "write:temp")).toHaveLength(
			Buffer.byteLength(readFileSync(file, "utf8")),
		);
		expect(WorkerRecoveryJournal.readLatest(file)).toEqual([
			expect.objectContaining({ busy: true, operationId: operationB }),
		]);
	});

	it("fails before replacement when a write makes zero progress", () => {
		const file = path();
		const tempPath = `${file}.zero.tmp`;
		const events: string[] = [];
		const journal = new WorkerRecoveryJournal(file, {
			fileSystem: recordingFileSystem(events, { zeroTempWrite: true }),
			makeTempPath: () => tempPath,
		});
		journal.record({ ...base, busy: true, operationId: operationA });
		journal.record({ ...base, busy: true, operationId: operationB });
		expect(() => journal.record({ ...base, busy: false, operationId: operationA })).toThrow(
			"Recovery journal write made no forward progress",
		);
		expect(events).toContain("unlink");
		expect(events).not.toContain("rename");
		expect(() => readFileSync(tempPath, "utf8")).toThrow();
		expect(WorkerRecoveryJournal.readLatest(file)).toEqual(
			expect.arrayContaining([expect.objectContaining({ busy: true, operationId: operationB })]),
		);
	});
});
