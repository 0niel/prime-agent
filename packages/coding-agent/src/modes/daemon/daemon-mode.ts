/**
 * Background daemon mode.
 *
 * The daemon owns live AgentSessionRuntime instances and exposes a small JSONL
 * protocol over a local socket. Clients can attach/detach from sessions without
 * disposing the underlying agent loop.
 */

import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { appendRotatingLog, getCronJobsPath, getDaemonLogPath, VERSION } from "../../config.js";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageDeliveryStatus,
	type AgentSessionMessageEndpoint,
	type AgentSessionMessageListResult,
	type AgentSessionMessagePayload,
	AgentSessionMessageRateLimiter,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
	assertAgentMessageQueueCapacity,
	assertDirectAgentMessageTarget,
	createAgentSessionMessageId,
	createAgentSessionMessagePrompt,
	createAgentSessionMessageReceipt,
	DEFAULT_AGENT_MESSAGE_MAX_CHARS,
	DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
	DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY,
	DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS,
	isAgentSessionMessagePrompt,
	normalizeAgentSessionMessage,
	resolveAgentSessionMessageStreamingBehavior,
} from "../../core/agent-messages.js";
import {
	type AgentObserveAgentSnapshot,
	type AgentObserveAgentSummary,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesInput,
	type AgentObserveRecentMessagesResult,
	createAgentObserveMessagePreview,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
} from "../../core/agent-observe.js";
import type { AgentSession, PromptOptions } from "../../core/agent-session.js";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.js";
import { flushAgentTraceUpload } from "../../core/agent-traces.js";
import {
	type AgentCronJob,
	AgentCronJobStore,
	AgentCronScheduler,
	type AgentHeartbeatUpdateAction,
	createAgentHeartbeatToolDefinitions,
	DEFAULT_HEARTBEAT_SCHEDULE,
	isHeartbeatCronJob,
	normalizeHeartbeatSchedule,
	shouldDeferHeartbeatCronJob,
} from "../../core/cron-jobs.js";
import type {
	CreateRlmSubagentRuntimeOptions,
	RlmSubagentRuntime,
	SubagentRuntimeHost,
} from "../../core/rlm-runtime.js";
import { deleteSessionFile } from "../../core/session-file-actions.js";
import { type SessionInfo, SessionManager } from "../../core/session-manager.js";
import type { SessionStats } from "../../core/session-stats.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import {
	createAgentConnectionCommands,
	createAgentConnectionResourceSnapshot,
	createAgentConnectionState,
} from "../agent-connection/snapshot.js";
import { createAgentConnectionToolDefinition } from "../agent-connection/tool-definition.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import {
	type ActiveSessionState,
	createActiveSessionId,
	type DaemonSocketClient,
	resolveActiveSessionState,
} from "./active-session-state.js";
import { filterClientEnv, withClientEnv } from "./daemon-client-env.js";
import { serializeDaemonError } from "./daemon-errors.js";
import { bindActiveSessionState } from "./daemon-extension-binding.js";
import {
	createDaemonEventMeta,
	createDaemonReplayInfo,
	DAEMON_DEFAULT_CLIENT_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonClientCapability,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
	type DaemonSavedSessionInfo,
	type DaemonSessionClosedReason,
	type DaemonSessionSnapshot,
	failure,
	isDaemonDialogExtensionUiRequest,
	success,
} from "./daemon-protocol.js";
import {
	buildRlmChildSnapshots,
	buildSessionList,
	isActiveSessionBusy,
	summaryForActiveSession,
} from "./daemon-session-list.js";
import { DaemonSessionSummarizer } from "./daemon-session-summarizer.js";
import {
	cleanupDaemonSocketPath,
	defaultDaemonSocketPath,
	prepareDaemonSocketPath,
	restrictDaemonSocketPath,
} from "./daemon-socket.js";

export interface DaemonModeOptions {
	socketPath?: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
	createRuntime: CreateAgentSessionRuntimeFactory;
}

export type { DaemonCommand, DaemonOutbound, DaemonResponse } from "./daemon-protocol.js";
export type { SessionActivity, SessionLifecycle, SessionSummary } from "./daemon-session-list.js";
export { defaultDaemonSocketPath } from "./daemon-socket.js";

const structuredLog = getLogger("coding-agent.daemon");

const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set([
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
	"send_message",
	"agent_messages_status",
	"agent_messages_pause",
	"agent_messages_resume",
	"agent_messages_clear",
	"abort",
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
	"shutdown",
]);

const DAEMON_SERVER_CAPABILITIES: readonly DaemonClientCapability[] = [
	"attach_snapshot",
	"event_sequence",
	"extension_ui",
	"slim_attach",
];

const DAEMON_CLIENT_CAPABILITY_SET: ReadonlySet<string> = new Set(DAEMON_SERVER_CAPABILITIES);

export async function runDaemonMode(options: DaemonModeOptions): Promise<never> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	const daemon = new AgentDaemon(socketPath, options);
	await daemon.start();
	return new Promise(() => {});
}

export class AgentDaemon {
	private server?: Server;
	private shuttingDown = false;
	private ownsSocketPath = false;
	private readonly clients = new Set<DaemonSocketClient>();
	private readonly sessions = new Map<string, ActiveSessionState>();
	private readonly openingSessions = new Map<string, Promise<ActiveSessionState>>();
	private readonly closingSessions = new Map<string, Promise<void>>();
	private readonly signalCleanupHandlers: Array<() => void> = [];
	private readonly cronStore: AgentCronJobStore;
	private readonly cronScheduler: AgentCronScheduler;
	private readonly agentMessageRateLimiter = new AgentSessionMessageRateLimiter();
	private readonly agentMessagePendingReservations = new Map<string, number>();
	private readonly agentMessageTargetLocks = new Map<string, Promise<void>>();
	private readonly agentMessageAcceptingTargets = new Set<string>();
	// Refcount of prompts in preflight (accepted but not yet streaming); >0 makes
	// concurrent agent messages queue instead of racing agent.prompt.
	private readonly agentMessagePreparingTargets = new Map<string, number>();
	// Sessions inserted into `sessions` but still awaiting extension binding;
	// visible to host controllers during bind, excluded from targeting.
	private readonly bindingSessions = new Set<string>();
	private agentMessagesPaused = false;
	private readonly summarizer = new DaemonSessionSummarizer(
		() => [...this.sessions.values()],
		(state) => {
			// Subagents share their recap with the parent so it shows in the parent's
			// subagent tree; their own session channel usually has no attached client.
			if (state.runtime.metadata.kind === "subagent") {
				state.runtime.session.setCurrentRecap(state.summaryState?.summary);
			}
			this.broadcastToSession(state, {
				type: "session_status",
				activeSessionId: state.activeSessionId,
				recap: state.summaryState?.summary,
			});
		},
	);

