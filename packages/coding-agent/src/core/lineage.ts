import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** ACP lineage-v1 producer: durable per-agent ledger, request-ID headers, manifest derivation. */

export const LINEAGE_REQUEST_ID_HEADER = "X-ACP-Lineage-Request-ID";
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export type LineageTransition = "root" | "spawn" | "compact";
export type LineageRequestKind = "turn" | "compaction";
export type LineageSessionStatus = "running" | "completed" | "failed" | "cancelled";
export type LineageCompactionStatus = "in_progress" | "completed" | "failed" | "cancelled";

export interface SessionRegisteredEvent {
	type: "session_registered";
	session_id: string;
	parent_session_id?: string;
	depth: number;
	initial_context_id: string;
	spawned_by_request_id?: string;
}

export interface RequestStartedEvent {
	type: "request_started";
	request_id: string;
	session_id: string;
	context_id: string;
	kind: LineageRequestKind;
	compaction_id?: string;
}

export interface CompactionBegunEvent {
	type: "compaction_begun";
	compaction_id: string;
	session_id: string;
	source_context_id: string;
	target_context_id: string;
}

export interface CompactionFinishedEvent {
	type: "compaction_finished";
	compaction_id: string;
	status: Exclude<LineageCompactionStatus, "in_progress">;
}

export interface SessionStatusEvent {
	type: "session_status";
	session_id: string;
	status: Exclude<LineageSessionStatus, "running">;
}

export type LineageEvent =
	| SessionRegisteredEvent
	| RequestStartedEvent
	| CompactionBegunEvent
	| CompactionFinishedEvent
	| SessionStatusEvent;

export interface LineageManifest {
	sessions: Array<{
		session_id: string;
		parent_session_id?: string;
		depth: number;
		initial_context_id: string;
		spawned_by_request_id?: string;
		status: LineageSessionStatus;
	}>;
	contexts: Array<{
		context_id: string;
		session_id: string;
		previous_context_id?: string;
		transition: LineageTransition;
		compaction_id?: string;
	}>;
	compactions: Array<{
		compaction_id: string;
		session_id: string;
		source_context_id: string;
		target_context_id?: string;
		summary_request_id: string;
		status: LineageCompactionStatus;
	}>;
	requests: Array<{
		request_id: string;
		session_id: string;
		context_id: string;
		kind: LineageRequestKind;
		compaction_id?: string;
	}>;
}

export function lineageRequestHeaders(requestId: string): Record<string, string> {
	return {
		[LINEAGE_REQUEST_ID_HEADER]: requestId,
		[IDEMPOTENCY_KEY_HEADER]: requestId,
	};
}

function mintId(): string {
	return randomUUID().replaceAll("-", "");
}

/** Shape of one turn call; Idempotency-Key reuse is only safe for a body-identical retry. */
export interface TurnCallShape {
	messageCount: number;
	lastRole?: string;
}

function sameShape(left: TurnCallShape | undefined, right: TurnCallShape | undefined): boolean {
	return left?.messageCount === right?.messageCount && left?.lastRole === right?.lastRole;
}

/**
 * Append-only lineage recorder for one agent session.
 *
 * Every event is appended to the ledger before the action it describes takes
 * effect, so an X-ACP-Lineage-Request-ID observed on the wire always has a
 * request_started event on disk. Constructing a recorder over an existing
 * ledger replays it; registration is idempotent across resumes.
 */
export class LineageRecorder {
	readonly sessionId: string;
	private readonly _ledgerPath?: string;
	private _activeContextId: string;
	private _activeCompactionId?: string;
	private _lastTurn?: { requestId: string; contextId: string; shape?: TurnCallShape };
	private _parkedRetry?: { requestId: string; contextId: string; shape?: TurnCallShape };
	private _pendingCompactions = new Map<string, { sourceContextId: string; targetContextId: string }>();
	private _terminalStatus?: SessionStatusEvent["status"];

