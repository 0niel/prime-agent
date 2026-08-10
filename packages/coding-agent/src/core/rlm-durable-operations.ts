/**
 * Durable, owner-local facts for daemon RLM terminal delivery.
 *
 * The JSONL files are the authority.  The index deliberately is not read by
 * this module when making a decision: it is merely a crash-safe, body-free
 * summary for an operator that already has permission to inspect artifacts.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

export type RlmChildTerminalStatus = "done" | "error" | "cancelled";
export const RLM_DURABLE_VERSION = 1 as const;

export interface RlmTerminalMessage {
	role: "custom";
	customType: "rlm_child_failure" | "rlm_child_terminal_notice" | "agent_message";
	content: string;
	display: boolean;
	details: Record<string, unknown>;
	timestamp: number;
}

export interface RlmOperationAdmittedRecord {
	version: 1;
	type: "admitted";
	parentSessionId: string;
	parentSessionFile: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	childSessionDir: string;
	requestedModel: { provider: string; modelId: string };
	rlmDepth: number;
	rlmMaxDepth: number;
	recordedAt: string;
}
export interface RlmOperationMaterializedRecord {
	version: 1;
	type: "materialized";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	childSessionId: string;
	childSessionFile: string;
	childArtifactDir: string;
	recordedAt: string;
}
export interface RlmOperationTerminalRecordedRecord {
	version: 1;
	type: "terminal_recorded";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	terminal: RlmChildTerminalStatus;
	recordedAt: string;
}
export interface RlmOperationReleasedRecord {
	version: 1;
	type: "released" | "deleted";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	recordedAt: string;
}
export type RlmOperationLedgerRecord =
	| RlmOperationAdmittedRecord
	| RlmOperationMaterializedRecord
	| RlmOperationTerminalRecordedRecord
	| RlmOperationReleasedRecord;

export interface RlmTerminalOutboxRecord {
	version: 1;
	type: "terminal";
	parentSessionId: string;
	parentSessionFile: string;
	childSessionId: string;
	childSessionFile: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	terminal: RlmChildTerminalStatus;
	message: RlmTerminalMessage;
	recordedAt: string;
}
export interface RlmTerminalInboxRecord extends Omit<RlmTerminalOutboxRecord, "type" | "recordedAt"> {
	version: 1;
	type: "received";
	receivedAt: string;
}
export interface RlmTerminalConsumedRecord {
	version: 1;
	type: "materialized" | "discarded";
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	sessionMessageId?: string;
	reason?: "parent_mismatch" | "superseded_assignment" | "deleted";
	recordedAt: string;
}

export interface RlmOperationAdmission {
	parentSessionId: string;
	parentSessionFile: string;
	/** Trusted root containing the parent session file, not its artifact dir. */
	parentSessionRoot: string;
	/** Trusted root containing the parent artifact dir, which may be a sibling of the session dir. */
	parentArtifactRoot: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	childSessionDir: string;
	requestedModel: { provider: string; modelId: string };
	rlmDepth: number;
	rlmMaxDepth: number;
}
export interface RlmOperationMaterialization {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	childSessionId: string;
	childSessionFile: string;
	childSessionRoot: string;
	childArtifactDir: string;
	childArtifactRoot: string;
}
export interface RlmOperationTerminal {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	terminal: RlmChildTerminalStatus;
}
export interface RlmTerminalOutbox extends Omit<RlmTerminalOutboxRecord, "version" | "type" | "recordedAt"> {
	/** Required trusted roots. They are validation inputs and are never persisted. */
	parentSessionRoot: string;
	parentArtifactRoot: string;
	childSessionRoot: string;
	childArtifactDir: string;
	childArtifactRoot: string;
}
export interface RlmDeliveryMaterialization {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	sessionMessageId: string;
}
export interface RlmDeliveryDiscard {
	parentSessionId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	reason: "parent_mismatch" | "superseded_assignment" | "deleted";
}

export interface RlmDurableOperation {
	key: string;
	parentSessionId: string;
	parentSessionFile: string;
	childId: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
	childSessionDir: string;
	requestedModel: { provider: string; modelId: string };
	rlmDepth: number;
	rlmMaxDepth: number;
	childSessionId?: string;
	childSessionFile?: string;
	childArtifactDir?: string;
	terminal?: RlmChildTerminalStatus;
	lifecycle: "admitted" | "materialized" | "terminal_recorded" | "released" | "deleted";
	uncertain: boolean;
}
export interface RlmDurableDelivery {
	key: string;
	operationKey: string;
	deliveryId: string;
	terminal?: RlmChildTerminalStatus;
	outboxed: boolean;
	received: boolean;
	consumed?: "materialized" | "discarded";
	uncertain: boolean;
}
export interface RlmDurableOperationRegistry {
	operations: Map<string, RlmDurableOperation>;
	deliveries: Map<string, RlmDurableDelivery>;
	/** A corrupt line without a usable compound key still makes the history unsafe. */
	hasUncertainRecords: boolean;
	diagnostics: readonly string[];
}