	constructor(
		private readonly socketPath: string,
		private readonly options: DaemonModeOptions,
	) {
		if (!options.defaultSessionConfig.agentDir) {
			throw new Error("Daemon config is missing agentDir");
		}
		this.cronStore = new AgentCronJobStore(getCronJobsPath(options.defaultSessionConfig.agentDir));
		this.cronScheduler = new AgentCronScheduler(this.cronStore, {
			runJob: (job) => this.runCronJob(job),
			onError: (job, error) => {
				this.log(`Cron job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			},
		});
	}

	// The daemon runs detached with no terminal, so route its diagnostics to its
	// rotating log file and the shared structured log (and stderr too, for when
	// it's run in the foreground).
	private log(message: string): void {
		console.error(message);
		structuredLog.warn(message, { socketPath: this.socketPath });
		appendRotatingLog(getDaemonLogPath(this.socketPath), `[${new Date().toISOString()}] ${message}`);
	}

	// A crash thrown outside a command handler would otherwise vanish with the
	// detached stdio; capture its stack before the process goes down.
	private installCrashHandlers(): void {
		process.on("uncaughtException", (error) => {
			this.log(`uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			process.exit(1);
		});
		process.on("unhandledRejection", (reason) => {
			this.log(
				`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
			);
			process.exit(1);
		});
	}

	async start(): Promise<void> {
		this.installCrashHandlers();
		await prepareDaemonSocketPath(this.socketPath);

		this.server = createServer((socket) => this.handleConnection(socket));

		try {
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
					} catch (error) {
						this.server?.close();
						rejectListen(error);
						return;
					}
					resolveListen();
				};
				this.server?.once("error", onError);
				this.server?.once("listening", onListening);
				this.server?.listen(this.socketPath);
			});
		} catch (error) {
			this.cleanupSocketPath();
			throw error;
		}

		this.registerSignalHandlers();
		this.summarizer.start();
		this.log(`Prime Agent daemon listening on ${this.socketPath}`);
		// No startup restore: on-disk sessions return only via /resume or --resume.
		if (!this.shuttingDown) {
			this.cronScheduler.start();
		}
	}

	private cleanupSocketPath(): void {
		if (!this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		cleanupDaemonSocketPath(this.socketPath);
	}

	/**
	 * Adopt env for a session that has none, propagating to subagents spawned
	 * before adoption (their exec-env providers read state.clientEnv live).
	 * Never overwrites an existing identity.
	 */
	private adoptClientEnv(state: ActiveSessionState, env?: Record<string, string>): void {
		if (!env || state.clientEnv) {
			return;
		}
		state.clientEnv = env;
		for (const child of this.sessions.values()) {
			const metadata = child.runtime.metadata;
			if (metadata.kind === "subagent" && metadata.parentActiveSessionId === state.activeSessionId) {
				this.adoptClientEnv(child, env);
			}
		}
	}

	private async addRuntime(
		runtime: AgentSessionRuntime,
		name?: string,
		clientEnv?: Record<string, string>,
		onStateCreated?: (state: ActiveSessionState) => void,
	): Promise<ActiveSessionState> {
		const state: ActiveSessionState = {
			activeSessionId: createActiveSessionId(this.sessions),
			runtime,
			clients: new Set(),
			extensionUiRequests: new Map(),
			lastEventSequence: 0,
			clientEnv,
		};
		if (name) {
			state.runtime.session.setSessionName(name);
		}
		this.sessions.set(state.activeSessionId, state);
		this.bindingSessions.add(state.activeSessionId);
		onStateCreated?.(state);
		try {
			await bindActiveSessionState(state, {
				broadcast: (targetSessionState, message) => this.broadcastToSession(targetSessionState, message),
				createConnectionState: (targetSessionState) => this.createConnectionState(targetSessionState),
				sessionReplaced: (targetSessionState) => this.refreshReplacedSessionState(targetSessionState),
				shutdown: () => {
					void this.shutdown(0);
				},
				subagentRuntimeHost: this.createSubagentRuntimeHost(state),
			});
		} catch (error) {
			state.unsubscribe?.();
			this.sessions.delete(state.activeSessionId);
			await runtime.dispose().catch(() => undefined);
			throw error;
		} finally {
			this.bindingSessions.delete(state.activeSessionId);
		}
		this.rebindCronJobsToState(state);
		if (runtime.metadata.kind !== "subagent") {
			// Mark the session as daemon-resident so a restarted daemon can
			// restore it. Closes for kill/completed/replaced flip this back to
			// sleep; clean shutdowns leave it in place on purpose.
			try {
				runtime.session.sessionManager.appendSessionState({ status: "active" });
			} catch {
				// Marking is best-effort; the session still works unrestored.
			}
		}
		// Restore the last persisted status so it shows before the first sweep.
		this.summarizer.seed(state);
		return state;
	}

	private refreshReplacedSessionState(state: ActiveSessionState): void {
		this.summarizer.forget(state.activeSessionId);
		state.summaryState = undefined;
		state.runtime.session.setCurrentRecap(undefined);
		this.summarizer.seed(state);
		if (state.runtime.metadata.kind === "subagent") {
			const summaryState = state.summaryState as ActiveSessionState["summaryState"];
			state.runtime.session.setCurrentRecap(summaryState?.summary);
		}
		this.rebindCronJobsToState(state);
	}

	private async createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState> {
		const config = mergeAgentSessionRuntimeConfig(this.options.defaultSessionConfig, command.config);
		if (!config.cwd) {
			throw new Error("Active session config is missing cwd");
		}
		if (!config.agentDir) {
			throw new Error("Active session config is missing agentDir");
		}

		const cwd = resolve(config.cwd);
		const agentDir = config.agentDir;
		const clientEnv = filterClientEnv(command.env);
		const cwdOverride = command.config?.cwd ? resolve(command.config.cwd) : undefined;
		const sessionPath = command.sessionPath
			? await resolveDaemonSessionPath(command.sessionPath, cwd, config.sessionDir)
			: undefined;
		const sessionManager = sessionPath
			? await SessionManager.openAsync(sessionPath, config.sessionDir, cwdOverride)
			: command.continueRecent
				? SessionManager.continueRecent(cwd, config.sessionDir)
				: SessionManager.create(cwd, config.sessionDir);
		const createState = async (): Promise<ActiveSessionState> => {
			const existing = this.findSessionBySessionFile(sessionManager.getSessionFile());
			if (existing) {
				// A live runtime already owns this session file; reuse it instead of
				// starting a second runtime that would interleave writes to one file.
				// clientEnv adopts the first offered identity (e.g. a pane opening a
				// cron-created session) but never overwrites one: extensions captured
				// the creator's identity at load, and swapping it would only make
				// pi.exec disagree with those captures.
				if (command.name) {
					existing.runtime.session.setSessionName(command.name);
				}
				this.adoptClientEnv(existing, clientEnv);
				this.rebindCronJobsToState(existing);
				return existing;
			}
			let stateRef: ActiveSessionState | undefined;
			// Extensions capture client env (e.g. herdr pane identity) synchronously
			// while the runtime loads them, so it must be in process.env for the
			// duration; withClientEnv restores it after.
			const runtime = await withClientEnv(clientEnv, () =>
				createAgentSessionRuntime(this.options.createRuntime, {
					cwd: sessionManager.getCwd(),
					agentDir,
					sessionManager,
					sessionConfig: config,
					sessionOptions: {
						customTools: [
							...createAgentHeartbeatToolDefinitions({
								getHeartbeat: () => {
									if (!stateRef) {
										throw new Error("Heartbeat state is not ready for this session yet");
									}
									return this.cronStore.getHeartbeat(stateRef.activeSessionId);
								},
							}),
						],
						rlmHeartbeatController: {
							listRlmHeartbeats: (listOptions) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.cronStore.listRlmHeartbeats(stateRef.activeSessionId, listOptions);
							},
							createRlmHeartbeat: (input) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.createRlmHeartbeatForState(stateRef, input);
							},
							updateRlmHeartbeat: (input) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.updateRlmHeartbeatForState(stateRef, input);
							},
							deleteRlmHeartbeat: (id) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.deleteRlmHeartbeatForState(stateRef, id);
							},
						},
						agentMessageController: {
							listAgents: () => {
								if (!stateRef) {
									throw new Error("Agent message state is not ready for this session yet");
								}
								return this.createAgentMessageListResult(stateRef);
							},
							sendAgentMessage: (input) => {
								if (!stateRef) {
									throw new Error("Agent message state is not ready for this session yet");
								}
								return this.sendAgentSessionMessage({
									targetSelector: input.target,
									message: input.message,
									fromState: stateRef,
									deliveryMode: input.deliveryMode,
									origin: "agent",
								});
							},
						},
						agentObserveController: this.createAgentObserveController(() => stateRef),
					},
				}),
			);
			return this.addRuntime(runtime, command.name, clientEnv, (state) => {
				stateRef = state;
			});
		};

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			return createState();
		}
		const sessionKey = resolve(sessionFile);
		const pending = this.openingSessions.get(sessionKey);
		if (pending) {
			// Same as the reuse path above: adopt-if-absent, never overwrite the
			// identity the racing creator's extensions already captured.
			const state = await pending;
			if (command.name) {
				state.runtime.session.setSessionName(command.name);
			}
			this.adoptClientEnv(state, clientEnv);
			this.rebindCronJobsToState(state);
			return state;
		}
		const opening = Promise.resolve().then(createState);
		this.openingSessions.set(sessionKey, opening);
		try {
			return await opening;
		} finally {
			if (this.openingSessions.get(sessionKey) === opening) {
				this.openingSessions.delete(sessionKey);
			}
		}
	}

	private async runCronJob(job: AgentCronJob): Promise<"skipped" | undefined> {
		const state = await this.getOrCreateCronJobSession(job);
		if (!state) {
			return "skipped";
		}
		const session = state.runtime.session;
		const isAgentMessagePromptInProgress =
			this.agentMessageAcceptingTargets.has(state.activeSessionId) ||
			this.agentMessagePreparingTargets.has(state.activeSessionId);
		if (isHeartbeatCronJob(job) && isAgentMessagePromptInProgress) {
			return "skipped";
		}
		if (shouldDeferHeartbeatCronJob(job, session)) {
			return "skipped";
		}
		const shouldQueueCronPrompt =
			isAgentMessagePromptInProgress ||
			session.isStreaming ||
			session.isCompacting ||
			session.isRetrying ||
			session.isBashRunning ||
			session.hasAcceptedPromptInFlight ||
			session.pendingMessageCount > 0;
		if (!isHeartbeatCronJob(job) && shouldQueueCronPrompt) {
			await session.followUp(job.prompt);
			return;
		}
		if (isHeartbeatCronJob(job)) {
			await this.promptHeartbeatWithAgentMessagePreparingGuard(state, job, {
				streamingBehavior: "followUp",
				followUpQueueKey: `heartbeat:${job.id}`,
				source: "rpc",
			});
			return;
		}
		await this.promptWithAgentMessagePreparingGuard(state, job.prompt, {
			streamingBehavior: "followUp",
			source: "rpc",
		});
	}

	// Wraps session.prompt so the target counts as "preparing" until the turn
	// starts streaming (or the prompt settles); concurrent agent messages queue
	// instead of racing agent.prompt during the preflight awaits. Refcounted so
	// overlapping prompts each hold their own registration.
	private async promptWithAgentMessagePreparingGuard(
		state: ActiveSessionState,
		message: string,
		options?: PromptOptions,
	): Promise<void> {
		await this.withAgentMessagePreparingGuard(state, (session) =>
			session.prompt(message, {
				...options,
				preflightResult: (didSucceed) => {
					options?.preflightResult?.(didSucceed);
				},
			}),
		);
	}

	private async promptHeartbeatWithAgentMessagePreparingGuard(
		state: ActiveSessionState,
		job: AgentCronJob,
		options?: PromptOptions,
	): Promise<void> {
		await this.withAgentMessagePreparingGuard(state, (session) =>
			session.promptHeartbeat(job, {
				...options,
				preflightResult: (didSucceed) => {
					options?.preflightResult?.(didSucceed);
				},
			}),
		);
	}

	private async withAgentMessagePreparingGuard(
		state: ActiveSessionState,
		run: (session: AgentSession) => Promise<void>,
	): Promise<void> {
		const activeSessionId = state.activeSessionId;
		const session = state.runtime.session;
		this.agentMessagePreparingTargets.set(
			activeSessionId,
			(this.agentMessagePreparingTargets.get(activeSessionId) ?? 0) + 1,
		);
		let cleared = false;
		const clearPreparing = () => {
			if (cleared) {
				return;
			}
			cleared = true;
			const next = (this.agentMessagePreparingTargets.get(activeSessionId) ?? 1) - 1;
			if (next <= 0) {
				this.agentMessagePreparingTargets.delete(activeSessionId);
			} else {
				this.agentMessagePreparingTargets.set(activeSessionId, next);
			}
		};
		try {
			await this.agentMessageTargetLocks.get(activeSessionId)?.catch(() => undefined);
			await run(session);
		} finally {
			clearPreparing();
		}
	}

	private createCronJobForState(state: ActiveSessionState, schedule: string, prompt: string): AgentCronJob {
		const session = state.runtime.session;
		const sessionFile = session.sessionFile;
		if (!sessionFile) {
			throw new Error("Cron jobs require a persisted session file");
		}
		const job = this.cronStore.create({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
			runtimeKind: state.runtime.metadata.kind,
			scheduleText: schedule,
			prompt,
		});
		this.cronScheduler.wake();
		return job;
	}

	private createHeartbeatForState(state: ActiveSessionState, schedule: string, instruction: string): AgentCronJob {
		const session = state.runtime.session;
		const sessionFile = session.sessionFile;
		if (!sessionFile) {
			throw new Error("Heartbeats require a persisted session file");
		}
		const previousHeartbeat = this.cronStore.getHeartbeat(state.activeSessionId);
		const job = this.cronStore.createHeartbeat({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
			runtimeKind: state.runtime.metadata.kind,
			scheduleText: normalizeHeartbeatSchedule(schedule),
			prompt: instruction,
		});
		if (previousHeartbeat) {
			this.removeQueuedHeartbeatFollowUp(state, previousHeartbeat);
		}
		this.cronScheduler.wake();
		return job;
	}

	private updateHeartbeatForState(
		state: ActiveSessionState,
		action: AgentHeartbeatUpdateAction,
	): AgentCronJob | undefined {
		const job =
			action === "pause"
				? this.cronStore.pauseHeartbeat(state.activeSessionId)
				: action === "resume"
					? this.cronStore.resumeHeartbeat(state.activeSessionId)
					: this.cronStore.clearHeartbeat(state.activeSessionId);
		if (job && action !== "resume") {
			this.removeQueuedHeartbeatFollowUp(state, job);
		}
		this.cronScheduler.wake();
		return job;
	}

	private createRlmHeartbeatForState(
		state: ActiveSessionState,
		input: { instruction: string; interval?: string; label?: string },
	): AgentCronJob {
		const session = state.runtime.session;
		const sessionFile = session.sessionFile;
		if (!sessionFile) {
			throw new Error("RLM heartbeats require a persisted session file");
		}
		const job = this.cronStore.createRlmHeartbeat({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
			runtimeKind: state.runtime.metadata.kind,
			label: input.label,
			scheduleText: normalizeHeartbeatSchedule(input.interval ?? DEFAULT_HEARTBEAT_SCHEDULE),
			prompt: input.instruction,
		});
		this.cronScheduler.wake();
		return job;
	}

	private updateRlmHeartbeatForState(
		state: ActiveSessionState,
		input: { id: string; instruction?: string; interval?: string; label?: string; status?: "pause" | "resume" },
	): AgentCronJob | undefined {
		const job = this.cronStore.updateRlmHeartbeat(state.activeSessionId, input.id, {
			label: input.label,
			prompt: input.instruction,
			scheduleText: input.interval ? normalizeHeartbeatSchedule(input.interval) : undefined,
			status: input.status,
		});
		if (job) {
			if (input.instruction !== undefined || input.interval !== undefined || input.status === "pause") {
				this.removeQueuedHeartbeatFollowUp(state, job);
			}
			this.cronScheduler.wake();
		}
		return job;
	}

	private deleteRlmHeartbeatForState(state: ActiveSessionState, id: string): AgentCronJob | undefined {
		const job = this.cronStore.deleteRlmHeartbeat(state.activeSessionId, id);
		if (job) {
			this.removeQueuedHeartbeatFollowUp(state, job);
			this.cronScheduler.wake();
		}
		return job;
	}

	private rebindCronJobsToState(state: ActiveSessionState): void {
		const sessionFile = state.runtime.session.sessionFile;
		if (!sessionFile) {
			return;
		}
		const reboundJobs = this.cronStore.rebindSessionJobs({
			activeSessionId: state.activeSessionId,
			sessionId: state.runtime.session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
		});
		if (reboundJobs.some((job) => job.status === "active")) {
			this.cronScheduler.wake();
		}
	}

	private cancelSubagentRlmHeartbeats(state: ActiveSessionState): void {
		if (state.runtime.metadata.kind !== "subagent") {
			return;
		}
		const cancelled = this.cronStore.cancelRlmHeartbeatsForSession(state.activeSessionId);
		for (const job of cancelled) {
			this.removeQueuedHeartbeatFollowUp(state, job);
		}
		if (cancelled.length > 0) {
			this.cronScheduler.wake();
		}
	}

	private removeQueuedHeartbeatFollowUp(state: ActiveSessionState, job: AgentCronJob): void {
		if (!isHeartbeatCronJob(job)) {
			return;
		}
		state.runtime.session.removeQueuedFollowUp(`heartbeat:${job.id}`);
	}

	private async getOrCreateCronJobSession(job: AgentCronJob): Promise<ActiveSessionState | undefined> {
		const current = this.sessions.get(job.activeSessionId) ?? this.findSessionBySessionFile(job.sessionFile);
		// A half-bound match falls through to createRuntime, which awaits the
		// pending create for the same session file instead of prompting mid-bind.
		if (current && !this.bindingSessions.has(current.activeSessionId)) {
			this.rebindCronJobsToState(current);
			return current;
		}
		if (job.source === "rlm_heartbeat" && job.runtimeKind === "subagent") {
			if (current && this.bindingSessions.has(current.activeSessionId)) {
				return undefined;
			}
			this.cronStore.cancel(job.id);
			this.cronScheduler.wake();
			return undefined;
		}
		return this.createRuntime({ type: "create", sessionPath: job.sessionFile });
	}

	private findSessionBySessionFile(sessionFile: string | undefined): ActiveSessionState | undefined {
		if (!sessionFile) {
			return undefined;
		}
		const target = resolve(sessionFile);
		for (const state of this.sessions.values()) {
			const file = state.runtime.session.sessionFile;
			if (file && resolve(file) === target) {
				return state;
			}
		}
		return undefined;
	}

	private getSessionState(id: string): ActiveSessionState {
		return resolveActiveSessionState(this.sessions, id);
	}

	// A bind failure disposes the runtime, so half-bound sessions must not be
	// targetable by attach, agent messages, or observe.
	private getBoundSessionState(id: string): ActiveSessionState {
		const state = this.getSessionState(id);
		if (this.bindingSessions.has(state.activeSessionId)) {
			throw new Error(`Active session ${state.activeSessionId} is still initializing`);
		}
		return state;
	}

	private findRuntimeState(runtime: RlmSubagentRuntime): ActiveSessionState | undefined {
		if (!(runtime instanceof AgentSessionRuntime)) {
			return undefined;
		}
		for (const state of this.sessions.values()) {
			if (state.runtime === runtime) {
				return state;
			}
		}
		return undefined;
	}

	private createSubagentRuntimeHost(parentState: ActiveSessionState): SubagentRuntimeHost {
		return {
			createRlmSubagentRuntime: async (options) => this.createRlmSubagentRuntime(parentState, options),
			disposeRlmSubagentRuntimes: async () => {
				const cascadeError = await this.closeChildSessions(parentState, "replaced");
				if (cascadeError) {
					throw cascadeError;
				}
			},
			releaseRlmSubagentRuntime: async (runtime, options, status) => {
				const state = this.findRuntimeState(runtime);
				// A successful subagent stays resident so it's still viewable (torn down with the
				// parent via closeChildSessions); errored/cancelled would re-seed as "done", so close them.
				if (state && status === "done") {
					// Run shutdown side effects without disposing the still-readable session.
					this.cancelSubagentRlmHeartbeats(state);
					await flushAgentTraceUpload(state.runtime.session.sessionManager).catch(() => undefined);
					// Retention can decline if the parent is already tearing down; if so, close
					// the session here so it doesn't linger in the registry.
					if (options.parentSession.retainFinishedRlmChildSession(options.id, runtime.session)) {
						return;
					}
				}
				if (state) {
					await this.closeSession(state, status === "cancelled" ? "killed" : "completed");
					return;
				}
				if (runtime instanceof AgentSessionRuntime) {
					await runtime.dispose();
					return;
				}
				runtime.session.dispose();
			},
		};
	}

	private async createRlmSubagentRuntime(
		parentState: ActiveSessionState,
		options: CreateRlmSubagentRuntimeOptions,
	): Promise<AgentSessionRuntime> {
		const sessionManager = SessionManager.create(options.parentSession.sessionManager.getCwd(), options.sessionDir);
		if (options.parentSession.sessionFile) {
			sessionManager.newSession({ parentSession: options.parentSession.sessionFile });
		}
		let stateRef: ActiveSessionState | undefined;
		// Subagents inherit the parent's client env (e.g. herdr pane identity).
		const runtime = await withClientEnv(parentState.clientEnv, () =>
			createAgentSessionRuntime(this.options.createRuntime, {
				cwd: sessionManager.getCwd(),
				agentDir: parentState.runtime.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
				sessionConfig: parentState.runtime.runtimeConfig,
				sessionOptions: {
					model: options.model,
					thinkingLevel: options.thinkingLevel,
					scopedModels: options.scopedModels,
					initialActiveToolNames: options.activeToolNames,
					allowedToolNames: options.allowedToolNames,
					customTools: options.customTools,
					includeGoals: options.includeGoals,
					includeCompactSkill: options.includeCompactSkill,
					rlmHeartbeatController: {
						listRlmHeartbeats: (listOptions) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.cronStore.listRlmHeartbeats(stateRef.activeSessionId, listOptions);
						},
						createRlmHeartbeat: (input) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.createRlmHeartbeatForState(stateRef, input);
						},
						updateRlmHeartbeat: (input) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.updateRlmHeartbeatForState(stateRef, input);
						},
						deleteRlmHeartbeat: (id) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.deleteRlmHeartbeatForState(stateRef, id);
						},
					},
					rlmDepth: options.rlmDepth,
					rlmMaxDepth: options.rlmMaxDepth,
					rlmSessionDir: options.sessionDir,
					rlmParentNodeId: options.rlmParentNodeId,
				},
				runtimeMetadata: {
					kind: "subagent",
					createdAt: Date.now(),
					parentActiveSessionId: parentState.activeSessionId,
					parentSessionId: options.parentSession.sessionId,
					parentSessionFile: options.parentSession.sessionFile,
					rlmChildId: options.id,
					rlmParentNodeId: options.rlmParentNodeId,
					prompt: options.prompt,
					spawnCode: options.spawnCode,
					sessionDir: options.sessionDir,
				},
			}),
		);
		await this.addRuntime(runtime, undefined, parentState.clientEnv, (state) => {
			stateRef = state;
		});
		return runtime;
	}

	private createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController {
		const requireCurrentState = () => {
			const current = getCurrentState();
			if (!current) {
				throw new Error("Agent observe state is not ready for this session yet");
			}
			return current;
		};
		return {
			listAgents: () => this.createAgentObserveListResult(requireCurrentState()),
			getAgent: (target) => this.createAgentObserveAgentSnapshot(requireCurrentState(), target),
			recentMessages: (input) => this.createAgentObserveRecentMessages(requireCurrentState(), input),
		};
	}

	private createAgentObserveListResult(currentState: ActiveSessionState): AgentObserveListResult {
		return {
			current: this.createAgentObserveSummary(currentState, currentState),
			agents: this.listTargetableSessionStates(currentState).map((state) =>
				this.createAgentObserveSummary(state, currentState),
			),
		};
	}

	private createAgentObserveAgentSnapshot(
		currentState: ActiveSessionState,
		target: string,
	): AgentObserveAgentSnapshot {
		return {
			agent: this.createAgentObserveSummary(this.getBoundSessionState(target), currentState),
		};
	}

	private createAgentObserveRecentMessages(
		currentState: ActiveSessionState,
		input: AgentObserveRecentMessagesInput,
	): AgentObserveRecentMessagesResult {
		const targetState = this.getBoundSessionState(input.target);
		const limit = normalizeObserveLimit(input.limit);
		const maxChars = normalizeObserveMaxChars(input.maxChars);
		const messages = targetState.runtime.session.messages;
		const startIndex = Math.max(0, messages.length - limit);
		return {
			agent: this.createAgentObserveSummary(targetState, currentState),
			messages: messages
				.slice(startIndex)
				.map((message, offset) => createAgentObserveMessagePreview(message, startIndex + offset, maxChars)),
			limit,
			maxChars,
			truncated: startIndex > 0,
		};
	}

	private createAgentObserveSummary(
		state: ActiveSessionState,
		currentState: ActiveSessionState,
	): AgentObserveAgentSummary {
		const summary = summaryForActiveSession(state);
		const session = state.runtime.session;
		const messages = session.messages;
		const latest = messages.at(-1);
		const status = session.isStreaming
			? session.state.pendingToolCalls.size > 0
				? "tool"
				: "model"
			: session.isCompacting
				? "compacting"
				: session.isRetrying ||
						session.isBashRunning ||
						session.hasAcceptedPromptInFlight ||
						session.pendingMessageCount > 0 ||
						session.hasRunningRlmChildren()
					? "busy"
					: state.clients.size > 0
						? "user"
						: "idle";
		return {
			activeSessionId: state.activeSessionId,
			sessionId: summary.sessionId,
			...(summary.sessionName ? { sessionName: summary.sessionName } : {}),
			...(summary.runtimeKind ? { runtimeKind: summary.runtimeKind } : {}),
			cwd: summary.cwd,
			status,
			isCurrent: state.activeSessionId === currentState.activeSessionId,
			isStreaming: summary.isStreaming,
			isCompacting: summary.isCompacting,
			attachedClients: summary.attachedClients,
			messageCount: summary.messageCount,
			pendingMessageCount: summary.pendingMessageCount,
			...(summary.parentActiveSessionId ? { parentActiveSessionId: summary.parentActiveSessionId } : {}),
			...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
			...(summary.rlmChildId ? { rlmChildId: summary.rlmChildId } : {}),
			...(summary.rlmParentNodeId ? { rlmParentNodeId: summary.rlmParentNodeId } : {}),
			...(summary.firstMessage ? { firstMessage: summary.firstMessage } : {}),
			...(latest ? { latestMessage: createAgentObserveMessagePreview(latest, messages.length - 1, 240) } : {}),
		};
	}

	private handleConnection(socket: Socket): void {
		const client: DaemonSocketClient = {
			id: createActiveSessionId(),
			socket,
			attachedActiveSessionIds: new Set(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(DAEMON_DEFAULT_CLIENT_CAPABILITIES),
		};
		this.clients.add(client);
		this.write(client, {
			type: "daemon_hello",
			socketPath: this.socketPath,
			protocol: DAEMON_PROTOCOL_INFO,
			appVersion: VERSION,
			clientId: client.id,
			serverCapabilities: DAEMON_SERVER_CAPABILITIES,
		});

		client.detachInput = attachJsonlLineReader(socket, (line) => {
			void this.handleLine(client, line);
		});

		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			socket.off("close", cleanup);
			socket.off("error", cleanup);
			this.detachClient(client);
			client.detachInput();
			this.clients.delete(client);
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	}

	private async handleLine(client: DaemonSocketClient, line: string): Promise<void> {
		let command: DaemonCommand;
		try {
			const parsed = JSON.parse(line) as { id?: unknown; type?: unknown };
			if (typeof parsed.type !== "string" || !DAEMON_COMMAND_TYPES.has(parsed.type)) {
				const commandName = typeof parsed.type === "string" ? parsed.type : "unknown";
				const commandId = typeof parsed.id === "string" ? parsed.id : undefined;
				this.write(client, failure(commandId, commandName, `Unknown daemon command: ${commandName}`));
				return;
			}
			command = parsed as DaemonCommand;
		} catch (error) {
			this.write(client, failure(undefined, "parse", error, serializeDaemonError(error)));
			return;
		}

		try {
			const response = await this.handleCommand(client, command);
			if (response) {
				this.write(client, response);
			}
		} catch (error) {
			// Only the error message reaches the client (serializeDaemonError drops
			// the rest), so log the full stack here — this is the one place a handler
			// crash like a RangeError from a pathological session is recoverable.
			this.log(
				`daemon command "${command.type}" failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
			);
			this.write(client, failure(command.id, command.type, error, serializeDaemonError(error)));
		}
	}

	private async handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
	): Promise<DaemonResponse | undefined> {
		switch (command.type) {
			case "list": {
				const activeSessions = Array.from(this.sessions.values());
				if (!command.all) {
					return success(command.id, "list", {
						sessions: buildSessionList(activeSessions, []),
					});
				}
				const defaultConfig = this.options.defaultSessionConfig;
				const listSessionDir = command.sessionDir ?? defaultConfig.sessionDir;
				if (command.cwd) {
					const savedSessions = await SessionManager.list(resolve(command.cwd), listSessionDir);
					return success(command.id, "list", {
						sessions: buildSessionList(activeSessions, savedSessions),
					});
				}
				const savedSessions =
					listSessionDir !== undefined
						? await SessionManager.listAll(undefined, listSessionDir)
						: await SessionManager.listAll();
				return success(command.id, "list", {
					sessions: buildSessionList(activeSessions, savedSessions),
				});
			}

			case "list_saved_sessions": {
				const state = this.getSessionState(command.activeSessionId);
				const sessionManager = state.runtime.session.sessionManager;
				const onProgress = command.id
					? (loaded: number, total: number) => {
							this.write(client, {
								id: command.id,
								type: "session_list_progress",
								command: "list_saved_sessions",
								activeSessionId: command.activeSessionId,
								loaded,
								total,
							});
						}
					: undefined;
				const savedSessions =
					command.scope === "current"
						? await SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir(), onProgress)
						: await SessionManager.listAll(onProgress, sessionManager.getSessionDir());
				return success(command.id, "list_saved_sessions", {
					sessions: savedSessions.map(serializeSavedSessionInfo),
				});
			}

			case "create": {
				const state = await this.createRuntime(command);
				return success(command.id, "create", summaryForActiveSession(state));
			}

			case "attach": {
				const state = this.getBoundSessionState(command.activeSessionId);
				if (command.clientId) {
					client.id = command.clientId;
				}
				client.capabilities = normalizeClientCapabilities(command.capabilities, command.supportsExtensionUi);
				client.supportsExtensionUi = client.capabilities.has("extension_ui");
				this.adoptClientEnv(state, filterClientEnv(command.env));
				state.clients.add(client);
				client.attachedActiveSessionIds.add(state.activeSessionId);
				const result = this.createAttachResult(client, state, command);
				// Slim clients consume only the command response; legacy clients (e.g.
				// the plain daemon attach REPL) read state/messages off this event.
				// Skipping it for slim clients halves the attach payload.
				if (result.state && result.messages) {
					this.write(client, {
						type: "session_attached",
						activeSessionId: state.activeSessionId,
						state: result.state,
						messages: result.messages,
						snapshot: result.snapshot,
						replay: result.replay,
						lastEventSequence: result.lastEventSequence,
					});
				}
				return success(command.id, "attach", result);
			}

			case "detach": {
				if (command.activeSessionId) {
					const state = this.getSessionState(command.activeSessionId);
					this.detachClientFromSession(client, state);
				} else {
					this.detachClient(client);
				}
				return success(command.id, "detach");
			}

			case "kill": {
				const state = this.getSessionState(command.activeSessionId);
				await this.closeSession(state, "killed");
				return success(command.id, "kill");
			}

			case "rename": {
				const state = this.getSessionState(command.activeSessionId);
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				state.runtime.session.setSessionName(name);
				return success(command.id, "rename", summaryForActiveSession(state));
			}

			case "rename_saved_session": {
				this.getSessionState(command.activeSessionId);
				const state = this.findActiveSessionByFile(command.sessionPath);
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				if (state) {
					state.runtime.session.setSessionName(name);
				} else {
					SessionManager.open(command.sessionPath).appendSessionInfo(name);
				}
				return success(command.id, "rename_saved_session");
			}

			case "delete_saved_session": {
				if (command.activeSessionId) {
					this.getSessionState(command.activeSessionId);
				}
				if (this.findActiveSessionByFile(command.sessionPath)) {
					throw new Error("Cannot delete the currently active session");
				}
				return success(command.id, "delete_saved_session", await deleteSessionFile(command.sessionPath));
			}

			case "prompt": {
				const state = this.getSessionState(command.activeSessionId);
				let responseSent = false;
				const sendSuccessResponse = () => {
					if (responseSent) {
						return;
					}
					responseSent = true;
					this.write(client, success(command.id, "prompt"));
				};
				void this.promptWithAgentMessagePreparingGuard(state, command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							sendSuccessResponse();
						}
					},
				})
					.then(() => {
						sendSuccessResponse();
					})
					.catch((error) => {
						if (responseSent) {
							this.broadcastToSession(state, failure(undefined, "prompt", error, serializeDaemonError(error)));
						} else {
							this.write(client, failure(command.id, "prompt", error, serializeDaemonError(error)));
						}
					});
				return undefined;
			}

