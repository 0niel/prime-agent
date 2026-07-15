import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import {
	appendRotatingLog,
	getCronJobsPath,
	getDaemonLogPath,
	getDaemonUpdateRestartManifestPath,
	VERSION,
} from "../../config.js";
import type { AgentSessionMessageAgentSummary } from "../../core/agent-messages.js";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import {
	type AgentCronJob,
	AgentCronJobStore,
	migrateLegacyCronJobsToSessionArtifacts,
	SESSION_SCHEDULED_JOBS_FILENAME,
} from "../../core/cron-jobs.js";
import {
	clearOrphanProcessJournal,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
} from "../../core/orphan-process-journal.js";
import { getProcessStartId } from "../../core/session-lease.js";
import type { SessionInfo } from "../../core/session-manager.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type { PrivateFrame } from "../session-worker/private-framing.js";
import { createActiveSessionId, type DaemonSocketClient } from "./active-session-state.js";
import { CommandRecoveryJournal, createCommandIdempotencyKey } from "./command-recovery-journal.js";
import { CompactAssistantStreamReconstructor, isCompactAssistantDelta } from "./compact-session-stream.js";
import { DAEMON_CATALOG_ROLE_ENV, DaemonCatalogClient } from "./daemon-catalog-process.js";
import { deserializeDaemonError, serializeDaemonError } from "./daemon-errors.js";
import {
	collectDaemonClientEnv,
	createDaemonEventMeta,
	DAEMON_DEFAULT_CLIENT_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonClientCapability,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
	type DaemonSavedSessionInfo,
	type DaemonUpdateRestartManifest,
	failure,
	isDaemonCommandEnvelope,
	isDaemonMutatingCommand,
	success,
} from "./daemon-protocol.js";
import { matchesSessionIdSuffix } from "./daemon-session-id.js";
import { type SessionSummary, summaryForInactiveSession } from "./daemon-session-list.js";
import {
	cleanupDaemonSocketPath,
	defaultDaemonSocketDir,
	defaultDaemonSocketPath,
	prepareDaemonSocketPath,
	restrictDaemonSocketPath,
} from "./daemon-socket.js";
import { DaemonWorkerClient } from "./daemon-worker-client.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
	type DaemonCreateCommand,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "./daemon-worker-protocol.js";
import { SNAPSHOT_TARGET_CHUNK_BYTES, SnapshotTranscriptCache } from "./snapshot-transcript-cache.js";
import { WorkerRecoveryJournal } from "./worker-recovery-journal.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;

const structuredLog = getLogger("coding-agent.daemon-supervisor");
const WORKER_CONNECT_TIMEOUT_MS = 30_000;
const WORKER_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const WORKER_RETRY_DELAYS_MS = [250, 1000, 5000] as const;
const SUPERVISOR_CONFIG_FILE_NAME = "supervisor-config";

const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"ack_result",
	"list",
	"list_saved_sessions",
	"create",
	"attach",
	"detach",
	"kill",
	"rename",
	"prompt",
	"steer",
	"follow_up",
	"restore_next_turn",
	"resume_queue",
	"send_message",
	"agent_messages_status",
	"agent_messages_pause",
	"agent_messages_resume",
	"agent_messages_clear",
	"abort",
	"start_side_question",
	"abort_side_question",
	"execute_bash",
	"abort_bash",
	"cancel_rlm_child",
	"wait_for_idle",
	"get_state",
	"get_connection_state",
	"get_messages",
	"get_session_stats",
	"get_context_tree",
	"get_commands",
	"get_resource_snapshot",
	"get_available_models",
	"get_queue",
	"clear_queue",
	"abort_and_clear_queue",
	"cron_list",
	"cron_add",
	"cron_cancel",
	"heartbeat_get",
	"heartbeat_set",
	"heartbeat_update",
	"set_model",
	"cycle_model",
	"set_scoped_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_transport",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"compact",
	"refine",
	"abort_compaction",
	"abort_branch_summary",
	"abort_retry",
	"reload",
	"new_session",
	"switch_session",
	"fork",
	"navigate_tree",
	"import_jsonl",
	"export_html",
	"export_jsonl",
	"set_session_name",
	"rename_saved_session",
	"delete_saved_session",
	"get_session_context",
	"get_session_tree",
	"get_user_messages_for_forking",
	"get_last_assistant_text",
	"get_system_prompt",
	"get_tool_definition",
	"set_session_entry_label",
	"extension_ui_response",
	"prepare_update_restart",
	"retry_worker",
	"restart",
	"shutdown",
]);

interface ResidentWorker {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	client?: DaemonWorkerClient;
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	incomingTranscriptActiveSessionIds: Set<string>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	recovery?: Promise<void>;
	intentionalStop: boolean;
	stopRevision: number;
}

interface DaemonSupervisorOptions {
	socketPath?: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
	descriptorDir?: string;
}

interface PersistedSupervisorConfig {
	version: 1;
	socketPath: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
}

interface WorkerMatch {
	worker: ResidentWorker;
	summary: SessionSummary;
}

interface WorkerAttachData {
	result: DaemonAttachResult;
	worker: ResidentWorker;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function withoutCommandId(command: DaemonCommand): DaemonCommandBody {
	const { id: _id, ...body } = command;
	return body as DaemonCommandBody;
}

function responseWithId(response: DaemonResponse, id: string | undefined): DaemonResponse {
	return { ...response, id };
}

function isSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { id?: unknown; sessionId?: unknown; cwd?: unknown };
	return (
		typeof candidate.id === "string" && typeof candidate.sessionId === "string" && typeof candidate.cwd === "string"
	);
}

function isDaemonWorkerDescriptor(value: unknown, socketPath: string): value is DaemonWorkerDescriptor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const descriptor = value as Partial<DaemonWorkerDescriptor>;
	return (
		descriptor.version === 1 &&
		descriptor.supervisorSocketPath === socketPath &&
		typeof descriptor.workerId === "string" &&
		Number.isInteger(descriptor.pid) &&
		(descriptor.pid ?? 0) > 0 &&
		(descriptor.processStartId === undefined || typeof descriptor.processStartId === "string") &&
		typeof descriptor.socketPath === "string" &&
		typeof descriptor.authenticationToken === "string" &&
		typeof descriptor.rootActiveSessionId === "string" &&
		typeof descriptor.createdAt === "string" &&
		typeof descriptor.updatedAt === "string" &&
		Number.isInteger(descriptor.consecutiveFailures) &&
		descriptor.createCommand !== undefined &&
		typeof descriptor.createCommand === "object" &&
		descriptor.createCommand.type === "create"
	);
}

function sessionSummariesFromResponse(response: DaemonResponse): SessionSummary[] {
	if (!response.success || !response.data || typeof response.data !== "object" || !("sessions" in response.data)) {
		throw new Error("Session worker returned an invalid list response");
	}
	const sessions = (response.data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions) || !sessions.every(isSessionSummary)) {
		throw new Error("Session worker returned an invalid list response");
	}
	return sessions;
}

function attachResultFromResponse(response: DaemonResponse): DaemonAttachResult {
	if (!response.success || !response.data || typeof response.data !== "object") {
		throw new Error(response.success ? "Session worker returned an invalid attach response" : response.error);
	}
	const candidate = response.data as Partial<DaemonAttachResult>;
	if (typeof candidate.activeSessionId !== "string" || !candidate.snapshot || !candidate.client) {
		throw new Error("Session worker returned an invalid attach response");
	}
	return candidate as DaemonAttachResult;
}

function cronJobsFromResponse(response: DaemonResponse): AgentCronJob[] {
	if (!response.success || !response.data || typeof response.data !== "object") {
		return [];
	}
	const jobs = (response.data as { jobs?: unknown }).jobs;
	return Array.isArray(jobs) ? (jobs as AgentCronJob[]) : [];
}

function sortCronJobs(jobs: AgentCronJob[]): AgentCronJob[] {
	return jobs.sort((left, right) => {
		if (left.nextRunAt === right.nextRunAt) {
			return 0;
		}
		if (left.nextRunAt === undefined) {
			return 1;
		}
		if (right.nextRunAt === undefined) {
			return -1;
		}
		return Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt);
	});
}

function serializeSavedSessionInfo(session: SessionInfo): DaemonSavedSessionInfo {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		state: session.state,
		parentSessionPath: session.parentSessionPath,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
		agentStatus: session.agentStatus,
	};
}

function descriptorKey(socketPath: string): string {
	return createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
}

function defaultWorkerDescriptorDir(agentDir: string, socketPath: string): string {
	return join(agentDir, "daemon-workers", descriptorKey(socketPath));
}

