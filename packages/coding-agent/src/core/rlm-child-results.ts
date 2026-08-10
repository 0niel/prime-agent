/**
 * C04's sole authority for bounded terminal child results and opaque, owner-local
 * artifacts.  This module deliberately has no daemon/protocol dependency.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, parse, relative, resolve } from "node:path";

export const CHILD_RESULT_SCHEMA_VERSION = 1 as const;
/** C04's opaque projection must still fit C03's 64 KiB full envelope.
 * 60 KiB leaves 4 KiB for the fixed C03 JSON/message fields and presentation. */
export const MAX_CHILD_RESULT_JSON_BYTES = 60 * 1024;
export const MAX_SUMMARY_CHARS = 4_096;
export const MAX_SUMMARY_BYTES = 16 * 1024;
export const MAX_PREVIEW_CHARS = 2_048;
export const MAX_PREVIEW_BYTES = 8 * 1024;
export const MAX_FACTS = 32;
export const MAX_NEXT_ACTIONS = 16;
export const MAX_ARTIFACTS_PER_RESULT = 16;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES_PER_CHILD_SESSION = 2 * 1024 * 1024 * 1024;
export const MAX_STREAM_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_CHILD_RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// C04 generates result, handle, assignment, operation, and delivery identifiers with
// randomUUID (v4). SessionManager is the sole exception: its session filenames
// are keyed by UUIDv7. Keep those validation domains separate so accepting a
// real child session ID cannot accidentally widen any opaque authority ID.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const statuses = new Set(["completed", "failed", "cancelled", "timed_out", "stalled", "unknown_after_crash"]);
const kinds = new Set(["terminal_output", "diagnostic", "trajectory", "attachment"]);
const contentTypes = new Set(["text/plain", "application/json", "application/octet-stream"]);
const retentionStates = new Set(["retained", "expired", "deleted", "unavailable", "uncertain"]);
const errorCodes = new Set([
	"invalid_result",
	"result_too_large",
	"artifact_too_large",
	"artifact_quota_exceeded",
	"artifact_unavailable",
	"artifact_integrity_failed",
	"artifact_expired",
	"terminal_storage_failed",
	"cancelled",
	"timed_out",
	"stalled",
	"unknown_after_crash",
]);

export type C04ChildResultStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "stalled"
	| "unknown_after_crash";
export type C04RetentionState = "retained" | "expired" | "deleted" | "unavailable" | "uncertain";
export type C04ArtifactKind = "terminal_output" | "diagnostic" | "trajectory" | "attachment";
export type C04ErrorCode =
	| "invalid_result"
	| "result_too_large"
	| "artifact_too_large"
	| "artifact_quota_exceeded"
	| "artifact_unavailable"
	| "artifact_integrity_failed"
	| "artifact_expired"
	| "terminal_storage_failed"
	| "cancelled"
	| "timed_out"
	| "stalled"
	| "unknown_after_crash";

/** Every component is required: matching a selector or only one ID is never authority. */
export interface C04ChildResultOwner {
	parentSessionId: string;
	childSessionId: string;
	childSessionFile: string;
	assignmentId: string;
	operationId: string;
	deliveryId: string;
}
export interface C04OpaqueArtifactReference {
	version: 1;
	handleId: string;
	resultId: string;
	kind: C04ArtifactKind;
	contentType: "text/plain" | "application/json" | "application/octet-stream";
	byteLength: number;
	sha256: string;
	creatorAssignmentId: string;
	ownerSessionId: string;
	retentionState: C04RetentionState;
}
export interface C04ChildResultReference {
	version: 1;
	resultId: string;
	status: C04ChildResultStatus;
	summary: string;
	preview: string;
	error?: { code: C04ErrorCode; message: string; diagnosticRef?: string };
	model: C04ModelMetadata;
	artifacts: C04OpaqueArtifactReference[];
	retentionState: C04RetentionState;
}
/** C05 receives only this same bounded shape, never correlation data or bytes. */
export type C04PublicChildResult = C04ChildResultReference;
export interface C04ModelMetadata {
	requestedSelector?: string;
	initialResolvedSelector: string;
	terminalResolvedSelector: string;
	fallbackHistory?: string[];
}
export interface C04TerminalCandidate {
	status: C04ChildResultStatus;
	summary: string;
	preview: string;
	facts?: Array<{ claim: string; evidenceRef?: string }>;
	nextActions?: string[];
	error?: { code?: string; message?: string; diagnostic?: C04ArtifactInput };
	model?: Partial<C04ModelMetadata>;
	/** Raw material is never returned or placed in the result record. */
	artifacts?: C04ArtifactInput[];
}
export interface C04ArtifactInput {
	kind: C04ArtifactKind;
	contentType: "text/plain" | "application/json" | "application/octet-stream";
	/** Payloads are stream-only. Inline strings/Uint8Arrays are deliberately
	 * rejected so a terminal can never accidentally retain an unbounded reply. */
	data: AsyncIterable<Uint8Array>;
}
export interface C04CreateTerminalChildResultInput {
	owner: C04ChildResultOwner;
	candidate: C04TerminalCandidate;
	/** Trusted SessionManager child artifact directory; callers never pass a relative object path. */
	childArtifactRoot: string;
	now?: () => Date;
}
interface StoredChildResult extends C04ChildResultReference {
	schemaVersion: 1;
	owner: C04ChildResultOwner;
	facts: Array<{ claim: string; evidenceRef?: string }>;
	nextActions: string[];
	committedAt: string;
	retention: { disposition: "retain_until"; expiresAt: string };
	requestDigest: string;
}
type AuditAction = "created" | "linked" | "read_allowed" | "read_denied" | "expired" | "deleted" | "uncertain";
const capabilities = new WeakMap<
	object,
	{ root: string; owner: C04ChildResultOwner; handleId: string; resultId: string }
>();

/**
 * Validate, stream and commit one immutable operation result.  An exact retry
 * returns its already committed reference; a different request is a conflict.
 */