			case "steer": {
				const state = this.getSessionState(command.activeSessionId);
				await state.runtime.session.steer(command.message, command.images);
				return success(command.id, "steer");
			}

			case "follow_up": {
				const state = this.getSessionState(command.activeSessionId);
				await state.runtime.session.followUp(command.message, command.images);
				return success(command.id, "follow_up");
			}

			case "send_message": {
				const fromState = command.fromActiveSessionId
					? this.getSessionState(command.fromActiveSessionId)
					: undefined;
				const receipt = await this.sendAgentSessionMessage({
					targetSelector: command.targetActiveSessionId,
					message: command.message,
					fromState,
					clientId: client.id,
					senderKey: this.createCliAgentMessageSenderKey(),
					deliveryMode: command.deliveryMode,
					origin: "cli",
				});
				return success(command.id, "send_message", receipt);
			}

			case "agent_messages_status": {
				return success(command.id, "agent_messages_status", this.getAgentMessageSafetyStatus());
			}

			case "agent_messages_pause": {
				this.agentMessagesPaused = true;
				this.agentMessageRateLimiter.clear();
				await this.clearQueuedAgentSessionMessagesForAllStates();
				return success(command.id, "agent_messages_pause", this.getAgentMessageSafetyStatus());
			}

			case "agent_messages_resume": {
				this.agentMessagesPaused = false;
				return success(command.id, "agent_messages_resume", this.getAgentMessageSafetyStatus());
			}