	constructor(options: {
		ledgerPath?: string;
		sessionId: string;
		depth: number;
		parentSessionId?: string;
		spawnedByRequestId?: string;
	}) {
		this.sessionId = options.sessionId;
		this._ledgerPath = options.ledgerPath;

		const existing = this._loadExisting();
		const registered = existing.find(
			(event): event is SessionRegisteredEvent =>
				event.type === "session_registered" && event.session_id === this.sessionId,
		);
		if (registered) {
			this._activeContextId = registered.initial_context_id;
			for (const event of existing) {
				this._replay(event);
			}
			return;
		}

		this._activeContextId = mintId();
		this._append({
			type: "session_registered",
			session_id: this.sessionId,
			...(options.parentSessionId !== undefined ? { parent_session_id: options.parentSessionId } : {}),
			depth: options.depth,
			initial_context_id: this._activeContextId,
			...(options.spawnedByRequestId !== undefined ? { spawned_by_request_id: options.spawnedByRequestId } : {}),
		});
	}

	get activeContextId(): string {
		return this._activeContextId;
	}

	get lastTurnRequestId(): string | undefined {
		return this._lastTurn?.requestId;
	}

	/** Mint (or, for a body-identical retry, reuse) the request ID for one turn call. */
	startTurnRequest(shape?: TurnCallShape): string {
		const parked = this._parkedRetry;
		if (parked && parked.contextId === this._activeContextId && sameShape(parked.shape, shape)) {
			this._parkedRetry = undefined;
			this._lastTurn = parked;
			return parked.requestId;
		}
		const requestId = mintId();
		this._lastTurn = { requestId, contextId: this._activeContextId, shape };
		this._append({
			type: "request_started",
			request_id: requestId,
			session_id: this.sessionId,
			context_id: this._activeContextId,
			kind: "turn",
			...(this._activeCompactionId !== undefined ? { compaction_id: this._activeCompactionId } : {}),
		});
		return requestId;
	}

	/** Park the last turn request so the upcoming auto-retry reuses its ID. */
	prepareTurnRetry(): void {
		this._parkedRetry = this._lastTurn;
	}

	clearTurnRetry(): void {
		this._parkedRetry = undefined;
	}

	beginCompaction(): { compactionId: string; requestId: string } {
		const compactionId = mintId();
		const requestId = mintId();
		const sourceContextId = this._activeContextId;
		const targetContextId = mintId();
		this._pendingCompactions.set(compactionId, { sourceContextId, targetContextId });
		this._append({
			type: "compaction_begun",
			compaction_id: compactionId,
			session_id: this.sessionId,
			source_context_id: sourceContextId,
			target_context_id: targetContextId,
		});
		this._append({
			type: "request_started",
			request_id: requestId,
			session_id: this.sessionId,
			context_id: sourceContextId,
			kind: "compaction",
			compaction_id: compactionId,
		});
		return { compactionId, requestId };
	}

	finishCompaction(compactionId: string, status: Exclude<LineageCompactionStatus, "in_progress">): void {
		const pending = this._pendingCompactions.get(compactionId);
		if (!pending) {
			throw new Error(`unknown lineage compaction: ${compactionId}`);
		}
		this._pendingCompactions.delete(compactionId);
		this._append({ type: "compaction_finished", compaction_id: compactionId, status });
		if (status === "completed") {
			this._activeContextId = pending.targetContextId;
			this._activeCompactionId = compactionId;
		}
	}

	/** A session has one terminal outcome; later observations must not rewrite it. */
	recordSessionStatus(status: SessionStatusEvent["status"]): void {
		if (this._terminalStatus) {
			return;
		}
		this._terminalStatus = status;
		this._append({ type: "session_status", session_id: this.sessionId, status });
	}