export async function createOrGetTerminalChildResult(
	input: C04CreateTerminalChildResultInput,
): Promise<C04ChildResultReference> {
	const owner = validateOwner(input.owner);
	// Bind before creating C04 state: an untrusted sibling/renamed root never gets
	// a durable directory merely because it was supplied by a caller.
	validateChildBinding(owner, input.childArtifactRoot);
	const root = prepareBoundRoot(owner, input.childArtifactRoot);
	const now = input.now?.() ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new Error("C04 time is invalid");
	const candidate = validateCandidate(input.candidate);
	const artifactInputs = candidateArtifactInputs(candidate);
	// The diagnostic is an artifact too. Validate the combined count before any
	// object is published so a rejected candidate cannot consume quota.
	if (artifactInputs.length > MAX_ARTIFACTS_PER_RESULT) throw new Error("artifact count exceeds C04 limit");
	const indexPath = safePath(root, "operation-index", `${owner.operationId}.json`);
	const existing = readIndex(indexPath);
	// A committed operation is immutable.  We do not touch a retry stream until its
	// operation identity has been resolved, avoiding a concurrent writer consuming it.
	if (existing) {
		if (!sameOwner(existing.owner, owner)) throw immutableConflict(root, owner.operationId);
		// A retry supplies a fresh stream; hash its bytes incrementally rather than
		// collapsing all streams to a literal. Different raw output is a conflict.
		if (existing.requestDigest !== (await digestCandidateStreams(owner, candidate)))
			throw immutableConflict(root, owner.operationId);
		return projection(readStored(root, existing.resultId));
	}
	const release = reserveOperationAndQuota(root, owner, indexPath);
	const resultId = randomUuid();
	const artifacts: C04OpaqueArtifactReference[] = [];
	const publishedHandleIndexes: string[] = [];
	let resultPublished = false;
	let reservedBytes = aggregateBytes(root, owner);
	try {
		for (const artifact of artifactInputs) {
			const written = await writeArtifact(root, owner, resultId, artifact, reservedBytes);
			reservedBytes += written.byteLength;
			artifacts.push(written);
		}
		const diagnostic = candidate.error?.diagnostic ? artifacts.at(-1) : undefined;
		const requestDigest = digestableCandidateDigest(owner, candidate, artifacts);
		const facts = candidate.facts.map((fact) => ({
			claim: fact.claim,
			...(fact.evidenceRef && artifacts.some((ref) => ref.handleId === fact.evidenceRef)
				? { evidenceRef: fact.evidenceRef }
				: {}),
		}));
		const stored: StoredChildResult = {
			schemaVersion: 1,
			version: 1,
			resultId,
			owner,
			status: candidate.status,
			summary: candidate.summary,
			preview: candidate.preview,
			facts,
			nextActions: candidate.nextActions,
			...(candidate.error
				? {
						error: {
							code: candidate.error.code as C04ErrorCode,
							message: candidate.error.message as string,
							...(diagnostic ? { diagnosticRef: diagnostic.handleId } : {}),
						},
					}
				: {}),
			model: candidate.model as C04ModelMetadata,
			artifacts,
			retentionState: "retained",
			committedAt: now.toISOString(),
			retention: {
				disposition: "retain_until",
				expiresAt: new Date(now.getTime() + DEFAULT_CHILD_RESULT_RETENTION_MS).toISOString(),
			},
			requestDigest,
		};
		assertStored(stored);
		// readStored rejects files over this cap. Check the complete durable record,
		// rather than only its public projection, before publishing anything.
		assertStoredJsonSize(stored);
		// Initial result publication is immutable: a final name is never rename-overwritten.
		atomicExclusiveJson(safePath(root, "results", `${resultId}.json`), stored);
		resultPublished = true;
		for (const artifact of artifacts) {
			atomicExclusiveJson(safePath(root, "handle-index", `${artifact.handleId}.json`), {
				version: 1,
				resultId,
				owner,
				handleId: artifact.handleId,
			});
			publishedHandleIndexes.push(artifact.handleId);
		}
		const index = { version: 1, resultId, owner, requestDigest };
		try {
			atomicExclusiveJson(indexPath, index);
		} catch (error) {
			const raced = readIndex(indexPath);
			if (raced && sameOwner(raced.owner, owner) && raced.requestDigest === requestDigest) {
				// Another process won the immutable operation index. This writer's
				// independently published result is not authoritative: remove every
				// object/index it created before returning the winner.
				for (const handleId of publishedHandleIndexes)
					safeUnlink(safePath(root, "handle-index", `${handleId}.json`));
				if (resultPublished) safeUnlink(safePath(root, "results", `${resultId}.json`));
				for (const artifact of artifacts) safeUnlink(safePath(root, "objects", `${artifact.handleId}.blob`));
				return projection(readStored(root, raced.resultId));
			}
			appendAudit(root, "uncertain", "immutable_conflict", owner.operationId);
			throw error;
		}
		appendAudit(root, "created", "committed", resultId);
		appendAudit(root, "linked", "operation_indexed", resultId);
		return projection(stored);
	} catch (error) {
		// A terminal record is all-or-nothing. A failed result/index/handle commit
		// must not strand published blobs that would evade future aggregate quota.
		for (const handleId of publishedHandleIndexes)
			safeUnlink(safePath(root, "handle-index", `${handleId}.json`));
		if (resultPublished) safeUnlink(safePath(root, "results", `${resultId}.json`));
		for (const artifact of artifacts) safeUnlink(safePath(root, "objects", `${artifact.handleId}.blob`));
		if (!(error instanceof Error && error.message === "C04 immutable operation conflict"))
			appendAudit(root, "uncertain", "storage_failed", owner.operationId);
		throw error;
	} finally {
		release();
	}
}

export function getChildResultProjection(
	owner: C04ChildResultOwner,
	resultId: string,
	childArtifactRoot: string,
	now = new Date(),
): C04ChildResultReference | undefined {
	try {
		const verified = validateOwner(owner);
		const root = prepareBoundRoot(verified, childArtifactRoot, false);
		const result = readStored(root, resultId);
		if (!sameOwner(result.owner, verified)) return denied(root, "owner_mismatch");
		const reduced = expireIfElapsed(root, result, now);
		return projection(reduced);
	} catch {
		return undefined;
	}
}

