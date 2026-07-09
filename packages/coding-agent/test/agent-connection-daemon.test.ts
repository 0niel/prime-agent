import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MissingSessionCwdError } from "../src/core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../src/core/session-import-errors.js";
import {
	DAEMON_REFINE_REQUEST_TIMEOUT_MS,
	DaemonAgentConnection,
} from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionEvent, AgentConnectionState } from "../src/modes/agent-connection/types.js";
import type {
	DaemonClient,
	DaemonClientCloseListener,
	DaemonClientMessageListener,
	DaemonClientRequestOptions,
} from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";

class FakeDaemonClient {
	readonly requests: DaemonCommand[] = [];
	readonly requestTimeouts: number[] = [];
	attachResultFactory: ((command: Extract<DaemonCommand, { type: "attach" }>) => DaemonAttachResult) | undefined;
	closeCount = 0;
	abortBashUnknownCommand = false;
	abortAndClearQueueUnknownCommand = false;
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();

	async request(
		command: DaemonCommand,
		timeoutMs = 30000,
		options: DaemonClientRequestOptions = {},
	): Promise<DaemonResponse> {
		this.requests.push(command);
		this.requestTimeouts.push(timeoutMs);
		switch (command.type) {
			case "attach":
				if (command.activeSessionId === "missing") {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown active session: missing",
					};
				}
				return {
					type: "response",
					command: command.type,
					success: true,
					data:
						this.attachResultFactory?.(command) ??
						createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12),
				};
			case "get_queue":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { steering: ["steer"], followUp: ["follow"] },
				};
			case "get_connection_state":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: createConnectionState(command.activeSessionId, "session-current"),
				};
			case "get_messages":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { messages: [{ role: "user", content: "current prompt", timestamp: 4 }] },
				};
			case "get_resource_snapshot":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						contextFiles: [{ path: "/tmp/AGENTS.md" }],
						skills: [
							{
								name: "demo-skill",
								description: "Demo skill",
								filePath: "/tmp/skills/demo-skill/SKILL.md",
								sourceInfo: {
									path: "/tmp/skills/demo-skill/SKILL.md",
									source: "local",
									scope: "project",
									origin: "top-level",
									baseDir: "/tmp/skills",
								},
							},
						],
						prompts: [],
						extensions: [],
						themes: [],
						diagnostics: {
							skills: [],
							prompts: [],
							extensions: [],
							themes: [],
						},
					},
				};
			case "get_session_context":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						context: {
							messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
							thinkingLevel: "medium",
							model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
						},
					},
				};
			case "get_session_tree":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						tree: [
							{
								entry: {
									type: "message",
									id: "user-1",
									parentId: null,
									timestamp: "2026-01-01T00:00:00.000Z",
									message: { role: "user", content: "hello", timestamp: 1 },
								},
								children: [],
							},
						],
						leafId: "user-1",
					},
				};
			case "get_tool_definition":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						toolDefinition: {
							name: command.name,
							label: command.name,
							description: `${command.name} description`,
							promptSnippet: `${command.name} prompt`,
							promptGuidelines: [`Use ${command.name}`],
							parameters: { type: "object" },
							renderShell: "self",
						},
					},
				};
			case "clear_queue":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { steering: ["cleared"], followUp: [] },
				};
			case "abort_and_clear_queue":
				if (this.abortAndClearQueueUnknownCommand) {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: abort_and_clear_queue",
					};
				}
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { steering: ["aborted"], followUp: ["cleared"] },
				};
			case "list_saved_sessions":
				options.onProgress?.({
					id: "daemon_test",
					type: "session_list_progress",
					command: "list_saved_sessions",
					activeSessionId: command.activeSessionId,
					loaded: 1,
					total: 2,
				});
				options.onProgress?.({
					id: "daemon_test",
					type: "session_list_progress",
					command: "list_saved_sessions",
					activeSessionId: command.activeSessionId,
					loaded: 2,
					total: 2,
				});
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						sessions: [
							{
								path: "/tmp/session-a.jsonl",
								id: "session-a",
								cwd: "/tmp",
								name: "Saved session",
								created: "2026-01-01T00:00:00.000Z",
								modified: "2026-01-02T00:00:00.000Z",
								messageCount: 2,
								firstMessage: "hello",
								allMessagesText: "hello world",
							},
						],
					},
				};
			case "wait_for_idle":
			case "set_scoped_models":
			case "rename_saved_session":
			case "extension_ui_response":
			case "detach":
				return { type: "response", command: command.type, success: true };
			case "cancel_rlm_child":
				if (command.childId === "stale-daemon") {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: cancel_rlm_child",
					};
				}
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { cancelled: command.childId === "child-1" },
				};
			case "execute_bash":
				if (command.command === "stale-daemon") {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: execute_bash",
					};
				}
				return { type: "response", command: command.type, success: true };
			case "abort_bash":
				if (this.abortBashUnknownCommand) {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: abort_bash",
					};
				}
				return { type: "response", command: command.type, success: true };
			case "delete_saved_session":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { ok: true, method: "trash" },
				};
			case "refine":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						id: "refine_daemon",
						summary: "Daemon refinement",
						rationale: "Test daemon refine timeout",
						expectedOutcome: "Refine request completes",
						appliedEdits: [],
						harnessStatePath: "/tmp/harness_state.json",
					},
				};
			case "switch_session":
				return {
					type: "response",
					command: command.type,
					success: false,
					error: "Stored session working directory does not exist: /tmp/missing\nSession file: /tmp/session.jsonl\nCurrent working directory: /tmp/current",
					errorInfo: {
						code: "missing_session_cwd",
						issue: {
							sessionFile: "/tmp/session.jsonl",
							sessionCwd: "/tmp/missing",
							fallbackCwd: "/tmp/current",
						},
					},
				};
			case "import_jsonl":
				return {
					type: "response",
					command: command.type,
					success: false,
					error: "File not found: /tmp/not-found.jsonl",
					errorInfo: {
						code: "session_import_file_not_found",
						filePath: "/tmp/not-found.jsonl",
					},
				};
			default:
				throw new Error(`Unexpected command: ${command.type}`);
		}
	}

	onMessage(listener: DaemonClientMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	onClose(listener: DaemonClientCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	emitMessage(message: DaemonOutbound): void {
		for (const listener of [...this.messageListeners]) {
			listener(message);
		}
	}

	getMessageListenerCount(): number {
		return this.messageListeners.size;
	}

	getCloseListenerCount(): number {
		return this.closeListeners.size;
	}

	close(): void {
		this.closeCount++;
	}
}

function asDaemonClient(client: FakeDaemonClient): DaemonClient {
	return client as unknown as DaemonClient;
}

function createConnectionState(activeSessionId: string, sessionId: string): AgentConnectionState {
	return {
		activeSessionId,
		cwd: "/tmp/project",
		model: undefined,
		thinkingLevel: "medium",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: `/tmp/${sessionId}.jsonl`,
		sessionId,
		sessionName: `${sessionId} name`,
		sessionDir: "/tmp/sessions",
		leafId: `${sessionId}-leaf`,
		autoCompactionEnabled: true,
		messageCount: 1,
		pendingMessageCount: 0,
		compactionCount: 0,
		goal: {
			active: false,
			status: "idle",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		},
		scopedModels: [],
		activeToolNames: ["ipython"],
		contextUsage: undefined,
	};
}

interface CreateAttachResultOptions {
	state?: AgentConnectionState;
	messages?: AgentMessage[];
	sessionContext?: DaemonAttachResult["snapshot"]["sessionContext"];
	omitSessionContext?: boolean;
	sessionTree?: DaemonAttachResult["snapshot"]["sessionTree"];
	parent?: DaemonAttachResult["snapshot"]["parent"];
	replay?: DaemonAttachResult["replay"];
}

function createAttachResult(
	activeSessionId: string,
	clientId: string | undefined,
	capabilities: readonly string[] | undefined,
	lastEventSequence: number,
	options: CreateAttachResultOptions = {},
): DaemonAttachResult {
	const state = options.state ?? createConnectionState(activeSessionId, "session-current");
	const messages = options.messages ?? [];
	const summary = {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live" as const,
		activity: "idle" as const,
		sessionId: state.sessionId,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: messages.length,
		pendingMessageCount: 0,
	};
	// Slim shape: the daemon omits top-level state/messages for clients with the
	// "slim_attach" capability, which DaemonAgentConnection always advertises.
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary,
			state,
			messages,
			...(options.omitSessionContext
				? {}
				: {
						sessionContext:
							options.sessionContext ??
							({
								messages,
								thinkingLevel: state.thinkingLevel,
								model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
							} satisfies NonNullable<DaemonAttachResult["snapshot"]["sessionContext"]>),
					}),
			sessionTree: options.sessionTree ?? { tree: [], leafId: state.leafId },
			lastEventSequence,
			...(options.parent ? { parent: options.parent } : {}),
		},
		replay: options.replay ?? {
			status: "complete",
			toSequence: lastEventSequence,
		},
		lastEventSequence,
		client: {
			id: clientId ?? "client-1",
			capabilities: (capabilities ?? ["attach_snapshot", "event_sequence"]).filter(
				(capability): capability is DaemonAttachResult["client"]["capabilities"][number] =>
					capability === "attach_snapshot" ||
					capability === "event_sequence" ||
					capability === "extension_ui" ||
					capability === "slim_attach",
			),
		},
	};
}