	private _replay(event: LineageEvent): void {
		switch (event.type) {
			case "compaction_begun":
				if (event.session_id === this.sessionId) {
					this._pendingCompactions.set(event.compaction_id, {
						sourceContextId: event.source_context_id,
						targetContextId: event.target_context_id,
					});
				}
				break;
			case "compaction_finished": {
				const pending = this._pendingCompactions.get(event.compaction_id);
				if (pending) {
					this._pendingCompactions.delete(event.compaction_id);
					if (event.status === "completed") {
						this._activeContextId = pending.targetContextId;
						this._activeCompactionId = event.compaction_id;
					}
				}
				break;
			}
			case "session_status":
				if (event.session_id === this.sessionId && !this._terminalStatus) {
					this._terminalStatus = event.status;
				}
				break;
			default:
				break;
		}
	}

	private _loadExisting(): LineageEvent[] {
		if (!this._ledgerPath || !existsSync(this._ledgerPath)) {
			return [];
		}
		const raw = readFileSync(this._ledgerPath, "utf8");
		const parsed = parseLedgerContent(raw);
		if (parsed.validLength < raw.length) {
			// Discard a torn tail line before appending so it never becomes mid-file corruption.
			truncateSync(this._ledgerPath, Buffer.byteLength(raw.slice(0, parsed.validLength)));
		} else if (raw.length > 0 && !raw.endsWith("\n")) {
			appendFileSync(this._ledgerPath, "\n");
		}
		return parsed.events;
	}

	private _append(event: LineageEvent): void {
		this._replay(event);
		if (!this._ledgerPath) {
			return;
		}
		mkdirSync(dirname(this._ledgerPath), { recursive: true });
		appendFileSync(this._ledgerPath, `${JSON.stringify(event)}\n`);
	}
}

/** Parse a ledger, tolerating a torn (killed mid-append) final line only. */
function parseLedgerContent(raw: string): { events: LineageEvent[]; validLength: number } {
	const events: LineageEvent[] = [];
	let offset = 0;
	let validLength = 0;
	let lineNumber = 0;
	while (offset < raw.length) {
		const newlineIndex = raw.indexOf("\n", offset);
		const end = newlineIndex === -1 ? raw.length : newlineIndex + 1;
		const line = raw.slice(offset, end);
		lineNumber += 1;
		if (line.trim().length > 0) {
			try {
				events.push(JSON.parse(line) as LineageEvent);
			} catch (error) {
				if (end === raw.length) {
					return { events, validLength };
				}
				throw new Error(`corrupt lineage ledger line ${lineNumber}: ${String(error)}`);
			}
		}
		offset = end;
		validLength = end;
	}
	return { events, validLength };
}

export function readLineageLedger(path: string): LineageEvent[] {
	return parseLedgerContent(readFileSync(path, "utf8")).events;
}

/**
 * Fold ledgers into the lineage-v1 manifest. Contexts are derived (initial
 * from session_registered, compact targets from completed compactions) so a
 * torn ledger tail can never split a context from its transition record.
 */