export interface RlmDurableOperationStore {
	admit(input: RlmOperationAdmission): RlmDurableOperation;
	markMaterialized(input: RlmOperationMaterialization): boolean;
	recordTerminal(input: RlmOperationTerminal): boolean;
	appendOutbox(input: RlmTerminalOutbox): "new" | "already_recorded";
	importOutbox(input: RlmTerminalOutbox): "new" | "already_received";
	markMaterializedDelivery(input: RlmDeliveryMaterialization): "new" | "already_materialized";
	markDiscardedDelivery(input: RlmDeliveryDiscard): "new" | "already_discarded";
	rebuild(): RlmDurableOperationRegistry;
}

/** Injectable only for focused durability fault tests. */
export interface RlmDurableIo {
	mkdirSync: typeof mkdirSync;
	chmodSync: typeof chmodSync;
	openSync: typeof openSync;
	closeSync: typeof closeSync;
	writeSync: typeof writeSync;
	fsyncSync: typeof fsyncSync;
	readFileSync: typeof readFileSync;
	realpathSync: typeof realpathSync;
	renameSync: typeof renameSync;
}
export interface RlmDurableOperationStoreOptions {
	io?: RlmDurableIo;
	now?: () => string;
}

const defaultIo: RlmDurableIo = {
	mkdirSync,
	chmodSync,
	openSync,
	closeSync,
	writeSync,
	fsyncSync,
	readFileSync,
	realpathSync,
	renameSync,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINALS = new Set<RlmChildTerminalStatus>(["done", "error", "cancelled"]);
const MAX_MESSAGE_CHARS = 16_384;
const MAX_MESSAGE_BYTES = 24 * 1024;
const LEDGER = "rlm-operation-ledger.jsonl";
const INBOX = "rlm-terminal-inbox.jsonl";
const CONSUMED = "rlm-terminal-consumed.jsonl";
const INDEX = "rlm-active-index.json";
const OUTBOX = "rlm-terminal-outbox.jsonl";

export function materializedTerminalMessageId(deliveryId: string): string {
	assertUuid(deliveryId, "deliveryId");
	return `rlm-terminal-${deliveryId}`;
}

/** Open is an owner action and creates its supplied artifact directory with owner-only permissions. */
export function openRlmDurableOperationStore(
	parentArtifactDir: string,
	options: RlmDurableOperationStoreOptions = {},
): RlmDurableOperationStore {
	return new Store(parentArtifactDir, options);
}

/** Passive: this does not create, chmod, repair, or write an artifact/cache. */
export function readRlmDurableOperationRegistry(parentArtifactDir: string): RlmDurableOperationRegistry {
	return reduceArtifact(parentArtifactDir, defaultIo, false);
}

class Store implements RlmDurableOperationStore {
	private readonly io: RlmDurableIo;
	private readonly now: () => string;
	private readonly parentArtifactDir: string;

	constructor(parentArtifactDir: string, options: RlmDurableOperationStoreOptions) {
		this.io = options.io ?? defaultIo;
		this.now = options.now ?? (() => new Date().toISOString());
		this.io.mkdirSync(parentArtifactDir, { recursive: true, mode: 0o700 });
		this.io.chmodSync(parentArtifactDir, 0o700);
		this.parentArtifactDir = this.io.realpathSync(parentArtifactDir);
	}

	admit(input: RlmOperationAdmission): RlmDurableOperation {
		this.assertAdmission(input);
		const registry = this.reduce();
		const key = operationKey(input.parentSessionId, input.assignmentId, input.operationId);
		const existing = registry.operations.get(key);
		const record: RlmOperationAdmittedRecord = {
			version: 1,
			type: "admitted",
			parentSessionId: input.parentSessionId,
			parentSessionFile: canonicalExistingFile(input.parentSessionFile, input.parentSessionRoot, this.io),
			childId: boundedText(input.childId, "childId", 256),
			assignmentId: canonicalUuid(input.assignmentId, "assignmentId"),
			operationId: canonicalUuid(input.operationId, "operationId"),
			deliveryId: canonicalUuid(input.deliveryId, "deliveryId"),
			childSessionDir: canonicalDirectory(input.childSessionDir, input.childSessionDir, this.io),
			requestedModel: validateModel(input.requestedModel),
			rlmDepth: boundedInteger(input.rlmDepth, "rlmDepth"),
			rlmMaxDepth: boundedInteger(input.rlmMaxDepth, "rlmMaxDepth"),
			recordedAt: this.now(),
		};
		if (record.rlmDepth > record.rlmMaxDepth) throw new Error("rlmDepth cannot exceed rlmMaxDepth");
		if (existing) {
			if (existing.uncertain || !sameAdmitted(existing, record))
				throw new Error(`Conflicting durable admission: ${key}`);
			return existing;
		}
		this.append(this.path(LEDGER), record);
		return this.afterAppend().operations.get(key)!;
	}

	markMaterialized(input: RlmOperationMaterialization): boolean {
		assertOperationInput(input);
		const registry = this.reduce();
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (!operation || operation.uncertain || operation.lifecycle === "released" || operation.lifecycle === "deleted")
			return false;
		const childFile = canonicalExistingFile(input.childSessionFile, input.childSessionRoot, this.io);
		try {
			assertSessionIdentity(input.childSessionId, childFile, this.io);
			assertContainedDirectory(input.childArtifactDir, input.childArtifactRoot, this.io, true);
		} catch {
			return false;
		}
		const record: RlmOperationMaterializedRecord = {
			version: 1,
			type: "materialized",
			parentSessionId: input.parentSessionId,
			assignmentId: input.assignmentId,
			operationId: input.operationId,
			childSessionId: input.childSessionId,
			childSessionFile: childFile,
			childArtifactDir: assertContainedDirectory(input.childArtifactDir, input.childArtifactRoot, this.io, true),
			recordedAt: this.now(),
		};
		if (operation.childSessionFile) {
			if (
				operation.childSessionId === record.childSessionId &&
				operation.childSessionFile === record.childSessionFile
			)
				return true;
			return false;
		}
		this.append(this.path(LEDGER), record);
		this.afterAppend();
		return true;
	}

	recordTerminal(input: RlmOperationTerminal): boolean {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		assertTerminal(input.terminal);
		const registry = this.reduce();
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (!operation || operation.uncertain || !operation.childSessionFile || operation.deliveryId !== input.deliveryId)
			return false;
		if (operation.terminal) return operation.terminal === input.terminal;
		const delivery = registry.deliveries.get(deliveryKey(operation.key, input.deliveryId));
		if (!delivery?.outboxed || delivery.terminal !== input.terminal || delivery.uncertain) return false;
		this.append(this.path(LEDGER), { version: 1, type: "terminal_recorded", ...input, recordedAt: this.now() });
		this.afterAppend();
		return true;
	}

	appendOutbox(input: RlmTerminalOutbox): "new" | "already_recorded" {
		const { operation, record } = this.validateOutboxInput(input, false);
		const registry = this.reduce();
		const prior = registry.deliveries.get(deliveryKey(operation.key, record.deliveryId));
		if (prior?.outboxed) {
			const priorDigest = (prior as RlmDurableDelivery & { _digest?: string })._digest;
			if (
				prior.uncertain ||
				prior.terminal !== record.terminal ||
				(priorDigest !== undefined && priorDigest !== digestMessage(record.message))
			) {
				throw new Error("Conflicting durable outbox record");
			}
			return "already_recorded";
		}
		this.append(joinArtifact(input.childArtifactDir, OUTBOX, this.io), record);
		this.afterAppend();
		return "new";
	}

	importOutbox(input: RlmTerminalOutbox): "new" | "already_received" {
		const { operation, record } = this.validateOutboxInput(input, true);
		const registry = this.reduce();
		const delivery = registry.deliveries.get(deliveryKey(operation.key, record.deliveryId));
		if (!delivery?.outboxed || delivery.uncertain || operation.terminal !== record.terminal) {
			throw new Error("Outbox is not a durable terminal hand-off");
		}
		if (delivery.received) return "already_received";
		const inbox: RlmTerminalInboxRecord = { ...record, type: "received", receivedAt: this.now() };
		this.append(this.path(INBOX), inbox);
		this.afterAppend();
		return "new";
	}

	markMaterializedDelivery(input: RlmDeliveryMaterialization): "new" | "already_materialized" {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		if (
			boundedText(input.sessionMessageId, "sessionMessageId", 128) !==
			materializedTerminalMessageId(input.deliveryId)
		) {
			throw new Error("sessionMessageId must be the deterministic durable delivery id");
		}
		const registry = this.reduce();
		const delivery = registry.deliveries.get(
			deliveryKey(operationKey(input.parentSessionId, input.assignmentId, input.operationId), input.deliveryId),
		);
		if (!delivery || delivery.uncertain || !delivery.received)
			throw new Error("Cannot consume a missing or uncertain inbox record");
		if (delivery.consumed === "materialized") return "already_materialized";
		if (delivery.consumed) throw new Error("Delivery was discarded");
		this.append(this.path(CONSUMED), { version: 1, type: "materialized", ...input, recordedAt: this.now() });
		this.afterAppend();
		return "new";
	}

	markDiscardedDelivery(input: RlmDeliveryDiscard): "new" | "already_discarded" {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		const registry = this.reduce();
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		const delivery = registry.deliveries.get(deliveryKey(operation?.key ?? "", input.deliveryId));
		if (
			!operation ||
			operation.uncertain ||
			operation.lifecycle !== "deleted" ||
			!delivery?.received ||
			delivery.uncertain
		) {
			throw new Error("Only an exact deleted operation may discard an inbox delivery");
		}
		if (delivery.consumed === "discarded") return "already_discarded";
		if (delivery.consumed) throw new Error("Delivery was materialized");
		this.append(this.path(CONSUMED), { version: 1, type: "discarded", ...input, recordedAt: this.now() });
		this.afterAppend();
		return "new";
	}

	rebuild(): RlmDurableOperationRegistry {
		const registry = this.reduce();
		this.writeIndex(registry); // cache failure cannot undo an fsynced authority append.
		return registry;
	}

	/** Releases/deletes are deliberately internal helpers for later host integration. */
	recordRelease(
		input: Pick<RlmOperationTerminal, "parentSessionId" | "assignmentId" | "operationId">,
		type: "released" | "deleted",
	): boolean {
		assertOperationInput(input);
		const operation = this.reduce().operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (!operation || operation.uncertain || operation.lifecycle === "released" || operation.lifecycle === "deleted")
			return false;
		this.append(this.path(LEDGER), { version: 1, type, ...input, recordedAt: this.now() });
		this.afterAppend();
		return true;
	}

	private validateOutboxInput(
		input: RlmTerminalOutbox,
		requireTerminal: boolean,
	): { operation: RlmDurableOperation; record: RlmTerminalOutboxRecord } {
		assertOperationInput(input);
		assertUuid(input.deliveryId, "deliveryId");
		assertTerminal(input.terminal);
		assertTerminalMessage(input.message);
		const registry = this.reduce();
		const operation = registry.operations.get(
			operationKey(input.parentSessionId, input.assignmentId, input.operationId),
		);
		if (
			!operation ||
			operation.uncertain ||
			!operation.childSessionFile ||
			!operation.childSessionId ||
			operation.deliveryId !== input.deliveryId
		) {
			throw new Error("Outbox does not match an exact materialized operation");
		}
		if (requireTerminal && operation.terminal !== input.terminal)
			throw new Error("Outbox terminal is not ledger-recorded");
		const parentFile = canonicalExistingFile(input.parentSessionFile, input.parentSessionRoot, this.io);
		const childFile = canonicalExistingFile(input.childSessionFile, input.childSessionRoot, this.io);
		assertSessionIdentity(input.parentSessionId, parentFile, this.io);
		assertSessionIdentity(input.childSessionId, childFile, this.io);
		assertContainedDirectory(this.parentArtifactDir, input.parentArtifactRoot, this.io, false);
		assertContainedDirectory(input.childArtifactDir, input.childArtifactRoot, this.io, true);
		if (
			operation.parentSessionFile !== parentFile ||
			operation.childSessionFile !== childFile ||
			operation.childSessionId !== input.childSessionId ||
			operation.childId !== input.childId
		) {
			throw new Error("Outbox session identity/path conflicts with admission");
		}
		return {
			operation,
			record: {
				version: 1,
				type: "terminal",
				parentSessionId: input.parentSessionId,
				parentSessionFile: parentFile,
				childSessionId: input.childSessionId,
				childSessionFile: childFile,
				childId: boundedText(input.childId, "childId", 256),
				assignmentId: input.assignmentId,
				operationId: input.operationId,
				deliveryId: input.deliveryId,
				terminal: input.terminal,
				message: input.message,
				recordedAt: this.now(),
			},
		};
	}

	private assertAdmission(input: RlmOperationAdmission): void {
		assertUuid(input.parentSessionId, "parentSessionId");
		assertUuid(input.assignmentId, "assignmentId");
		assertUuid(input.operationId, "operationId");
		assertUuid(input.deliveryId, "deliveryId");
		const parentFile = canonicalExistingFile(input.parentSessionFile, input.parentSessionRoot, this.io);
		assertSessionIdentity(input.parentSessionId, parentFile, this.io);
		assertContainedDirectory(this.parentArtifactDir, input.parentArtifactRoot, this.io, false);
		canonicalDirectory(input.childSessionDir, input.childSessionDir, this.io);
	}
	private reduce(): RlmDurableOperationRegistry {
		return reduceArtifact(this.parentArtifactDir, this.io, false);
	}
	private afterAppend(): RlmDurableOperationRegistry {
		const registry = this.reduce();
		this.writeIndex(registry);
		return registry;
	}
	private path(name: string): string {
		return joinArtifact(this.parentArtifactDir, name, this.io);
	}
	private append(path: string, record: unknown): void {
		appendJsonl(path, record, this.io);
	}
	private writeIndex(registry: RlmDurableOperationRegistry): void {
		try {
			const body = JSON.stringify(bodylessIndex(registry));
			atomicCache(this.path(INDEX), body, this.io);
		} catch {
			// Cache is deliberately non-authoritative. The next owner rebuild may retry.
		}
	}
}

function reduceArtifact(
	parentArtifactDir: string,
	io: RlmDurableIo,
	_writeCache: boolean,
): RlmDurableOperationRegistry {
	const registry: RlmDurableOperationRegistry = {
		operations: new Map(),
		deliveries: new Map(),
		hasUncertainRecords: false,
		diagnostics: [],
	};
	let canonicalParent: string;
	try {
		canonicalParent = io.realpathSync(parentArtifactDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return registry;
		throw error;
	}
	for (const parsed of readJsonl(joinArtifact(canonicalParent, LEDGER, io), io, registry, "ledger"))
		reduceLedger(parsed, registry);
	// A child outbox becomes discoverable only from a materialized, admitted operation.
	for (const operation of registry.operations.values()) {
		if (!operation.childSessionFile || !operation.childArtifactDir || operation.uncertain) continue;
		try {
			for (const parsed of readJsonl(joinArtifact(operation.childArtifactDir, OUTBOX, io), io, registry, "outbox"))
				reduceOutbox(parsed, registry);
		} catch {
			markOperationUncertain(operation, registry, "outbox path cannot be read");
		}
	}
	for (const parsed of readJsonl(joinArtifact(canonicalParent, INBOX, io), io, registry, "inbox"))
		reduceInbox(parsed, registry);
	for (const parsed of readJsonl(joinArtifact(canonicalParent, CONSUMED, io), io, registry, "consumed"))
		reduceConsumed(parsed, registry);
	return registry;
}

function readJsonl(path: string, io: RlmDurableIo, registry: RlmDurableOperationRegistry, kind: string): unknown[] {
	let source: string;
	try {
		source = io.readFileSync(path, "utf8") as string;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!source) return [];
	const lines = source.split("\n");
	const hasFinalNewline = source.endsWith("\n");
	const count = hasFinalNewline ? lines.length - 1 : lines.length;
	const parsed: unknown[] = [];
	for (let i = 0; i < count; i++) {
		const line = lines[i]!;
		if (!line) {
			registry.hasUncertainRecords = true;
			registry.diagnostics = [...registry.diagnostics, `${kind}: empty complete line ${i + 1}`];
			continue;
		}
		try {
			parsed.push(JSON.parse(line));
		} catch {
			// Only an invalid physical final tail without a newline is crash-tolerated.
			if (!hasFinalNewline && i === count - 1) continue;
			registry.hasUncertainRecords = true;
			registry.diagnostics = [...registry.diagnostics, `${kind}: malformed complete line ${i + 1}`];
		}
	}
	return parsed;
}

function reduceLedger(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!isObject(raw) || raw.version !== 1 || typeof raw.type !== "string") {
		globalUncertain(registry, "invalid ledger record");
		return;
	}
	if (raw.type === "admitted") {
		if (!validAdmitted(raw)) {
			globalUncertain(registry, "invalid admitted record");
			return;
		}
		const record = raw as unknown as RlmOperationAdmittedRecord;
		const key = operationKey(record.parentSessionId, record.assignmentId, record.operationId);
		const existing = registry.operations.get(key);
		if (!existing) {
			registry.operations.set(key, {
				key,
				parentSessionId: record.parentSessionId,
				parentSessionFile: record.parentSessionFile,
				childId: record.childId,
				assignmentId: record.assignmentId,
				operationId: record.operationId,
				deliveryId: record.deliveryId,
				childSessionDir: record.childSessionDir,
				requestedModel: record.requestedModel,
				rlmDepth: record.rlmDepth,
				rlmMaxDepth: record.rlmMaxDepth,
				lifecycle: "admitted",
				uncertain: false,
			});
		} else if (!sameAdmitted(existing, record)) markOperationUncertain(existing, registry, "conflicting admission");
		return;
	}
	if (!hasOperationIdentity(raw)) {
		globalUncertain(registry, "invalid ledger identity");
		return;
	}
	const operation = registry.operations.get(operationKey(raw.parentSessionId, raw.assignmentId, raw.operationId));
	if (!operation) {
		globalUncertain(registry, "ledger event without admission");
		return;
	}
	if (raw.type === "materialized") {
		if (!validMaterialized(raw)) {
			markOperationUncertain(operation, registry, "invalid materialization");
			return;
		}
		if (!operation.childSessionFile) {
			operation.childSessionId = raw.childSessionId;
			operation.childSessionFile = raw.childSessionFile;
			operation.childArtifactDir = raw.childArtifactDir;
			operation.lifecycle = "materialized";
		} else if (
			operation.childSessionId !== raw.childSessionId ||
			operation.childSessionFile !== raw.childSessionFile ||
			operation.childArtifactDir !== raw.childArtifactDir
		)
			markOperationUncertain(operation, registry, "conflicting materialization");
		return;
	}
	if (raw.type === "terminal_recorded") {
		if (!validTerminalRecorded(raw) || !operation.childSessionFile || raw.deliveryId !== operation.deliveryId) {
			markOperationUncertain(operation, registry, "invalid terminal");
			return;
		}
		if (!operation.terminal) {
			operation.terminal = raw.terminal as RlmChildTerminalStatus;
			if (operation.lifecycle !== "deleted") operation.lifecycle = "terminal_recorded";
		} else if (operation.terminal !== raw.terminal)
			markOperationUncertain(operation, registry, "conflicting terminal");
		return;
	}
	if (raw.type === "released" || raw.type === "deleted") {
		if (!validStamped(raw)) {
			markOperationUncertain(operation, registry, "invalid release");
			return;
		}
		if (operation.lifecycle === "released" || operation.lifecycle === "deleted") {
			if (operation.lifecycle !== raw.type)
				markOperationUncertain(operation, registry, "conflicting release/deletion");
		} else operation.lifecycle = raw.type;
		return;
	}
	markOperationUncertain(operation, registry, "unknown ledger event");
}

function reduceOutbox(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!validOutbox(raw, "terminal")) {
		globalUncertain(registry, "invalid outbox record");
		return;
	}
	const record = raw as RlmTerminalOutboxRecord;
	const operation = registry.operations.get(
		operationKey(record.parentSessionId, record.assignmentId, record.operationId),
	);
	if (!operation) {
		globalUncertain(registry, "outbox without operation");
		return;
	}
	const delivery = deliveryFor(operation, record.deliveryId, registry);
	if (
		operation.uncertain ||
		record.deliveryId !== operation.deliveryId ||
		operation.parentSessionFile !== record.parentSessionFile ||
		operation.childSessionId !== record.childSessionId ||
		operation.childSessionFile !== record.childSessionFile ||
		operation.childId !== record.childId
	) {
		markDeliveryUncertain(delivery, operation, registry, "outbox identity mismatch");
		return;
	}
	if (!delivery.outboxed) {
		delivery.outboxed = true;
		delivery.terminal = record.terminal;
		defineDeliveryDigest(delivery, record);
	} else if (
		delivery.terminal !== record.terminal ||
		deliveryDigest(delivery, record) !== digestMessage(record.message)
	)
		markDeliveryUncertain(delivery, operation, registry, "conflicting outbox");
	else defineDeliveryDigest(delivery, record);
}

