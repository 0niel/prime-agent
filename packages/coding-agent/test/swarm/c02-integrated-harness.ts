/** C02 evidence harness: drives integrated ownership, daemon attachment, and UI seams. */

import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { type FauxResponseStep, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type { DaemonSocketClient } from "../../src/modes/daemon/active-session-state.js";
import { DaemonSupervisor } from "../../src/modes/daemon/daemon-supervisor.js";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.js";

export const C02_FANOUT = 64;
const OPERATION_TIMEOUT_MS = 10_000;

export interface C02IntegratedRepetition {
	parentPendingHighWater: number;
	uiPendingHighWater: number;
	slowCatchupPendingHighWater: number;
	slowCatchupScheduleHighWater: number;
	slowCatchupPromiseHighWater: number;
	timersScheduled: number;
	timersCancelled: number;
	timersFired: number;
	terminalDeliveries: number;
	healthyAttachmentLive: number;
	hookErrors: number;
	observerErrors: number;
	beforeToolVetoes: number;
	droppedReplaceableProgress: number;
	teardownPending: number;
	delayP50Milliseconds: number;
	delayP95Milliseconds: number;
	delayP99Milliseconds: number;
	delayMaxMilliseconds: number;
}

const afterMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const afterImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

async function bounded<T>(label: string, promise: Promise<T>, timeoutMs = OPERATION_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`C02_INTEGRATED_TIMEOUT:${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function requireInvariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`C02_INTEGRATED_INVARIANT:${message}`);
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/**
 * Opens an actual local socket through DaemonSupervisor.handleConnection. This
 * deliberately does not start a daemon worker: C02 owns attachment-local work,
 * and the drain seam below is the only worker-dependent operation substituted.
 */
async function openDaemonAttachment(supervisor: DaemonSupervisor): Promise<{
	attachment: DaemonSocketClient;
	peer: Socket;
	close(): Promise<void>;
}> {
	let resolveAttachment!: (attachment: DaemonSocketClient) => void;
	let rejectAttachment!: (error: Error) => void;
	const accepted = new Promise<DaemonSocketClient>((resolve, reject) => {
		resolveAttachment = resolve;
		rejectAttachment = reject;
	});
	const internals = supervisor as unknown as {
		handleConnection(socket: Socket): void;
		clients: Set<DaemonSocketClient>;
	};
	const server = createServer((socket) => {
		try {
			internals.handleConnection(socket);
			const attachment = [...internals.clients].find((candidate) => candidate.socket === socket);
			if (!attachment) throw new Error("Daemon did not register local attachment");
			resolveAttachment(attachment);
		} catch (error) {
			rejectAttachment(error instanceof Error ? error : new Error(String(error)));
			socket.destroy();
		}
	});
	await bounded(
		"daemon attachment listen",
		new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port: 0 }, () => {
				server.off("error", reject);
				resolve();
			});
		}),
	);
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("C02_INTEGRATED_INVARIANT:local TCP address unavailable");
	}
	const peer = connect({ host: "127.0.0.1", port: address.port });
	peer.once("error", rejectAttachment);
	await bounded("daemon attachment connect", once(peer, "connect"));
	const attachment = await bounded("daemon attachment registration", accepted);
	let closed = false;
	return {
		attachment,
		peer,
		async close() {
			if (closed) return;
			closed = true;
			const peerClosed = once(peer, "close").catch(() => undefined);
			attachment.socket.destroy();
			await bounded("daemon attachment socket close", peerClosed);
			await bounded("daemon attachment server close", closeServer(server));
		},
	};
}

/** Exercise real socket close cleanup plus real per-attachment scheduler/latch ownership. */
async function exerciseAttachments(): Promise<
	Pick<
		C02IntegratedRepetition,
		| "slowCatchupPendingHighWater"
		| "slowCatchupScheduleHighWater"
		| "slowCatchupPromiseHighWater"
		| "healthyAttachmentLive"
		| "timersScheduled"
		| "timersCancelled"
		| "timersFired"
	>
> {
	const supervisor = new DaemonSupervisor("/tmp/c02-integrated-evidence.sock", {
		defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
		descriptorDir: "/tmp/c02-integrated-evidence-state",
	});
	const slowConnection = await openDaemonAttachment(supervisor);
	const healthyConnection = await openDaemonAttachment(supervisor);
	const slow = slowConnection.attachment;
	const healthy = healthyConnection.attachment;
	const internals = supervisor as unknown as {
		queueCatchup(client: DaemonSocketClient, activeSessionId: string, purpose?: "replacement" | "resync"): void;
		scheduleClientCatchup(client: DaemonSocketClient): void;
		cancelClientCatchup(client: DaemonSocketClient): void;
		catchUpClient(client: DaemonSocketClient): Promise<void>;
		drainClientCatchups(client: DaemonSocketClient): Promise<void>;
		catchupDrainTimers: Map<DaemonSocketClient, ReturnType<typeof setImmediate>>;
		clients: Set<DaemonSocketClient>;
	};
	let releaseSlow!: () => void;
	const slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	let healthyDrains = 0;
	let timersScheduled = 0;
	let timersCancelled = 0;
	let timersFired = 0;
	const realSchedule = internals.scheduleClientCatchup.bind(supervisor);
	const realCancel = internals.cancelClientCatchup.bind(supervisor);
	const realDrain = internals.drainClientCatchups.bind(supervisor);
	const realTimerDelete = internals.catchupDrainTimers.delete.bind(internals.catchupDrainTimers);
	let cancellingTimer = false;
	// Observe removal at the production timer map. A callback deletes itself before
	// deciding whether its client is still live, while cancelClientCatchup deletes
	// the same entry as part of real socket cleanup. This accounts for both paths
	// exactly once, including an inert callback that observes a closing socket.
	internals.catchupDrainTimers.delete = (client) => {
		const removed = realTimerDelete(client);
		if (removed) {
			if (cancellingTimer) timersCancelled++;
			else timersFired++;
		}
		return removed;
	};
	internals.scheduleClientCatchup = (client) => {
		const scheduledBefore = internals.catchupDrainTimers.has(client);
		realSchedule(client);
		if (!scheduledBefore && internals.catchupDrainTimers.has(client)) timersScheduled++;
	};
	internals.cancelClientCatchup = (client) => {
		cancellingTimer = true;
		try {
			realCancel(client);
		} finally {
			cancellingTimer = false;
		}
	};
	// Replace only the worker request body. Queue ownership, immediate callback,
	// latch, backpressure conditions, and socket-close cleanup stay production code.
	internals.drainClientCatchups = async (client) => {
		client.catchupActiveSessionIds?.clear();
		client.catchupPurposes?.clear();
		if (client === slow) await slowGate;
		else if (client === healthy) healthyDrains++;
		else await realDrain(client);
	};
	try {
		let slowPendingHighWater = 0;
		let scheduledHighWater = 0;
		for (let index = 0; index < C02_FANOUT; index++) {
			internals.queueCatchup(slow, "c02-active");
			internals.scheduleClientCatchup(slow);
			internals.queueCatchup(healthy, "c02-active");
			internals.scheduleClientCatchup(healthy);
			slowPendingHighWater = Math.max(slowPendingHighWater, slow.catchupActiveSessionIds?.size ?? 0);
			scheduledHighWater = Math.max(scheduledHighWater, Number(internals.catchupDrainTimers.has(slow)));
		}
		requireInvariant(slowPendingHighWater === 1, "slow attachment retains one latest session");
		requireInvariant(scheduledHighWater === 1, "slow attachment owns one deferred scheduler callback");
		const latchDeadline = Date.now() + OPERATION_TIMEOUT_MS;
		while (slow.catchupPromise === undefined && Date.now() < latchDeadline) await afterImmediate();
		const promiseHighWater = Number(slow.catchupPromise !== undefined);
		requireInvariant(promiseHighWater === 1, "slow attachment owns one in-flight catch-up promise");
		requireInvariant(healthyDrains === 1, "healthy attachment drains while slow is pending");
		releaseSlow();
		await bounded("slow attachment settle", slow.catchupPromise ?? Promise.resolve());
		await afterMacrotask();
		requireInvariant(slow.catchupPromise === undefined, "slow catch-up latch clears after completion");

		// Queue a real replacement callback, then use the actual socket close path.
		// Its cleanup invalidates/clears that callback in one later macrotask.
		internals.queueCatchup(slow, "c02-replacement", "replacement");
		internals.scheduleClientCatchup(slow);
		requireInvariant(slow.catchupPurposes?.get("c02-replacement") === "replacement", "replacement queued");
		// The production socket cleanup invokes the instrumented cancelClientCatchup
		// wrapper, which observes this callback's real removal exactly once.
		await slowConnection.close();
		await afterMacrotask();
		requireInvariant(!internals.clients.has(slow), "closed attachment removed from daemon");
		requireInvariant(!internals.catchupDrainTimers.has(slow), "closed socket owns no callback");
		requireInvariant((slow.catchupActiveSessionIds?.size ?? 0) === 0, "closed socket retains no catch-up");
		requireInvariant((slow.catchupPurposes?.size ?? 0) === 0, "closed socket retains no replacement");
		requireInvariant(slow.catchupPromise === undefined, "closed socket retains no catch-up latch");
		await healthyConnection.close();
		await afterMacrotask();
		requireInvariant(internals.clients.size === 0, "all local socket attachments cleaned up");
		return {
			slowCatchupPendingHighWater: slowPendingHighWater,
			slowCatchupScheduleHighWater: scheduledHighWater,
			slowCatchupPromiseHighWater: promiseHighWater,
			healthyAttachmentLive: healthyDrains,
			timersScheduled,
			timersCancelled,
			timersFired,
		};
	} finally {
		releaseSlow();
		internals.drainClientCatchups = realDrain;
		internals.catchupDrainTimers.delete = realTimerDelete;
		internals.scheduleClientCatchup = realSchedule;
		internals.cancelClientCatchup = realCancel;
		await slowConnection.close();
		await healthyConnection.close();
	}
}

/** Drive real InteractiveMode progress ordering through its established connection seam. */
async function exerciseInteractive(): Promise<
	Pick<C02IntegratedRepetition, "uiPendingHighWater" | "droppedReplaceableProgress">
> {
	type Event = {
		type: "session_event";
		event: { type: string; toolCallId?: string; partialResult?: { content: string[] } };
	};
	let listener: ((event: Event) => Promise<void>) | undefined;
	const handled: string[] = [];
	const harness = {
		agentConnection: {
			subscribe: (callback: (event: Event) => Promise<void>) => {
				listener = callback;
				return () => {};
			},
		},
		sessionEventQueue: Promise.resolve(),
		sessionEventGeneration: 0,
		progressFlushGeneration: 0,
		progressFlushStopped: false,
		handleEvent: async (event: { type: string; partialResult?: { content: string[] } }) => {
			handled.push(event.type === "tool_execution_update" ? String(event.partialResult?.content[0]) : event.type);
		},
		showError: () => {},
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	(InteractiveMode.prototype as unknown as { subscribeToAgent(this: typeof harness): void }).subscribeToAgent.call(
		harness,
	);
	let pendingHighWater = 0;
	for (let index = 0; index < C02_FANOUT; index++) {
		await listener?.({
			type: "session_event",
			event: { type: "tool_execution_update", toolCallId: "c02", partialResult: { content: [`progress-${index}`] } },
		});
		pendingHighWater = Math.max(
			pendingHighWater,
			(harness as typeof harness & { pendingProgressEvents?: Map<unknown, unknown> }).pendingProgressEvents?.size ??
				0,
		);
	}
	await listener?.({ type: "session_event", event: { type: "agent_end" } });
	const progressDelivered = handled.filter((entry) => entry.startsWith("progress-")).length;
	requireInvariant(
		handled.length === 2 && handled[0] === "progress-63" && handled[1] === "agent_end",
		"UI flushes latest progress before terminal",
	);
	requireInvariant(
		((harness as typeof harness & { pendingProgressEvents?: Map<unknown, unknown> }).pendingProgressEvents?.size ??
			0) === 0,
		"UI retains no progress after terminal",
	);
	return { uiPendingHighWater: pendingHighWater, droppedReplaceableProgress: C02_FANOUT - progressDelivered };
}

/** One fresh session/services/provider/socket/monitor repetition. */
export async function runC02IntegratedRepetition(measured = true): Promise<C02IntegratedRepetition> {
	const delay = monitorEventLoopDelay({ resolution: 10 });
	const directory = join(
		tmpdir(),
		`pi-c02-integrated-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(directory, { recursive: true });
	const faux = registerFauxProvider();
	let releaseAnswers!: () => void;
	const answerGate = new Promise<void>((resolve) => {
		releaseAnswers = resolve;
	});
	faux.setResponses(
		Array.from({ length: C02_FANOUT }, () => async () => {
			await answerGate;
			return fauxAssistantMessage("c02 terminal");
		}) as FauxResponseStep[],
	);
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	let session: any;
	try {
		const services = await bounded(
			"create real session services",
			createAgentSessionServices({
				agentDir: directory,
				authStorage,
				cwd: directory,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
			}),
		);
		const created = await bounded(
			"create real session",
			createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.create(directory, join(directory, "sessions")),
				model: faux.getModel(),
				rlmDepth: 0,
				rlmMaxDepth: 2,
			}),
		);
		session = created.session;
		const delivered = new Map<string, number>();
		const observedBefore = session._observerFailureDiagnostics;
		const hooksBefore = session._afterToolHookFailureDiagnostics;
		let observerFailureInjected = false;
		session.subscribe(() => {
			// Exercise the production observer isolation path once without turning a
			// metric run into a console-I/O benchmark.
			if (!observerFailureInjected) {
				observerFailureInjected = true;
				throw new Error("C02 observer isolation");
			}
		});
		session.subscribe((event: any) => {
			if (event.type === "rlm_child_update" && event.child.status === "done")
				delivered.set(event.child.id, (delivered.get(event.child.id) ?? 0) + 1);
		});
		const handles = await bounded(
			"admit independent real child runtimes",
			Promise.all(Array.from({ length: C02_FANOUT }, (_, index) => session.runRlmChild(`C02 child ${index}`))),
		);
		const deadline = Date.now() + OPERATION_TIMEOUT_MS;
		while (handles.some((handle) => !session.getRlmChildSession(handle.rlm_child_id))) {
			if (Date.now() > deadline) throw new Error("C02_INTEGRATED_TIMEOUT:real child lifecycle publication");
			await afterMacrotask();
		}

		// Begin a fresh measurement only after fixture/session construction and all
		// 64 child admissions. Prime the new monitor for one setup-only turn, then
		// reset immediately before the owner recap. From that reset through lifecycle
		// teardown, do not reset it: every measured C02 owner, hook, terminal,
		// attachment, InteractiveMode, and cleanup path is in the reported interval.
		delay.enable();
		await afterMacrotask();
		delay.reset();
		for (const handle of handles) {
			const child = session.getRlmChildSession(handle.rlm_child_id);
			child.setCurrentRecap("replaceable-first");
			child.setCurrentRecap("replaceable-latest");
		}
		const parentPendingHighWater = session._pendingRlmChildUpdates.size;
		requireInvariant(parentPendingHighWater === C02_FANOUT, "owner retained one latest activity per real child");
		await afterMacrotask();
		requireInvariant(session._pendingRlmChildUpdates.size === 0, "owner flushes after one macrotask");
		const runner = session._extensionRunner;
		const originalHasHandlers = runner.hasHandlers.bind(runner);
		runner.hasHandlers = (type: string) =>
			type === "tool_result" || type === "tool_call" || originalHasHandlers(type);
		runner.emitToolResult = async () => {
			throw new Error("C02 after hook");
		};
		runner.emitToolCall = async () => {
			throw new Error("C02 before veto");
		};
		await session.agent.afterToolCall?.({
			toolCall: { id: "c02", name: "c02", arguments: {} },
			args: {},
			result: { content: [] },
			isError: false,
		});
		let beforeToolVetoes = 0;
		try {
			await session.agent.beforeToolCall?.({ toolCall: { id: "c02", name: "c02", arguments: {} }, args: {} });
		} catch {
			beforeToolVetoes++;
		}
		releaseAnswers();
		while (delivered.size !== C02_FANOUT) {
			if (Date.now() > deadline) throw new Error("C02_INTEGRATED_TIMEOUT:real child terminals");
			await afterMacrotask();
		}
		requireInvariant(
			[...delivered.values()].every((count) => count === 1),
			"terminal delivered once to healthy observer",
		);
		const attachments = await exerciseAttachments();
		const interactive = await exerciseInteractive();

		// Exercise every real owner shutdown edge after terminals: explicit abort,
		// update-restart abort, then disposal. All retained child state must be inert
		// after one macrotask rather than leaking a timer or late update. This remains
		// inside the delay measurement, rather than being treated as teardown noise.
		await bounded("parent abort cleanup", session.abort());
		session.abortForUpdateRestart();
		await afterMacrotask();
		session.dispose();
		await afterMacrotask();
		requireInvariant(
			session._pendingRlmChildUpdates.size === 0 && session._rlmChildUpdateFlushTimer === undefined,
			"abort/restart/dispose leaves no owner callback",
		);
		requireInvariant(session._activeRlmChildRuns.size === 0, "dispose releases real child runs");

		// Allow the monitor's own sampling timer one final turn only after every
		// measured path above has completed. This is not a second sampling window:
		// the monitor has remained enabled and un-reset since before the owner recap.
		await bounded("event-loop delay final sample", new Promise<void>((resolve) => setTimeout(resolve, 25)));
		const delayStats = measured
			? {
					delayP50Milliseconds: delay.percentile(50) / 1_000_000,
					delayP95Milliseconds: delay.percentile(95) / 1_000_000,
					delayP99Milliseconds: delay.percentile(99) / 1_000_000,
					delayMaxMilliseconds: delay.max / 1_000_000,
				}
			: { delayP50Milliseconds: 0, delayP95Milliseconds: 0, delayP99Milliseconds: 0, delayMaxMilliseconds: 0 };
		delay.disable();
		return {
			parentPendingHighWater,
			terminalDeliveries: delivered.size,
			hookErrors: session._afterToolHookFailureDiagnostics - hooksBefore,
			observerErrors: session._observerFailureDiagnostics - observedBefore,
			beforeToolVetoes,
			teardownPending: session._pendingRlmChildUpdates.size,
			...delayStats,
			...attachments,
			...interactive,
		};
	} finally {
		releaseAnswers();
		try {
			session?.dispose();
			delay.disable();
		} finally {
			faux.unregister();
			await rm(directory, { recursive: true, force: true });
		}
	}
}
