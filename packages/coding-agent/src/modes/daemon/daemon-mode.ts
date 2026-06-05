/**
 * Background daemon mode.
 *
 * The daemon owns live AgentSessionRuntime instances and exposes a small JSONL
 * protocol over a local socket. Clients can attach/detach from sessions without
 * disposing the underlying agent loop.
 */

import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.js";
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
import { buildSessionList, summaryForActiveSession } from "./daemon-session-list.js";
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
export type { SessionStatus, SessionSummary } from "./daemon-session-list.js";
export { defaultDaemonSocketPath } from "./daemon-socket.js";

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
	"abort",
	"wait_for_idle",
	"get_state",
	"get_connection_state",
	"get_messages",
	"get_session_stats",
	"get_commands",
	"get_resource_snapshot",
	"get_available_models",
	"get_queue",
	"clear_queue",
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
	"get_tool_definition",
	"set_session_entry_label",
	"extension_ui_response",
	"shutdown",
]);

const DAEMON_SERVER_CAPABILITIES: readonly DaemonClientCapability[] = [
	"attach_snapshot",
	"event_sequence",
	"extension_ui",
];

const DAEMON_CLIENT_CAPABILITY_SET: ReadonlySet<string> = new Set(DAEMON_SERVER_CAPABILITIES);

export async function runDaemonMode(initialRuntime: AgentSessionRuntime, options: DaemonModeOptions): Promise<never> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	// main() creates a runtime before dispatching modes. Daemon mode should not
	// expose that bootstrap runtime as a user session; live sessions are created
	// explicitly through the daemon protocol.
	await initialRuntime.dispose();
	const daemon = new AgentDaemon(socketPath, options);
	await daemon.start();
	return new Promise(() => {});
}

class AgentDaemon {
	private server?: Server;
	private shuttingDown = false;
	private ownsSocketPath = false;
	private readonly clients = new Set<DaemonSocketClient>();
	private readonly sessions = new Map<string, ActiveSessionState>();
	private readonly closingSessions = new Map<string, Promise<void>>();
	private readonly signalCleanupHandlers: Array<() => void> = [];

	constructor(
		private readonly socketPath: string,
		private readonly options: DaemonModeOptions,
	) {}

	async start(): Promise<void> {
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
		console.error(`Prime Agent daemon listening on ${this.socketPath}`);
	}

	private cleanupSocketPath(): void {
		if (!this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		cleanupDaemonSocketPath(this.socketPath);
	}

	private async addRuntime(runtime: AgentSessionRuntime, name?: string): Promise<ActiveSessionState> {
		const state: ActiveSessionState = {
			activeSessionId: createActiveSessionId(this.sessions),
			runtime,
			clients: new Set(),
			extensionUiRequests: new Map(),
			lastEventSequence: 0,
		};
		try {
			await bindActiveSessionState(state, {
				broadcast: (targetSessionState, message) => this.broadcastToSession(targetSessionState, message),
				shutdown: () => {
					void this.shutdown(0);
				},
				subagentRuntimeHost: this.createSubagentRuntimeHost(state),
			});
		} catch (error) {
			state.unsubscribe?.();
			await runtime.dispose().catch(() => undefined);
			throw error;
		}
		this.sessions.set(state.activeSessionId, state);
		if (name) {
			state.runtime.session.setSessionName(name);
		}
		return state;
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
		const cwdOverride = command.config?.cwd ? resolve(command.config.cwd) : undefined;
		const sessionPath = command.sessionPath
			? await resolveDaemonSessionPath(command.sessionPath, cwd, config.sessionDir)
			: undefined;
		const sessionManager = sessionPath
			? SessionManager.open(sessionPath, config.sessionDir, cwdOverride)
			: command.continueRecent
				? SessionManager.continueRecent(cwd, config.sessionDir)
				: SessionManager.create(cwd, config.sessionDir);
		const runtime = await createAgentSessionRuntime(this.options.createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: config.agentDir,
			sessionManager,
			sessionConfig: config,
		});
		return this.addRuntime(runtime, command.name);
	}