function reduceInbox(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!validOutbox(raw, "received")) {
		globalUncertain(registry, "invalid inbox record");
		return;
	}
	const record = raw as RlmTerminalInboxRecord;
	const operation = registry.operations.get(
		operationKey(record.parentSessionId, record.assignmentId, record.operationId),
	);
	if (!operation) {
		globalUncertain(registry, "inbox without operation");
		return;
	}
	const delivery = deliveryFor(operation, record.deliveryId, registry);
	if (
		!delivery.outboxed ||
		delivery.uncertain ||
		!operation.terminal ||
		operation.terminal !== record.terminal ||
		delivery.terminal !== record.terminal
	) {
		markDeliveryUncertain(delivery, operation, registry, "inbox without matching outbox/terminal");
		return;
	}
	if (!delivery.received) {
		delivery.received = true;
		defineDeliveryDigest(delivery, record);
	} else if (deliveryDigest(delivery, record) !== digestMessage(record.message))
		markDeliveryUncertain(delivery, operation, registry, "conflicting inbox");
}

function reduceConsumed(raw: unknown, registry: RlmDurableOperationRegistry): void {
	if (!validConsumed(raw)) {
		globalUncertain(registry, "invalid consumed record");
		return;
	}
	const record = raw as RlmTerminalConsumedRecord;
	const operation = registry.operations.get(
		operationKey(record.parentSessionId, record.assignmentId, record.operationId),
	);
	if (!operation) {
		globalUncertain(registry, "consumed without operation");
		return;
	}
	const delivery = deliveryFor(operation, record.deliveryId, registry);
	if (!delivery.received || delivery.uncertain) {
		markDeliveryUncertain(delivery, operation, registry, "consumed before inbox");
		return;
	}
	if (record.type === "discarded" && operation.lifecycle !== "deleted") {
		markDeliveryUncertain(delivery, operation, registry, "discard without deletion");
		return;
	}
	if (!delivery.consumed) delivery.consumed = record.type;
	else if (delivery.consumed !== record.type)
		markDeliveryUncertain(delivery, operation, registry, "conflicting consumption");
}