			case "agent_messages_clear": {
				const state = this.getSessionState(command.activeSessionId);
				const cleared = await this.withAgentMessageTargetLock(state.activeSessionId, async () => {
					this.agentMessageRateLimiter.clearMatching((key) => key.endsWith(`->${state.activeSessionId}`));
					return state.runtime.session.clearQueuedUserMessagesMatching(isAgentSessionMessagePrompt);
				});
				return success(command.id, "agent_messages_clear", cleared);
			}

			case "abort": {
				const state = this.getSessionState(command.activeSessionId);
				await state.runtime.session.abort();
				return success(command.id, "abort");
			}

			case "execute_bash": {
				const state = this.getSessionState(command.activeSessionId);
				if (state.runtime.session.isBashRunning) {
					throw new Error("A bash command is already running");
				}
				// Respond before completion (bash can outlive the client request
				// timeout); output and completion stream via bash_* session events.
				void state.runtime.session
					.runUserBash(command.command, { excludeFromContext: command.excludeFromContext })
					.catch((error) => {
						this.broadcastToSession(
							state,
							failure(undefined, "execute_bash", error, serializeDaemonError(error)),
						);
					});
				return success(command.id, "execute_bash");
			}

			case "abort_bash": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortBash();
				return success(command.id, "abort_bash");
			}

			case "cancel_rlm_child": {
				const state = this.getSessionState(command.activeSessionId);
				const cancelled = state.runtime.session.cancelRlmChildRun(command.childId);
				return success(command.id, "cancel_rlm_child", { cancelled });
			}

			case "wait_for_idle": {
				const state = this.getSessionState(command.activeSessionId);
				await state.runtime.session.agent.waitForIdle();
				return success(command.id, "wait_for_idle");
			}

			case "get_state": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_state", summaryForActiveSession(state));
			}

			case "get_connection_state": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_connection_state", this.createConnectionState(state));
			}

			case "get_messages": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_messages", { messages: state.runtime.session.messages });
			}

			case "get_session_stats": {
				const state = this.getSessionState(command.activeSessionId);
				const stats: SessionStats = state.runtime.session.getSessionStats();
				return success(command.id, "get_session_stats", stats);
			}

			case "get_context_tree": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_context_tree", state.runtime.session.getContextTree());
			}

			case "get_commands": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_commands", {
					commands: createAgentConnectionCommands(state.runtime.session),
				});
			}

			case "get_resource_snapshot": {
				const state = this.getSessionState(command.activeSessionId);
				return success(
					command.id,
					"get_resource_snapshot",
					createAgentConnectionResourceSnapshot(state.runtime.session),
				);
			}

			case "get_available_models": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.modelRegistry.refresh();
				return success(command.id, "get_available_models", {
					models: state.runtime.session.modelRegistry.getAvailable(),
				});
			}

			case "get_queue": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_queue", {
					steering: [...state.runtime.session.getSteeringMessagePreviews()],
					followUp: [...state.runtime.session.getFollowUpMessagePreviews()],
				});
			}

			case "clear_queue": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "clear_queue", state.runtime.session.clearQueue());
			}

			case "cron_list": {
				const jobs = this.cronStore.list().filter((job) => {
					if (!command.includeInactive && job.status !== "active" && job.status !== "paused") {
						return false;
					}
					if (command.activeSessionId && job.activeSessionId !== command.activeSessionId) {
						return false;
					}
					return true;
				});
				return success(command.id, "cron_list", { jobs });
			}

			case "cron_add": {
				const state = this.getSessionState(command.activeSessionId);
				const job = this.createCronJobForState(state, command.schedule, command.prompt);
				return success(command.id, "cron_add", { job });
			}

			case "cron_cancel": {
				const job = this.cronStore.cancel(command.jobId);
				if (!job) {
					throw new Error(`No cron job found: ${command.jobId}`);
				}
				const state = this.sessions.get(job.activeSessionId);
				if (state) {
					this.removeQueuedHeartbeatFollowUp(state, job);
				}
				this.cronScheduler.wake();
				return success(command.id, "cron_cancel", { job });
			}

			case "heartbeat_get": {
				const state = this.getSessionState(command.activeSessionId);
				const heartbeat = this.cronStore.getHeartbeat(state.activeSessionId);
				return success(command.id, "heartbeat_get", { heartbeat: heartbeat ?? null });
			}

			case "heartbeat_set": {
				const state = this.getSessionState(command.activeSessionId);
				const heartbeat = this.createHeartbeatForState(state, command.schedule, command.prompt);
				return success(command.id, "heartbeat_set", { heartbeat });
			}

			case "heartbeat_update": {
				const state = this.getSessionState(command.activeSessionId);
				const heartbeat = this.updateHeartbeatForState(state, command.action);
				return success(command.id, "heartbeat_update", { heartbeat: heartbeat ?? null });
			}

			case "set_model": {
				const state = this.getSessionState(command.activeSessionId);
				const session = state.runtime.session;
				session.modelRegistry.refresh();
				const model = session.modelRegistry.getAvailable().find((candidate) => {
					return candidate.provider === command.provider && candidate.id === command.modelId;
				});
				if (!model) {
					throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(command.id, "set_model", model);
			}

			case "cycle_model": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.cycleModel(command.direction);
				return success(command.id, "cycle_model", result ?? null);
			}

			case "set_scoped_models": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setScopedModels(command.scopedModels);
				return success(command.id, "set_scoped_models");
			}

			case "set_thinking_level": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setThinkingLevel(command.level);
				return success(command.id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const state = this.getSessionState(command.activeSessionId);
				const level = state.runtime.session.cycleThinkingLevel();
				return success(command.id, "cycle_thinking_level", level ? { level } : null);
			}

			case "set_transport": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.settingsManager.setTransport(command.transport);
				state.runtime.session.agent.transport = command.transport;
				return success(command.id, "set_transport");
			}

			case "set_steering_mode": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setSteeringMode(command.mode);
				return success(command.id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setFollowUpMode(command.mode);
				return success(command.id, "set_follow_up_mode");
			}

			case "set_auto_compaction": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setAutoCompactionEnabled(command.enabled);
				return success(command.id, "set_auto_compaction");
			}

			case "compact": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.compact(command.customInstructions);
				return success(command.id, "compact", result);
			}

			case "refine": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.refine({
					instructions: command.instructions,
					rollbackId: command.rollbackId,
					global: command.global,
				});
				return success(command.id, "refine", result);
			}

			case "abort_compaction": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortCompaction();
				return success(command.id, "abort_compaction");
			}

			case "abort_branch_summary": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortBranchSummary();
				return success(command.id, "abort_branch_summary");
			}

			case "abort_retry": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortRetry();
				return success(command.id, "abort_retry");
			}

			case "reload": {
				const state = this.getSessionState(command.activeSessionId);
				// Reload re-evaluates extension modules, which capture client env
				// (e.g. herdr pane identity) synchronously at load.
				await withClientEnv(state.clientEnv, () => state.runtime.session.reload());
				return success(command.id, "reload");
			}

			case "new_session": {
				const state = this.getSessionState(command.activeSessionId);
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await state.runtime.newSession(options);
				this.rebindCronJobsToState(state);
				return success(command.id, "new_session", result);
			}

			case "switch_session": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.switchSession(command.sessionPath, {
					cwdOverride: command.cwdOverride,
				});
				this.rebindCronJobsToState(state);
				return success(command.id, "switch_session", result);
			}

			case "fork": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.fork(command.entryId, {
					position: command.position,
				});
				this.rebindCronJobsToState(state);
				return success(command.id, "fork", result);
			}

			case "navigate_tree": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.navigateTree(command.targetId, {
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
				});
				return success(command.id, "navigate_tree", result);
			}

			case "import_jsonl": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.importFromJsonl(command.inputPath, command.cwdOverride);
				return success(command.id, "import_jsonl", result);
			}

			case "export_html": {
				const state = this.getSessionState(command.activeSessionId);
				const path = await state.runtime.session.exportToHtml(command.outputPath);
				return success(command.id, "export_html", { path });
			}

			case "export_jsonl": {
				const state = this.getSessionState(command.activeSessionId);
				const path = state.runtime.session.exportToJsonl(command.outputPath);
				return success(command.id, "export_jsonl", { path });
			}

			case "set_session_name": {
				const state = this.getSessionState(command.activeSessionId);
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				state.runtime.session.setSessionName(name);
				return success(command.id, "set_session_name");
			}

			case "get_session_context": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_session_context", {
					context: state.runtime.session.sessionManager.buildSessionContext(),
				});
			}

			case "get_session_tree": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_session_tree", {
					tree: state.runtime.session.sessionManager.getTree(),
					leafId: state.runtime.session.sessionManager.getLeafId(),
				});
			}

			case "get_user_messages_for_forking": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_user_messages_for_forking", {
					messages: state.runtime.session.getUserMessagesForForking(),
				});
			}

			case "get_last_assistant_text": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_last_assistant_text", {
					text: state.runtime.session.getLastAssistantText(),
				});
			}

			case "get_system_prompt": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_system_prompt", {
					systemPrompt: state.runtime.session.systemPrompt,
				});
			}

			case "get_tool_definition": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_tool_definition", {
					toolDefinition: createAgentConnectionToolDefinition(
						state.runtime.session.getToolDefinition(command.name),
					),
				});
			}

			case "set_session_entry_label": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.sessionManager.appendLabelChange(command.entryId, command.label);
				return success(command.id, "set_session_entry_label");
			}

			case "extension_ui_response": {
				const state = this.getSessionState(command.activeSessionId);
				const pending = state.extensionUiRequests.get(command.requestId);
				if (!pending) {
					throw new Error(`Unknown extension UI request: ${command.requestId}`);
				}
				state.extensionUiRequests.delete(command.requestId);
				pending.resolve(command.response);
				return success(command.id, "extension_ui_response");
			}

			case "shutdown":
				this.log(`shutdown command received over socket; ${this.sessions.size} active session(s) will be closed`);
				setImmediate(() => {
					void this.shutdown(0);
				});
				return success(command.id, "shutdown");
		}
	}

	private createAttachResult(
		client: DaemonSocketClient,
		state: ActiveSessionState,
		command: Extract<DaemonCommand, { type: "attach" }>,
	): DaemonAttachResult {
		const snapshot = this.createSessionSnapshot(state);
		const replay =
			command.resumeCursor?.activeSessionId && command.resumeCursor.activeSessionId !== state.activeSessionId
				? {
						status: "unavailable" as const,
						fromSequence: command.resumeCursor.eventSequence,
						toSequence: state.lastEventSequence,
						reason: "resume_cursor_session_mismatch",
					}
				: createDaemonReplayInfo(command.resumeCursor, state.lastEventSequence);
		// Slim clients read summary/messages from the snapshot; duplicating them at
		// the top level would serialize the full history twice more per attach.
		const slim = client.capabilities.has("slim_attach");
		return {
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: state.activeSessionId,
			...(slim ? {} : { state: snapshot.summary, messages: snapshot.messages }),
			snapshot,
			replay,
			lastEventSequence: state.lastEventSequence,
			client: {
				id: client.id,
				capabilities: [...client.capabilities],
			},
		};
	}

	private createSessionSnapshot(state: ActiveSessionState): DaemonSessionSnapshot {
		const metadata = state.runtime.metadata;
		const parent =
			metadata.parentActiveSessionId || metadata.parentSessionId || metadata.rlmParentNodeId || metadata.rlmChildId
				? {
						...(metadata.parentActiveSessionId ? { activeSessionId: metadata.parentActiveSessionId } : {}),
						...(metadata.parentSessionId ? { sessionId: metadata.parentSessionId } : {}),
						...(metadata.rlmParentNodeId ? { nodeId: metadata.rlmParentNodeId } : {}),
						...(metadata.rlmChildId ? { childId: metadata.rlmChildId } : {}),
					}
				: undefined;
		const children = buildRlmChildSnapshots(state.activeSessionId, [...this.sessions.values()]);
		const connectionState = this.createConnectionState(state);
		return {
			activeSessionId: state.activeSessionId,
			summary: summaryForActiveSession(state),
			state: connectionState,
			messages: state.runtime.session.messages,
			// Omit duplicate heavy payloads from attach. The client can derive render
			// context from messages + state, and fetch the full session tree lazily
			// when the tree/branch selector opens.
			lastEventSequence: state.lastEventSequence,
			...(parent ? { parent } : {}),
			...(children.length > 0 ? { children } : {}),
		};
	}

	private createConnectionState(state: ActiveSessionState): ReturnType<typeof createAgentConnectionState> {
		const connectionState = createAgentConnectionState(state.runtime, state.activeSessionId);
		connectionState.heartbeat = this.cronStore.getLatestHeartbeat(state.activeSessionId) ?? null;
		if (state.summaryState?.summary) {
			connectionState.recap = state.summaryState.summary;
		}
		return connectionState;
	}

	private createAgentSessionMessageEndpoint(state: ActiveSessionState): AgentSessionMessageEndpoint {
		const metadata = state.runtime.metadata;
		return {
			activeSessionId: state.activeSessionId,
			sessionId: state.runtime.session.sessionId,
			...(state.runtime.session.sessionName ? { sessionName: state.runtime.session.sessionName } : {}),
			runtimeKind: metadata.kind,
		};
	}

	private createAgentSessionMessageSender(
		state: ActiveSessionState | undefined,
		clientId: string,
	): AgentSessionMessageSender {
		if (!state) {
			return { clientId };
		}
		return {
			...this.createAgentSessionMessageEndpoint(state),
			clientId,
		};
	}

	private createAgentMessageAgentSummary(state: ActiveSessionState): AgentSessionMessageAgentSummary {
		const metadata = state.runtime.metadata;
		return {
			...this.createAgentSessionMessageEndpoint(state),
			cwd: state.runtime.cwd,
			isStreaming: state.runtime.session.isStreaming,
			pendingMessageCount:
				state.runtime.session.pendingMessageCount + (state.runtime.session.hasAcceptedPromptInFlight ? 1 : 0),
			...(metadata.parentActiveSessionId ? { parentActiveSessionId: metadata.parentActiveSessionId } : {}),
			...(metadata.rlmChildId ? { rlmChildId: metadata.rlmChildId } : {}),
		};
	}

	private createAgentMessageListResult(current: ActiveSessionState): AgentSessionMessageListResult {
		return {
			current: this.createAgentSessionMessageEndpoint(current),
			agents: this.listTargetableSessionStates(current).map((state) => this.createAgentMessageAgentSummary(state)),
		};
	}

	// Half-bound sessions are hidden from other sessions' listings; the current
	// session stays visible to itself (controllers run during its own bind).
	private listTargetableSessionStates(current: ActiveSessionState): ActiveSessionState[] {
		return [...this.sessions.values()].filter(
			(state) =>
				state.activeSessionId === current.activeSessionId || !this.bindingSessions.has(state.activeSessionId),
		);
	}

	private getAgentMessageSafetyStatus() {
		return {
			paused: this.agentMessagesPaused,
			maxMessageChars: DEFAULT_AGENT_MESSAGE_MAX_CHARS,
			maxPendingPerSession: DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
			rateLimitCapacity: DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY,
			rateLimitRefillMs: DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS,
		};
	}

	private createCliAgentMessageSenderKey(): string {
		return `cli:${this.socketPath}`;
	}

	private async clearQueuedAgentSessionMessagesForState(state: ActiveSessionState) {
		return this.withAgentMessageTargetLock(state.activeSessionId, async () =>
			state.runtime.session.clearQueuedUserMessagesMatching(isAgentSessionMessagePrompt),
		);
	}

	private async clearQueuedAgentSessionMessagesForAllStates(): Promise<void> {
		await Promise.all(
			[...this.sessions.values()].map((state) => this.clearQueuedAgentSessionMessagesForState(state)),
		);
	}

	private reserveAgentMessageQueueSlot(targetState: ActiveSessionState): () => void {
		const activeSessionId = targetState.activeSessionId;
		const reserved = this.agentMessagePendingReservations.get(activeSessionId) ?? 0;
		assertAgentMessageQueueCapacity(
			targetState.runtime.session.pendingMessageCount +
				(targetState.runtime.session.hasAcceptedPromptInFlight ? 1 : 0) +
				reserved,
			DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
		);
		this.agentMessagePendingReservations.set(activeSessionId, reserved + 1);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const next = (this.agentMessagePendingReservations.get(activeSessionId) ?? 1) - 1;
			if (next <= 0) {
				this.agentMessagePendingReservations.delete(activeSessionId);
			} else {
				this.agentMessagePendingReservations.set(activeSessionId, next);
			}
		};
	}

	private async withAgentMessageTargetLock<T>(activeSessionId: string, run: () => Promise<T>): Promise<T> {
		const previous = this.agentMessageTargetLocks.get(activeSessionId) ?? Promise.resolve();
		let releaseCurrent: () => void = () => {};
		const current = new Promise<void>((resolve) => {
			releaseCurrent = resolve;
		});
		const next = previous.catch(() => undefined).then(() => current);
		this.agentMessageTargetLocks.set(activeSessionId, next);
		await previous.catch(() => undefined);
		try {
			return await run();
		} finally {
			releaseCurrent();
			if (this.agentMessageTargetLocks.get(activeSessionId) === next) {
				this.agentMessageTargetLocks.delete(activeSessionId);
			}
		}
	}

	private async sendAgentSessionMessage(options: {
		targetSelector: string;
		message: string;
		fromState?: ActiveSessionState;
		clientId?: string;
		senderKey?: string;
		deliveryMode?: AgentSessionMessagePayload["deliveryMode"];
		origin: "agent" | "cli";
	}): Promise<AgentSessionMessageReceipt> {
		if (this.agentMessagesPaused) {
			throw new Error("Agent messaging is paused");
		}
		const targetSelector = assertDirectAgentMessageTarget(options.targetSelector);
		const targetState = this.getBoundSessionState(targetSelector);
		if (options.fromState?.activeSessionId === targetState.activeSessionId) {
			throw new Error("Agent messaging cannot target the sending session");
		}
		const message = normalizeAgentSessionMessage(options.message, DEFAULT_AGENT_MESSAGE_MAX_CHARS);
		const releaseQueueSlot = this.reserveAgentMessageQueueSlot(targetState);
		const senderKey =
			options.senderKey ?? options.fromState?.activeSessionId ?? `client:${options.clientId ?? "unknown"}`;
		const rateLimitKey = `${senderKey}->${targetState.activeSessionId}`;
		const rateLimit = this.agentMessageRateLimiter.tryConsume(rateLimitKey);
		if (!rateLimit.ok) {
			releaseQueueSlot();
			throw new Error(`Agent messaging rate limit exceeded; retry after ${rateLimit.retryAfterMs}ms`);
		}
		const payload: AgentSessionMessagePayload = {
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message,
			from: this.createAgentSessionMessageSender(options.fromState, options.clientId ?? options.origin),
			target: this.createAgentSessionMessageEndpoint(targetState),
			deliveryMode: options.deliveryMode ?? "auto",
		};
		try {
			const { status } = await this.withAgentMessageTargetLock(targetState.activeSessionId, async () => {
				if (this.agentMessagesPaused) {
					throw new Error("Agent messaging is paused");
				}
				if (
					!this.sessions.has(targetState.activeSessionId) ||
					this.closingSessions.has(targetState.activeSessionId)
				) {
					throw new Error("Target session is closing before agent message delivery");
				}
				if (targetState.runtime.session.sessionId !== payload.target.sessionId) {
					throw new Error("Target session changed before agent message delivery");
				}
				return this.acceptAgentSessionMessage(targetState, payload, releaseQueueSlot);
			});
			return createAgentSessionMessageReceipt(payload, status);
		} catch (error) {
			this.agentMessageRateLimiter.refund(rateLimitKey);
			throw error;
		} finally {
			// Error-path backstop; success paths release inside acceptAgentSessionMessage.
			releaseQueueSlot();
		}
	}

	private async acceptAgentSessionMessage(
		targetState: ActiveSessionState,
		payload: AgentSessionMessagePayload,
		releaseReservation: () => void,
	): Promise<{ status: AgentSessionMessageDeliveryStatus }> {
		const session = targetState.runtime.session;
		const reserved = this.agentMessagePendingReservations.get(targetState.activeSessionId) ?? 0;
		const otherReservations = Math.max(0, reserved - 1);
		assertAgentMessageQueueCapacity(
			session.pendingMessageCount + (session.hasAcceptedPromptInFlight ? 1 : 0) + otherReservations,
			DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
		);
		const shouldQueue =
			this.agentMessageAcceptingTargets.has(targetState.activeSessionId) ||
			this.agentMessagePreparingTargets.has(targetState.activeSessionId) ||
			session.isStreaming ||
			session.isCompacting ||
			session.isRetrying ||
			session.isBashRunning ||
			session.hasAcceptedPromptInFlight ||
			session.pendingMessageCount > 0;
		const streamingBehavior =
			resolveAgentSessionMessageStreamingBehavior(shouldQueue, payload.deliveryMode) ??
			(payload.deliveryMode === "steer" ? "steer" : "followUp");
		const prompt = createAgentSessionMessagePrompt(payload);

		if (shouldQueue) {
			const didQueue = await session.queueAgentMessagePrompt(prompt, streamingBehavior);
			if (!didQueue) {
				throw new Error("Agent message was not queued");
			}
			// The queued message now counts in pendingMessageCount.
			releaseReservation();
			// Do not await delivery: a queued message delivers only when the target's
			// turn progresses, and the sender is blocked inside its own turn — awaiting
			// here deadlocks mutual sends between busy sessions.
			return { status: "queued" };
		}

		this.agentMessageAcceptingTargets.add(targetState.activeSessionId);
		let preflightFailed = false;
		let preflightQueued = false;
		try {
			const acceptPrompt =
				typeof session.acceptAgentMessagePrompt === "function"
					? session.acceptAgentMessagePrompt.bind(session)
					: session.prompt.bind(session);
			await acceptPrompt(prompt, {
				expandPromptTemplates: false,
				streamingBehavior,
				queueIfBusy: true,
				preflightResult: (didSucceed, didQueue) => {
					preflightFailed = !didSucceed;
					preflightQueued = didSucceed && didQueue === true;
				},
			});
			if (preflightFailed) {
				throw new Error("Agent message was not accepted");
			}
			releaseReservation();
			return { status: preflightQueued ? "queued" : "delivered" };
		} finally {
			this.agentMessageAcceptingTargets.delete(targetState.activeSessionId);
		}
	}

	private detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void {
		detachClientFromActiveSession(client, state);
		this.write(client, { type: "session_detached", activeSessionId: state.activeSessionId });
		// Abandoned new-chat: discard it so it doesn't linger in memory or leave an
		// empty file. Replaces the old DeferredAgentConnection.
		if (this.isDiscardableDraft(state)) {
			// Re-check after yielding: a client may reattach before the async close
			// runs, in which case the draft is no longer abandoned and must be kept.
			queueMicrotask(() => {
				if (this.sessions.has(state.activeSessionId) && this.isDiscardableDraft(state)) {
					void this.closeSession(state, "killed");
				}
			});
		}
	}

	private isDiscardableDraft(state: ActiveSessionState): boolean {
		if (state.clients.size > 0) {
			return false;
		}
		if (state.runtime.metadata.kind === "subagent") {
			return false;
		}
		// A running bash or in-flight turn means there is live work to preserve.
		if (state.runtime.session.isBashRunning || isActiveSessionBusy(state)) {
			return false;
		}
		return this.isEmptyDraftContent(state);
	}

	/**
	 * True when a session holds nothing worth persisting: no messages, no user
	 * config (model/name/etc.), and no scheduled jobs. Shared by the detach-time
	 * discard and the close-time file deletion so both agree on what an abandoned
	 * draft is.
	 */
	private isEmptyDraftContent(state: ActiveSessionState): boolean {
		const session = state.runtime.session;
		if (session.messages.length > 0 || session.sessionManager.hasUserContent()) {
			return false;
		}
		return !this.hasScheduledJobsForSession(state.activeSessionId);
	}

	private hasScheduledJobsForSession(activeSessionId: string): boolean {
		return this.cronStore
			.list()
			.some(
				(job) =>
					job.activeSessionId === activeSessionId && job.status !== "cancelled" && job.status !== "completed",
			);
	}

	private detachClient(client: DaemonSocketClient): void {
		for (const activeSessionId of [...client.attachedActiveSessionIds]) {
			const state = this.sessions.get(activeSessionId);
			if (state) {
				this.detachClientFromSession(client, state);
			}
		}
	}

	private findActiveSessionByFile(sessionPath: string): ActiveSessionState | undefined {
		const resolvedSessionPath = resolve(sessionPath);
		for (const state of this.sessions.values()) {
			const sessionFile = state.runtime.session.sessionFile;
			if (sessionFile && resolve(sessionFile) === resolvedSessionPath) {
				return state;
			}
		}
		return undefined;
	}

	private async closeSession(state: ActiveSessionState, reason: DaemonSessionClosedReason): Promise<void> {
		const existingClose = this.closingSessions.get(state.activeSessionId);
		if (existingClose) {
			await existingClose;
			return;
		}
		const closePromise = Promise.resolve().then(() => this.closeSessionOnce(state, reason));
		this.closingSessions.set(state.activeSessionId, closePromise);
		try {
			await closePromise;
		} finally {
			this.closingSessions.delete(state.activeSessionId);
		}
	}

	private async closeSessionOnce(state: ActiveSessionState, reason: DaemonSessionClosedReason): Promise<void> {
		if (!this.sessions.has(state.activeSessionId)) {
			return;
		}
		this.cancelSubagentRlmHeartbeats(state);
		// Abort in-flight status work before any await/dispose so it can't write
		// agent_status to a session being torn down.
		this.summarizer.forget(state.activeSessionId);
		const cascadeError = await this.closeChildSessions(state, reason);
		// Empty draft (no messages, config, or jobs): discard rather than persist an
		// empty session file. Mirrors the detach-time discard so a config-bearing
		// draft closed via kill/completed is never wiped.
		const isEmptyDraftSession = reason !== "shutdown" && this.isEmptyDraftContent(state);
		let persistError: unknown;
		// Clean shutdown leaves the session un-archived so it stays in the resume list.
		if (reason !== "shutdown" && !isEmptyDraftSession) {
			try {
				state.runtime.session.sessionManager.appendSessionState({ status: "archived" });
			} catch (error) {
				persistError = error;
			}
		}
		cancelPendingExtensionUiRequests(state);
		if (reason === "killed" || reason === "shutdown" || reason === "replaced") {
			await state.runtime.session.abort().catch(() => undefined);
		}
		state.unsubscribe?.();
		await state.runtime.dispose();
		this.broadcastToSession(state, { type: "session_closed", activeSessionId: state.activeSessionId, reason });
		for (const client of state.clients) {
			client.attachedActiveSessionIds.delete(state.activeSessionId);
		}
		state.clients.clear();
		this.sessions.delete(state.activeSessionId);
		if (isEmptyDraftSession) {
			const sessionFile = state.runtime.session.sessionFile;
			if (sessionFile) {
				await deleteSessionFile(sessionFile).catch(() => undefined);
			}
		}
		if (persistError && reason !== "shutdown" && reason !== "completed") {
			throw persistError;
		}
		if (cascadeError && reason !== "shutdown" && reason !== "completed") {
			throw cascadeError;
		}
	}

	private async closeChildSessions(
		parentState: ActiveSessionState,
		reason: DaemonSessionClosedReason,
	): Promise<unknown> {
		let cascadeError: unknown;
		for (const childState of getChildActiveSessionStates(this.sessions, parentState)) {
			try {
				await this.closeSession(childState, reason);
			} catch (error) {
				cascadeError ??= error;
			}
		}
		return cascadeError;
	}

	private broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void {
		if (message.type === "session_event") {
			const eventType = message.event.type;
			// A finished turn/compaction is the cue to refresh status.
			if (eventType === "turn_end" || eventType === "compaction_end") {
				this.summarizer.notifyActivity(state);
			}
			// A draft whose last client detached while it was busy isn't discardable
			// at detach time; re-check once any work (turn, compaction, or bash)
			// settles so it doesn't linger in the daemon.
			if (
				(eventType === "turn_end" || eventType === "compaction_end" || eventType === "bash_end") &&
				this.isDiscardableDraft(state)
			) {
				void this.closeSession(state, "killed");
			}
		}
		this.stampRlmChildActiveSessionId(message);
		const sequencedMessage = this.addSessionEventMeta(state, message);
		for (const client of state.clients) {
			if (!shouldSendDaemonOutboundToClient(client, sequencedMessage)) {
				continue;
			}
			this.write(client, sequencedMessage);
		}
	}

	// The AgentSession doesn't know its own daemon active-session id, so fill it in here.
	private stampRlmChildActiveSessionId(message: DaemonOutbound): void {
		if (
			message.type !== "session_event" ||
			message.event.type !== "rlm_child_update" ||
			message.event.child.activeSessionId
		) {
			return;
		}
		const childId = message.event.child.id;
		for (const candidate of this.sessions.values()) {
			if (candidate.runtime.metadata.rlmChildId === childId) {
				message.event.child.activeSessionId = candidate.activeSessionId;
				return;
			}
		}
	}

	private addSessionEventMeta(state: ActiveSessionState, message: DaemonOutbound): DaemonOutbound {
		if (!isSequencedSessionOutbound(message) || message.meta) {
			return message;
		}
		const meta = createDaemonEventMeta(state.activeSessionId, state.lastEventSequence + 1);
		state.lastEventSequence = meta.sequence ?? state.lastEventSequence;
		return { ...message, meta };
	}

	private write(client: DaemonSocketClient, message: DaemonOutbound): void {
		if (client.socket.destroyed) {
			return;
		}
		client.socket.write(serializeJsonLine(message));
	}

	private registerSignalHandlers(): void {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => {
				this.log(`received ${signal}; shutting down`);
				killTrackedDetachedChildren();
				void this.shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const exitHandler = () => this.cleanupSocketPath();
		process.on("exit", exitHandler);
		this.signalCleanupHandlers.push(() => process.off("exit", exitHandler));
	}

	private async shutdown(exitCode: number): Promise<never> {
		if (this.shuttingDown) {
			process.exit(exitCode);
		}
		this.shuttingDown = true;
		this.log(`shutting down (exit ${exitCode}); closing ${this.sessions.size} active session(s)`);

		this.summarizer.stop();
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.cronScheduler.stop();
		for (const state of [...this.sessions.values()]) {
			await this.closeSession(state, "shutdown");
		}
		for (const client of this.clients) {
			client.detachInput();
			client.socket.end();
		}
		await new Promise<void>((resolveClose) => {
			if (!this.server) {
				resolveClose();
				return;
			}
			this.server.close(() => resolveClose());
		});
		this.cleanupSocketPath();
		process.exit(exitCode);
	}
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
	};
}