export function deriveLineageManifest(ledgers: LineageEvent[][]): LineageManifest {
	const sessions = new Map<string, LineageManifest["sessions"][number]>();
	const contexts = new Map<string, LineageManifest["contexts"][number]>();
	const compactions = new Map<
		string,
		Omit<LineageManifest["compactions"][number], "summary_request_id" | "target_context_id"> & {
			summary_request_id?: string;
			pending_target_context_id: string;
			target_context_id?: string;
		}
	>();
	const requests = new Map<string, LineageManifest["requests"][number]>();

	for (const event of ledgers.flat()) {
		switch (event.type) {
			case "session_registered": {
				if (sessions.has(event.session_id)) {
					break;
				}
				sessions.set(event.session_id, {
					session_id: event.session_id,
					...(event.parent_session_id !== undefined ? { parent_session_id: event.parent_session_id } : {}),
					depth: event.depth,
					initial_context_id: event.initial_context_id,
					...(event.spawned_by_request_id !== undefined
						? { spawned_by_request_id: event.spawned_by_request_id }
						: {}),
					status: "running",
				});
				contexts.set(event.initial_context_id, {
					context_id: event.initial_context_id,
					session_id: event.session_id,
					transition: event.parent_session_id === undefined ? "root" : "spawn",
				});
				break;
			}
			case "request_started":
				requests.set(event.request_id, {
					request_id: event.request_id,
					session_id: event.session_id,
					context_id: event.context_id,
					kind: event.kind,
					...(event.compaction_id !== undefined ? { compaction_id: event.compaction_id } : {}),
				});
				break;
			case "compaction_begun":
				compactions.set(event.compaction_id, {
					compaction_id: event.compaction_id,
					session_id: event.session_id,
					source_context_id: event.source_context_id,
					pending_target_context_id: event.target_context_id,
					status: "in_progress",
				});
				break;
			case "compaction_finished": {
				const compaction = compactions.get(event.compaction_id);
				if (!compaction || compaction.status !== "in_progress") {
					break;
				}
				compaction.status = event.status;
				if (event.status === "completed") {
					compaction.target_context_id = compaction.pending_target_context_id;
					contexts.set(compaction.pending_target_context_id, {
						context_id: compaction.pending_target_context_id,
						session_id: compaction.session_id,
						previous_context_id: compaction.source_context_id,
						transition: "compact",
						compaction_id: compaction.compaction_id,
					});
				}
				break;
			}
			case "session_status": {
				const session = sessions.get(event.session_id);
				if (session && session.status === "running") {
					session.status = event.status;
				}
				break;
			}
		}
	}

	for (const compaction of compactions.values()) {
		const summaryRequest = [...requests.values()].find(
			(request) => request.kind === "compaction" && request.compaction_id === compaction.compaction_id,
		);
		if (summaryRequest) {
			compaction.summary_request_id = summaryRequest.request_id;
		}
	}

	// Torn-tail windows: a begun compaction may lack its summary request, and a
	// request may name a compaction whose begun record is absent. Drop both.
	const keptCompactions = [...compactions.values()].filter(
		(compaction): compaction is typeof compaction & { summary_request_id: string } =>
			compaction.summary_request_id !== undefined,
	);
	const keptCompactionIds = new Set(keptCompactions.map((compaction) => compaction.compaction_id));
	const keptRequests = [...requests.values()].filter(
		(request) => request.compaction_id === undefined || keptCompactionIds.has(request.compaction_id),
	);

	return {
		sessions: [...sessions.values()],
		contexts: [...contexts.values()],
		compactions: keptCompactions.map(({ pending_target_context_id: _pending, ...compaction }) => compaction),
		requests: keptRequests,
	};
}

const LINEAGE_INNER_STREAM_FN = Symbol.for("prime-agent.lineage.inner-stream-fn");

/**
 * Bind a stream function to one session's recorder. Re-wrapping an already
 * wrapped function rebinds the original, so a child session that inherits its
 * parent's streamFn attributes calls to its own ledger.
 */
export function wrapStreamFnWithLineage(streamFn: StreamFn, recorder: LineageRecorder): StreamFn {
	const inner = ((streamFn as { [LINEAGE_INNER_STREAM_FN]?: StreamFn })[LINEAGE_INNER_STREAM_FN] ??
		streamFn) as StreamFn;
	const wrapped: StreamFn = (model, context, options) => {
		const requestId = recorder.startTurnRequest({
			messageCount: context.messages.length,
			lastRole: context.messages[context.messages.length - 1]?.role,
		});
		return inner(model, context, {
			...options,
			headers: { ...options?.headers, ...lineageRequestHeaders(requestId) },
		});
	};
	(wrapped as { [LINEAGE_INNER_STREAM_FN]?: StreamFn })[LINEAGE_INNER_STREAM_FN] = inner;
	return wrapped;
}
