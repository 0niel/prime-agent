import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";
import { createHostRequestHandler, type HostRequestHandler } from "./kernel/index.js";

export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	/** Source of the IPython cell that issued this rlm.run call, when available. */
	cellSourceCode?: string;
	/** Dispatcher authority for this admission; revoked requests must not spawn. */
	signal: AbortSignal;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	/** Persisted session path, when daemon discovery can identify this incarnation. */
	session_file?: string;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running" | "preserved_newer";
}

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<Record<string, unknown>>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string, signal: AbortSignal) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

/** Validate and normalize an orchestrator-supplied subagent session name. */
export function normalizeRequestedRlmSubagentSessionName(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run name must be a string");
	}
	const name = value.trim();
	if (!name) {
		throw new Error("rlm.run name must not be empty");
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`rlm.run name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

/** Validate and normalize an orchestrator-supplied subagent model reference. */
export function normalizeRequestedRlmSubagentModel(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run model must be a string");
	}
	const model = value.trim();
	if (!model) {
		throw new Error("rlm.run model must not be empty");
	}
	return model;
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/** Adapt an RlmRunHandler into the typed "rlm.run" handler for the kernel host bridge. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return createHostRequestHandler(async (payload, context) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler({
			prompt: payload.prompt,
			kwargs,
			cellSourceCode,
			signal: context.signal,
		});
		return result as unknown as Record<string, unknown>;
	});
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return createHostRequestHandler(async (payload, _context) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	});
}

/** Expose the current parent session's RLM child registry to its kernel. */
export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): HostRequestHandler {
	return createHostRequestHandler(async (_payload, _context) => {
		const { subagents } = await handler();
		return { subagents };
	});
}

/** Delete one direct child selected from the current parent session's registry. */
export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): HostRequestHandler {
	return createHostRequestHandler(async (payload, context) => {
		if (typeof payload.target !== "string" || !payload.target.trim()) {
			throw new Error("rlm.delete_subagent target must be a non-empty string");
		}
		const { subagent, outcome } = await handler(payload.target.trim(), context.signal);
		return outcome === undefined ? { subagent } : { subagent, outcome };
	});
}

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Source of the IPython cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
}

/**
 * What the host can prove about a cancelled, never-admitted child's deletion.
 * This is deliberately not a public child status: uncertainty must never make a
 * private artifact appear active, idle, or inactive.
 */
export type RlmSubagentDeletionDurability = "absent" | "tombstoned" | "stale" | "unknown";

export interface RlmSubagentReleaseOutcome {
	deletionDurability: RlmSubagentDeletionDurability;
}

/** The durable phase reached by a host-owned deletion attempt. */
export type RlmSubagentDeletionPhase = "precommit" | "tombstoned";

/** A host result either removes the selected incarnation or observes it was superseded. */
export interface RlmSubagentHostDeletionResult {
	deletionDurability: Exclude<RlmSubagentDeletionDurability, "unknown">;
}

/**
 * A typed host deletion failure. `precommit` guarantees that no durable
 * tombstone was appended, so the caller must leave its live child tracking
 * untouched. `tombstoned` means the registry commit is authoritative and only
 * runtime cleanup remains retryable.
 */
export class RlmSubagentHostDeletionError extends Error {
	readonly phase: RlmSubagentDeletionPhase;

	constructor(phase: RlmSubagentDeletionPhase, cause: unknown) {
		super(
			phase === "precommit"
				? "RLM subagent deletion did not commit"
				: "RLM subagent tombstone committed but runtime close failed",
			{ cause },
		);
		this.name = "RlmSubagentHostDeletionError";
		this.phase = phase;
	}
}

/**
 * Authority held by the exact host request that asked to reconcile a private
 * deletion lease. This is a typed host contract, never child-controlled data.
 */
export interface RlmSubagentDeletionAuthority {
	/** Exact child incarnation this attempt is allowed to reconcile. */
	childId: string;
	sessionDir: string;
	/**
	 * Persisted/runtime incarnation fences. Passive deletion has no object
	 * reference, so it must carry at least one of these when discovery has it.
	 */
	sessionFile?: string;
	sessionId?: string;
	/** Monotonic per-parent attempt token; never reused after an aborted owner. */
	generation: number;
	/**
	 * Throws unless this exact generation still owns the exact child lease. The
	 * daemon calls this after its asynchronous registry read and immediately
	 * before the synchronous append/fsync boundary.
	 */
	assertCurrent(): void;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, session: AgentSession): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
		authority?: RlmSubagentDeletionAuthority,
	) => Promise<RlmSubagentReleaseOutcome>;
	/** Re-check a release whose durability was unknown, without inventing a public child status. */
	resolveRlmSubagentDeletion?(
		childId: string,
		authority: RlmSubagentDeletionAuthority,
	): Promise<RlmSubagentDeletionDurability>;
	/** Close or remove the host-owned child; session is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(
		childId: string,
		session?: AgentSession,
		authority?: RlmSubagentDeletionAuthority,
	): Promise<RlmSubagentHostDeletionResult | undefined>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