/** Exact owner + opaque handle resolver.  It is deliberately not a generic get(handle). */
export function resolveOwnedChildResult(
	owner: C04ChildResultOwner,
	handleId: string,
	childArtifactRoot: string,
	now = new Date(),
): { result: C04PublicChildResult; capability: object } | undefined {
	try {
		const verified = validateOwner(owner);
		const root = prepareBoundRoot(verified, childArtifactRoot, false);
		const indexed = readHandleIndex(root, handleId);
		const result = readStored(root, indexed.resultId);
		if (
			!sameOwner(indexed.owner, verified) ||
			!sameOwner(result.owner, verified) ||
			!result.artifacts.some((a) => a.handleId === handleId)
		)
			return denied(root, "owner_mismatch");
		const current = expireIfElapsed(root, result, now);
		const artifact = current.artifacts.find((value) => value.handleId === handleId);
		if (!artifact || artifact.retentionState !== "retained") return denied(root, "unavailable");
		const capability = Object.freeze({});
		capabilities.set(capability, { root, owner: current.owner, handleId, resultId: current.resultId });
		appendAudit(root, "read_allowed", "resolved", handleId);
		return { result: projection(current), capability };
	} catch {
		return undefined;
	}
}

/** Reads at most one C04 chunk and checks owner, retention and digest before returning bytes. */
export function readOwnedArtifact(
	capability: object,
	range: { offset: number; length: number },
): Uint8Array | undefined {
	const grant = capabilities.get(capability);
	if (
		!grant ||
		!Number.isSafeInteger(range.offset) ||
		!Number.isSafeInteger(range.length) ||
		range.offset < 0 ||
		range.length < 0 ||
		range.length > MAX_STREAM_CHUNK_BYTES
	)
		return undefined;
	try {
		// Capabilities are bearer objects, not a substitute for the SessionManager
		// binding: revalidate the parent/runtime-owned child root on every read.
		if (prepareBoundRoot(grant.owner, dirname(grant.root), false) !== grant.root) return undefined;
		// Retention is evaluated for every capability read, not merely resolution.
		const result = expireIfElapsed(grant.root, readStored(grant.root, grant.resultId), new Date());
		if (!sameOwner(result.owner, grant.owner)) return denied(grant.root, "owner_mismatch");
		const artifact = result.artifacts.find((a) => a.handleId === grant.handleId);
		if (!artifact || artifact.retentionState !== "retained" || range.offset > artifact.byteLength)
			return denied(grant.root, "unavailable");
		const file = safePath(grant.root, "objects", `${artifact.handleId}.blob`);
		const fd = openSyncNoFollow(file, "r");
		try {
			const before = fstatSync(fd);
			if (!before.isFile() || before.size !== artifact.byteLength) return denied(grant.root, "integrity");
			const hash = hashOpenFile(fd, artifact.byteLength);
			const after = fstatSync(fd);
			if (
				hash !== artifact.sha256 ||
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.size !== artifact.byteLength
			)
				return denied(grant.root, "integrity");
			const bytes = Buffer.allocUnsafe(Math.min(range.length, artifact.byteLength - range.offset));
			const read = readSync(fd, bytes, 0, bytes.length, range.offset);
			const final = fstatSync(fd);
			if (
				final.size !== artifact.byteLength ||
				final.dev !== before.dev ||
				final.ino !== before.ino ||
				hashOpenFile(fd, artifact.byteLength) !== artifact.sha256
			)
				return denied(grant.root, "integrity");
			appendAudit(grant.root, "read_allowed", "read", artifact.handleId);
			return bytes.subarray(0, read);
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** Idempotently records an explicit retention/delete disposition for an exact owner/result/handle. */
export function recordChildResultDisposition(
	owner: C04ChildResultOwner,
	input: { resultId: string; handleId?: string; disposition: "expired" | "deleted" },
	childArtifactRoot: string,
): boolean {
	try {
		const verified = validateOwner(owner);
		const root = prepareBoundRoot(verified, childArtifactRoot, false);
		const result = readStored(root, input.resultId);
		if (!sameOwner(result.owner, verified)) return false;
		if (input.handleId && !result.artifacts.some((a) => a.handleId === input.handleId)) return false;
		const changed = result.artifacts.map((artifact) =>
			artifact.handleId === input.handleId || !input.handleId
				? { ...artifact, retentionState: input.disposition }
				: artifact,
		);
		if (canonicalJson(changed) !== canonicalJson(result.artifacts)) {
			// A handle-specific delete preserves the result and every other retained
			// handle. The result itself becomes unavailable only when a whole-result
			// disposition is requested or its last retained artifact is removed.
			const retentionState =
				input.handleId && changed.some((artifact) => artifact.retentionState === "retained")
					? "retained"
					: input.disposition;
			// State and audit are durable before bytes become unreachable.
			atomicJson(safePath(root, "results", `${result.resultId}.json`), {
				...result,
				artifacts: changed,
				retentionState,
			});
			appendAudit(root, input.disposition, input.disposition, input.handleId ?? input.resultId);
			for (const artifact of changed)
				if (artifact.retentionState !== "retained")
					safeUnlink(safePath(root, "objects", `${artifact.handleId}.blob`));
		}
		return true;
	} catch {
		return false;
	}
}

export function canonicalChildResultBytes(value: C04ChildResultReference): Uint8Array {
	assertReference(value);
	return Buffer.from(canonicalJson(value));
}

/** A bounded C04-shaped terminal used when durable storage itself is unavailable. */
export function terminalStorageFailedProjection(
	input: { status?: Exclude<C04ChildResultStatus, "completed">; model?: Partial<C04ModelMetadata> } = {},
): C04ChildResultReference {
	const status = input.status ?? "failed";
	const model = validateModel(input.model);
	const result: C04ChildResultReference = {
		version: 1,
		resultId: randomUuid(),
		status,
		summary: "Child terminal storage failed.",
		preview: "A bounded terminal result could not be persisted.",
		error: { code: "terminal_storage_failed", message: "Terminal result storage failed." },
		model,
		artifacts: [],
		retentionState: "unavailable",
	};
	assertReference(result);
	return result;
}

function validateOwner(value: C04ChildResultOwner): C04ChildResultOwner {
	if (
		!isObject(value) ||
		!exactKeys(value as unknown as Record<string, unknown>, [
			"parentSessionId",
			"childSessionId",
			"childSessionFile",
			"assignmentId",
			"operationId",
			"deliveryId",
		])
	)
		throw new Error("invalid C04 owner");
	// SessionManager persists UUIDv7 session files. The parent and child session
	// identifiers therefore use v7; C04-issued correlation identifiers remain v4.
	for (const key of ["parentSessionId", "childSessionId"] as const)
		if (!isUuidV7(value[key])) throw new Error(`invalid C04 owner ${key}`);
	for (const key of ["assignmentId", "operationId", "deliveryId"] as const)
		if (!isUuidV4(value[key])) throw new Error(`invalid C04 owner ${key}`);
	if (
		typeof value.childSessionFile !== "string" ||
		!value.childSessionFile ||
		!resolve(value.childSessionFile).startsWith("/")
	)
		throw new Error("invalid C04 child session file");
	return { ...value, childSessionFile: resolve(value.childSessionFile) };
}
function validateCandidate(
	value: C04TerminalCandidate,
): Required<Pick<C04TerminalCandidate, "status" | "summary" | "preview" | "facts" | "nextActions" | "model">> &
	Pick<C04TerminalCandidate, "error" | "artifacts"> {
	if (
		!isObject(value) ||
		!exactKeys(value as unknown as Record<string, unknown>, [
			"status",
			"summary",
			"preview",
			...optionalKeys(value as unknown as Record<string, unknown>, [
				"facts",
				"nextActions",
				"error",
				"model",
				"artifacts",
			]),
		])
	)
		throw new Error("invalid C04 terminal candidate");
	if (!statuses.has(value.status)) throw new Error("invalid C04 terminal status");
	const status = value.status as C04ChildResultStatus;
	const summary = safeText(value.summary, MAX_SUMMARY_CHARS, MAX_SUMMARY_BYTES, "summary");
	const preview = safeText(value.preview, MAX_PREVIEW_CHARS, MAX_PREVIEW_BYTES, "preview");
	const facts = Array.isArray(value.facts) ? value.facts : [];
	if (
		facts.length > MAX_FACTS ||
		!facts.every((f) => isObject(f) && exactKeys(f, ["claim", ...optionalKeys(f, ["evidenceRef"])]))
	)
		throw new Error("invalid C04 facts");
	const normalizedFacts = facts.map((f) => ({
		claim: safeText(f.claim, 1024, 4096, "fact"),
		...(typeof f.evidenceRef === "string" && isUuidV4(f.evidenceRef) ? { evidenceRef: f.evidenceRef } : {}),
	}));
	const nextActions = Array.isArray(value.nextActions) ? value.nextActions : [];
	if (nextActions.length > MAX_NEXT_ACTIONS) throw new Error("too many next actions");
	const normalizedNext = nextActions.map((a) => safeText(a, 512, 2048, "next action"));
	let error: { code: C04ErrorCode; message: string; diagnostic?: C04ArtifactInput } | undefined;
	if (status === "completed") {
		if (value.error !== undefined) throw new Error("completed C04 result has error");
	} else {
		if (!isObject(value.error)) throw new Error("failed C04 result requires error");
		const rawCode =
			typeof value.error.code === "string" && errorCodes.has(value.error.code)
				? (value.error.code as C04ErrorCode)
				: status === "cancelled"
					? "cancelled"
					: status === "timed_out"
						? "timed_out"
						: status === "stalled"
							? "stalled"
							: status === "unknown_after_crash"
								? "unknown_after_crash"
								: "invalid_result";
		error = {
			code: rawCode,
			message: safeText(value.error.message ?? "Terminal result unavailable", 1024, 4096, "error"),
		};
		if (value.error.diagnostic) error.diagnostic = validateArtifact(value.error.diagnostic);
	}
	const model = validateModel(value.model);
	const artifacts =
		value.artifacts === undefined
			? []
			: Array.isArray(value.artifacts) && value.artifacts.length <= MAX_ARTIFACTS_PER_RESULT
				? value.artifacts.map(validateArtifact)
				: (() => {
						throw new Error("invalid C04 artifacts");
					})();
	return { status, summary, preview, facts: normalizedFacts, nextActions: normalizedNext, error, model, artifacts };
}
function validateModel(value: unknown): C04ModelMetadata {
	const source = isObject(value) ? value : {};
	if (
		Object.keys(source).some(
			(key) =>
				!["requestedSelector", "initialResolvedSelector", "terminalResolvedSelector", "fallbackHistory"].includes(
					key,
				),
		)
	)
		throw new Error("invalid C04 model");
	const initialResolvedSelector = safeText(source.initialResolvedSelector ?? "unknown", 256, 1024, "model");
	const terminalResolvedSelector = safeText(
		source.terminalResolvedSelector ?? initialResolvedSelector,
		256,
		1024,
		"model",
	);
	const history =
		source.fallbackHistory === undefined
			? undefined
			: Array.isArray(source.fallbackHistory) && source.fallbackHistory.length <= 16
				? source.fallbackHistory.map((v) => safeText(v, 256, 1024, "model fallback"))
				: (() => {
						throw new Error("invalid model fallback");
					})();
	return {
		...(source.requestedSelector === undefined
			? {}
			: { requestedSelector: safeText(source.requestedSelector, 256, 1024, "requested model") }),
		initialResolvedSelector,
		terminalResolvedSelector,
		...(history ? { fallbackHistory: history } : {}),
	};
}
function validateArtifact(value: unknown): C04ArtifactInput {
	if (
		!isObject(value) ||
		!exactKeys(value, ["kind", "contentType", "data"]) ||
		!kinds.has(value.kind) ||
		!contentTypes.has(value.contentType) ||
		!isAsyncIterable(value.data)
	)
		throw new Error("invalid C04 artifact: payload must be an AsyncIterable<Uint8Array>");
	return value as C04ArtifactInput;
}
function candidateArtifactInputs(
	candidate: ReturnType<typeof validateCandidate>,
): C04ArtifactInput[] {
	return [
		...(candidate.artifacts ?? []),
		...(candidate.error?.diagnostic ? [candidate.error.diagnostic] : []),
	];
}
function assertStoredJsonSize(value: StoredChildResult): void {
	if (Buffer.byteLength(canonicalJson(value)) > MAX_CHILD_RESULT_JSON_BYTES)
		throw new Error("C04 result record too large");
}

async function writeArtifact(
	root: string,
	owner: C04ChildResultOwner,
	resultId: string,
	artifact: C04ArtifactInput,
	used = aggregateBytes(root, owner),
): Promise<C04OpaqueArtifactReference> {
	const handleId = randomUuid();
	const finalPath = safePath(root, "objects", `${handleId}.blob`);
	const temp = safePath(root, "objects", `.${handleId}.${randomUuid()}.tmp`);
	let fd: number | undefined;
	const hash = createHash("sha256");
	let count = 0;
	try {
		fd = openSyncNoFollow(temp, "wx", 0o600);
		for await (const chunk of chunks(artifact.data)) {
			if (chunk.length > MAX_STREAM_CHUNK_BYTES) throw new Error("C04 stream chunk exceeds limit");
			count += chunk.length;
			if (count > MAX_ARTIFACT_BYTES) throw new Error("C04 artifact exceeds limit");
			if (used + count > MAX_ARTIFACT_BYTES_PER_CHILD_SESSION)
				throw new Error("C04 session artifact quota exceeded");
			hash.update(chunk);
			writeAll(fd, chunk);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		publishExclusive(temp, finalPath);
		fsyncDirectory(dirname(finalPath));
		return {
			version: 1,
			handleId,
			resultId,
			kind: artifact.kind,
			contentType: artifact.contentType,
			byteLength: count,
			sha256: hash.digest("hex"),
			creatorAssignmentId: owner.assignmentId,
			ownerSessionId: owner.childSessionId,
			retentionState: "retained",
		};
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		safeUnlink(temp);
		throw error;
	}
}
async function* chunks(data: C04ArtifactInput["data"]): AsyncGenerator<Uint8Array> {
	for await (const chunk of data) {
		if (!(chunk instanceof Uint8Array)) throw new Error("C04 stream yielded non-bytes");
		yield chunk;
	}
}

function aggregateBytes(root: string, owner: C04ChildResultOwner): number {
	let total = 0;
	for (const name of readdirSync(safePath(root, "results"))) {
		if (!name.endsWith(".json")) continue;
		try {
			const r = readStored(root, name.slice(0, -5));
			if (
				r.owner.parentSessionId === owner.parentSessionId &&
				r.owner.childSessionId === owner.childSessionId &&
				r.owner.childSessionFile === owner.childSessionFile
			)
				total += r.artifacts.reduce((n, a) => n + (a.retentionState === "retained" ? a.byteLength : 0), 0);
		} catch {
			throw new Error("uncertain C04 result store");
		}
	}
	return total;
}
const operationReservations = new Set<string>();
/** Reservation ownership is a nonce-bound fact. A losing writer never unlinks
 * a name it did not create, including during the create-one/create-two cut. */
function reserveOperationAndQuota(root: string, owner: C04ChildResultOwner, indexPath: string): () => void {
	const key = `${root}:${owner.parentSessionId}:${owner.childSessionId}:${owner.childSessionFile}`;
	if (operationReservations.has(key)) throw immutableConflict(root, owner.operationId);
	const reservation = safePath(root, "operation-index", `.${owner.operationId}.reserve`);
	const quotaReservation = safePath(
		root,
		"operation-index",
		`.quota.${owner.parentSessionId}.${owner.childSessionId}.reserve`,
	);
	const nonce = randomUuid();
	const token = canonicalJson({ version: 1, owner, indexPath, nonce });
	let operationFd: number | undefined;
	let quotaFd: number | undefined;
	try {
		operationFd = openSyncNoFollow(reservation, "wx", 0o600);
		writeAll(operationFd, Buffer.from(token));
		fsyncSync(operationFd);
		quotaFd = openSyncNoFollow(quotaReservation, "wx", 0o600);
		writeAll(quotaFd, Buffer.from(token));
		fsyncSync(quotaFd);
		closeSync(operationFd);
		closeSync(quotaFd);
		operationFd = quotaFd = undefined;
		fsyncDirectory(dirname(reservation));
		operationReservations.add(key);
	} catch {
		if (operationFd !== undefined) closeSync(operationFd);
		if (quotaFd !== undefined) closeSync(quotaFd);
		unlinkReservationIfOwned(reservation, token);
		unlinkReservationIfOwned(quotaReservation, token);
		throw immutableConflict(root, owner.operationId);
	}
	return () => {
		operationReservations.delete(key);
		unlinkReservationIfOwned(reservation, token);
		unlinkReservationIfOwned(quotaReservation, token);
		fsyncDirectory(dirname(reservation));
	};
}
function unlinkReservationIfOwned(path: string, token: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192 && readFileSync(path, "utf8") === token)
			unlinkSync(path);
	} catch {}
}
function immutableConflict(root: string, operationId: string): Error {
	appendAudit(root, "uncertain", "immutable_conflict", operationId);
	return new Error("C04 immutable operation conflict");
}
/** The C04 root belongs below, not beside, the validated child artifact dir. */
function validateChildBinding(owner: C04ChildResultOwner, childArtifactRoot: string): void {
	const file = canonicalExistingRegularFile(owner.childSessionFile);
	if (!file) throw new Error("C04 child session file is not a stable regular file");
	const root = canonicalDirectoryNoSymlinks(childArtifactRoot);
	const sessionId = owner.childSessionId;
	// This is the one layout SessionManager publishes. IDs and paths are all
	// checked together so a sibling session's root cannot be substituted.
	const sessionDir = dirname(file);
	if (basename(sessionDir) !== "sessions" || basename(file) !== `${sessionId}.jsonl`)
		throw new Error("C04 child session file is not the exact SessionManager child binding");
	const expected = join(dirname(sessionDir), "session-artifacts", sessionId);
	if (root !== expected) throw new Error("C04 child artifact root is not the exact SessionManager child binding");
}
function canonicalExistingRegularFile(path: string): string | undefined {
	try {
		const st = lstatSync(path);
		return st.isFile() && !st.isSymbolicLink() ? realpathSync(path) : undefined;
	} catch {
		return undefined;
	}
}
function canonicalDirectoryNoSymlinks(path: string): string {
	const requested = resolve(path);
	const requestedStat = lstatSync(requested);
	if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink())
		throw new Error("C04 rejects symlink/non-directory root");
	// Normalize OS-owned aliases (/var -> /private/var on macOS), then reject every
	// application-visible ancestor from the canonical path downward.
	const absolute = realpathSync(requested);
	const { root } = parse(absolute);
	let current = root;
	for (const part of relative(root, absolute).split(/[/\\]/).filter(Boolean)) {
		current = join(current, part);
		const st = lstatSync(current);
		if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("C04 rejects symlink/non-directory ancestor");
	}
	return absolute;
}
/** Re-check the SessionManager-shaped child binding before every C04 operation.
 * SessionManager owns `<state>/sessions/<id>.jsonl` and
 * `<state>/session-artifacts/<id>`; accepting merely a common ancestor would
 * let a sibling child supply its artifact directory. */
function prepareBoundRoot(owner: C04ChildResultOwner, childArtifactRoot: string, create = true): string {
	validateChildBinding(owner, childArtifactRoot);
	const base = assertPrivateDirectory(childArtifactRoot);
	const root = join(base, "rlm-child-results");
	if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
	assertPrivateDirectory(root);
	for (const dir of ["operation-index", "results", "objects", "handle-index"]) {
		const path = join(root, dir);
		if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
		assertPrivateDirectory(path);
	}
	return root;
}
function assertPrivateDirectory(path: string): string {
	const canonical = canonicalDirectoryNoSymlinks(path);
	const stat = lstatSync(canonical);
	if ((stat.mode & 0o077) !== 0) {
		chmodSync(canonical, 0o700);
		if ((lstatSync(canonical).mode & 0o077) !== 0) throw new Error("C04 directory is not owner-private");
	}
	return canonical;
}
function safePath(root: string, directory: string, name?: string): string {
	if (
		!/^[a-z-]+$/.test(directory) ||
		(name !== undefined && (!/^[a-z0-9.-]+(?:\.(?:json|blob|tmp|reserve))?$/.test(name) || name.includes("..")))
	)
		throw new Error("invalid C04 generated path");
	const target = name === undefined ? join(root, directory) : join(root, directory, name);
	if (relative(root, target).startsWith("..") || resolve(target) === root)
		throw new Error("C04 containment violation");
	return target;
}
function readStored(root: string, resultId: string): StoredChildResult {
	if (!isUuidV4(resultId)) throw new Error("invalid result ID");
	const path = safePath(root, "results", `${resultId}.json`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHILD_RESULT_JSON_BYTES)
		throw new Error("unavailable C04 result");
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	assertStored(parsed);
	return parsed;
}
function readIndex(
	path: string,
): { version: 1; resultId: string; owner: C04ChildResultOwner; requestDigest: string } | undefined {
	try {
		const st = lstatSync(path);
		if (!st.isFile() || st.isSymbolicLink() || st.size > 8192) return undefined;
		const x = JSON.parse(readFileSync(path, "utf8"));
		if (
			!isObject(x) ||
			!exactKeys(x, ["version", "resultId", "owner", "requestDigest"]) ||
			x.version !== 1 ||
			!isUuidV4(x.resultId) ||
			!SHA256.test(x.requestDigest)
		)
			return undefined;
		return {
			version: 1,
			resultId: x.resultId,
			owner: validateOwner(x.owner as C04ChildResultOwner),
			requestDigest: x.requestDigest,
		};
	} catch {
		return undefined;
	}
}
function readHandleIndex(
	root: string,
	handleId: string,
): { resultId: string; owner: C04ChildResultOwner; handleId: string } {
	if (!isUuidV4(handleId)) throw new Error("invalid handle");
	const path = safePath(root, "handle-index", `${handleId}.json`);
	const st = lstatSync(path);
	if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) throw new Error("not found");
	const index = JSON.parse(readFileSync(path, "utf8"));
	if (
		!isObject(index) ||
		!exactKeys(index, ["version", "resultId", "owner", "handleId"]) ||
		index.version !== 1 ||
		index.handleId !== handleId ||
		!isUuidV4(index.resultId)
	)
		throw new Error("not found");
	return { resultId: index.resultId, owner: validateOwner(index.owner as C04ChildResultOwner), handleId };
}