function deliveryFor(
	operation: RlmDurableOperation,
	deliveryId: string,
	registry: RlmDurableOperationRegistry,
): RlmDurableDelivery {
	const key = deliveryKey(operation.key, deliveryId);
	let delivery = registry.deliveries.get(key);
	if (!delivery) {
		delivery = { key, operationKey: operation.key, deliveryId, outboxed: false, received: false, uncertain: false };
		registry.deliveries.set(key, delivery);
	}
	return delivery;
}
function defineDeliveryDigest(
	delivery: RlmDurableDelivery & { _digest?: string },
	record: { message: RlmTerminalMessage },
): void {
	delivery._digest = digestMessage(record.message);
}
function deliveryDigest(
	delivery: RlmDurableDelivery & { _digest?: string },
	record: { message: RlmTerminalMessage },
): string {
	return delivery._digest ?? digestMessage(record.message);
}
function markOperationUncertain(
	operation: RlmDurableOperation,
	registry: RlmDurableOperationRegistry,
	message: string,
): void {
	operation.uncertain = true;
	registry.hasUncertainRecords = true;
	registry.diagnostics = [...registry.diagnostics, `${operation.key}: ${message}`];
}
function markDeliveryUncertain(
	delivery: RlmDurableDelivery,
	operation: RlmDurableOperation,
	registry: RlmDurableOperationRegistry,
	message: string,
): void {
	delivery.uncertain = true;
	markOperationUncertain(operation, registry, message);
}
function globalUncertain(registry: RlmDurableOperationRegistry, message: string): void {
	registry.hasUncertainRecords = true;
	registry.diagnostics = [...registry.diagnostics, message];
}