	private getSessionState(id: string): ActiveSessionState {
		return resolveActiveSessionState(this.sessions, id);
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
			releaseRlmSubagentRuntime: async (runtime) => {
				const state = this.findRuntimeState(runtime);
				if (state) {
					await this.closeSession(state, "completed");
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
		const runtime = await createAgentSessionRuntime(this.options.createRuntime, {
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
				includeGoalTools: options.includeGoalTools,
				autoActivateGoalTools: options.autoActivateGoalTools,
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
				sessionDir: options.sessionDir,
			},
		});
		await this.addRuntime(runtime);
		return runtime;
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
				const state = this.getSessionState(command.activeSessionId);
				if (command.clientId) {
					client.id = command.clientId;
				}
				client.capabilities = normalizeClientCapabilities(command.capabilities, command.supportsExtensionUi);
				client.supportsExtensionUi = client.capabilities.has("extension_ui");
				state.clients.add(client);
				client.attachedActiveSessionIds.add(state.activeSessionId);
				const result = this.createAttachResult(client, state, command);
				this.write(client, {
					type: "session_attached",
					activeSessionId: state.activeSessionId,
					state: result.state,
					messages: result.messages,
					snapshot: result.snapshot,
					replay: result.replay,
					lastEventSequence: result.lastEventSequence,
				});
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
				this.getSessionState(command.activeSessionId);
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
				void state.runtime.session
					.prompt(command.message, {
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

			case "abort": {
				const state = this.getSessionState(command.activeSessionId);
				await state.runtime.session.abort();
				return success(command.id, "abort");
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
				return success(
					command.id,
					"get_connection_state",
					createAgentConnectionState(state.runtime, state.activeSessionId),
				);
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
					steering: [...state.runtime.session.getSteeringMessages()],
					followUp: [...state.runtime.session.getFollowUpMessages()],
				});
			}

			case "clear_queue": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "clear_queue", state.runtime.session.clearQueue());
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
				await state.runtime.session.reload();
				return success(command.id, "reload");
			}

			case "new_session": {
				const state = this.getSessionState(command.activeSessionId);
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await state.runtime.newSession(options);
				return success(command.id, "new_session", result);
			}

			case "switch_session": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.switchSession(command.sessionPath, {
					cwdOverride: command.cwdOverride,
				});
				return success(command.id, "switch_session", result);
			}

			case "fork": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.fork(command.entryId, {
					position: command.position,
				});
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
		return {
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: state.activeSessionId,
			state: snapshot.summary,
			messages: snapshot.messages,
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
		const sessionManager = state.runtime.session.sessionManager;
		const parent =
			metadata.parentActiveSessionId || metadata.parentSessionId || metadata.rlmParentNodeId || metadata.rlmChildId
				? {
						...(metadata.parentActiveSessionId ? { activeSessionId: metadata.parentActiveSessionId } : {}),
						...(metadata.parentSessionId ? { sessionId: metadata.parentSessionId } : {}),
						...(metadata.rlmParentNodeId ? { nodeId: metadata.rlmParentNodeId } : {}),
						...(metadata.rlmChildId ? { childId: metadata.rlmChildId } : {}),
					}
				: undefined;
		return {
			activeSessionId: state.activeSessionId,
			summary: summaryForActiveSession(state),
			state: createAgentConnectionState(state.runtime, state.activeSessionId),
			messages: state.runtime.session.messages,
			sessionContext: sessionManager.buildSessionContext(),
			sessionTree: {
				tree: sessionManager.getTree(),
				leafId: sessionManager.getLeafId(),
			},
			lastEventSequence: state.lastEventSequence,
			...(parent ? { parent } : {}),
		};
	}

	private detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void {
		detachClientFromActiveSession(client, state);
		this.write(client, { type: "session_detached", activeSessionId: state.activeSessionId });
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
		const cascadeError = await this.closeChildSessions(state, reason);
		let persistError: unknown;
		try {
			state.runtime.session.sessionManager.appendSessionState({ status: "sleep" });
		} catch (error) {
			persistError = error;
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
		const sequencedMessage = this.addSessionEventMeta(state, message);
		for (const client of state.clients) {
			if (!shouldSendDaemonOutboundToClient(client, sequencedMessage)) {
				continue;
			}
			this.write(client, sequencedMessage);
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

		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
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
		type: "session_event" | "session_replaced" | "session_closed" | "extension_ui_request" | "extension_error";
	}
>;

function isSequencedSessionOutbound(message: DaemonOutbound): message is SequencedDaemonOutbound {
	return (
		message.type === "session_event" ||
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