function workerSocketPath(supervisorSocketPath: string, workerId: string): string {
	const key = descriptorKey(supervisorSocketPath);
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-worker-${key}-${workerId.slice(0, 12)}`;
	}
	return join(defaultDaemonSocketDir(), `worker-${key}-${workerId.slice(0, 12)}.sock`);
}

function looksLikeSessionPath(selector: string): boolean {
	return isAbsolute(selector) || selector.endsWith(".jsonl") || selector.includes("/") || selector.includes("\\");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// Fall back when process groups are unavailable or the group already exited.
	}
	try {
		process.kill(pid, signal);
	} catch {
		// The process may already be fully reaped.
	}
}

function isFinalizedTranscriptEvent(eventType: string | undefined): boolean {
	return (
		eventType === "message_end" ||
		eventType === "turn_end" ||
		eventType === "compaction_end" ||
		eventType === "bash_end"
	);
}

function normalizeCapabilities(
	capabilities: readonly DaemonClientCapability[] | undefined,
	supportsExtensionUi: boolean | undefined,
): Set<DaemonClientCapability> {
	const normalized = new Set(capabilities ?? DAEMON_DEFAULT_CLIENT_CAPABILITIES);
	if (supportsExtensionUi) {
		normalized.add("extension_ui");
	}
	return normalized;
}

function mergeSessionLists(active: readonly SessionSummary[], saved: readonly SessionInfo[]): SessionSummary[] {
	const activeByFile = new Map<string, SessionSummary>();
	for (const summary of active) {
		if (summary.sessionFile) {
			activeByFile.set(resolve(summary.sessionFile), summary);
		}
	}
	const merged: SessionSummary[] = [];
	const seenActiveIds = new Set<string>();
	for (const session of saved) {
		const resident = activeByFile.get(resolve(session.path));
		if (resident) {
			merged.push({
				...resident,
				created: resident.created ?? session.created.toISOString(),
				modified: resident.modified ?? session.modified.toISOString(),
				firstMessage: resident.firstMessage ?? session.firstMessage,
			});
			seenActiveIds.add(resident.activeSessionId ?? resident.id);
		} else {
			merged.push(summaryForInactiveSession(session));
		}
	}
	for (const summary of active) {
		if (!seenActiveIds.has(summary.activeSessionId ?? summary.id)) {
			merged.push(summary);
		}
	}
	return merged;
}

export async function runDaemonSupervisorMode(options: DaemonSupervisorOptions): Promise<never> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	const supervisor = new DaemonSupervisor(socketPath, options);
	await supervisor.start();
	return new Promise(() => {});
}

export class DaemonSupervisor {
	private server?: Server;
	private readonly ready: Promise<void>;
	private markReady: () => void = () => {};
	private ownsSocketPath = false;
	private shuttingDown = false;
	private readonly clients = new Set<DaemonSocketClient>();
	private readonly workers = new Map<string, ResidentWorker>();
	private readonly openingWorkers = new Map<string, Promise<ResidentWorker>>();
	private readonly signalCleanupHandlers: Array<() => void> = [];
	private readonly descriptorDir: string;
	private readonly generation = randomUUID();
	private readonly supervisorConfigPath: string;
	private readonly defaultSessionConfig: AgentSessionRuntimeConfig;
	private readonly snapshotCacheRoot: string;
	private readonly commandJournal: CommandRecoveryJournal;
	private readonly streamReconstructor = new CompactAssistantStreamReconstructor();
	private readonly compactCatchupInProgress = new Set<string>();
	private agentPeerSyncQueue: Promise<void> = Promise.resolve();
	private readonly catalog: DaemonCatalogClient;

	constructor(
		private readonly socketPath: string,
		options: DaemonSupervisorOptions,
	) {
		this.ready = new Promise<void>((resolveReady) => {
			this.markReady = resolveReady;
		});
		const agentDir = options.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		this.descriptorDir = options.descriptorDir ?? defaultWorkerDescriptorDir(agentDir, socketPath);
		this.supervisorConfigPath = join(this.descriptorDir, SUPERVISOR_CONFIG_FILE_NAME);
		this.defaultSessionConfig = this.loadPersistedSupervisorConfig() ?? options.defaultSessionConfig;
		this.snapshotCacheRoot = join(this.descriptorDir, "snapshot-cache");
		this.commandJournal = new CommandRecoveryJournal(join(this.descriptorDir, "command-journal.jsonl"));
		this.catalog = new DaemonCatalogClient((message) => this.log(message));
	}

	async start(): Promise<void> {
		await prepareDaemonSocketPath(this.socketPath);
		mkdirSync(this.descriptorDir, { recursive: true, mode: 0o700 });
		chmodSync(this.descriptorDir, 0o700);
		this.persistSupervisorConfig();
		rmSync(this.snapshotCacheRoot, { recursive: true, force: true });
		mkdirSync(this.snapshotCacheRoot, { recursive: true, mode: 0o700 });
		this.loadWorkerDescriptors();
		const workersToAdopt = [...this.workers.values()];

		this.server = createServer((socket) => this.handleConnection(socket));
		await new Promise<void>((resolveListen, rejectListen) => {
			const onError = (error: Error) => {
				this.server?.off("listening", onListening);
				rejectListen(error);
			};
			const onListening = () => {
				this.server?.off("error", onError);
				try {
					this.ownsSocketPath = true;
					if (process.platform !== "win32") {
						restrictDaemonSocketPath(this.socketPath);
					}
					resolveListen();
				} catch (error) {
					rejectListen(error);
				}
			};
			this.server?.once("error", onError);
			this.server?.once("listening", onListening);
			this.server?.listen(this.socketPath);
		});

		this.registerSignalHandlers();
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		const ownedSessionFiles = new Set(
			[...this.workers.values()]
				.flatMap((worker) => [worker.descriptor.sessionFile, worker.descriptor.createCommand.sessionPath])
				.filter((path): path is string => typeof path === "string")
				.map((path) => resolve(path)),
		);
		const migratedJobs = migrateLegacyCronJobsToSessionArtifacts(getCronJobsPath(agentDir), {
			isSessionOwned: (job) => ownedSessionFiles.has(resolve(job.sessionFile)),
		});
		if (migratedJobs > 0) {
			this.log(`Migrated ${migratedJobs} scheduled jobs into session artifacts`);
		}
		await this.catalog.start().catch((error) => this.log(`Could not start daemon catalog: ${String(error)}`));
		await Promise.all(workersToAdopt.map((worker) => this.adoptOrRecoverWorker(worker)));
		await this.syncAgentPeers().catch((error) => this.log(`Could not synchronize agent peers: ${String(error)}`));
		this.markReady();
		this.log(`Prime Agent daemon supervisor ${this.generation} listening on ${this.socketPath}`);
	}

	private log(message: string): void {
		console.error(message);
		structuredLog.warn(message, { socketPath: this.socketPath });
		appendRotatingLog(getDaemonLogPath(this.socketPath), `[${new Date().toISOString()}] supervisor: ${message}`);
	}

	private loadWorkerDescriptors(): void {
		for (const name of readdirSync(this.descriptorDir)) {
			if (name === SUPERVISOR_CONFIG_FILE_NAME || !name.endsWith(".json")) {
				continue;
			}
			const path = join(this.descriptorDir, name);
			try {
				const descriptor: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!isDaemonWorkerDescriptor(descriptor, this.socketPath)) {
					continue;
				}
				descriptor.lifecycle = "recovering";
				descriptor.recoveryJournalPath ??= join(this.descriptorDir, `${descriptor.workerId}.recovery.jsonl`);
				descriptor.orphanProcessJournalPath ??= join(this.descriptorDir, `${descriptor.workerId}.orphans.jsonl`);
				this.workers.set(descriptor.workerId, {
					descriptor,
					descriptorPath: path,
					summaries: new Map(),
					snapshotCache: new Map(),
					transcriptCaches: new Map(),
					incomingTranscriptActiveSessionIds: new Set(),
					snapshotLoads: new Map(),
					intentionalStop: descriptor.stopRequestedAt !== undefined,
					stopRevision: 0,
				});
			} catch (error) {
				this.log(`Ignoring invalid worker descriptor ${path}: ${String(error)}`);
			}
		}
	}

	private loadPersistedSupervisorConfig(): AgentSessionRuntimeConfig | undefined {
		try {
			const parsed = JSON.parse(
				readFileSync(this.supervisorConfigPath, "utf8"),
			) as Partial<PersistedSupervisorConfig>;
			if (
				parsed.version !== 1 ||
				parsed.socketPath !== this.socketPath ||
				!parsed.defaultSessionConfig ||
				typeof parsed.defaultSessionConfig !== "object" ||
				typeof parsed.defaultSessionConfig.agentDir !== "string"
			) {
				return undefined;
			}
			return parsed.defaultSessionConfig;
		} catch {
			return undefined;
		}
	}

	private persistSupervisorConfig(): void {
		const persisted: PersistedSupervisorConfig = {
			version: 1,
			socketPath: this.socketPath,
			defaultSessionConfig: this.defaultSessionConfig,
		};
		const tempPath = `${this.supervisorConfigPath}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, this.supervisorConfigPath);
	}

	private hasPersistedWorkerDescriptors(): boolean {
		return readdirSync(this.descriptorDir).some(
			(name) => name !== SUPERVISOR_CONFIG_FILE_NAME && name.endsWith(".json"),
		);
	}

	private persistWorker(worker: ResidentWorker): void {
		worker.descriptor.updatedAt = new Date().toISOString();
		const tempPath = `${worker.descriptorPath}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(worker.descriptor, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, worker.descriptorPath);
	}

	private deleteWorkerDescriptor(worker: ResidentWorker): void {
		try {
			rmSync(worker.descriptorPath, { force: true });
			rmSync(worker.descriptor.recoveryJournalPath, { force: true });
			if (worker.descriptor.orphanProcessJournalPath) {
				rmSync(worker.descriptor.orphanProcessJournalPath, { force: true });
			}
		} catch (error) {
			this.log(`Failed to remove worker descriptor ${worker.descriptorPath}: ${String(error)}`);
		}
	}

	private handleConnection(socket: Socket): void {
		const client: DaemonSocketClient = {
			id: createActiveSessionId(),
			socket,
			attachedActiveSessionIds: new Set(),
			catchupActiveSessionIds: new Set(),
			backpressured: false,
			authenticated: true,
			snapshotActiveSessionIds: new Set(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(DAEMON_DEFAULT_CLIENT_CAPABILITIES),
		};
		this.clients.add(client);
		void this.ready.then(() => {
			if (!client.socket.destroyed && this.clients.has(client)) {
				this.write(client, {
					type: "daemon_hello",
					socketPath: this.socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					appVersion: VERSION,
					supervisorGeneration: this.generation,
					supervisorPid: process.pid,
					clientId: client.id,
					serverCapabilities: [
						"attach_snapshot",
						"event_sequence",
						"extension_ui",
						"slim_attach",
						"chunked_snapshot",
					],
				});
			}
		});

		client.detachInput = attachJsonlLineReader(socket, (line) => void this.handleLine(client, line));
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) {
				return;
			}
			cleaned = true;
			client.detachInput();
			this.clients.delete(client);
			for (const activeSessionId of [...client.attachedActiveSessionIds]) {
				client.attachedActiveSessionIds.delete(activeSessionId);
				void this.syncWorkerExtensionUi(activeSessionId);
			}
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
		socket.on("drain", () => {
			if (!client.snapshotStreaming) {
				void this.catchUpClient(client);
			}
		});
	}

	private async handleLine(client: DaemonSocketClient, line: string): Promise<void> {
		await this.ready;
		let command: DaemonCommand;
		let envelopeClientId: string | undefined;
		try {
			const parsed = JSON.parse(line) as unknown;
			const candidate = isDaemonCommandEnvelope(parsed)
				? { ...parsed.command, id: parsed.id }
				: (parsed as { id?: unknown; type?: unknown });
			if (isDaemonCommandEnvelope(parsed)) {
				envelopeClientId = parsed.clientId ?? client.id;
				client.id = envelopeClientId;
			}
			if (typeof candidate.type !== "string" || !DAEMON_COMMAND_TYPES.has(candidate.type)) {
				const commandName = typeof candidate.type === "string" ? candidate.type : "unknown";
				this.write(
					client,
					failure(
						typeof candidate.id === "string" ? candidate.id : undefined,
						commandName,
						`Unknown daemon command: ${commandName}`,
					),
				);
				return;
			}
			command = candidate as DaemonCommand;
		} catch (error) {
			this.write(client, failure(undefined, "parse", error));
			return;
		}

		const journalIdentity =
			envelopeClientId && command.id && isDaemonMutatingCommand(command)
				? { clientId: envelopeClientId, commandId: command.id }
				: undefined;
		if (journalIdentity) {
			const existing = this.commandJournal.begin(journalIdentity.clientId, journalIdentity.commandId, command.type);
			if (existing.status === "complete") {
				this.write(client, existing.response);
				return;
			}
			if (existing.status === "pending") {
				this.write(
					client,
					failure(command.id, command.type, "The previous command result is uncertain and was not replayed", {
						code: "command_result_uncertain",
						...journalIdentity,
					}),
				);
				return;
			}
		}

		try {
			const response = await this.handleCommand(client, command);
			if (response) {
				if (journalIdentity) {
					this.commandJournal.recordResult(journalIdentity.clientId, journalIdentity.commandId, response);
				}
				this.write(client, response);
			}
		} catch (error) {
			this.log(`Supervisor command ${command.type} failed: ${error instanceof Error ? error.stack : String(error)}`);
			const response = failure(command.id, command.type, error, serializeDaemonError(error));
			if (journalIdentity) {
				this.commandJournal.recordResult(journalIdentity.clientId, journalIdentity.commandId, response);
			}
			this.write(client, response);
		}
	}

	private async handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
	): Promise<DaemonResponse | undefined> {
		switch (command.type) {
			case "ack_result":
				this.commandJournal.acknowledge(client.id, command.commandId);
				return undefined;
			case "list":
				return this.handleList(command);
			case "list_saved_sessions":
				return this.handleSavedSessionList(client, command);
			case "create": {
				const worker = await this.createOrReuseWorker(client.id, command);
				const summary = worker.summaries.get(worker.descriptor.rootActiveSessionId);
				if (!summary) {
					throw new Error("Session worker started without a root session");
				}
				return success(command.id, "create", this.publicSummary(worker, summary));
			}
			case "attach": {
				const attached = await this.attachClient(client, command);
				if (client.capabilities.has("chunked_snapshot")) {
					const transcript = this.getOrCreateTranscriptCache(attached.worker, attached.result);
					const streamedResult = this.createStreamedAttachResult(attached.result, transcript);
					this.write(client, success(command.id, "attach", streamedResult));
					void this.streamSnapshot(client, streamedResult, transcript).catch((error) =>
						this.log(`Failed to stream attach snapshot for ${streamedResult.activeSessionId}: ${String(error)}`),
					);
					return undefined;
				}
				return success(command.id, "attach", attached.result);
			}
			case "detach":
				this.detachClient(client, command.activeSessionId);
				return success(command.id, "detach");
			case "retry_worker": {
				const direct = [...this.workers.values()].find(
					(worker) =>
						worker.descriptor.rootActiveSessionId === command.activeSessionId ||
						worker.descriptor.rootSessionId === command.activeSessionId,
				);
				const worker = direct ?? (await this.findWorker(command.activeSessionId)).worker;
				worker.intentionalStop = false;
				worker.descriptor.lifecycle = "recovering";
				worker.descriptor.consecutiveFailures = 0;
				this.persistWorker(worker);
				await this.recoverWorker(worker);
				if (this.workers.get(worker.descriptor.workerId)?.descriptor.lifecycle !== "ready") {
					throw new Error(worker.descriptor.lastError ?? "Session worker recovery failed");
				}
				const summary = worker.summaries.get(worker.descriptor.rootActiveSessionId);
				return success(command.id, command.type, summary ? this.publicSummary(worker, summary) : undefined);
			}
			case "restart":
				setImmediate(() => void this.shutdown(0, false, true));
				return success(command.id, command.type);
			case "shutdown":
				setImmediate(() => void this.shutdown(0, true, false, command.force === true));
				return success(command.id, "shutdown");
			case "prepare_update_restart": {
				const manifest = await this.prepareUpdateRestart();
				return success(command.id, "prepare_update_restart", manifest);
			}
			case "agent_messages_status": {
				const first = [...this.workers.values()].find((worker) => worker.client);
				if (!first) {
					return success(command.id, command.type, { paused: false, limits: {} });
				}
				return this.forwardToWorker(first, command);
			}
			case "agent_messages_pause":
			case "agent_messages_resume": {
				const responses = await Promise.all(
					[...this.workers.values()]
						.filter((worker) => worker.client)
						.map((worker) => this.forwardToWorker(worker, command)),
				);
				const failed = responses.find((response) => !response.success);
				return failed ?? success(command.id, command.type, responses.find((response) => response.success)?.data);
			}
			case "cron_list": {
				if (command.activeSessionId) {
					const match = await this.findWorker(command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const jobs = new Map<string, AgentCronJob>();
				const responses = await Promise.all(
					[...this.workers.values()]
						.filter((worker) => worker.client && worker.descriptor.lifecycle === "ready")
						.map((worker) =>
							this.forwardToWorker(worker, command, 5000).catch((error: unknown) =>
								failure(command.id, command.type, error, serializeDaemonError(error)),
							),
						),
				);
				for (const response of responses) {
					if (!response.success) {
						this.log(`Could not list scheduled jobs from a worker: ${response.error}`);
						continue;
					}
					for (const job of cronJobsFromResponse(response)) {
						jobs.set(job.id, job);
					}
				}
				return success(command.id, "cron_list", { jobs: sortCronJobs([...jobs.values()]) });
			}
			case "cron_add": {
				const match = await this.findWorker(command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "cron_cancel": {
				const listed = await Promise.all(
					[...this.workers.values()]
						.filter((worker) => worker.client && worker.descriptor.lifecycle === "ready")
						.map(async (worker) => ({
							worker,
							response: await this.forwardToWorker(
								worker,
								{ type: "cron_list", includeInactive: true },
								5000,
							).catch(() => undefined),
						})),
				);
				for (const candidate of listed) {
					if (
						candidate.response?.success &&
						cronJobsFromResponse(candidate.response).some((job) => job.id === command.jobId)
					) {
						return this.forwardToWorker(candidate.worker, command);
					}
				}
				throw new Error(`No cron job found: ${command.jobId}`);
			}
			case "heartbeat_get": {
				const match = await this.findWorker(command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "heartbeat_set": {
				const match = await this.findWorker(command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "heartbeat_update": {
				const match = await this.findWorker(command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "rename_saved_session":
				if (!command.activeSessionId) {
					await this.catalog.rename(command.sessionPath, command.name);
					return success(command.id, command.type);
				}
				break;
			case "delete_saved_session":
				if (!command.activeSessionId) {
					const active = this.findWorkerBySessionFile(command.sessionPath);
					if (active) {
						throw new Error("Cannot delete the currently active session");
					}
					const result = await this.catalog.delete(command.sessionPath);
					return success(command.id, command.type, result);
				}
				break;
		}

		if (command.type === "send_message") {
			const target = await this.findWorker(command.targetActiveSessionId);
			const source = command.fromActiveSessionId ? await this.findWorker(command.fromActiveSessionId) : undefined;
			if (source && source.worker !== target.worker) {
				if (!target.worker.client) {
					throw new Error("Target session worker is not connected");
				}
				const response = await target.worker.client.requestWorker(
					{
						type: "worker_deliver_message",
						targetActiveSessionId: target.summary.activeSessionId ?? target.summary.id,
						message: command.message,
						sender: {
							activeSessionId: source.summary.activeSessionId ?? source.summary.id,
							sessionId: source.summary.sessionId,
							...(source.summary.sessionName ? { sessionName: source.summary.sessionName } : {}),
							runtimeKind: source.summary.runtimeKind ?? "top-level",
							clientId: client.id,
						},
						deliveryMode: command.deliveryMode,
					},
					WORKER_REQUEST_TIMEOUT_MS,
				);
				return { ...response, id: command.id, command: command.type };
			}
			return this.forwardToWorker(target.worker, command);
		}

		if (!("activeSessionId" in command) || typeof command.activeSessionId !== "string") {
			throw new Error(`Supervisor cannot route daemon command: ${command.type}`);
		}
		const match = await this.findWorker(command.activeSessionId);
		const resolvedCommand = {
			...command,
			activeSessionId: match.summary.activeSessionId ?? match.summary.id,
		} as DaemonCommand;
		const isRootKill =
			command.type === "kill" &&
			(match.summary.activeSessionId ?? match.summary.id) === match.worker.descriptor.rootActiveSessionId;
		if (!isRootKill) {
			return this.forwardToWorker(match.worker, resolvedCommand);
		}
		this.persistWorkerStopTombstone(match.worker, true);
		let response: DaemonResponse;
		try {
			response = await this.forwardToWorker(match.worker, resolvedCommand);
		} finally {
			await this.stopWorker(match.worker, true, false, true);
		}
		return response;
	}

	private async handleList(command: Extract<DaemonCommand, { type: "list" }>): Promise<DaemonResponse> {
		await Promise.all(
			[...this.workers.values()].map((worker) => this.refreshWorkerSummaries(worker).catch(() => undefined)),
		);
		await this.syncAgentPeers().catch((error) => this.log(`Could not synchronize agent peers: ${String(error)}`));
		const active = [...this.workers.values()].flatMap((worker) =>
			[...worker.summaries.values()].map((summary) => this.publicSummary(worker, summary)),
		);
		if (!command.all) {
			return success(command.id, "list", { sessions: active });
		}
		const sessionDir = command.sessionDir ?? this.defaultSessionConfig.sessionDir;
		const saved = await this.catalog.list(command.cwd ? resolve(command.cwd) : undefined, sessionDir);
		return success(command.id, "list", { sessions: mergeSessionLists(active, saved) });
	}

	private async handleSavedSessionList(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "list_saved_sessions" }>,
	): Promise<DaemonResponse> {
		let cwd: string;
		let sessionDir: string | undefined;
		let activeSessionId: string | undefined;
		if ("activeSessionId" in command) {
			const match = await this.findWorker(command.activeSessionId);
			cwd = match.summary.cwd;
			sessionDir = this.defaultSessionConfig.sessionDir;
			activeSessionId = match.summary.activeSessionId ?? match.summary.id;
		} else {
			cwd = resolve(command.cwd);
			sessionDir = command.sessionDir;
		}
		const callbacks = command.id
			? {
					onProgress: (loaded: number, total: number) =>
						this.write(client, {
							id: command.id,
							type: "session_list_progress",
							command: "list_saved_sessions",
							...(activeSessionId ? { activeSessionId } : {}),
							loaded,
							total,
						}),
					onSession: (session: SessionInfo) =>
						this.write(client, {
							id: command.id,
							type: "session_list_item",
							command: "list_saved_sessions",
							...(activeSessionId ? { activeSessionId } : {}),
							session: serializeSavedSessionInfo(session),
						}),
				}
			: undefined;
		const saved = await this.catalog.list(command.scope === "current" ? cwd : undefined, sessionDir, callbacks);
		return success(command.id, "list_saved_sessions", { sessions: saved.map(serializeSavedSessionInfo) });
	}

	private async createOrReuseWorker(clientId: string, command: DaemonCreateCommand): Promise<ResidentWorker> {
		let createCommand = command;
		if (command.sessionPath) {
			const activeMatches = this.matchWorkers(command.sessionPath);
			if (activeMatches.length === 1) {
				return activeMatches[0]!.worker;
			}
			if (activeMatches.length > 1) {
				throw new Error(`Ambiguous active session "${command.sessionPath}"`);
			}
			const config = mergeAgentSessionRuntimeConfig(this.defaultSessionConfig, command.config);
			const sessionPath = looksLikeSessionPath(command.sessionPath)
				? resolve(command.sessionPath)
				: await this.catalog.resolve(command.sessionPath, config.cwd ?? process.cwd(), config.sessionDir);
			createCommand = { ...command, sessionPath };
			const existing = this.findWorkerBySessionFile(sessionPath);
			if (existing) {
				return existing.worker;
			}
		}
		const key = createCommand.sessionPath
			? resolve(createCommand.sessionPath)
			: `new:${command.id ? createCommandIdempotencyKey(clientId, command.id) : createActiveSessionId()}`;
		const pending = this.openingWorkers.get(key);
		if (pending) {
			return pending;
		}
		const opening = this.launchWorker(createCommand);
		this.openingWorkers.set(key, opening);
		try {
			return await opening;
		} finally {
			if (this.openingWorkers.get(key) === opening) {
				this.openingWorkers.delete(key);
			}
		}
	}

	private async launchWorker(command: DaemonCreateCommand, existing?: ResidentWorker): Promise<ResidentWorker> {
		if (existing && this.isWorkerRecoveryCancelled(existing)) {
			throw new Error(`Session worker ${existing.descriptor.workerId} recovery was cancelled`);
		}
		const recoveryStopRevision = existing?.stopRevision;
		const createCommand: DaemonCreateCommand = {
			...command,
			config: mergeAgentSessionRuntimeConfig(this.defaultSessionConfig, command.config),
		};
		const workerId = existing?.descriptor.workerId ?? createActiveSessionId();
		const rootActiveSessionId = existing?.descriptor.rootActiveSessionId ?? createActiveSessionId();
		const socketPath = existing?.descriptor.socketPath ?? workerSocketPath(this.socketPath, workerId);
		const token = existing?.descriptor.authenticationToken ?? randomBytes(32).toString("base64url");
		const now = new Date().toISOString();
		const descriptorPath = existing?.descriptorPath ?? join(this.descriptorDir, `${workerId}.json`);
		const recoveryJournalPath =
			existing?.descriptor.recoveryJournalPath ?? join(this.descriptorDir, `${workerId}.recovery.jsonl`);
		const orphanProcessJournalPath =
			existing?.descriptor.orphanProcessJournalPath ?? join(this.descriptorDir, `${workerId}.orphans.jsonl`);
		const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", socketPath]);
		const child: ChildProcess = spawn(launch.command, launch.args, {
			cwd: createCommand.config?.cwd ?? process.cwd(),
			detached: true,
			env: {
				...process.env,
				[DAEMON_WORKER_ROLE_ENV]: "1",
				[DAEMON_WORKER_TOKEN_ENV]: token,
				[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: rootActiveSessionId,
				[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: this.socketPath,
				[DAEMON_WORKER_RECOVERY_JOURNAL_ENV]: recoveryJournalPath,
				[ORPHAN_PROCESS_JOURNAL_ENV]: orphanProcessJournalPath,
				[SESSION_LEASES_ENABLED_ENV]: "1",
				[SESSION_LEASE_OWNER_ID_ENV]: rootActiveSessionId,
			},
			stdio: "ignore",
		});
		child.on("error", (error) => {
			this.log(
				`Session worker ${workerId} process error: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		if (!child.pid) {
			throw new Error("Failed to obtain daemon session worker pid");
		}
		const childProcessStartId = getProcessStartId(child.pid);
		child.unref();

		const descriptor: DaemonWorkerDescriptor = {
			version: 1,
			workerId,
			pid: child.pid,
			...(childProcessStartId ? { processStartId: childProcessStartId } : {}),
			socketPath,
			recoveryJournalPath,
			orphanProcessJournalPath,
			supervisorSocketPath: this.socketPath,
			authenticationToken: token,
			rootActiveSessionId,
			createdAt: existing?.descriptor.createdAt ?? now,
			updatedAt: now,
			lifecycle: "starting",
			createCommand: { ...createCommand, id: undefined },
			consecutiveFailures: existing?.descriptor.consecutiveFailures ?? 0,
		};
		const worker = existing ?? {
			descriptor,
			descriptorPath,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		worker.descriptor = descriptor;
		worker.intentionalStop = false;
		this.workers.set(workerId, worker);
		this.persistWorker(worker);

		try {
			const client = await this.connectWorker(worker, WORKER_CONNECT_TIMEOUT_MS);
			const response = await client.request(withoutCommandId(createCommand), WORKER_REQUEST_TIMEOUT_MS);
			if (!response.success) {
				throw deserializeDaemonError(response);
			}
			if (!isSessionSummary(response.data)) {
				throw new Error("Session worker returned an invalid create response");
			}
			const summary = response.data;
			if ((summary.activeSessionId ?? summary.id) !== rootActiveSessionId) {
				throw new Error("Session worker did not preserve its assigned active session id");
			}
			worker.summaries.set(rootActiveSessionId, summary);
			worker.descriptor.rootSessionId = summary.sessionId;
			worker.descriptor.sessionFile = summary.sessionFile;
			await this.subscribeWorker(worker, rootActiveSessionId);
			await this.refreshWorkerSummaries(worker);
			if (existing && (this.isWorkerRecoveryCancelled(worker) || worker.stopRevision !== recoveryStopRevision)) {
				throw new Error(`Session worker ${workerId} recovery was cancelled`);
			}
			worker.descriptor.lifecycle = "ready";
			worker.descriptor.consecutiveFailures = 0;
			worker.descriptor.lastError = undefined;
			this.persistWorker(worker);
			await this.syncAgentPeers();
			return worker;
		} catch (error) {
			const shouldResumeRecovery =
				existing !== undefined &&
				!this.shuttingDown &&
				worker.descriptor.stopRequestedAt === undefined &&
				worker.stopRevision === recoveryStopRevision;
			await this.stopWorker(worker, existing === undefined, true, false, existing !== undefined).catch((stopError) =>
				this.log(`Could not stop failed worker ${workerId}: ${String(stopError)}`),
			);
			if (
				shouldResumeRecovery &&
				!this.shuttingDown &&
				worker.descriptor.stopRequestedAt === undefined &&
				worker.stopRevision === recoveryStopRevision
			) {
				worker.intentionalStop = false;
				worker.descriptor.lifecycle = "recovering";
				this.workers.set(workerId, worker);
				this.persistWorker(worker);
			}
			throw error;
		}
	}

	private async connectWorker(worker: ResidentWorker, timeoutMs: number): Promise<DaemonWorkerClient> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			const client = new DaemonWorkerClient(worker.descriptor.socketPath);
			try {
				await client.connect(Math.min(500, Math.max(50, deadline - Date.now())));
				await client.waitForHello(1000);
				await client.authenticateWorker(worker.descriptor.authenticationToken, 1000);
				client.onFrame((frame) => this.handleWorkerFrame(worker, frame));
				client.onClose((error) => this.handleWorkerClose(worker, client, error));
				worker.client?.close();
				worker.client = client;
				return client;
			} catch (error) {
				lastError = error;
				client.close();
				await delay(25);
			}
		}
		throw new Error(`Timed out connecting to daemon session worker: ${String(lastError)}`);
	}

	private async subscribeWorker(worker: ResidentWorker, activeSessionId: string): Promise<void> {
		if (!worker.client) {
			throw new Error("Session worker is not connected");
		}
		const supportsExtensionUi = [...this.clients].some(
			(client) => client.attachedActiveSessionIds.has(activeSessionId) && client.supportsExtensionUi,
		);
		const response = await worker.client.requestWorker({
			type: "worker_subscribe",
			activeSessionId,
			capabilities: supportsExtensionUi
				? ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"]
				: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			supportsExtensionUi,
		});
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	private async adoptOrRecoverWorker(worker: ResidentWorker): Promise<void> {
		if (worker.descriptor.stopRequestedAt) {
			try {
				// A tombstoned worker must not run long enough to elect another
				// supervisor while its intentional stop is being adopted.
				signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL");
				await this.stopWorker(worker, true, true, worker.descriptor.archiveOnStop === true);
				this.log(`Completed intentional stop for worker ${worker.descriptor.workerId} during supervisor adoption`);
			} catch (error) {
				worker.descriptor.lifecycle = "failed";
				worker.descriptor.lastError = error instanceof Error ? error.message : String(error);
				this.persistWorker(worker);
				this.log(`Could not complete intentional stop for worker ${worker.descriptor.workerId}: ${String(error)}`);
			}
			return;
		}
		try {
			if (!isProcessAlive(worker.descriptor.pid)) {
				throw new Error("Session worker process is no longer running");
			}
			const observedProcessStartId = getProcessStartId(worker.descriptor.pid);
			await this.connectWorker(worker, 2000);
			await this.subscribeWorker(worker, worker.descriptor.rootActiveSessionId);
			await this.refreshWorkerSummaries(worker);
			if (worker.descriptor.processStartId === undefined && observedProcessStartId) {
				worker.descriptor.processStartId = observedProcessStartId;
			}
			worker.descriptor.lifecycle = "ready";
			worker.descriptor.consecutiveFailures = 0;
			this.persistWorker(worker);
		} catch (error) {
			this.log(`Could not adopt worker ${worker.descriptor.workerId}: ${String(error)}`);
			await this.recoverWorker(worker);
		}
	}

	private handleWorkerClose(worker: ResidentWorker, client: DaemonWorkerClient, error: Error): void {
		if (worker.client !== client) {
			return;
		}
		worker.client = undefined;
		for (const activeSessionId of worker.incomingTranscriptActiveSessionIds) {
			worker.transcriptCaches
				.get(activeSessionId)
				?.markFailed(new Error("Session worker disconnected during snapshot transfer"));
		}
		worker.incomingTranscriptActiveSessionIds.clear();
		if (this.shuttingDown || worker.intentionalStop) {
			return;
		}
		worker.descriptor.lifecycle = "recovering";
		worker.descriptor.lastError = error.message;
		this.persistWorker(worker);
		void this.syncAgentPeers().catch(() => undefined);
		void this.recoverWorker(worker);
	}

	private async recoverWorker(worker: ResidentWorker): Promise<void> {
		if (this.isWorkerRecoveryCancelled(worker)) {
			return;
		}
		if (worker.recovery) {
			return worker.recovery;
		}
		worker.recovery = (async () => {
			for (const [retryIndex, retryDelay] of WORKER_RETRY_DELAYS_MS.entries()) {
				await delay(retryDelay);
				if (this.isWorkerRecoveryCancelled(worker)) {
					return;
				}
				try {
					const processAlive = isProcessAlive(worker.descriptor.pid);
					const observedProcessStartId = processAlive ? getProcessStartId(worker.descriptor.pid) : undefined;
					const processIdentityMatches =
						worker.descriptor.processStartId === undefined ||
						observedProcessStartId === worker.descriptor.processStartId;
					if (processAlive && processIdentityMatches) {
						try {
							await this.connectWorker(worker, 1500);
							await this.subscribeWorker(worker, worker.descriptor.rootActiveSessionId);
							await this.refreshWorkerSummaries(worker);
							if (this.isWorkerRecoveryCancelled(worker)) {
								return;
							}
							if (worker.descriptor.processStartId === undefined && observedProcessStartId) {
								worker.descriptor.processStartId = observedProcessStartId;
							}
							worker.descriptor.lifecycle = "ready";
							worker.descriptor.consecutiveFailures = 0;
							this.persistWorker(worker);
							await this.syncAgentPeers().catch((error) =>
								this.log(`Could not synchronize agent peers after worker recovery: ${String(error)}`),
							);
							return;
						} catch (error) {
							worker.client?.close();
							worker.client = undefined;
							if (retryIndex < WORKER_RETRY_DELAYS_MS.length - 1) {
								throw error;
							}
						}
					}
					if (
						processAlive &&
						(worker.descriptor.processStartId === undefined || observedProcessStartId === undefined)
					) {
						throw new Error(
							`Cannot safely replace live session worker ${worker.descriptor.workerId} without a verified process identity`,
						);
					}
					const safeToKillWorkerProcess =
						processAlive && processIdentityMatches && worker.descriptor.processStartId !== undefined;
					await this.recoverUncertainWorkerOperations(worker, safeToKillWorkerProcess);
					if (this.isWorkerRecoveryCancelled(worker)) {
						return;
					}
					await this.launchWorker(worker.descriptor.createCommand, worker);
					return;
				} catch (error) {
					if (this.isWorkerRecoveryCancelled(worker)) {
						return;
					}
					worker.client?.close();
					worker.client = undefined;
					worker.descriptor.consecutiveFailures++;
					worker.descriptor.lastFailureAt = new Date().toISOString();
					worker.descriptor.lastError = error instanceof Error ? error.message : String(error);
					this.persistWorker(worker);
				}
			}
			worker.descriptor.lifecycle = "failed";
			this.persistWorker(worker);
			await this.syncAgentPeers().catch(() => undefined);
			this.log(`Worker ${worker.descriptor.workerId} failed after three recovery attempts`);
		})().finally(() => {
			worker.recovery = undefined;
		});
		return worker.recovery;
	}

	private isWorkerRecoveryCancelled(worker: ResidentWorker): boolean {
		return (
			this.shuttingDown ||
			worker.intentionalStop ||
			worker.descriptor.stopRequestedAt !== undefined ||
			this.workers.get(worker.descriptor.workerId) !== worker
		);
	}

	private async recoverUncertainWorkerOperations(worker: ResidentWorker, killWorkerProcess = true): Promise<void> {
		if (killWorkerProcess) {
			signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL");
		}
		const orphanProcessJournalPath = worker.descriptor.orphanProcessJournalPath;
		if (orphanProcessJournalPath) {
			try {
				for (const orphan of readActiveOrphanProcesses(orphanProcessJournalPath, worker.descriptor.pid)) {
					if (!isOrphanProcessIdentityCurrent(orphan)) {
						continue;
					}
					const { pid } = orphan;
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// The detached resource may already have exited.
						}
					}
				}
				clearOrphanProcessJournal(orphanProcessJournalPath);
			} catch (error) {
				this.log(`Could not reap orphaned worker resources: ${String(error)}`);
			}
		}
		const journal = new WorkerRecoveryJournal(worker.descriptor.recoveryJournalPath);
		const latest = journal.getLatest();
		const uncertain = latest.filter((record) => record.busy);
		if (uncertain.length === 0) {
			return;
		}
		const interruptedSessions = new Map<
			string,
			{ activeSessionId: string; sessionFile: string; operations: Set<string> }
		>();
		for (const record of uncertain) {
			const sessionFile =
				record.sessionFile ??
				(record.activeSessionId === worker.descriptor.rootActiveSessionId
					? worker.descriptor.sessionFile
					: undefined);
			if (!sessionFile) {
				continue;
			}
			const key = `${record.activeSessionId}\0${sessionFile}`;
			let interrupted = interruptedSessions.get(key);
			if (!interrupted) {
				interrupted = { activeSessionId: record.activeSessionId, sessionFile, operations: new Set() };
				interruptedSessions.set(key, interrupted);
			}
			interrupted.operations.add(record.operation);
		}
		await Promise.all(
			[...interruptedSessions.values()].map((interrupted) =>
				this.catalog.markInterrupted(interrupted.sessionFile, interrupted.activeSessionId, [
					...interrupted.operations,
				]),
			),
		);
		for (const record of latest) {
			journal.record({
				activeSessionId: record.activeSessionId,
				sessionId: record.sessionId,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				busy: false,
				operation: "recovery_hold",
			});
		}
		this.log(
			`Recovered worker ${worker.descriptor.workerId} without replaying uncertain operations: ${uncertain
				.map((record) => record.operation)
				.join(", ")}`,
		);
	}

	private async refreshWorkerSummaries(worker: ResidentWorker): Promise<void> {
		if (!worker.client) {
			throw new Error("Session worker is not connected");
		}
		const response = await worker.client.request({ type: "list" }, 5000);
		const summaries = sessionSummariesFromResponse(response);
		worker.summaries = new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary]));
		for (const summary of summaries) {
			const activeSessionId = summary.activeSessionId ?? summary.id;
			if (summary.streamingMessage?.role === "assistant") {
				this.streamReconstructor.seed(activeSessionId, summary.streamingMessage);
			} else if (!summary.isStreaming) {
				this.streamReconstructor.clear(activeSessionId);
			}
		}
		const root = worker.summaries.get(worker.descriptor.rootActiveSessionId);
		if (root) {
			worker.descriptor.rootSessionId = root.sessionId;
			worker.descriptor.sessionFile = root.sessionFile;
			worker.descriptor.createCommand = {
				...worker.descriptor.createCommand,
				sessionPath: root.sessionFile,
				continueRecent: false,
				config: {
					...worker.descriptor.createCommand.config,
					cwd: root.cwd,
				},
			};
			this.persistWorker(worker);
		}
	}

	private syncAgentPeers(): Promise<void> {
		const sync = this.agentPeerSyncQueue
			.catch(() => undefined)
			.then(async () => {
				const readyWorkers = [...this.workers.values()].filter(
					(worker): worker is ResidentWorker & { client: DaemonWorkerClient } =>
						worker.descriptor.lifecycle === "ready" && worker.client !== undefined,
				);
				await Promise.all(
					readyWorkers.map(async (worker) => {
						const peers = readyWorkers
							.filter((candidate) => candidate !== worker)
							.flatMap((candidate) =>
								[...candidate.summaries.values()].map((summary) => this.agentPeerSummary(summary)),
							);
						const response = await worker.client.requestWorker({ type: "worker_sync_agent_peers", peers }, 5000);
						if (!response.success) {
							throw new Error(response.error);
						}
					}),
				);
			});
		this.agentPeerSyncQueue = sync;
		return sync;
	}

	private agentPeerSummary(summary: SessionSummary): AgentSessionMessageAgentSummary {
		return {
			activeSessionId: summary.activeSessionId ?? summary.id,
			sessionId: summary.sessionId,
			...(summary.sessionName ? { sessionName: summary.sessionName } : {}),
			runtimeKind: summary.runtimeKind ?? "top-level",
			cwd: summary.cwd,
			isStreaming: summary.isStreaming,
			pendingMessageCount: summary.pendingMessageCount,
			...(summary.parentActiveSessionId ? { parentActiveSessionId: summary.parentActiveSessionId } : {}),
			...(summary.rlmChildId ? { rlmChildId: summary.rlmChildId } : {}),
		};
	}

	private publicSummary(worker: ResidentWorker, summary: SessionSummary): SessionSummary {
		const activeSessionId = summary.activeSessionId ?? summary.id;
		return {
			...summary,
			attachedClients: [...this.clients].filter((client) => client.attachedActiveSessionIds.has(activeSessionId))
				.length,
			workerState: worker.descriptor.lifecycle,
			workerPid: worker.descriptor.pid,
		};
	}

	private async findWorker(selector: string): Promise<WorkerMatch> {
		let matches = this.matchWorkers(selector);
		if (matches.length === 0) {
			await Promise.all(
				[...this.workers.values()].map((worker) => this.refreshWorkerSummaries(worker).catch(() => undefined)),
			);
			matches = this.matchWorkers(selector);
		}
		if (matches.length === 1) {
			return matches[0]!;
		}
		if (matches.length > 1) {
			throw new Error(`Ambiguous active session "${selector}"`);
		}
		throw new Error(`Unknown active session: ${selector}`);
	}

	private matchWorkers(selector: string): WorkerMatch[] {
		const exact: WorkerMatch[] = [];
		const suffix: WorkerMatch[] = [];
		for (const worker of this.workers.values()) {
			for (const summary of worker.summaries.values()) {
				const activeSessionId = summary.activeSessionId ?? summary.id;
				const match = { worker, summary };
				if (activeSessionId === selector || summary.sessionId === selector || summary.sessionName === selector) {
					exact.push(match);
				} else if (
					matchesSessionIdSuffix(activeSessionId, selector) ||
					matchesSessionIdSuffix(summary.sessionId, selector)
				) {
					suffix.push(match);
				}
			}
		}
		return exact.length > 0 ? exact : suffix;
	}

	private findWorkerBySessionFile(sessionFile: string): WorkerMatch | undefined {
		const target = resolve(sessionFile);
		for (const worker of this.workers.values()) {
			for (const summary of worker.summaries.values()) {
				if (summary.sessionFile && resolve(summary.sessionFile) === target) {
					return { worker, summary };
				}
			}
		}
		return undefined;
	}

	private async forwardToWorker(
		worker: ResidentWorker,
		command: DaemonCommand,
		timeoutMs = WORKER_REQUEST_TIMEOUT_MS,
	): Promise<DaemonResponse> {
		if (!worker.client || worker.descriptor.lifecycle !== "ready") {
			throw new Error(`Session worker is ${worker.descriptor.lifecycle}`);
		}
		const response = await worker.client.request(withoutCommandId(command), timeoutMs);
		if (command.type === "get_state" && response.success && isSessionSummary(response.data)) {
			return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
		}
		if (command.type === "rename" && response.success && isSessionSummary(response.data)) {
			await this.refreshWorkerSummaries(worker);
			return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
		}
		return responseWithId(response, command.id);
	}

	private async attachClient(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "attach" }>,
	): Promise<WorkerAttachData> {
		const match = await this.findWorker(command.activeSessionId);
		const activeSessionId = match.summary.activeSessionId ?? match.summary.id;
		if (command.clientId) {
			client.id = command.clientId;
		}
		client.capabilities = normalizeCapabilities(command.capabilities, command.supportsExtensionUi);
		client.supportsExtensionUi = client.capabilities.has("extension_ui");

		let result = match.worker.snapshotCache.get(activeSessionId);
		if (
			result &&
			!client.capabilities.has("chunked_snapshot") &&
			result.snapshot.messages.length < result.snapshot.summary.messageCount
		) {
			result = undefined;
		}
		if (!result) {
			const snapshotLoadKey = `${activeSessionId}:${client.capabilities.has("chunked_snapshot") ? "chunked" : "full"}`;
			let loading = match.worker.snapshotLoads.get(snapshotLoadKey);
			if (!loading) {
				loading = (async () => {
					if (!match.worker.client) {
						throw new Error("Session worker is not connected");
					}
					const response = await match.worker.client.request({
						type: "attach",
						activeSessionId,
						capabilities: client.capabilities.has("chunked_snapshot")
							? ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"]
							: ["attach_snapshot", "event_sequence", "slim_attach"],
						supportsExtensionUi: false,
						env: command.env ?? collectDaemonClientEnv(),
					});
					const loaded = attachResultFromResponse(response);
					if (loaded.snapshotStream) {
						let transcript = match.worker.transcriptCaches.get(activeSessionId);
						if (transcript && transcript.snapshotId !== loaded.snapshotStream.id) {
							transcript.dispose();
							transcript = undefined;
						}
						if (!transcript) {
							transcript = new SnapshotTranscriptCache({
								activeSessionId,
								snapshotId: loaded.snapshotStream.id,
								cacheRoot: this.snapshotCacheRoot,
								targetChunkBytes: loaded.snapshotStream.targetChunkBytes,
							});
							match.worker.transcriptCaches.set(activeSessionId, transcript);
						}
						match.worker.incomingTranscriptActiveSessionIds.add(activeSessionId);
					}
					match.worker.snapshotCache.set(activeSessionId, loaded);
					return loaded;
				})().finally(() => {
					match.worker.snapshotLoads.delete(snapshotLoadKey);
				});
				match.worker.snapshotLoads.set(snapshotLoadKey, loading);
			}
			result = await loading;
		}
		client.attachedActiveSessionIds.add(activeSessionId);
		try {
			const publicSummary = this.publicSummary(match.worker, result.snapshot.summary);
			if (publicSummary.streamingMessage?.role === "assistant") {
				this.streamReconstructor.seed(activeSessionId, publicSummary.streamingMessage);
			} else {
				for (let index = result.snapshot.messages.length - 1; index >= 0; index--) {
					const latestMessage = result.snapshot.messages[index];
					if (latestMessage?.role === "assistant") {
						this.streamReconstructor.seed(activeSessionId, latestMessage);
						break;
					}
				}
			}
			const publicResult: DaemonAttachResult = {
				...result,
				state: result.state ? publicSummary : undefined,
				snapshot: { ...result.snapshot, summary: publicSummary },
				client: { id: client.id, capabilities: [...client.capabilities] },
			};
			if (publicResult.state && publicResult.messages) {
				this.write(client, {
					type: "session_attached",
					activeSessionId,
					state: publicResult.state,
					messages: publicResult.messages,
					snapshot: publicResult.snapshot,
					replay: publicResult.replay,
					lastEventSequence: publicResult.lastEventSequence,
				});
			}
			await this.syncWorkerExtensionUi(activeSessionId);
			return { result: publicResult, worker: match.worker };
		} catch (error) {
			client.attachedActiveSessionIds.delete(activeSessionId);
			throw error;
		}
	}

	private getOrCreateTranscriptCache(worker: ResidentWorker, result: DaemonAttachResult): SnapshotTranscriptCache {
		const activeSessionId = result.activeSessionId;
		const existing = worker.transcriptCaches.get(activeSessionId);
		if (existing) {
			return existing;
		}
		if (result.snapshot.messages.length < result.snapshot.summary.messageCount) {
			throw new Error("Session worker returned snapshot metadata without a transcript cache");
		}
		const revision = createHash("sha256")
			.update(
				`${activeSessionId}:${result.snapshot.summary.sessionId}:${result.lastEventSequence}:${result.snapshot.messages.length}`,
			)
			.digest("hex")
			.slice(0, 16);
		const transcript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: `${activeSessionId}-${revision}`,
			messages: result.snapshot.messages,
			cacheRoot: this.snapshotCacheRoot,
			targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
		});
		worker.transcriptCaches.set(activeSessionId, transcript);
		worker.snapshotCache.set(activeSessionId, {
			...result,
			messages: result.messages ? [] : undefined,
			snapshot: { ...result.snapshot, messages: [] },
		});
		return transcript;
	}

	private createStreamedAttachResult(
		result: DaemonAttachResult,
		transcript: SnapshotTranscriptCache,
	): DaemonAttachResult {
		return {
			...result,
			messages: result.messages ? [] : undefined,
			snapshot: { ...result.snapshot, messages: [] },
			snapshotStream: {
				id: transcript.snapshotId,
				messageCount: result.snapshot.summary.messageCount,
				targetChunkBytes: transcript.targetChunkBytes,
			},
		};
	}

	private async streamSnapshot(
		client: DaemonSocketClient,
		result: DaemonAttachResult,
		transcript: SnapshotTranscriptCache,
		purpose: "attach" | "replacement" | "resync" = "attach",
	): Promise<void> {
		const stream = result.snapshotStream;
		if (!stream || client.socket.destroyed) {
			return;
		}
		const releaseTranscript = transcript.retain();
		client.snapshotStreaming = true;
		if (!client.snapshotActiveSessionIds) {
			client.snapshotActiveSessionIds = new Set();
		}
		client.snapshotActiveSessionIds.add(result.activeSessionId);
		const { messages: _messages, ...snapshotHeader } = result.snapshot;
		try {
			if (
				!(await this.writeSnapshotRecord(client, {
					type: "session_snapshot_begin",
					activeSessionId: result.activeSessionId,
					snapshotId: stream.id,
					snapshot: snapshotHeader,
					messageCount: stream.messageCount,
					targetChunkBytes: stream.targetChunkBytes,
					purpose,
				}))
			) {
				return;
			}
			let chunkCount = 0;
			while (true) {
				const chunk = await transcript.waitForChunk(chunkCount);
				if (!chunk) {
					break;
				}
				if (!(await this.writeSnapshotBuffer(client, chunk))) {
					return;
				}
				chunkCount++;
			}
			await this.writeSnapshotRecord(client, {
				type: "session_snapshot_end",
				activeSessionId: result.activeSessionId,
				snapshotId: stream.id,
				chunkCount,
				lastEventSequence: result.lastEventSequence,
				lastEventCursor: result.lastEventCursor,
			});
		} finally {
			client.snapshotActiveSessionIds?.delete(result.activeSessionId);
			client.snapshotStreaming = (client.snapshotActiveSessionIds?.size ?? 0) > 0;
			if (!client.snapshotStreaming) {
				client.backpressured = false;
			}
			releaseTranscript();
			if (!client.snapshotStreaming && client.catchupActiveSessionIds?.size) {
				void this.catchUpClient(client);
			}
		}
	}

	private writeSnapshotRecord(client: DaemonSocketClient, message: DaemonOutbound): Promise<boolean> {
		return this.writeSnapshotBuffer(client, Buffer.from(serializeJsonLine(message)));
	}

	private async writeSnapshotBuffer(client: DaemonSocketClient, buffer: Uint8Array): Promise<boolean> {
		if (client.socket.destroyed) {
			return false;
		}
		if (this.writeSerialized(client, buffer)) {
			return true;
		}
		return new Promise<boolean>((resolveDrain) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				client.socket.off("drain", onDrain);
				client.socket.off("close", onClose);
				client.socket.off("error", onClose);
				resolveDrain(value);
			};
			const onDrain = () => finish(true);
			const onClose = () => finish(false);
			client.socket.once("drain", onDrain);
			client.socket.once("close", onClose);
			client.socket.once("error", onClose);
		});
	}

	private detachClient(client: DaemonSocketClient, activeSessionId?: string): void {
		const targets = activeSessionId ? [activeSessionId] : [...client.attachedActiveSessionIds];
		for (const selector of targets) {
			const match = this.matchWorkers(selector)[0];
			const resolvedId = match ? (match.summary.activeSessionId ?? match.summary.id) : selector;
			if (!client.attachedActiveSessionIds.delete(resolvedId)) {
				continue;
			}
			this.write(client, { type: "session_detached", activeSessionId: resolvedId });
			void this.syncWorkerExtensionUi(resolvedId);
		}
	}

	private async syncWorkerExtensionUi(activeSessionId: string): Promise<void> {
		const match = this.matchWorkers(activeSessionId)[0];
		if (!match?.worker.client) {
			return;
		}
		await this.subscribeWorker(match.worker, match.summary.activeSessionId ?? match.summary.id).catch(
			() => undefined,
		);
	}

	private handleWorkerFrame(worker: ResidentWorker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void {
		if (frame.header.kind !== "outbound") {
			return;
		}
		const { outboundType, activeSessionId, sessionEventType, payloadEncoding, snapshotPurpose } = frame.header;
		if (outboundType === "session_snapshot_begin" && activeSessionId) {
			try {
				const begin = JSON.parse(frame.payload.toString("utf8")) as Extract<
					DaemonOutbound,
					{ type: "session_snapshot_begin" }
				>;
				if (
					begin.type !== "session_snapshot_begin" ||
					begin.activeSessionId !== activeSessionId ||
					typeof begin.snapshotId !== "string" ||
					typeof begin.targetChunkBytes !== "number" ||
					!begin.snapshot ||
					!isSessionSummary(begin.snapshot.summary)
				) {
					throw new Error("Worker returned an invalid snapshot begin frame");
				}
				const existing = worker.transcriptCaches.get(activeSessionId);
				let transcript = existing;
				if (!existing || existing.snapshotId !== begin.snapshotId) {
					existing?.dispose();
					transcript = new SnapshotTranscriptCache({
						activeSessionId,
						snapshotId: begin.snapshotId,
						cacheRoot: this.snapshotCacheRoot,
						targetChunkBytes: begin.targetChunkBytes,
					});
					worker.transcriptCaches.set(activeSessionId, transcript);
				}
				if (!transcript) {
					throw new Error("Worker snapshot cache could not be initialized");
				}
				const publicSummary = this.publicSummary(worker, begin.snapshot.summary);
				const snapshot = {
					...begin.snapshot,
					summary: publicSummary,
					messages: [],
				};
				const result: DaemonAttachResult = {
					protocol: DAEMON_PROTOCOL_INFO,
					activeSessionId,
					snapshot,
					replay: {
						status: "complete",
						toSequence: snapshot.lastEventSequence,
						...(snapshot.lastEventCursor ? { toCursor: snapshot.lastEventCursor } : {}),
					},
					lastEventSequence: snapshot.lastEventSequence,
					...(snapshot.lastEventCursor ? { lastEventCursor: snapshot.lastEventCursor } : {}),
					snapshotStream: {
						id: begin.snapshotId,
						messageCount: begin.messageCount,
						targetChunkBytes: begin.targetChunkBytes,
					},
					client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
				};
				worker.snapshotCache.set(activeSessionId, result);
				worker.incomingTranscriptActiveSessionIds.add(activeSessionId);
				if (snapshotPurpose === "replacement") {
					for (const client of this.clients) {
						if (
							!client.attachedActiveSessionIds.has(activeSessionId) ||
							!client.capabilities.has("chunked_snapshot")
						) {
							continue;
						}
						void this.streamSnapshot(client, result, transcript, "replacement").catch((error) =>
							this.log(`Failed to stream replacement snapshot for ${activeSessionId}: ${String(error)}`),
						);
					}
				}
			} catch (error) {
				this.log(`Invalid worker snapshot begin frame: ${String(error)}`);
			}
			return;
		}
		if (outboundType === "session_snapshot_chunk" && activeSessionId) {
			const transcript = worker.transcriptCaches.get(activeSessionId);
			if (transcript && worker.incomingTranscriptActiveSessionIds.has(activeSessionId)) {
				try {
					transcript.appendEncodedChunk(Buffer.from(frame.payload));
				} catch (error) {
					transcript.markFailed(error instanceof Error ? error : new Error(String(error)));
					worker.incomingTranscriptActiveSessionIds.delete(activeSessionId);
				}
			}
			return;
		}
		if (outboundType === "session_snapshot_end" && activeSessionId) {
			worker.transcriptCaches.get(activeSessionId)?.markComplete();
			worker.incomingTranscriptActiveSessionIds.delete(activeSessionId);
			if (snapshotPurpose === "replacement" || snapshotPurpose === "catchup") {
				for (const client of this.clients) {
					if (!client.attachedActiveSessionIds.has(activeSessionId)) continue;
					if (snapshotPurpose === "replacement" && client.capabilities.has("chunked_snapshot")) continue;
					this.queueCatchup(client, activeSessionId, snapshotPurpose === "replacement" ? "replacement" : "resync");
					void this.catchUpClient(client);
				}
			}
			return;
		}
		if (
			outboundType === "daemon_hello" ||
			outboundType === "response" ||
			outboundType === "session_list_progress" ||
			outboundType === "session_list_item" ||
			outboundType === "session_attached" ||
			outboundType === "session_detached" ||
			!activeSessionId
		) {
			return;
		}
		let publicPayload = frame.payload;
		let decodedOutbound: DaemonOutbound | undefined;
		if (payloadEncoding === "assistant-delta") {
			let compactValue: unknown;
			try {
				compactValue = JSON.parse(frame.payload.toString("utf8"));
			} catch {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			if (!isCompactAssistantDelta(compactValue)) {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			const reconstructed = this.streamReconstructor.reconstruct(compactValue);
			if (!reconstructed) {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			publicPayload = Buffer.from(serializeJsonLine(reconstructed));
		} else if (
			sessionEventType === "message_start" ||
			sessionEventType === "message_end" ||
			outboundType === "session_replaced" ||
			outboundType === "session_resynced" ||
			outboundType === "session_closed"
		) {
			try {
				decodedOutbound = JSON.parse(frame.payload.toString("utf8")) as DaemonOutbound;
				this.streamReconstructor.observe(decodedOutbound);
			} catch {
				// A malformed worker event is still isolated to this worker connection.
			}
		}
		const replacementSnapshotFollows =
			decodedOutbound?.type === "session_replaced" && decodedOutbound.snapshotFollows === true;
		this.invalidateWorkerSnapshot(
			worker,
			activeSessionId,
			outboundType === "session_replaced" ||
				outboundType === "session_closed" ||
				isFinalizedTranscriptEvent(sessionEventType),
		);
		for (const client of this.clients) {
			if (!client.attachedActiveSessionIds.has(activeSessionId)) {
				continue;
			}
			if (replacementSnapshotFollows && !client.capabilities.has("chunked_snapshot")) {
				continue;
			}
			if (outboundType === "extension_ui_request" && !client.supportsExtensionUi) {
				continue;
			}
			if (client.snapshotActiveSessionIds?.has(activeSessionId)) {
				this.queueCatchup(client, activeSessionId, outboundType === "session_replaced" ? "replacement" : "resync");
				continue;
			}
			if (client.backpressured === true) {
				this.queueCatchup(client, activeSessionId, outboundType === "session_replaced" ? "replacement" : "resync");
				continue;
			}
			if (!this.writeSerialized(client, publicPayload)) {
				this.queueCatchup(client, activeSessionId, outboundType === "session_replaced" ? "replacement" : "resync");
			}
		}
		if (outboundType === "session_replaced" || outboundType === "session_closed") {
			void this.refreshWorkerSummaries(worker)
				.then(() => this.syncAgentPeers())
				.catch(() => undefined);
		} else if (
			sessionEventType === "turn_start" ||
			sessionEventType === "turn_end" ||
			sessionEventType === "rlm_child_update"
		) {
			void this.refreshWorkerSummaries(worker)
				.then(() => this.syncAgentPeers())
				.catch(() => undefined);
		}
		if (
			decodedOutbound?.type === "session_closed" &&
			decodedOutbound.reason === "shutdown" &&
			activeSessionId === worker.descriptor.rootActiveSessionId &&
			!this.shuttingDown
		) {
			worker.intentionalStop = true;
			this.workers.delete(worker.descriptor.workerId);
			this.deleteWorkerDescriptor(worker);
			void this.syncAgentPeers().catch(() => undefined);
		}
	}

	private invalidateWorkerSnapshot(worker: ResidentWorker, activeSessionId: string, transcriptChanged = true): void {
		worker.snapshotCache.delete(activeSessionId);
		if (!transcriptChanged) {
			return;
		}
		const transcript = worker.transcriptCaches.get(activeSessionId);
		if (transcript) {
			transcript.dispose();
			worker.transcriptCaches.delete(activeSessionId);
		}
		worker.incomingTranscriptActiveSessionIds.delete(activeSessionId);
	}

	private scheduleCompactCatchup(worker: ResidentWorker, activeSessionId: string): void {
		if (this.compactCatchupInProgress.has(activeSessionId)) {
			return;
		}
		this.compactCatchupInProgress.add(activeSessionId);
		this.invalidateWorkerSnapshot(worker, activeSessionId);
		const clients = [...this.clients].filter((client) => client.attachedActiveSessionIds.has(activeSessionId));
		for (const client of clients) {
			this.queueCatchup(client, activeSessionId);
		}
		void Promise.all(clients.map((client) => this.catchUpClient(client))).finally(() => {
			this.compactCatchupInProgress.delete(activeSessionId);
		});
	}

	private queueCatchup(
		client: DaemonSocketClient,
		activeSessionId: string,
		purpose: "replacement" | "resync" = "resync",
	): void {
		if (!client.catchupActiveSessionIds) {
			client.catchupActiveSessionIds = new Set();
		}
		client.catchupActiveSessionIds.add(activeSessionId);
		client.catchupPurposes ??= new Map();
		if (purpose === "replacement" || !client.catchupPurposes.has(activeSessionId)) {
			client.catchupPurposes.set(activeSessionId, purpose);
		}
	}

	private async catchUpClient(client: DaemonSocketClient): Promise<void> {
		if (client.socket.destroyed) {
			return;
		}
		client.backpressured = false;
		const pending = [...(client.catchupActiveSessionIds ?? [])].map((activeSessionId) => ({
			activeSessionId,
			purpose: client.catchupPurposes?.get(activeSessionId) ?? ("resync" as const),
		}));
		client.catchupActiveSessionIds?.clear();
		client.catchupPurposes?.clear();
		for (let index = 0; index < pending.length; index++) {
			const { activeSessionId, purpose } = pending[index]!;
			try {
				const attached = await this.attachClient(client, {
					type: "attach",
					activeSessionId,
					capabilities: [...client.capabilities],
					supportsExtensionUi: client.supportsExtensionUi,
				});
				if (client.capabilities.has("chunked_snapshot")) {
					const transcript = this.getOrCreateTranscriptCache(attached.worker, attached.result);
					if (purpose === "replacement") {
						this.write(client, {
							type: "session_replaced",
							activeSessionId,
							state: attached.result.snapshot.state,
							messages: [],
							snapshotFollows: true,
							meta: createDaemonEventMeta(
								activeSessionId,
								attached.result.lastEventSequence,
								undefined,
								attached.result.lastEventCursor?.generation,
							),
						});
					}
					await this.streamSnapshot(
						client,
						this.createStreamedAttachResult(attached.result, transcript),
						transcript,
						purpose,
					);
					continue;
				}
				const meta = createDaemonEventMeta(
					activeSessionId,
					attached.result.lastEventSequence,
					undefined,
					attached.result.lastEventCursor?.generation,
				);
				const catchup: DaemonOutbound =
					purpose === "replacement"
						? {
								type: "session_replaced",
								activeSessionId,
								state: attached.result.snapshot.state,
								messages: attached.result.snapshot.messages,
								meta,
							}
						: {
								type: "session_resynced",
								activeSessionId,
								snapshot: attached.result.snapshot,
								meta,
							};
				if (!this.write(client, catchup)) {
					for (const remaining of pending.slice(index + 1)) {
						this.queueCatchup(client, remaining.activeSessionId, remaining.purpose);
					}
					return;
				}
			} catch (error) {
				this.log(`Failed to catch up client ${client.id} for ${activeSessionId}: ${String(error)}`);
			}
		}
	}

	private async prepareUpdateRestart(): Promise<DaemonUpdateRestartManifest> {
		const workers = [...this.workers.values()].filter(
			(worker): worker is ResidentWorker & { client: DaemonWorkerClient } => worker.client !== undefined,
		);
		const prepared: Array<ResidentWorker & { client: DaemonWorkerClient }> = [];
		const preparationResults = await Promise.allSettled(
			workers.map(async (worker) => {
				const response = await worker.client.requestWorker(
					{ type: "worker_prepare_update" },
					WORKER_REQUEST_TIMEOUT_MS,
				);
				if (!response.success || !response.data || typeof response.data !== "object") {
					throw new Error(response.success ? "Worker returned an invalid update manifest" : response.error);
				}
				return { worker, manifest: response.data as DaemonUpdateRestartManifest };
			}),
		);
		for (const result of preparationResults) {
			if (result.status === "fulfilled") {
				prepared.push(result.value.worker);
			}
		}
		const preparationFailure = preparationResults.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (preparationFailure) {
			await Promise.all(
				prepared.map((worker) =>
					worker.client.requestWorker({ type: "worker_cancel_update" }, 5000).catch(() => undefined),
				),
			);
			throw preparationFailure.reason;
		}
		const responses = preparationResults.flatMap((result) =>
			result.status === "fulfilled" ? [result.value.manifest] : [],
		);
		const manifest = {
			createdAt: new Date().toISOString(),
			sessions: responses.flatMap((manifest) => manifest.sessions),
		};
		try {
			this.validateAndPersistUpdateManifest(manifest);
		} catch (error) {
			await Promise.all(
				prepared.map((worker) =>
					worker.client.requestWorker({ type: "worker_cancel_update" }, 5000).catch(() => undefined),
				),
			);
			throw error;
		}
		await Promise.all(
			prepared.map(async (worker) => {
				const response = await worker.client.requestWorker(
					{ type: "worker_commit_update" },
					WORKER_REQUEST_TIMEOUT_MS,
				);
				if (!response.success) {
					throw new Error(response.error);
				}
			}),
		);
		await Promise.all(prepared.map((worker) => this.stopWorker(worker, false)));
		return manifest;
	}

	private validateAndPersistUpdateManifest(manifest: DaemonUpdateRestartManifest): void {
		const activeSessionIds = new Set<string>();
		const sessionFiles = new Set<string>();
		for (const session of manifest.sessions) {
			if (!session.activeSessionId || !session.sessionFile) {
				throw new Error("Update manifest contains an incomplete session checkpoint");
			}
			if (activeSessionIds.has(session.activeSessionId)) {
				throw new Error(`Update manifest contains duplicate active session ${session.activeSessionId}`);
			}
			const sessionFile = resolve(session.sessionFile);
			if (sessionFiles.has(sessionFile)) {
				throw new Error(`Update manifest contains duplicate session file ${sessionFile}`);
			}
			activeSessionIds.add(session.activeSessionId);
			sessionFiles.add(sessionFile);
		}
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		const path = getDaemonUpdateRestartManifestPath(agentDir);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tempPath = `${path}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
		chmodSync(tempPath, 0o600);
		const validated = JSON.parse(readFileSync(tempPath, "utf8")) as DaemonUpdateRestartManifest;
		if (!Array.isArray(validated.sessions) || validated.sessions.length !== manifest.sessions.length) {
			throw new Error("Could not validate aggregate update manifest");
		}
		renameSync(tempPath, path);
	}

	private async stopWorker(
		worker: ResidentWorker,
		removeDescriptor: boolean,
		force = false,
		archiveSession = false,
		recoveryCleanup = false,
	): Promise<void> {
		if (!recoveryCleanup) {
			worker.stopRevision++;
		}
		if (removeDescriptor) {
			this.persistWorkerStopTombstone(worker, archiveSession);
		} else {
			worker.intentionalStop = true;
			worker.descriptor.lifecycle = "recovering";
			this.persistWorker(worker);
		}
		for (const transcript of worker.transcriptCaches.values()) {
			transcript.dispose();
		}
		worker.transcriptCaches.clear();
		worker.snapshotCache.clear();
		if (worker.client) {
			if (archiveSession) {
				await worker.client
					.requestWorker({ type: "worker_archive_and_shutdown" }, force ? 1000 : 5000)
					.catch(() => undefined);
			} else {
				await worker.client.request({ type: "shutdown" }, force ? 1000 : 5000).catch(() => undefined);
			}
			worker.client.close();
			worker.client = undefined;
		} else if (isProcessAlive(worker.descriptor.pid)) {
			signalProcessGroupOrProcess(worker.descriptor.pid, "SIGTERM");
		}
		const gracefulDeadline = Date.now() + (force ? 500 : 2000);
		while (isProcessAlive(worker.descriptor.pid) && Date.now() < gracefulDeadline) {
			await delay(25);
		}
		if (force && isProcessAlive(worker.descriptor.pid)) {
			signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL");
			const forceDeadline = Date.now() + 1000;
			while (isProcessAlive(worker.descriptor.pid) && Date.now() < forceDeadline) {
				await delay(25);
			}
		}
		if (isProcessAlive(worker.descriptor.pid)) {
			worker.intentionalStop = worker.descriptor.stopRequestedAt !== undefined;
			throw new Error(`Session worker ${worker.descriptor.workerId} did not stop${force ? " after SIGKILL" : ""}`);
		}
		if (removeDescriptor && worker.descriptor.archiveOnStop) {
			if (force) {
				this.reclaimStoppedWorkerCronLock(worker);
			}
			await this.finalizeArchivedWorkerStop(worker);
		}
		this.workers.delete(worker.descriptor.workerId);
		if (removeDescriptor) {
			this.deleteWorkerDescriptor(worker);
		}
		if (!this.shuttingDown) {
			void this.syncAgentPeers().catch(() => undefined);
		}
	}

	private async finalizeArchivedWorkerStop(worker: ResidentWorker): Promise<void> {
		const context = this.workerSessionArtifactContext(worker);
		if (!context) {
			return;
		}
		if (worker.descriptor.rootSessionId) {
			const cronStore = AgentCronJobStore.forSessionArtifacts();
			cronStore.registerSessionArtifact(worker.descriptor.rootSessionId, context.artifactDir);
			cronStore.cancelJobsForSession({
				sessionId: worker.descriptor.rootSessionId,
				sessionFile: context.sessionFile,
			});
			await this.catalog.archive(context.sessionFile, worker.descriptor.rootSessionId);
		}
	}

	private reclaimStoppedWorkerCronLock(worker: ResidentWorker): void {
		const context = this.workerSessionArtifactContext(worker);
		if (!context) {
			return;
		}
		rmSync(join(context.artifactDir, `${SESSION_SCHEDULED_JOBS_FILENAME}.lock`), { recursive: true, force: true });
	}

	private workerSessionArtifactContext(
		worker: ResidentWorker,
	): { sessionFile: string; artifactDir: string } | undefined {
		const sessionFile = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
		if (!sessionFile || !worker.descriptor.rootSessionId) {
			return undefined;
		}
		return {
			sessionFile,
			artifactDir: join(dirname(dirname(sessionFile)), "session-artifacts", worker.descriptor.rootSessionId),
		};
	}

	private persistWorkerStopTombstone(worker: ResidentWorker, archiveSession = false): void {
		worker.intentionalStop = true;
		worker.descriptor.stopRequestedAt ??= new Date().toISOString();
		worker.descriptor.archiveOnStop ||= archiveSession;
		this.persistWorker(worker);
	}

	private write(client: DaemonSocketClient, message: DaemonOutbound): boolean {
		return this.writeSerialized(client, serializeJsonLine(message));
	}

	private writeSerialized(client: DaemonSocketClient, line: string | Uint8Array): boolean {
		if (client.socket.destroyed) {
			return false;
		}
		const accepted = client.socket.write(line);
		if (!accepted) {
			client.backpressured = true;
		}
		return accepted;
	}

	private registerSignalHandlers(): void {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => void this.shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143, false);
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const exitHandler = () => this.cleanupSocket();
		process.on("exit", exitHandler);
		this.signalCleanupHandlers.push(() => process.off("exit", exitHandler));
	}

	private cleanupSocket(): void {
		if (!this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		cleanupDaemonSocketPath(this.socketPath);
	}

	private async shutdown(
		exitCode: number,
		stopWorkers: boolean,
		relaunch = false,
		forceWorkers = false,
	): Promise<never> {
		if (this.shuttingDown) {
			process.exit(exitCode);
		}
		this.shuttingDown = true;
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		if (stopWorkers) {
			await Promise.all(
				[...this.workers.values()].map((worker) => this.stopWorker(worker, true, forceWorkers, true)),
			);
			if (!this.hasPersistedWorkerDescriptors()) {
				rmSync(this.supervisorConfigPath, { force: true });
			}
		} else {
			for (const worker of this.workers.values()) {
				worker.intentionalStop = true;
				worker.client?.close();
				worker.client = undefined;
			}
		}
		await this.catalog.stop();
		for (const client of this.clients) {
			client.detachInput();
			client.socket.end();
		}
		await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()) ?? resolveClose());
		this.cleanupSocket();
		if (relaunch) {
			const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", this.socketPath]);
			const environment = { ...process.env };
			delete environment[DAEMON_CATALOG_ROLE_ENV];
			delete environment[DAEMON_WORKER_ROLE_ENV];
			delete environment[DAEMON_WORKER_TOKEN_ENV];
			delete environment[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
			delete environment[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			delete environment[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
			delete environment[ORPHAN_PROCESS_JOURNAL_ENV];
			delete environment[SESSION_LEASES_ENABLED_ENV];
			delete environment[SESSION_LEASE_OWNER_ID_ENV];
			const replacement = spawn(launch.command, launch.args, {
				cwd: this.defaultSessionConfig.cwd ?? process.cwd(),
				detached: true,
				env: environment,
				stdio: "ignore",
			});
			replacement.unref();
		}
		process.exit(exitCode);
	}
}
