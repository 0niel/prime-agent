import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

const generationA = "11111111-1111-4111-8111-111111111111";
const generationB = "22222222-2222-4222-8222-222222222222";
const operationA = "33333333-3333-4333-8333-333333333333";
const operationB = "44444444-4444-4444-8444-444444444444";

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
		expect(journal.getLatest()).toEqual([
			expect.objectContaining({ busy: false, operationId: operationA, generation: generationA }),
		]);
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
		expect(journal.getLatest()).toEqual([
			expect.objectContaining({ busy: true, operationId: operationB, generation: generationA }),
		]);
	});

	it("refuses a stale operation completion while retaining another generation", () => {
		const journal = new WorkerRecoveryJournal(path());
		journal.record({ ...base, busy: true });
		journal.record({ ...base, busy: false, operationId: operationB });
		journal.record({ ...base, busy: true, generation: generationB });
		journal.record({ ...base, busy: false, generation: generationB });
		expect(journal.getLatest()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ busy: true, operationId: operationA, generation: generationA }),
				expect.objectContaining({ busy: false, operationId: operationA, generation: generationB }),
			]),
		);
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
		// overlapping queued turns.  This is the daemon scheduler's A/B ordering.
		journal.record({ ...base, busy: true, operationId: operationA });
		journal.record({ ...base, busy: true, operationId: operationB });
		journal.record({ ...base, busy: false, operationId: operationA });
		expect(journal.getLatest()).toEqual([
			expect.objectContaining({ busy: true, operationId: operationB, generation: generationA }),
		]);

		// A restart reads B as crash evidence.  A cancellation/terminal callback
		// carrying A remains stale, while B's exact terminal token clears B.
		const restarted = new WorkerRecoveryJournal(file);
		restarted.record({ ...base, busy: false, operationId: operationA });
		expect(restarted.getLatest()).toEqual([expect.objectContaining({ busy: true, operationId: operationB })]);
		restarted.record({ ...base, busy: false, operationId: operationB });
		expect(restarted.getLatest()).toEqual([expect.objectContaining({ busy: false, operationId: operationB })]);
	});
});
