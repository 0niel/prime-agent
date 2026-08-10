import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { assertFreshUuid } from "./daemon-lifecycle-identity.js";

/** Checkpoints emitted by the daemon worker. Keep the durable vocabulary closed. */
export const WORKER_RECOVERY_OPERATIONS = [
	"ready",
	"prompt",
	"prompt_accepted",
	"steer_queued",
	"follow_up_queued",
	"actions_restored",
	"closed:killed",
	"closed:shutdown",
	"closed:completed",
	"closed:replaced",
	"closed:update",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"bash_start",
	"bash_end",
	"session_action_update",
	"rlm_child_update",
	"ipython_sent_agent_message",
	"auth_stale",
	"bash_output",
	"goal_update",
	"model_stream",
	"tool_execution",
	"recovery_hold",
] as const;
export type WorkerRecoveryOperation = (typeof WORKER_RECOVERY_OPERATIONS)[number];

/** The only writer format. operationId and generation fence a completion. */
export interface WorkerRecoveryRecord {
	version: 2;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: WorkerRecoveryOperation;
	operationId: string;
	generation: string;
	recordedAt: string;
}

/** v1 evidence is intentionally readable, but cannot authorize v2 cleanup. */
export interface LegacyWorkerRecoveryRecord {
	version: 1;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}
export type ReadWorkerRecoveryRecord = WorkerRecoveryRecord | LegacyWorkerRecoveryRecord;

interface ParsedRecords {
	latest: Map<string, ReadWorkerRecoveryRecord>;
	hasInvalidRecords: boolean;
}

const v2Key = (record: Pick<WorkerRecoveryRecord, "activeSessionId" | "generation">) =>
	`${record.activeSessionId}\u0000${record.generation}`;
const legacyKey = (record: Pick<LegacyWorkerRecoveryRecord, "activeSessionId">) =>
	`legacy\u0000${record.activeSessionId}`;

function isV2(value: unknown): value is WorkerRecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<WorkerRecoveryRecord>;
	return (
		record.version === 2 &&
		typeof record.activeSessionId === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.busy === "boolean" &&
		typeof record.operation === "string" &&
		(WORKER_RECOVERY_OPERATIONS as readonly string[]).includes(record.operation) &&
		assertFreshUuid(record.operationId) &&
		assertFreshUuid(record.generation) &&
		typeof record.recordedAt === "string" &&
		(record.sessionFile === undefined || typeof record.sessionFile === "string")
	);
}

function isV1(value: unknown): value is LegacyWorkerRecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<LegacyWorkerRecoveryRecord>;
	return (
		record.version === 1 &&
		typeof record.activeSessionId === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.busy === "boolean" &&
		typeof record.operation === "string" &&
		typeof record.recordedAt === "string" &&
		(record.sessionFile === undefined || typeof record.sessionFile === "string")
	);
}

function parseRecords(path: string): ParsedRecords {
	const latest = new Map<string, ReadWorkerRecoveryRecord>();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { latest, hasInvalidRecords: false };
		throw error;
	}
	let hasInvalidRecords = false;
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			hasInvalidRecords = true;
			continue;
		}
		if (isV2(value)) latest.set(v2Key(value), value);
		else if (isV1(value)) latest.set(legacyKey(value), value);
		else hasInvalidRecords = true;
	}
	return { latest, hasInvalidRecords };
}

export class WorkerRecoveryJournal {
	private readonly latest: Map<string, ReadWorkerRecoveryRecord>;
	private readonly hasInvalidRecords: boolean;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const parsed = parseRecords(path);
		this.latest = parsed.latest;
		this.hasInvalidRecords = parsed.hasInvalidRecords;
	}

	/**
	 * Append a fully validated v2 checkpoint. A non-busy record is a completion:
	 * it may replace only the busy record with precisely the same operation and
	 * process incarnation. This is the journal's authoritative stale-callback fence.
	 */
	record(input: Omit<WorkerRecoveryRecord, "version" | "recordedAt">): void {
		const record: WorkerRecoveryRecord = { version: 2, ...input, recordedAt: new Date().toISOString() };
		if (!isV2(record)) throw new Error("Invalid C01 recovery checkpoint");
		const key = v2Key(record);
		const previous = this.latest.get(key);
		// A completion is never an admission. It must replace a *busy* v2 record
		// for this exact operation incarnation; in particular a random/new ID must
		// not manufacture a clear when no begin was durably observed.
		if (
			!record.busy &&
			(!previous || !isV2(previous) || !previous.busy || previous.operationId !== record.operationId)
		)
			return;
		if (
			previous &&
			isV2(previous) &&
			previous.busy === record.busy &&
			previous.operation === record.operation &&
			previous.operationId === record.operationId &&
			previous.sessionFile === record.sessionFile
		)
			return;
		this.append(record);
		this.latest.set(key, record);
		// Never compact away v1 crash evidence. It is conservative recovery input.
		if ([...this.latest.values()].every((entry) => !isV2(entry) || !entry.busy)) this.compact();
	}

	getLatest(): ReadWorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	hasUnreadableRecords(): boolean {
		return this.hasInvalidRecords;
	}

	static readLatest(path: string): ReadWorkerRecoveryRecord[] {
		return [...parseRecords(path).latest.values()];
	}

	private append(record: WorkerRecoveryRecord): void {
		const fd = openSync(this.path, "a", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(record)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(this.path, 0o600);
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${[...this.latest.values()].map((record) => JSON.stringify(record)).join("\n")}\n`, {
			mode: 0o600,
		});
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, this.path);
	}
}
