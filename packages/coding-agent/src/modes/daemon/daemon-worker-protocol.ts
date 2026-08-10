import { closeSync, readFileSync } from "node:fs";
import type {
	AgentSessionMessageAgentSummary,
	AgentSessionMessageDeliveryMode,
	AgentSessionMessageSender,
} from "../../core/agent-messages.js";
import type { IdleEvictionMinutes } from "../../core/session-action-store.js";

export { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../../core/session-lease.js";

import type { DaemonClientCapability, DaemonCommand, DaemonOutbound } from "./daemon-protocol.js";

export const DAEMON_WORKER_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
export const DAEMON_WORKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
export const DAEMON_WORKER_ACTIVE_SESSION_ID_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
export const DAEMON_WORKER_SUPERVISOR_SOCKET_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
export const DAEMON_WORKER_RECOVERY_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
/** Opaque supervisor-minted worker incarnation for recovery-journal v2. */
export const DAEMON_WORKER_GENERATION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_GENERATION";
export const DAEMON_WORKER_STARTUP_GATE_FD_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD";
export const DAEMON_WORKER_STARTUP_GATE_COMMIT = "start\n";
/**
 * `passivated` descriptors retain a session's routing metadata without a worker
 * process. They are deliberately revived only by an explicit session operation.
 */
export {
	DAEMON_WORKER_LIFECYCLES,
	type DaemonWorkerLifecycle,
	isDaemonWorkerLifecycle,
	type ProcessIdentity,
} from "./daemon-lifecycle-identity.js";

import type { DaemonWorkerLifecycle, ProcessIdentity } from "./daemon-lifecycle-identity.js";

export type DaemonWorkerFrameHeader =
	| {
			kind: "command";
			requestId: string;
			commandType: string;
	  }
	| {
			kind: "outbound";
			requestId?: string;
			outboundType: DaemonOutbound["type"];
			activeSessionId?: string;
			snapshotId?: string;
			sessionEventType?: string;
			payloadEncoding?: "jsonl" | "assistant-delta";
			snapshotPurpose?: "attach" | "replacement" | "catchup";
	  };

export type DaemonCreateCommand = Extract<DaemonCommand, { type: "create" }>;

export type DaemonWorkerCommand =
	| {
			id?: string;
			type: "worker_auth";
			token: string;
			supervisorGeneration: string;
			supervisorPid: number;
			supervisorProcessStartId?: string;
			supervisorSocketPath: string;
	  }
	| {
			id?: string;
			type: "worker_subscribe";
			activeSessionId: string;
			capabilities?: readonly DaemonClientCapability[];
			supportsExtensionUi?: boolean;
	  }
	| { id?: string; type: "worker_unsubscribe"; activeSessionId: string }
	| { id?: string; type: "worker_sync_agent_peers"; peers: AgentSessionMessageAgentSummary[] }
	| { id?: string; type: "worker_archive_and_shutdown" }
	| {
			id?: string;
			type: "worker_passivate_idle_children";
			idleEvictionMinutes: IdleEvictionMinutes;
			now: number;
			limit: number;
	  }
	| {
			id?: string;
			type: "worker_deliver_message";
			targetActiveSessionId: string;
			message: string;
			sender: AgentSessionMessageSender;
			deliveryMode?: AgentSessionMessageDeliveryMode;
	  }
	| { id?: string; type: "worker_prepare_update" }
	| { id?: string; type: "worker_commit_update" }
	| { id?: string; type: "worker_cancel_update" };

export type DaemonWorkerCommandBody = DaemonWorkerCommand extends infer TCommand
	? TCommand extends { id?: string }
		? Omit<TCommand, "id">
		: never
	: never;

export interface DaemonWorkerDescriptor {
	version: 1;
	workerId: string;
	/**
	 * Process identity for resident workers. Both fields are deliberately absent
	 * only for passivated descriptors in every C01 write. Reader-only legacy or
	 * malformed lifecycle evidence may be processless in memory, but is never
	 * rewritten as a non-passivated C01 descriptor. Legacy fields are accepted
	 * only while reading a non-passivated v1 descriptor; writers never retain
	 * them on a passivation.
	 */
	/** Present only for a resident C01 worker. Legacy pid fields are reader-only. */
	process?: ProcessIdentity;
	/** Fresh UUID for every launch/adoption; legacy records may not have one. */
	generation?: string;
	/** @deprecated reader-only legacy v1 fields; never emitted by C01 writers. */
	pid?: number;
	/** @deprecated reader-only legacy v1 fields; never emitted by C01 writers. */
	processStartId?: string;
	socketPath: string;
	recoveryJournalPath: string;
	orphanProcessJournalPath?: string;
	supervisorSocketPath: string;
	authenticationToken: string;
	rootActiveSessionId: string;
	/** Stable protocol client that owns this worker. Omitted for resident sessions. */
	ownerClientId?: string;
	rootSessionId?: string;
	sessionFile?: string;
	createdAt: string;
	updatedAt: string;
	lifecycle: DaemonWorkerLifecycle;
	createCommand: DaemonCreateCommand;
	consecutiveFailures: number;
	/** Durable intent written before root termination so replacement supervisors never recover it. */
	stopRequestedAt?: string;
	/** Complete the root's archived lifecycle state after its process has stopped. */
	archiveOnStop?: boolean;
	lastFailureAt?: string;
	lastError?: string;
}

/**
 * Reader compatibility stays intentionally broad in DaemonWorkerDescriptor.
 * Every C01 resident/new write instead uses this closed shape: it has a fresh
 * generation and cannot carry the old PID selector fields.
 */
export interface ResidentDaemonWorkerDescriptor
	extends Omit<DaemonWorkerDescriptor, "generation" | "pid" | "processStartId"> {
	/** Every published resident/passivated C01 descriptor has an incarnation. */
	generation: string;
	/** Legacy flat selectors are accepted only by the reader descriptor above. */
	pid?: never;
	processStartId?: never;
}

export function isDaemonWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_WORKER_ROLE_ENV] === "1";
}