function expireIfElapsed(root: string, result: StoredChildResult, now: Date): StoredChildResult {
	if (Date.parse(result.retention.expiresAt) > now.getTime()) return result;
	if (result.retentionState !== "retained") return result;
	return setExpired(root, result);
}
function setExpired(root: string, result: StoredChildResult): StoredChildResult {
	const expired = {
		...result,
		retentionState: "expired" as const,
		artifacts: result.artifacts.map((a) => ({ ...a, retentionState: "expired" as const })),
	};
	atomicJson(safePath(root, "results", `${result.resultId}.json`), expired);
	appendAudit(root, "expired", "retention_elapsed", result.resultId);
	for (const a of expired.artifacts) safeUnlink(safePath(root, "objects", `${a.handleId}.blob`));
	return expired;
}
function projection(result: StoredChildResult): C04ChildResultReference {
	const {
		schemaVersion: _schemaVersion,
		owner: _owner,
		facts: _facts,
		nextActions: _nextActions,
		committedAt: _committedAt,
		retention: _retention,
		requestDigest: _requestDigest,
		...reference
	} = result;
	assertReference(reference);
	return reference;
}
function assertStored(value: unknown): asserts value is StoredChildResult {
	if (
		!isObject(value) ||
		value.schemaVersion !== 1 ||
		!exactKeys(value, [
			"schemaVersion",
			"version",
			"resultId",
			"owner",
			"status",
			"summary",
			"preview",
			"facts",
			"nextActions",
			"model",
			"artifacts",
			"retentionState",
			"committedAt",
			"retention",
			"requestDigest",
			...optionalKeys(value, ["error"]),
		])
	)
		throw new Error("invalid C04 result record");
	assertReference({
		version: value.version,
		resultId: value.resultId,
		status: value.status,
		summary: value.summary,
		preview: value.preview,
		...(value.error === undefined ? {} : { error: value.error }),
		model: value.model,
		artifacts: value.artifacts,
		retentionState: value.retentionState,
	});
	const storedOwner = validateOwner(value.owner as C04ChildResultOwner);
	for (const artifact of value.artifacts as C04OpaqueArtifactReference[]) {
		if (
			artifact.creatorAssignmentId !== storedOwner.assignmentId ||
			artifact.ownerSessionId !== storedOwner.childSessionId
		)
			throw new Error("C04 artifact owner cross-reference mismatch");
	}
	if (
		value.error?.diagnosticRef &&
		!(value.artifacts as C04OpaqueArtifactReference[]).some((a) => a.handleId === value.error?.diagnosticRef)
	)
		throw new Error("C04 diagnostic cross-reference mismatch");
	if (
		!Array.isArray(value.facts) ||
		value.facts.length > MAX_FACTS ||
		!value.facts.every(
			(fact) =>
				isObject(fact) &&
				exactKeys(fact, ["claim", ...optionalKeys(fact, ["evidenceRef"])]) &&
				typeof fact.claim === "string" &&
				(fact.evidenceRef === undefined || isUuidV4(fact.evidenceRef)),
		) ||
		!Array.isArray(value.nextActions) ||
		value.nextActions.length > MAX_NEXT_ACTIONS ||
		!value.nextActions.every((action) => typeof action === "string") ||
		!isObject(value.retention) ||
		value.retention.disposition !== "retain_until" ||
		typeof value.retention.expiresAt !== "string" ||
		Number.isNaN(Date.parse(value.retention.expiresAt)) ||
		typeof value.committedAt !== "string" ||
		Number.isNaN(Date.parse(value.committedAt)) ||
		typeof value.requestDigest !== "string" ||
		!SHA256.test(value.requestDigest)
	)
		throw new Error("invalid C04 result record");
	// A live result may have some explicitly deleted handles while retaining
	// others. A non-retained result, however, must never advertise a readable
	// artifact. This is the atomic retention boundary for partial deletion.
	if (
		value.retentionState !== "retained" &&
		(value.artifacts as C04OpaqueArtifactReference[]).some((a) => a.retentionState === "retained")
	)
		throw new Error("C04 retention consistency mismatch");
}
function assertReference(value: unknown): asserts value is C04ChildResultReference {
	if (
		!isObject(value) ||
		value.version !== 1 ||
		!exactKeys(value, [
			"version",
			"resultId",
			"status",
			"summary",
			"preview",
			"model",
			"artifacts",
			"retentionState",
			...optionalKeys(value, ["error"]),
		]) ||
		!isUuidV4(value.resultId) ||
		!statuses.has(value.status) ||
		!retentionStates.has(value.retentionState)
	)
		throw new Error("invalid C04 projection");
	safeText(value.summary, MAX_SUMMARY_CHARS, MAX_SUMMARY_BYTES, "summary");
	safeText(value.preview, MAX_PREVIEW_CHARS, MAX_PREVIEW_BYTES, "preview");
	validateModel(value.model);
	if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS_PER_RESULT)
		throw new Error("invalid artifacts");
	for (const a of value.artifacts) assertArtifactRef(a, value.resultId);
	if (
		value.status === "completed"
			? value.error !== undefined
			: !isObject(value.error) || !errorCodes.has(value.error.code) || typeof value.error.message !== "string"
	)
		throw new Error("invalid error");
	if (value.error) {
		if (!exactKeys(value.error, ["code", "message", ...optionalKeys(value.error, ["diagnosticRef"])]))
			throw new Error("invalid error");
		safeText(value.error.message, 1024, 4096, "error");
		if (value.error.diagnosticRef !== undefined && !isUuidV4(value.error.diagnosticRef))
			throw new Error("invalid diagnostic reference");
	}
	if (Buffer.byteLength(canonicalJson(value)) > MAX_CHILD_RESULT_JSON_BYTES)
		throw new Error("C04 projection too large");
}
function assertArtifactRef(value: unknown, resultId: string): asserts value is C04OpaqueArtifactReference {
	if (
		!isObject(value) ||
		!exactKeys(value, [
			"version",
			"handleId",
			"resultId",
			"kind",
			"contentType",
			"byteLength",
			"sha256",
			"creatorAssignmentId",
			"ownerSessionId",
			"retentionState",
		]) ||
		value.version !== 1 ||
		!isUuidV4(value.handleId) ||
		value.resultId !== resultId ||
		!kinds.has(value.kind) ||
		!contentTypes.has(value.contentType) ||
		!Number.isSafeInteger(value.byteLength) ||
		value.byteLength < 0 ||
		value.byteLength > MAX_ARTIFACT_BYTES ||
		typeof value.sha256 !== "string" ||
		!SHA256.test(value.sha256) ||
		!isUuidV4(value.creatorAssignmentId) ||
		!isUuidV7(value.ownerSessionId) ||
		!retentionStates.has(value.retentionState)
	)
		throw new Error("invalid C04 artifact reference");
}
function publishExclusive(temp: string, path: string): void {
	// link(2) is an atomic no-replace publication. Node has no linkSync import
	// here, so create the destination exclusively and copy from the private temp
	// FD; a collision can never overwrite an immutable object name.
	const source = openSyncNoFollow(temp, "r");
	let destination: number | undefined;
	let created = false;
	try {
		destination = openSyncNoFollow(path, "wx", 0o600);
		created = true;
		const buffer = Buffer.allocUnsafe(MAX_STREAM_CHUNK_BYTES);
		for (;;) {
			const count = readSync(source, buffer, 0, buffer.length, null);
			if (count === 0) break;
			writeAll(destination, buffer.subarray(0, count));
		}
		fsyncSync(destination);
	} catch (error) {
		// Only remove a name this invocation won exclusively. A collision is never
		// ours to remove, while an interrupted copy must not leave an orphan blob.
		if (created) safeUnlink(path);
		throw error;
	} finally {
		closeSync(source);
		if (destination !== undefined) closeSync(destination);
		safeUnlink(temp);
	}
}
function atomicJson(path: string, value: unknown): void {
	const temp = `${path}.${randomUuid()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSyncNoFollow(temp, "wx", 0o600);
		writeAll(fd, Buffer.from(canonicalJson(value)));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		fsyncDirectory(dirname(path));
	} catch (e) {
		if (fd !== undefined) closeSync(fd);
		safeUnlink(temp);
		throw e;
	}
}
function atomicExclusiveJson(path: string, value: unknown): void {
	let created = false;
	let fd: number | undefined;
	try {
		fd = openSyncNoFollow(path, "wx", 0o600);
		created = true;
		writeAll(fd, Buffer.from(canonicalJson(value)));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		fsyncDirectory(dirname(path));
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		// An exclusive open proves this invocation owns a partially committed name.
		// Remove it on every failed write/fsync so retries cannot find a corrupt
		// result, handle index, or operation index.
		if (created) safeUnlink(path);
		throw error;
	}
}
function appendAudit(root: string, action: AuditAction, reason: string, id: string): void {
	try {
		const path = join(root, "audit.jsonl");
		const fd = openSyncNoFollow(path, "a", 0o600);
		try {
			const rec = {
				version: 1,
				timestamp: new Date().toISOString(),
				action,
				reason: id ? reason : "unknown",
				idFingerprint: sha256(id).slice(0, 16),
			};
			writeAll(fd, Buffer.from(`${canonicalJson(rec)}\n`));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* Audit must not turn an already durable terminal fact into a raw exception path. */
	}
}
function denied<T>(root: string, reason: string): T | undefined {
	appendAudit(root, "read_denied", reason, reason);
	return undefined;
}
function hashOpenFile(fd: number, length: number): string {
	const h = createHash("sha256");
	const buffer = Buffer.allocUnsafe(MAX_STREAM_CHUNK_BYTES);
	let off = 0;
	while (off < length) {
		const n = readSync(fd, buffer, 0, Math.min(buffer.length, length - off), off);
		if (n <= 0) throw new Error("short object");
		h.update(buffer.subarray(0, n));
		off += n;
	}
	// A byte after declared length detects a trailing append without a second path/FD.
	if (readSync(fd, buffer, 0, 1, length) !== 0) throw new Error("trailing object bytes");
	return h.digest("hex");
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function openSyncNoFollow(path: string, flags: string, mode?: number): number {
	const numeric =
		flags === "r"
			? constants.O_RDONLY
			: flags === "a"
				? constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY
				: flags === "wx"
					? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
					: (() => {
							throw new Error("invalid C04 open mode");
						})();
	// O_NOFOLLOW closes the lstat/open race on platforms that support it.
	return openSync(path, numeric | (constants.O_NOFOLLOW ?? 0), mode);
}
function writeAll(fd: number, bytes: Uint8Array): void {
	let at = 0;
	while (at < bytes.length) {
		const n = writeSync(fd, bytes, at, bytes.length - at);
		if (n <= 0) throw new Error("short C04 write");
		at += n;
	}
}
function safeUnlink(path: string): void {
	try {
		const st = lstatSync(path);
		if (st.isFile() && !st.isSymbolicLink()) unlinkSync(path);
	} catch {}
}
function safeText(value: unknown, chars: number, bytes: number, label: string): string {
	if (typeof value !== "string") throw new Error(`invalid C04 ${label}`);
	const cleaned = value
		.normalize("NFC")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replace(/(?:[A-Za-z]:\\|\/)[^\s]{2,}/g, "[redacted]")
		.replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
		.trim();
	if (!cleaned || [...cleaned].length > chars || Buffer.byteLength(cleaned) > bytes || hasUnpairedSurrogate(cleaned))
		throw new Error(`invalid C04 ${label}`);
	return cleaned;
}
function hasUnpairedSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const n = value.charCodeAt(i);
		if (n >= 0xd800 && n <= 0xdbff) {
			if (++i >= value.length || value.charCodeAt(i) < 0xdc00 || value.charCodeAt(i) > 0xdfff) return true;
		} else if (n >= 0xdc00 && n <= 0xdfff) return true;
	}
	return false;
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const o = value as Record<string, unknown>;
	return `{${Object.keys(o)
		.sort()
		.filter((k) => o[k] !== undefined)
		.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
		.join(",")}}`;
}
function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function randomUuid(): string {
	return randomUUID();
}
function isUuidV4(value: unknown): value is string {
	return typeof value === "string" && UUID_V4.test(value);
}
function isUuidV7(value: unknown): value is string {
	return typeof value === "string" && UUID_V7.test(value);
}
function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const a = Object.keys(value).sort(),
		b = [...keys].sort();
	return a.length === b.length && a.every((x, i) => x === b[i]);
}
function optionalKeys(value: Record<string, unknown>, keys: string[]): string[] {
	return keys.filter((k) => value[k] !== undefined);
}
function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
	return !!value && typeof (value as any)[Symbol.asyncIterator] === "function";
}
function sameOwner(a: C04ChildResultOwner, b: C04ChildResultOwner): boolean {
	return (
		a.parentSessionId === b.parentSessionId &&
		a.childSessionId === b.childSessionId &&
		a.childSessionFile === b.childSessionFile &&
		a.assignmentId === b.assignmentId &&
		a.operationId === b.operationId &&
		a.deliveryId === b.deliveryId
	);
}
function digestableCandidateDigest(
	owner: C04ChildResultOwner,
	candidate: C04TerminalCandidate,
	artifacts: readonly C04OpaqueArtifactReference[],
): string {
	return sha256(canonicalJson({ owner, candidate: digestableCandidate(candidate, artifacts) }));
}
async function digestCandidateStreams(
	owner: C04ChildResultOwner,
	candidate: ReturnType<typeof validateCandidate>,
): Promise<string> {
	const descriptors: Array<{
		kind: C04ArtifactKind;
		contentType: C04ArtifactInput["contentType"];
		byteLength: number;
		sha256: string;
	}> = [];
	for (const artifact of [
		...(candidate.artifacts ?? []),
		...(candidate.error?.diagnostic ? [candidate.error.diagnostic] : []),
	]) {
		const hash = createHash("sha256");
		let count = 0;
		for await (const chunk of chunks(artifact.data)) {
			if (chunk.length > MAX_STREAM_CHUNK_BYTES) throw new Error("C04 stream chunk exceeds limit");
			count += chunk.length;
			if (count > MAX_ARTIFACT_BYTES) throw new Error("C04 artifact exceeds limit");
			hash.update(chunk);
		}
		descriptors.push({
			kind: artifact.kind,
			contentType: artifact.contentType,
			byteLength: count,
			sha256: hash.digest("hex"),
		});
	}
	const surrogate = descriptors.map((d) => ({
		version: 1 as const,
		handleId: randomUuid(),
		resultId: randomUuid(),
		...d,
		creatorAssignmentId: owner.assignmentId,
		ownerSessionId: owner.childSessionId,
		retentionState: "retained" as const,
	}));
	// digestableCandidate uses only kind/type/length/hash and no generated IDs.
	return digestableCandidateDigest(owner, candidate, surrogate);
}
function digestableCandidate(candidate: any, artifacts: readonly C04OpaqueArtifactReference[]): unknown {
	let cursor = 0;
	const artifactDigest = (a: C04ArtifactInput) => {
		const written = artifacts[cursor++];
		if (!written || written.kind !== a.kind || written.contentType !== a.contentType)
			throw new Error("C04 artifact digest mismatch");
		return { kind: a.kind, contentType: a.contentType, byteLength: written.byteLength, sha256: written.sha256 };
	};
	const output = {
		...candidate,
		artifacts: (candidate.artifacts ?? []).map(artifactDigest),
		error: candidate.error
			? {
					code: candidate.error.code,
					message: candidate.error.message,
					diagnostic: candidate.error.diagnostic ? artifactDigest(candidate.error.diagnostic) : undefined,
				}
			: undefined,
	};
	if (cursor !== artifacts.length) throw new Error("C04 artifact digest mismatch");
	return output;
}
