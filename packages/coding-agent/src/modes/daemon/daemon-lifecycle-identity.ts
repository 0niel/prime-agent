import { getProcessStartId } from "../../core/session-lease.js";

/** Closed daemon-owned lifecycle values. Disk input is untrusted. */
export const DAEMON_WORKER_LIFECYCLES = ["starting", "ready", "recovering", "failed", "passivated"] as const;
export type DaemonWorkerLifecycle = (typeof DAEMON_WORKER_LIFECYCLES)[number];
export function isDaemonWorkerLifecycle(value: unknown): value is DaemonWorkerLifecycle {
	return typeof value === "string" && (DAEMON_WORKER_LIFECYCLES as readonly string[]).includes(value);
}

/** Execution terminals, deliberately distinct from public registry presentation status. */
export const RLM_CHILD_TERMINAL_STATUSES = ["done", "error", "cancelled"] as const;
export type RlmChildTerminalStatus = (typeof RLM_CHILD_TERMINAL_STATUSES)[number];
export function isRlmChildTerminalStatus(value: unknown): value is RlmChildTerminalStatus {
	return typeof value === "string" && (RLM_CHILD_TERMINAL_STATUSES as readonly string[]).includes(value);
}

export interface ProcessIdentity {
	pid: number;
	processStartId: string;
}

export interface OperationIdentity {
	operationId: string;
	generation: string;
}

// UUIDs written by C01 use crypto.randomUUID(). Require canonical RFC-4122 text
// when accepting an identity from disk rather than allowing arbitrary selectors.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertFreshUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

/** A PID alone is never a process identity. Unreadable start IDs fail closed. */
export function isCurrentProcessIdentity(identity: ProcessIdentity): boolean {
	if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !identity.processStartId) return false;
	try {
		return getProcessStartId(identity.pid) === identity.processStartId;
	} catch {
		return false;
	}
}