export function waitForDaemonWorkerStartupGate(environment: NodeJS.ProcessEnv = process.env): void {
	const rawFd = environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	if (rawFd === undefined) {
		return;
	}
	delete environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	const fd = Number(rawFd);
	if (!Number.isInteger(fd) || fd < 3) {
		throw new Error("Daemon session worker has an invalid startup gate");
	}
	let marker: string;
	try {
		marker = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	if (!marker.startsWith(DAEMON_WORKER_STARTUP_GATE_COMMIT)) {
		throw new Error("Daemon session worker startup was cancelled");
	}
	// The supervisor observes the child start identity before minting this value.
	// Publishing it through the gate prevents the worker from journaling or
	// callback-registration before it has the exact committed incarnation.
	const generation = marker.slice(DAEMON_WORKER_STARTUP_GATE_COMMIT.length).trim();
	if (!generation) throw new Error("Daemon session worker startup omitted its generation");
	environment[DAEMON_WORKER_GENERATION_ENV] = generation;
}

export function requireDaemonWorkerAuthenticationToken(environment: NodeJS.ProcessEnv = process.env): string {
	const token = environment[DAEMON_WORKER_TOKEN_ENV];
	if (!token) {
		throw new Error("Daemon session worker is missing its authentication token");
	}
	return token;
}

export function isDaemonWorkerFrameHeader(value: unknown): value is DaemonWorkerFrameHeader {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "command") {
		return typeof candidate.requestId === "string" && typeof candidate.commandType === "string";
	}
	return (
		candidate.kind === "outbound" &&
		typeof candidate.outboundType === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string") &&
		(candidate.activeSessionId === undefined || typeof candidate.activeSessionId === "string") &&
		(candidate.snapshotId === undefined || typeof candidate.snapshotId === "string") &&
		(candidate.sessionEventType === undefined || typeof candidate.sessionEventType === "string") &&
		(candidate.snapshotPurpose === undefined ||
			candidate.snapshotPurpose === "attach" ||
			candidate.snapshotPurpose === "replacement" ||
			candidate.snapshotPurpose === "catchup") &&
		(candidate.payloadEncoding === undefined ||
			candidate.payloadEncoding === "jsonl" ||
			candidate.payloadEncoding === "assistant-delta")
	);
}