export function getChildActiveSessionStates(
	sessions: ReadonlyMap<string, ActiveSessionState>,
	parentState: ActiveSessionState,
): ActiveSessionState[] {
	return [...sessions.values()].filter(
		(state) =>
			state.activeSessionId !== parentState.activeSessionId &&
			state.runtime.metadata.parentActiveSessionId === parentState.activeSessionId,
	);
}

export function detachClientFromActiveSession(client: DaemonSocketClient, state: ActiveSessionState): void {
	state.clients.delete(client);
	client.attachedActiveSessionIds.delete(state.activeSessionId);
	if (state.clients.size === 0) {
		cancelPendingExtensionUiRequests(state);
	}
}

export function cancelPendingExtensionUiRequests(state: ActiveSessionState): void {
	const pendingRequests = [...state.extensionUiRequests.values()];
	state.extensionUiRequests.clear();
	for (const pending of pendingRequests) {
		pending.resolve({ cancelled: true });
	}
}

function normalizeClientCapabilities(
	capabilities: readonly DaemonClientCapability[] | undefined,
	supportsExtensionUi: boolean | undefined,
): Set<DaemonClientCapability> {
	const normalized = new Set<DaemonClientCapability>();
	for (const capability of capabilities ?? DAEMON_DEFAULT_CLIENT_CAPABILITIES) {
		if (DAEMON_CLIENT_CAPABILITY_SET.has(capability)) {
			normalized.add(capability);
		}
	}
	if (supportsExtensionUi) {
		normalized.add("extension_ui");
	}
	return normalized;
}

