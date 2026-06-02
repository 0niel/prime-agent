/**
 * Background daemon mode.
 *
 * The daemon owns live AgentSessionRuntime instances and exposes a small JSONL
 * protocol over a local socket. Clients can attach/detach from sessions without
 * disposing the underlying agent loop.
 */

import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import type { SessionStats } from "../../core/agent-session.js";
import { mergeAgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import { type AgentSessionRuntime, createAgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { type SessionInfo, SessionManager } from "../../core/session-manager.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type { RpcSlashCommand } from "../rpc/rpc-types.js";
import {
	type ActiveSessionState,
	createActiveSessionId,
	type DaemonSocketClient,
	resolveActiveSessionState,
} from "./active-session-state.js";
import { bindActiveSessionState } from "./daemon-extension-binding.js";
import {
	type DaemonCommand,
	type DaemonModeOptions,
	type DaemonOutbound,
	type DaemonResponse,
	failure,
	success,
} from "./daemon-protocol.js";
import { buildSessionList, summaryForActiveSession } from "./daemon-session-list.js";
import {
	cleanupDaemonSocketPath,
	defaultDaemonSocketPath,
	prepareDaemonSocketPath,
	restrictDaemonSocketPath,
} from "./daemon-socket.js";

export type { DaemonCommand, DaemonModeOptions, DaemonOutbound, DaemonResponse } from "./daemon-protocol.js";
export type { SessionStatus, SessionSummary } from "./daemon-session-list.js";
export { defaultDaemonSocketPath } from "./daemon-socket.js";

const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"list",
	"create",
	"attach",
	"detach",
	"kill",
	"rename",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"get_state",
	"get_messages",
	"get_session_stats",
	"get_commands",
	"shutdown",
]);

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
		};
		try {
			await bindActiveSessionState(state, {
				broadcast: (targetSessionState, message) => this.broadcastToSession(targetSessionState, message),
				shutdown: () => {
					void this.shutdown(0);
				},
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

	private handleConnection(socket: Socket): void {
		const client: DaemonSocketClient = {
			id: createActiveSessionId(),
			socket,
			attachedActiveSessionIds: new Set(),
			detachInput: () => {},
		};
		this.clients.add(client);
		this.write(client, { type: "daemon_hello", socketPath: this.socketPath });

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
			this.write(client, failure(undefined, "parse", error));
			return;
		}

		try {
			const response = await this.handleCommand(client, command);
			if (response) {
				this.write(client, response);
			}
		} catch (error) {
			this.write(client, failure(command.id, command.type, error));
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

			case "create": {
				const state = await this.createRuntime(command);
				return success(command.id, "create", summaryForActiveSession(state));
			}

			case "attach": {
				const state = this.getSessionState(command.activeSessionId);
				state.clients.add(client);
				client.attachedActiveSessionIds.add(state.activeSessionId);
				this.write(client, {
					type: "session_attached",
					activeSessionId: state.activeSessionId,
					state: summaryForActiveSession(state),
					messages: state.runtime.session.messages,
				});
				return success(command.id, "attach", summaryForActiveSession(state));
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
				await this.killSession(state, "killed");
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
							this.broadcastToSession(state, failure(undefined, "prompt", error));
						} else {
							this.write(client, failure(command.id, "prompt", error));
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

			case "get_state": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_state", summaryForActiveSession(state));
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
				const session = state.runtime.session;
				const commands: RpcSlashCommand[] = [
					...session.extensionRunner.getRegisteredCommands().map((entry) => ({
						name: entry.invocationName,
						description: entry.description,
						source: "extension" as const,
						sourceInfo: entry.sourceInfo,
					})),
					...session.promptTemplates.map((entry) => ({
						name: entry.name,
						description: entry.description,
						source: "prompt" as const,
						sourceInfo: entry.sourceInfo,
					})),
					...session.resourceLoader.getSkills().skills.map((entry) => ({
						name: `skill:${entry.name}`,
						description: entry.description,
						source: "skill" as const,
						sourceInfo: entry.sourceInfo,
					})),
				];
				return success(command.id, "get_commands", { commands });
			}

			case "shutdown":
				setImmediate(() => {
					void this.shutdown(0);
				});
				return success(command.id, "shutdown");
		}
	}

	private detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void {
		state.clients.delete(client);
		client.attachedActiveSessionIds.delete(state.activeSessionId);
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

	private async killSession(state: ActiveSessionState, reason: "killed" | "shutdown"): Promise<void> {
		let persistError: unknown;
		try {
			state.runtime.session.sessionManager.appendSessionState({ status: "sleep" });
		} catch (error) {
			persistError = error;
		}
		state.unsubscribe?.();
		await state.runtime.dispose();
		this.broadcastToSession(state, { type: "session_closed", activeSessionId: state.activeSessionId, reason });
		for (const client of state.clients) {
			client.attachedActiveSessionIds.delete(state.activeSessionId);
		}
		state.clients.clear();
		this.sessions.delete(state.activeSessionId);
		if (persistError && reason !== "shutdown") {
			throw persistError;
		}
	}

	private broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void {
		for (const client of state.clients) {
			this.write(client, message);
		}
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
			await this.killSession(state, "shutdown");
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