function emitSequencedQueueUpdate(client: FakeDaemonClient, activeSessionId: string, sequence: number): void {
	client.emitMessage({
		type: "session_event",
		activeSessionId,
		event: {
			type: "queue_update",
			steering: [],
			followUp: [],
		},
		meta: {
			id: `${activeSessionId}:${sequence}`,
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			sequence,
			emittedAt: "2026-01-01T00:00:00.000Z",
		},
	});
}

describe("DaemonAgentConnection", () => {
	it("loads connection state and forwards replacement snapshots through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();

		await expect(connection.getState()).resolves.toMatchObject({
			activeSessionId: "active-1",
			cwd: "/tmp/project",
			sessionId: "session-current",
			sessionName: "session-current name",
			activeToolNames: ["ipython"],
		});

		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "active-1",
			state: createConnectionState("active-1", "session-next"),
			messages: [{ role: "user", content: "replacement prompt", timestamp: 1 }],
		});
		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "other",
			state: createConnectionState("other", "ignored"),
			messages: [{ role: "user", content: "ignored", timestamp: 2 }],
		});

		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach"]);
		expect(events).toEqual([
			{
				type: "session_replaced",
				state: expect.objectContaining({
					activeSessionId: "active-1",
					sessionId: "session-next",
					sessionName: "session-next name",
					activeToolNames: ["ipython"],
				}),
				messages: [{ role: "user", content: "replacement prompt", timestamp: 1 }],
			},
		]);
	});

	it("exposes attach snapshots as the initial connection snapshot", async () => {
		const fakeClient = new FakeDaemonClient();
		const snapshotMessage: AgentMessage = { role: "user", content: "snapshot prompt", timestamp: 1 };
		const messages: AgentMessage[] = [snapshotMessage];
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 15, {
				state: createConnectionState(command.activeSessionId, "session-snapshot"),
				messages,
				sessionContext: {
					messages,
					thinkingLevel: "medium",
					model: null,
				},
				sessionTree: {
					tree: [
						{
							entry: {
								type: "message",
								id: "user-1",
								parentId: null,
								timestamp: "2026-01-01T00:00:00.000Z",
								message: snapshotMessage,
							},
							children: [],
						},
					],
					leafId: "user-1",
				},
				parent: {
					activeSessionId: "parent-active",
					sessionId: "parent-session",
					nodeId: "parent-node",
					childId: "child-1",
				},
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();

		await expect(connection.getInitialSnapshot()).resolves.toMatchObject({
			state: {
				activeSessionId: "active-1",
				sessionId: "session-snapshot",
			},
			messages,
			sessionContext: {
				messages,
				thinkingLevel: "medium",
				model: null,
			},
			sessionTree: {
				leafId: "user-1",
			},
			parent: {
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				nodeId: "parent-node",
				childId: "child-1",
			},
			lastEventSequence: 15,
			replay: {
				status: "complete",
				toSequence: 15,
			},
		});
		await expect(connection.getState()).resolves.toMatchObject({
			sessionId: "session-snapshot",
		});
		await expect(connection.getMessages()).resolves.toEqual(messages);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach"]);
	});

	it("keeps attach snapshots usable when the daemon omits duplicate session context", async () => {
		const fakeClient = new FakeDaemonClient();
		const messages: AgentMessage[] = [{ role: "user", content: "snapshot prompt", timestamp: 1 }];
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 15, {
				state: createConnectionState(command.activeSessionId, "session-snapshot"),
				messages,
				omitSessionContext: true,
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();

		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot).toMatchObject({
			state: {
				activeSessionId: "active-1",
				sessionId: "session-snapshot",
			},
			messages,
			lastEventSequence: 15,
		});
		expect(snapshot.sessionContext).toBeUndefined();
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach"]);

		await expect(connection.getSessionContext()).resolves.toMatchObject({
			messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
		});
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "get_session_context"]);
	});

	it("keeps reconnect usable from attach snapshots when replay is unavailable", async () => {
		const fakeClient = new FakeDaemonClient();
		const reconnectedMessages: AgentMessage[] = [{ role: "user", content: "reconnected prompt", timestamp: 2 }];
		let attachCount = 0;
		fakeClient.attachResultFactory = (command) => {
			attachCount++;
			if (attachCount === 1) {
				return createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12, {
					state: createConnectionState(command.activeSessionId, "session-initial"),
				});
			}
			return createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 20, {
				state: createConnectionState(command.activeSessionId, "session-reconnected"),
				messages: reconnectedMessages,
				sessionContext: {
					messages: reconnectedMessages,
					thinkingLevel: "medium",
					model: null,
				},
				replay: {
					status: "unavailable",
					fromSequence: 14,
					toSequence: 20,
					reason: "event_replay_not_available",
				},
			});
		};
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();
		emitSequencedQueueUpdate(fakeClient, "active-1", 14);
		await connection.attach();

		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach"],
			resumeCursor: {
				activeSessionId: "active-1",
				eventSequence: 14,
			},
		});
		await expect(connection.getInitialSnapshot()).resolves.toMatchObject({
			state: {
				sessionId: "session-reconnected",
			},
			messages: reconnectedMessages,
			replay: {
				status: "unavailable",
				fromSequence: 14,
				toSequence: 20,
				reason: "event_replay_not_available",
			},
			lastEventSequence: 20,
		});
		await expect(connection.getState()).resolves.toMatchObject({
			sessionId: "session-reconnected",
		});
		await expect(connection.getMessages()).resolves.toEqual(reconnectedMessages);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "attach"]);
	});

	it("refreshes initial snapshots after live events make the cached snapshot stale", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12, {
				state: createConnectionState(command.activeSessionId, "session-attached"),
				messages: [{ role: "user", content: "attached prompt", timestamp: 1 }],
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();
		emitSequencedQueueUpdate(fakeClient, "active-1", 13);

		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot).toMatchObject({
			state: {
				sessionId: "session-current",
			},
			messages: [{ role: "user", content: "current prompt", timestamp: 4 }],
			sessionContext: {
				messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
			},
		});
		// The session tree is fetched lazily (only when the tree/branch selector is
		// opened), so refreshing the initial snapshot must not request it.
		expect(snapshot.sessionTree).toBeUndefined();
		expect(fakeClient.requests.map((request) => request.type)).toEqual([
			"attach",
			"get_connection_state",
			"get_messages",
			"get_session_context",
		]);
	});

	it("ignores older sequenced events after an attach snapshot", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		await connection.attach();
		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "active-1",
			state: createConnectionState("active-1", "session-old"),
			messages: [{ role: "user", content: "old prompt", timestamp: 1 }],
			meta: {
				id: "active-1:10",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 10,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "active-1",
			state: createConnectionState("active-1", "session-new"),
			messages: [{ role: "user", content: "new prompt", timestamp: 2 }],
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		expect(events).toEqual([
			{
				type: "session_replaced",
				state: expect.objectContaining({
					sessionId: "session-new",
				}),
				messages: [{ role: "user", content: "new prompt", timestamp: 2 }],
			},
		]);
		await expect(connection.getState()).resolves.toMatchObject({
			sessionId: "session-new",
		});
	});

	it("sends queue commands through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.getQueue()).resolves.toEqual({ steering: ["steer"], followUp: ["follow"] });
		await expect(connection.clearQueue()).resolves.toEqual({ steering: ["cleared"], followUp: [] });
		await expect(connection.abortAndClearQueue()).resolves.toEqual({ steering: ["aborted"], followUp: ["cleared"] });
		await connection.waitForIdle();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found");
		}
		await connection.setScopedModels([{ model, thinkingLevel: "high" }]);

		expect(fakeClient.requests.map((request) => request.type)).toEqual([
			"attach",
			"get_queue",
			"clear_queue",
			"abort_and_clear_queue",
			"wait_for_idle",
			"set_scoped_models",
		]);
		expect(fakeClient.requests[1]).toMatchObject({ type: "get_queue", activeSessionId: "active-1" });
		expect(fakeClient.requests[2]).toMatchObject({ type: "clear_queue", activeSessionId: "active-1" });
		expect(fakeClient.requests[3]).toMatchObject({ type: "abort_and_clear_queue", activeSessionId: "active-1" });
		expect(fakeClient.requests[4]).toMatchObject({ type: "wait_for_idle", activeSessionId: "active-1" });
		expect(fakeClient.requests[5]).toMatchObject({
			type: "set_scoped_models",
			activeSessionId: "active-1",
			scopedModels: [{ model, thinkingLevel: "high" }],
		});

		fakeClient.abortAndClearQueueUnknownCommand = true;
		await expect(connection.abortAndClearQueue()).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
	});

	it("cancels rlm child runs through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.cancelRlmChild("child-1")).resolves.toBe(true);
		await expect(connection.cancelRlmChild("finished-child")).resolves.toBe(false);

		expect(fakeClient.requests[1]).toMatchObject({
			type: "cancel_rlm_child",
			activeSessionId: "active-1",
			childId: "child-1",
		});

		// A daemon from a build that predates the command reports a restart hint
		// instead of the raw protocol error.
		await expect(connection.cancelRlmChild("stale-daemon")).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
	});

	it("sends bash commands through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await connection.executeBash("echo hi", { excludeFromContext: true });
		await connection.abortBash();

		expect(fakeClient.requests[1]).toMatchObject({
			type: "execute_bash",
			activeSessionId: "active-1",
			command: "echo hi",
			excludeFromContext: true,
		});
		expect(fakeClient.requests[2]).toMatchObject({ type: "abort_bash", activeSessionId: "active-1" });

		// A daemon from a build that predates the command reports a restart hint
		// instead of the raw protocol error.
		await expect(connection.executeBash("stale-daemon")).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
		fakeClient.abortBashUnknownCommand = true;
		await expect(connection.abortBash()).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
	});

	it("loads resource snapshots through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.getResourceSnapshot()).resolves.toMatchObject({
			contextFiles: [{ path: "/tmp/AGENTS.md" }],
			skills: [{ name: "demo-skill", filePath: "/tmp/skills/demo-skill/SKILL.md" }],
			diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_resource_snapshot",
			activeSessionId: "active-1",
		});
	});

	it("loads session context through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "queue_update",
				steering: [],
				followUp: [],
			},
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		await expect(connection.getSessionContext()).resolves.toEqual({
			messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
			thinkingLevel: "medium",
			model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_session_context",
			activeSessionId: "active-1",
		});
	});

	it("loads session trees through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "queue_update",
				steering: [],
				followUp: [],
			},
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		await expect(connection.getSessionTree()).resolves.toEqual({
			tree: [
				{
					entry: {
						type: "message",
						id: "user-1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "hello", timestamp: 1 },
					},
					children: [],
				},
			],
			leafId: "user-1",
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_session_tree",
			activeSessionId: "active-1",
		});
	});

	it("loads serializable tool metadata through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.getToolDefinition("custom_tool")).resolves.toEqual({
			name: "custom_tool",
			label: "custom_tool",
			description: "custom_tool description",
			promptSnippet: "custom_tool prompt",
			promptGuidelines: ["Use custom_tool"],
			parameters: { type: "object" },
			renderShell: "self",
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_tool_definition",
			activeSessionId: "active-1",
			name: "custom_tool",
		});
	});

	it("forwards daemon session events through the connection boundary", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();

		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "queue_update",
				steering: ["interrupt"],
				followUp: ["later"],
			},
			meta: {
				id: "active-1:14",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 14,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "other",
			event: {
				type: "queue_update",
				steering: ["ignored"],
				followUp: [],
			},
		});

		expect(events).toEqual([
			{
				type: "session_event",
				event: {
					type: "queue_update",
					steering: ["interrupt"],
					followUp: ["later"],
				},
			},
		]);

		await connection.attach();
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			clientId: expect.any(String),
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach"],
			resumeCursor: {
				activeSessionId: "active-1",
				eventSequence: 14,
			},
		});

		await connection.attach();
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach"],
			resumeCursor: {
				activeSessionId: "active-1",
				eventSequence: 14,
			},
		});
	});

	it("forwards extension UI requests and responses", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();
		expect(fakeClient.requests[0]).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			supportsExtensionUi: true,
			clientId: expect.any(String),
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach"],
		});

		fakeClient.emitMessage({
			type: "extension_ui_request",
			activeSessionId: "active-1",
			id: "request-1",
			method: "confirm",
			payload: { title: "Confirm", message: "Proceed?" },
		});
		fakeClient.emitMessage({
			type: "extension_ui_request",
			activeSessionId: "other",
			id: "request-2",
			method: "confirm",
			payload: { title: "Ignore", message: "Wrong session" },
		});

		expect(events).toEqual([
			{
				type: "extension_ui_request",
				request: {
					id: "request-1",
					method: "confirm",
					payload: { title: "Confirm", message: "Proceed?" },
				},
			},
		]);

		await connection.respondToExtensionUiRequest("request-1", { confirmed: true });
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "extension_ui_response",
			activeSessionId: "active-1",
			requestId: "request-1",
			response: { confirmed: true },
		});
	});

	it("uses an extended timeout for refine requests through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(
			connection.refine({ instructions: "remember this", rollbackId: "refine_previous" }),
		).resolves.toMatchObject({
			id: "refine_daemon",
			appliedEdits: [],
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "refine",
			activeSessionId: "active-1",
			instructions: "remember this",
			rollbackId: "refine_previous",
		});
		expect(fakeClient.requests[1]).not.toHaveProperty("global");
		expect(fakeClient.requestTimeouts[0]).toBe(30000);
		expect(fakeClient.requestTimeouts[1]).toBe(DAEMON_REFINE_REQUEST_TIMEOUT_MS);
	});

	it("lists and renames saved sessions through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		const progress: Array<[number, number]> = [];

		const sessions = await connection.listSavedSessions("current", (loaded, total) => {
			progress.push([loaded, total]);
		});
		await connection.renameSavedSession("/tmp/session-a.jsonl", "Next name");
		await expect(connection.deleteSavedSession("/tmp/session-a.jsonl")).resolves.toEqual({
			ok: true,
			method: "trash",
		});

		expect(sessions).toEqual([
			{
				path: "/tmp/session-a.jsonl",
				id: "session-a",
				cwd: "/tmp",
				name: "Saved session",
				created: new Date("2026-01-01T00:00:00.000Z"),
				modified: new Date("2026-01-02T00:00:00.000Z"),
				messageCount: 2,
				firstMessage: "hello",
				allMessagesText: "hello world",
			},
		]);
		expect(progress).toEqual([
			[1, 2],
			[2, 2],
		]);
		expect(fakeClient.requests[1]).toMatchObject({
			type: "list_saved_sessions",
			activeSessionId: "active-1",
			scope: "current",
		});
		expect(fakeClient.requests[2]).toMatchObject({
			type: "rename_saved_session",
			activeSessionId: "active-1",
			sessionPath: "/tmp/session-a.jsonl",
			name: "Next name",
		});
		expect(fakeClient.requests[3]).toMatchObject({
			type: "delete_saved_session",
			activeSessionId: "active-1",
			sessionPath: "/tmp/session-a.jsonl",
		});
	});

	it("rehydrates daemon recoverable errors for interactive recovery flows", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.switchSession("/tmp/session.jsonl")).rejects.toBeInstanceOf(MissingSessionCwdError);
		await expect(connection.switchSession("/tmp/session.jsonl")).rejects.toMatchObject({
			issue: {
				sessionFile: "/tmp/session.jsonl",
				sessionCwd: "/tmp/missing",
				fallbackCwd: "/tmp/current",
			},
		});
		await expect(connection.importFromJsonl("/tmp/not-found.jsonl")).rejects.toBeInstanceOf(
			SessionImportFileNotFoundError,
		);
		await expect(connection.importFromJsonl("/tmp/not-found.jsonl")).rejects.toMatchObject({
			filePath: "/tmp/not-found.jsonl",
		});
	});

	it("can close the daemon client when disposed by an owning caller", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			closeClientOnDispose: true,
		});
		await connection.attach();

		await connection.dispose();

		expect(fakeClient.requests.at(-1)).toMatchObject({ type: "detach", activeSessionId: "active-1" });
		expect(fakeClient.closeCount).toBe(1);
	});

	it("cleans up daemon client subscriptions when static attach fails", async () => {
		const fakeClient = new FakeDaemonClient();

		await expect(
			DaemonAgentConnection.attach(asDaemonClient(fakeClient), "missing", { closeClientOnDispose: true }),
		).rejects.toThrow("Unknown active session: missing");

		expect(fakeClient.getMessageListenerCount()).toBe(0);
		expect(fakeClient.getCloseListenerCount()).toBe(0);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "detach"]);
		expect(fakeClient.closeCount).toBe(1);
	});
});