type SequencedDaemonOutbound = Extract<
	DaemonOutbound,
	{
		type:
			| "session_event"
			| "session_status"
			| "session_replaced"
			| "session_closed"
			| "extension_ui_request"
			| "extension_error";
	}
>;

function isSequencedSessionOutbound(message: DaemonOutbound): message is SequencedDaemonOutbound {
	return (
		message.type === "session_event" ||
		message.type === "session_status" ||
		message.type === "session_replaced" ||
		message.type === "session_closed" ||
		message.type === "extension_ui_request" ||
		message.type === "extension_error"
	);
}

export function shouldSendDaemonOutboundToClient(client: DaemonSocketClient, message: DaemonOutbound): boolean {
	return (
		message.type !== "extension_ui_request" ||
		!isDaemonDialogExtensionUiRequest(message.method) ||
		client.supportsExtensionUi
	);
}

export async function resolveDaemonSessionPath(selector: string, cwd: string, sessionDir?: string): Promise<string> {
	if (looksLikeSessionPath(selector)) {
		return selector;
	}

	const localMatches = (await SessionManager.list(cwd, sessionDir)).filter((session) =>
		session.id.startsWith(selector),
	);
	const localMatch = resolveUniqueSavedSessionMatch(selector, localMatches);
	if (localMatch) {
		return localMatch.path;
	}

	const allSessions =
		sessionDir !== undefined ? await SessionManager.listAll(undefined, sessionDir) : await SessionManager.listAll();
	const globalMatches = allSessions.filter((session) => session.id.startsWith(selector));
	const globalMatch = resolveUniqueSavedSessionMatch(selector, globalMatches);
	if (globalMatch) {
		return globalMatch.path;
	}

	throw new Error(`No session found matching "${selector}"`);
}

function resolveUniqueSavedSessionMatch(selector: string, matches: readonly SessionInfo[]): SessionInfo | undefined {
	if (matches.length === 0) {
		return undefined;
	}
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous saved session "${selector}": matches ${matches
				.map((session) => `${session.id}${session.name ? ` (${session.name})` : ""}`)
				.join(", ")}`,
		);
	}
	return matches[0];
}

function looksLikeSessionPath(selector: string): boolean {
	return selector.includes("/") || selector.includes("\\") || selector.endsWith(".jsonl");
}
