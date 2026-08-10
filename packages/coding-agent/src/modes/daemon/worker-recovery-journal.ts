import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
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

/** Narrow filesystem boundary so durability order and failure behavior are testable. */
export interface WorkerRecoveryJournalFileSystem {
	mkdirSync(path: string, options: { recursive: true; mode: number }): string | undefined;
	readFileSync(path: string, encoding: "utf8"): string;
	openSync(path: string, flags: string, mode?: number): number;
	writeSync(fd: number, data: Uint8Array, offset: number, length: number): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
	chmodSync(path: string, mode: number): void;
	renameSync(oldPath: string, newPath: string): void;
	unlinkSync(path: string): void;
}

export interface WorkerRecoveryJournalOptions {
	fileSystem?: WorkerRecoveryJournalFileSystem;
	makeTempPath?: (journalPath: string) => string;
	platform?: NodeJS.Platform;
}

const nativeFileSystem: WorkerRecoveryJournalFileSystem = {
	mkdirSync,
	readFileSync,
	openSync,
	writeSync,
	fsyncSync,
	closeSync,
	chmodSync,
	renameSync,
	unlinkSync,
};

const v2Key = (record: Pick<WorkerRecoveryRecord, "activeSessionId" | "generation" | "operationId">) =>
	`${record.activeSessionId}\u0000${record.generation}\u0000${record.operationId}`;
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

function parseRecords(
	path: string,
	fileSystem: Pick<WorkerRecoveryJournalFileSystem, "readFileSync"> = nativeFileSystem,
): ParsedRecords {
	const latest = new Map<string, ReadWorkerRecoveryRecord>();
	let contents: string;
	try {
		contents = fileSystem.readFileSync(path, "utf8");
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
	private readonly fileSystem: WorkerRecoveryJournalFileSystem;
	private readonly makeTempPath: (journalPath: string) => string;
	private readonly platform: NodeJS.Platform;

	constructor(
		private readonly path: string,
		{
			fileSystem = nativeFileSystem,
			makeTempPath = (journalPath) => `${journalPath}.${process.pid}.${randomUUID()}.tmp`,
			platform = process.platform,
		}: WorkerRecoveryJournalOptions = {},
	) {
		this.fileSystem = fileSystem;
		this.makeTempPath = makeTempPath;
		this.platform = platform;
		this.fileSystem.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const parsed = parseRecords(path, this.fileSystem);
		this.latest = parsed.latest;
		this.hasInvalidRecords = parsed.hasInvalidRecords;
		// Upgrade journals written before completed v2 identities were pruned.
		// A restart must not expose their historical terminal records forever. Raw
		// malformed lines are fail-closed recovery evidence, however: rewriting a
		// parsed subset would silently erase both that evidence and the unreadable
		// signal on the next restart.
		if (!this.hasInvalidRecords && [...this.latest.values()].some((record) => isV2(record) && !record.busy)) {
			this.compact();
		}
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
		// for the same stable active-session/generation/operation-ID key and operation.
		// sessionId and sessionFile describe the session at each checkpoint, but are
		// not authority: materialization, resume, or branching can change either while
		// an admitted operation is still running. In particular, a random/new operation
		// ID or a different operation must not manufacture a clear without its begin.
		if (
			!record.busy &&
			(!previous ||
				!isV2(previous) ||
				!previous.busy ||
				previous.operationId !== record.operationId ||
				previous.operation !== record.operation)
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
		// A terminal v2 operation is only a stale-callback fence while the append
		// above is durable. It is not recovery evidence. Compact it immediately so
		// operationId cardinality cannot turn completed work into unbounded journal
		// or getLatest history. v1 remains conservative uncertainty; every busy v2
		// identity remains exact crash evidence.
		if (!record.busy) {
			// The terminal append is already durable. Do not roll it back in memory:
			// restoring `previous` would let a later successful compaction rewrite its
			// old busy record and resurrect completed work. compact() still propagates
			// replacement failures to the caller, because it may not have durably
			// retained the complete sibling evidence set.
			this.compact();
		}
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
		const fd = this.fileSystem.openSync(this.path, "a", 0o600);
		try {
			this.writeAll(fd, `${JSON.stringify(record)}\n`);
			this.fileSystem.fsyncSync(fd);
		} finally {
			this.fileSystem.closeSync(fd);
		}
		this.fileSystem.chmodSync(this.path, 0o600);
	}

	private compact(): void {
		// Parsed records are not a lossless representation of malformed input. Do
		// not replace the journal while it contains any such raw evidence; otherwise
		// a compaction would make future recovery appear safe merely by deleting it.
		if (this.hasInvalidRecords) return;
		// Completed v2 operations are deliberately omitted. Keeping their UUID-keyed
		// terminal entries would make a long-lived idle worker retain one record per
		// historical operation. v1 has no identity fence and is therefore preserved
		// verbatim as uncertain legacy recovery evidence.
		const retained = [...this.latest.entries()].filter(([, record]) => !isV2(record) || record.busy);
		const contents = retained.map(([, record]) => JSON.stringify(record)).join("\n");
		this.replaceAtomically(contents ? `${contents}\n` : "");
		// Do not alter in-memory recovery evidence until its replacement is durable.
		this.latest.clear();
		for (const [key, record] of retained) this.latest.set(key, record);
	}

	private replaceAtomically(contents: string): void {
		const tempPath = this.makeTempPath(this.path);
		let tempFd: number | undefined;
		let renamed = false;
		try {
			// Exclusive creation makes cleanup safe: this invocation owns this temp file.
			tempFd = this.fileSystem.openSync(tempPath, "wx", 0o600);
			this.fileSystem.chmodSync(tempPath, 0o600);
			this.writeAll(tempFd, contents);
			this.fileSystem.fsyncSync(tempFd);
			this.fileSystem.closeSync(tempFd);
			tempFd = undefined;
			this.fileSystem.renameSync(tempPath, this.path);
			renamed = true;
			this.fsyncParentDirectory();
		} catch (error) {
			if (tempFd !== undefined) {
				try {
					this.fileSystem.closeSync(tempFd);
				} catch {
					// The original write/sync/rename failure is the actionable failure.
				}
			}
			if (!renamed) {
				try {
					this.fileSystem.unlinkSync(tempPath);
				} catch {
					// A unique, restrictive temp can be cleaned by a later operator; never touch the journal.
				}
			}
			throw error;
		}
	}

	private writeAll(fd: number, contents: string): void {
		const bytes = Buffer.from(contents);
		for (let offset = 0; offset < bytes.length; ) {
			const written = this.fileSystem.writeSync(fd, bytes, offset, bytes.length - offset);
			if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset)
				throw new Error("Recovery journal write made no forward progress");
			offset += written;
		}
	}

	private fsyncParentDirectory(): void {
		let directoryFd: number | undefined;
		try {
			directoryFd = this.fileSystem.openSync(dirname(this.path), "r");
			this.fileSystem.fsyncSync(directoryFd);
		} catch (error) {
			if (!this.isDirectoryFsyncUnsupported(error)) throw error;
		} finally {
			if (directoryFd !== undefined) this.fileSystem.closeSync(directoryFd);
		}
	}

	private isDirectoryFsyncUnsupported(error: unknown): boolean {
		const code = (error as NodeJS.ErrnoException).code;
		return (
			code === "ENOTSUP" ||
			code === "EOPNOTSUPP" ||
			code === "EINVAL" ||
			(this.platform === "win32" && (code === "EPERM" || code === "EISDIR"))
		);
	}
}