function appendJsonl(path: string, record: unknown, io: RlmDurableIo): void {
	const fd = io.openSync(path, "a", 0o600);
	try {
		writeAll(fd, Buffer.from(`${JSON.stringify(record)}\n`), io);
		io.fsyncSync(fd);
	} finally {
		io.closeSync(fd);
	}
	io.chmodSync(path, 0o600);
}
function writeAll(fd: number, data: Buffer, io: RlmDurableIo): void {
	let offset = 0;
	while (offset < data.length) {
		const written = io.writeSync(fd, data, offset, data.length - offset);
		if (!Number.isSafeInteger(written) || written <= 0 || written > data.length - offset)
			throw new Error("Durable write made no forward progress");
		offset += written;
	}
}
function atomicCache(path: string, body: string, io: RlmDurableIo): void {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	const fd = io.openSync(temp, "wx", 0o600);
	try {
		writeAll(fd, Buffer.from(body), io);
		io.fsyncSync(fd);
	} finally {
		io.closeSync(fd);
	}
	io.chmodSync(temp, 0o600);
	io.renameSync(temp, path);
	const directory = io.openSync(dirname(path), "r");
	try {
		io.fsyncSync(directory);
	} finally {
		io.closeSync(directory);
	}
}

function bodylessIndex(registry: RlmDurableOperationRegistry): unknown {
	return {
		version: 1,
		operations: [...registry.operations.values()].map(({ parentSessionFile, childSessionFile, ...operation }) => ({
			...operation,
			parentSessionFile,
			childSessionFile,
		})),
		deliveries: [...registry.deliveries.values()].map((delivery) => ({ ...delivery })),
		uncertain: registry.hasUncertainRecords,
	};
}
function operationKey(parentSessionId: string, assignmentId: string, operationId: string): string {
	return JSON.stringify([parentSessionId, assignmentId, operationId]);
}
function deliveryKey(operation: string, deliveryId: string): string {
	return JSON.stringify([operation, deliveryId]);
}
function joinArtifact(directory: string, file: string, io: RlmDurableIo): string {
	return `${canonicalDirectory(directory, directory, io)}/${file}`;
}
function canonicalDirectory(path: string, root: string, io: RlmDurableIo): string {
	return assertContainedDirectory(path, root, io, false);
}
function canonicalExistingFile(path: string, root: string, io: RlmDurableIo): string {
	const canonicalRoot = io.realpathSync(root);
	const file = io.realpathSync(path);
	if (!inside(canonicalRoot, file)) throw new Error("Path escapes trusted session root");
	return file;
}
function assertContainedDirectory(path: string, root: string, io: RlmDurableIo, create: boolean): string {
	if (create) {
		io.mkdirSync(path, { recursive: true, mode: 0o700 });
		io.chmodSync(path, 0o700);
	}
	const canonicalRoot = io.realpathSync(root);
	const target = io.realpathSync(path);
	if (!inside(canonicalRoot, target)) throw new Error("Path escapes trusted artifact root");
	return target;
}
function inside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("../") && !rel.startsWith("..\\") && rel !== ".." && !isAbsolute(rel));
}
function assertSessionIdentity(id: string, file: string, io: RlmDurableIo): void {
	assertUuid(id, "sessionId");
	const first = (io.readFileSync(file, "utf8") as string).split("\n", 1)[0];
	try {
		const header = JSON.parse(first) as unknown;
		if (!isObject(header) || header.type !== "session" || header.id !== id) throw new Error();
	} catch {
		throw new Error("Session file does not match claimed session id");
	}
}
function assertUuid(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${name} must be a canonical UUID`);
}
function canonicalUuid(value: string, name: string): string {
	assertUuid(value, name);
	return value;
}
function boundedText(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum)
		throw new Error(`${name} is invalid or too large`);
	return value;
}
function boundedInteger(value: unknown, name: string): number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1024)
		throw new Error(`${name} is not a bounded integer`);
	return value as number;
}
function assertTerminal(value: unknown): asserts value is RlmChildTerminalStatus {
	if (typeof value !== "string" || !TERMINALS.has(value as RlmChildTerminalStatus))
		throw new Error("Unknown terminal projection");
}
function validateModel(value: unknown): { provider: string; modelId: string } {
	if (!isObject(value)) throw new Error("requestedModel is invalid");
	return {
		provider: boundedText(value.provider, "provider", 256),
		modelId: boundedText(value.modelId, "modelId", 256),
	};
}
function assertOperationInput(value: { parentSessionId: string; assignmentId: string; operationId: string }): void {
	assertUuid(value.parentSessionId, "parentSessionId");
	assertUuid(value.assignmentId, "assignmentId");
	assertUuid(value.operationId, "operationId");
}
function assertTerminalMessage(value: unknown): asserts value is RlmTerminalMessage {
	if (
		!isObject(value) ||
		value.role !== "custom" ||
		(value.customType !== "rlm_child_failure" &&
			value.customType !== "rlm_child_terminal_notice" &&
			value.customType !== "agent_message") ||
		typeof value.content !== "string" ||
		value.content.length > MAX_MESSAGE_CHARS ||
		typeof value.display !== "boolean" ||
		!Number.isFinite(value.timestamp) ||
		!isSafeDetails(value.details, 0)
	)
		throw new Error("Terminal message is not a bounded approved custom projection");
	if (Buffer.byteLength(stableJson(value)) > MAX_MESSAGE_BYTES) throw new Error("Terminal message is too large");
}
function isSafeDetails(value: unknown, depth: number): boolean {
	if (depth > 4) return false;
	if (value === null || typeof value === "boolean" || typeof value === "number") return true;
	if (typeof value === "string") return value.length <= 4096;
	if (Array.isArray(value)) return value.length <= 32 && value.every((item) => isSafeDetails(item, depth + 1));
	if (!isObject(value)) return false;
	const entries = Object.entries(value);
	return (
		entries.length <= 32 &&
		entries.every(
			([key, item]) =>
				key.length <= 64 &&
				key !== "__proto__" &&
				key !== "constructor" &&
				key !== "prototype" &&
				isSafeDetails(item, depth + 1),
		)
	);
}
function digestMessage(message: RlmTerminalMessage): string {
	return createHash("sha256").update(stableJson(message)).digest("hex");
}
function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOperationIdentity(value: Record<string, unknown>): value is Record<string, string> {
	return (
		typeof value.parentSessionId === "string" &&
		typeof value.assignmentId === "string" &&
		typeof value.operationId === "string" &&
		UUID.test(value.parentSessionId) &&
		UUID.test(value.assignmentId) &&
		UUID.test(value.operationId)
	);
}
function validStamped(value: Record<string, unknown>): boolean {
	return typeof value.recordedAt === "string" && !Number.isNaN(Date.parse(value.recordedAt));
}
function validAdmitted(value: Record<string, unknown>): boolean {
	return (
		hasOperationIdentity(value) &&
		typeof value.deliveryId === "string" &&
		UUID.test(value.deliveryId) &&
		typeof value.parentSessionFile === "string" &&
		isAbsolute(value.parentSessionFile) &&
		typeof value.childId === "string" &&
		typeof value.childSessionDir === "string" &&
		isAbsolute(value.childSessionDir) &&
		isObject(value.requestedModel) &&
		typeof value.requestedModel.provider === "string" &&
		typeof value.requestedModel.modelId === "string" &&
		Number.isInteger(value.rlmDepth) &&
		Number.isInteger(value.rlmMaxDepth) &&
		validStamped(value)
	);
}
function validMaterialized(value: Record<string, unknown>): value is Record<string, string> {
	return (
		hasOperationIdentity(value) &&
		typeof value.childSessionId === "string" &&
		UUID.test(value.childSessionId) &&
		typeof value.childSessionFile === "string" &&
		isAbsolute(value.childSessionFile) &&
		typeof value.childArtifactDir === "string" &&
		isAbsolute(value.childArtifactDir) &&
		validStamped(value)
	);
}
function validTerminalRecorded(value: Record<string, unknown>): value is Record<string, string> {
	return (
		hasOperationIdentity(value) &&
		typeof value.deliveryId === "string" &&
		UUID.test(value.deliveryId) &&
		typeof value.terminal === "string" &&
		TERMINALS.has(value.terminal as RlmChildTerminalStatus) &&
		validStamped(value)
	);
}
function validOutbox(value: unknown, type: "terminal" | "received"): boolean {
	if (
		!isObject(value) ||
		value.version !== 1 ||
		value.type !== type ||
		!hasOperationIdentity(value) ||
		typeof value.deliveryId !== "string" ||
		!UUID.test(value.deliveryId) ||
		typeof value.parentSessionFile !== "string" ||
		!isAbsolute(value.parentSessionFile) ||
		typeof value.childSessionId !== "string" ||
		!UUID.test(value.childSessionId) ||
		typeof value.childSessionFile !== "string" ||
		!isAbsolute(value.childSessionFile) ||
		typeof value.childId !== "string" ||
		typeof value.terminal !== "string" ||
		!TERMINALS.has(value.terminal as RlmChildTerminalStatus)
	)
		return false;
	try {
		assertTerminalMessage(value.message);
	} catch {
		return false;
	}
	return type === "terminal"
		? validStamped(value)
		: typeof value.receivedAt === "string" && !Number.isNaN(Date.parse(value.receivedAt));
}
function validConsumed(value: unknown): boolean {
	return (
		isObject(value) &&
		value.version === 1 &&
		(value.type === "materialized" || value.type === "discarded") &&
		hasOperationIdentity(value) &&
		typeof value.deliveryId === "string" &&
		UUID.test(value.deliveryId) &&
		validStamped(value) &&
		(value.type !== "materialized" || typeof value.sessionMessageId === "string") &&
		(value.type !== "discarded" ||
			value.reason === "parent_mismatch" ||
			value.reason === "superseded_assignment" ||
			value.reason === "deleted")
	);
}
function sameAdmitted(operation: RlmDurableOperation, record: RlmOperationAdmittedRecord): boolean {
	return (
		operation.parentSessionId === record.parentSessionId &&
		operation.parentSessionFile === record.parentSessionFile &&
		operation.childId === record.childId &&
		operation.assignmentId === record.assignmentId &&
		operation.operationId === record.operationId &&
		operation.deliveryId === record.deliveryId &&
		operation.childSessionDir === record.childSessionDir &&
		operation.requestedModel.provider === record.requestedModel.provider &&
		operation.requestedModel.modelId === record.requestedModel.modelId &&
		operation.rlmDepth === record.rlmDepth &&
		operation.rlmMaxDepth === record.rlmMaxDepth
	);
}
