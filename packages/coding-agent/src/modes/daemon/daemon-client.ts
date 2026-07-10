import { createConnection, type Socket } from "node:net";
import { getDaemonLogPath } from "../../config.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type {
	DaemonClosingReason,
	DaemonCommand,
	DaemonOutbound,
	DaemonRequestProgress,
	DaemonResponse,
	DaemonSavedSessionInfo,
} from "./daemon-protocol.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;

export type DaemonHello = Extract<DaemonOutbound, { type: "daemon_hello" }>;

export type DaemonClientMessageListener = (message: DaemonOutbound) => void;
export type DaemonClientCloseListener = (error: Error) => void;
export type DaemonClientProgressListener = (message: DaemonRequestProgress) => void;

export interface DaemonClientRequestOptions {
	onProgress?: DaemonClientProgressListener;
}

function daemonEndpointDetails(socketPath: string): string {
	return `Socket: ${socketPath}. Daemon log: ${getDaemonLogPath(socketPath)}.`;
}

export class DaemonSocketClosedError extends Error {
	constructor(
		socketPath: string,
		readonly daemonClosingReason?: DaemonClosingReason,
		cause?: string,
	) {
		const reasonDetails = daemonClosingReason ? ` Reason: ${daemonClosingReason}.` : "";
		const causeDetails = cause ? ` Cause: ${cause}.` : "";
		super(
			`Connection to the Prime Agent daemon closed.${reasonDetails}${causeDetails} ${daemonEndpointDetails(socketPath)}`,
		);
		this.name = "DaemonSocketClosedError";
	}
}

export function getDaemonSocketCloseReason(error: Error): DaemonClosingReason | undefined {
	return error instanceof DaemonSocketClosedError ? error.daemonClosingReason : undefined;
}

export class DaemonClient {
	private socket?: Socket;
	private detachReader?: () => void;
	private readonly listeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();
	private readonly pendingRequests = new Map<
		string,
		{
			resolve: (response: DaemonResponse) => void;
			reject: (error: Error) => void;
			timeout: ReturnType<typeof setTimeout>;
			onProgress?: DaemonClientProgressListener;
		}
	>();
	private requestId = 0;
	private helloMessage?: DaemonHello;
	private daemonClosingReason?: DaemonClosingReason;
	private reconnectPromise?: Promise<void>;
	private readonly helloWaiters = new Set<{
		resolve: (hello: DaemonHello) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>();

	constructor(private readonly socketPath: string) {}

	get hello(): DaemonHello | undefined {
		return this.helloMessage;
	}

	get isConnected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	/** Wait for the daemon_hello greeting sent on connect. */
	async waitForHello(timeoutMs = 3000): Promise<DaemonHello> {
		if (this.helloMessage) {
			return this.helloMessage;
		}
		if (!this.socket || this.socket.destroyed) {
			throw new Error(
				`Cannot wait for the Prime Agent daemon handshake because the daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`,
			);
		}
		return new Promise<DaemonHello>((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.helloWaiters.delete(waiter);
					reject(
						new Error(
							`Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon handshake. ${daemonEndpointDetails(this.socketPath)}`,
						),
					);
				}, timeoutMs),
			};
			this.helloWaiters.add(waiter);
		});
	}

	async connect(timeoutMs = 3000): Promise<void> {
		if (this.socket) {
			throw new Error(`Prime Agent daemon client is already connected. ${daemonEndpointDetails(this.socketPath)}`);
		}

		this.helloMessage = undefined;
		this.daemonClosingReason = undefined;
		const socket = createConnection(this.socketPath);
		this.socket = socket;
		this.detachReader = attachJsonlLineReader(socket, (line) => this.handleLine(line));

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				this.clearSocketReference(socket);
				socket.destroy();
				reject(
					new Error(
						`Timed out after ${timeoutMs}ms connecting to the Prime Agent daemon. ${daemonEndpointDetails(this.socketPath)}`,
					),
				);
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timeout);
				socket.off("connect", onConnect);
				socket.off("error", onError);
			};
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				this.clearSocketReference(socket);
				reject(
					new Error(
						`Failed to connect to the Prime Agent daemon: ${error.message}. ${daemonEndpointDetails(this.socketPath)}`,
					),
				);
			};
			socket.once("connect", onConnect);
			socket.once("error", onError);
		});

		socket.on("error", (error) =>
			this.notifyClosed(
				socket,
				this.daemonClosingReason
					? new DaemonSocketClosedError(this.socketPath, this.daemonClosingReason, error.message)
					: error,
			),
		);
		socket.on("close", () =>
			this.notifyClosed(socket, new DaemonSocketClosedError(this.socketPath, this.daemonClosingReason)),
		);
	}

	async reconnect(timeoutMs = 3000): Promise<void> {
		if (this.reconnectPromise) {
			return this.reconnectPromise;
		}
		if (this.socket && !this.socket.destroyed) {
			return;
		}
		const reconnectPromise = this.connect(timeoutMs);
		this.reconnectPromise = reconnectPromise;
		try {
			await reconnectPromise;
		} finally {
			if (this.reconnectPromise === reconnectPromise) {
				this.reconnectPromise = undefined;
			}
		}
	}

	disconnectForReconnect(reason: DaemonClosingReason): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return;
		}
		this.daemonClosingReason = reason;
		this.notifyClosed(socket, new DaemonSocketClosedError(this.socketPath, reason));
		socket.end();
		socket.destroy();
	}

	onMessage(listener: DaemonClientMessageListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onClose(listener: DaemonClientCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	async request(
		command: DaemonCommandBody,
		timeoutMs = 30000,
		options: DaemonClientRequestOptions = {},
	): Promise<DaemonResponse> {
		if (!this.socket || this.socket.destroyed) {
			throw new Error(
				`Cannot send daemon command "${command.type}" because the Prime Agent daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`,
			);
		}

		const id = `daemon_${++this.requestId}`;
		const fullCommand = { ...command, id } as DaemonCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(
					new Error(
						`Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon response to "${command.type}". ${daemonEndpointDetails(this.socketPath)}`,
					),
				);
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timeout, onProgress: options.onProgress });
			this.socket!.write(serializeJsonLine(fullCommand));
		});
	}

	close(): void {
		this.detachReader?.();
		this.detachReader = undefined;
		this.rejectAll(
			new Error(
				`Prime Agent daemon client closed before the operation completed. ${daemonEndpointDetails(this.socketPath)}`,
			),
		);
		this.socket?.end();
		this.socket?.destroy();
		this.socket = undefined;
	}

	private clearSocketReference(socket: Socket): void {
		if (this.socket !== socket) {
			return;
		}
		this.detachReader?.();
		this.detachReader = undefined;
		this.socket = undefined;
	}

	private handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		if (isDaemonHello(message)) {
			this.helloMessage = message;
			for (const waiter of [...this.helloWaiters]) {
				clearTimeout(waiter.timeout);
				this.helloWaiters.delete(waiter);
				waiter.resolve(message);
			}
		}
		if (isDaemonClosing(message)) {
			this.daemonClosingReason = message.reason;
		}

		if (isDaemonResponse(message) && message.id) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pendingRequests.delete(message.id);
				pending.resolve(message);
				return;
			}
		}
		if (isDaemonRequestProgress(message) && message.id) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				pending.onProgress?.(message);
				return;
			}
		}

		for (const listener of this.listeners) {
			listener(message as DaemonOutbound);
		}
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pendingRequests.delete(id);
		}
		for (const waiter of [...this.helloWaiters]) {
			clearTimeout(waiter.timeout);
			this.helloWaiters.delete(waiter);
			waiter.reject(error);
		}
	}

	private notifyClosed(socket: Socket, error: Error): void {
		if (this.socket !== socket) {
			return;
		}
		this.clearSocketReference(socket);
		this.rejectAll(error);
		for (const listener of [...this.closeListeners]) {
			listener(error);
		}
	}
}

function isDaemonClosing(value: unknown): value is Extract<DaemonOutbound, { type: "daemon_closing" }> {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; reason?: unknown };
	return candidate.type === "daemon_closing" && (candidate.reason === "shutdown" || candidate.reason === "update");
}

function isDaemonHello(value: unknown): value is DaemonHello {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; protocol?: unknown };
	return candidate.type === "daemon_hello" && typeof candidate.protocol === "object" && candidate.protocol !== null;
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; success?: unknown; command?: unknown };
	return (
		candidate.type === "response" && typeof candidate.success === "boolean" && typeof candidate.command === "string"
	);
}

function isDaemonRequestProgress(value: unknown): value is DaemonRequestProgress {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as {
		type?: unknown;
		command?: unknown;
		id?: unknown;
		activeSessionId?: unknown;
		loaded?: unknown;
		total?: unknown;
		session?: unknown;
	};
	if (candidate.command !== "list_saved_sessions" || typeof candidate.id !== "string") {
		return false;
	}
	if (candidate.type === "session_list_progress") {
		return typeof candidate.loaded === "number" && typeof candidate.total === "number";
	}
	return candidate.type === "session_list_item" && isDaemonSavedSessionInfo(candidate.session);
}

function isDaemonSavedSessionInfo(value: unknown): value is DaemonSavedSessionInfo {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.path === "string" &&
		typeof candidate.id === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.created === "string" &&
		typeof candidate.modified === "string" &&
		typeof candidate.messageCount === "number" &&
		typeof candidate.firstMessage === "string" &&
		typeof candidate.allMessagesText === "string" &&
		(candidate.agentStatus === undefined || isDaemonSavedSessionAgentStatus(candidate.agentStatus))
	);
}

function isDaemonSavedSessionAgentStatus(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.summary === "string" &&
		typeof candidate.basedOnMessageCount === "number" &&
		(candidate.taskState === undefined ||
			candidate.taskState === "needs_input" ||
			candidate.taskState === "completed")
	);
}
