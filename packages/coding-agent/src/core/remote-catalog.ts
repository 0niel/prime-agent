import { type Api, getApiProvider, getLogger, type Model } from "@earendil-works/pi-ai";
import { readFileSync, renameSync, writeFileSync } from "fs";
import { VERSION } from "../config.js";
import { getPiUserAgent } from "../utils/pi-user-agent.js";

export const REMOTE_CATALOG_STORE_FILE = "models-store.json";
const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const ATTEMPT_TIMEOUT_MS = 4_000;
const MAX_RETRIES = 2;

const log = getLogger("coding-agent.remote-catalog");

export interface RemoteCatalogEntry {
	models: Model<Api>[];
	/** Unix ms timestamp from the remote catalog's Last-Modified header. */
	lastModified?: number;
	/** Unix ms timestamp of the last completed remote check. */
	checkedAt?: number;
	/** Opaque validator from the ETag header, stored verbatim and echoed as If-None-Match. */
	etag?: string;
}

function isOptionalFiniteNumber(value: unknown): boolean {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isFiniteNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value);
}

/** Requires every field that registry consumers dereference, so a malformed entry can never overlay a bundled model. */
function isRemoteModel(value: unknown): value is Model<Api> {
	if (typeof value !== "object" || value === null) return false;
	const model = value as Partial<Model<Api>>;
	return (
		typeof model.id === "string" &&
		typeof model.name === "string" &&
		typeof model.api === "string" &&
		typeof model.baseUrl === "string" &&
		typeof model.reasoning === "boolean" &&
		Array.isArray(model.input) &&
		model.input.every((input) => input === "text" || input === "image") &&
		typeof model.cost === "object" &&
		model.cost !== null &&
		isFiniteNumber(model.cost.input) &&
		isFiniteNumber(model.cost.output) &&
		isFiniteNumber(model.cost.cacheRead) &&
		isFiniteNumber(model.cost.cacheWrite) &&
		isFiniteNumber(model.contextWindow) &&
		isFiniteNumber(model.maxTokens)
	);
}

function isCatalogEntry(value: unknown): value is RemoteCatalogEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<RemoteCatalogEntry>;
	return (
		Array.isArray(entry.models) &&
		entry.models.every(isRemoteModel) &&
		isOptionalFiniteNumber(entry.lastModified) &&
		isOptionalFiniteNumber(entry.checkedAt) &&
		(entry.etag === undefined || typeof entry.etag === "string")
	);
}

/** Persisted per-provider remote catalogs, written atomically to one JSON file. */
export class RemoteCatalogStore {
	private entries: Record<string, RemoteCatalogEntry> = {};

	private constructor(private readonly path: string) {}

	static open(path: string): RemoteCatalogStore {
		const store = new RemoteCatalogStore(path);
		store.reload();
		return store;
	}

	reload(): void {
		const entries: Record<string, RemoteCatalogEntry> = {};
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				for (const [providerId, entry] of Object.entries(parsed)) {
					if (isCatalogEntry(entry)) entries[providerId] = entry;
				}
			}
		} catch {
			// A missing or invalid store only means the overlay starts empty.
		}
		this.entries = entries;
	}

	get(providerId: string): RemoteCatalogEntry | undefined {
		return this.entries[providerId];
	}

	set(providerId: string, entry: RemoteCatalogEntry): void {
		this.entries[providerId] = entry;
	}

	save(): void {
		try {
			const tmpPath = `${this.path}.${process.pid}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(this.entries), { mode: 0o600 });
			renameSync(tmpPath, this.path);
		} catch {
			// A failed write only requires a later refetch.
		}
	}
}

function mergeModels(baseline: readonly Model<Api>[], remote: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of remote) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

/** Remote models only apply when the remote catalog is newer than the bundled one. */
export function overlayRemoteModels(
	bundled: Model<Api>[],
	entry: RemoteCatalogEntry | undefined,
	localGeneratedAt: number | undefined,
): Model<Api>[] {
	if (!entry) return bundled;
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return bundled;
	}
	// pi.dev may serve apis our fork doesn't support; keep the bundled model instead.
	return mergeModels(
		bundled,
		entry.models.filter((model) => getApiProvider(model.api) !== undefined),
	);
}

function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries.filter(isRemoteModel).map((model) => ({ ...model, provider: providerId }));
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

/**
 * Fetch with a bounded per-attempt timeout so a hung connection is retried
 * instead of consuming the whole refresh budget. Caller cancellation is terminal.
 */
async function fetchCatalog(
	url: URL,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		const attemptSignal = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				headers,
				signal: signal ? AbortSignal.any([signal, attemptSignal]) : attemptSignal,
			});
			if (attempt >= MAX_RETRIES || !isRetryableStatus(response.status)) return response;
			try {
				await response.body?.cancel();
			} catch {
				// Nothing more to do if cancelling the body also fails.
			}
		} catch (error) {
			if (signal?.aborted || attempt >= MAX_RETRIES) throw error;
		}
	}
}

async function refreshProvider(
	store: RemoteCatalogStore,
	providerId: string,
	baseUrl: string,
	signal: AbortSignal | undefined,
	force: boolean,
): Promise<"skipped" | "checked" | "changed"> {
	const stored = store.get(providerId);
	if (
		!force &&
		stored?.checkedAt !== undefined &&
		stored.lastModified !== undefined &&
		Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
	) {
		return "skipped";
	}

	// Only revalidate when a cached body backs the validator, so a 304 can never
	// leave the overlay empty.
	const validator = stored?.models.length ? stored.etag : undefined;
	const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, baseUrl);
	const headers = {
		accept: "application/json",
		"User-Agent": getPiUserAgent(VERSION),
		...(validator ? { "if-none-match": validator } : {}),
	};

	try {
		const response = await fetchCatalog(url, headers, signal);
		const checkedAt = Date.now();
		if (response.status === 304 && stored) {
			store.set(providerId, { ...stored, checkedAt });
			return "checked";
		}
		if (response.status === 404 || response.status === 501) {
			store.set(providerId, { ...(stored ?? {}), models: [], checkedAt, lastModified: 0, etag: undefined });
			return stored?.models.length ? "changed" : "checked";
		}
		if (!response.ok) {
			// Transient failure: the cached body and its validator stay valid, so keep
			// the etag and let the next refresh revalidate.
			store.set(providerId, { ...(stored ?? { models: [] }), checkedAt });
			log.warn("remote model catalog request failed", { provider: providerId, status: response.status });
			return "checked";
		}
		const models = parseCatalog(providerId, await response.json());
		const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
		store.set(providerId, {
			models,
			checkedAt,
			lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
			etag: response.headers.get("etag") ?? undefined,
		});
		return "changed";
	} catch (error) {
		// No lastModified on purpose: a failed first check stays outside the freshness
		// window so the next user-triggered refresh retries.
		store.set(providerId, { ...(stored ?? { models: [] }), checkedAt: Date.now() });
		log.warn("remote model catalog refresh failed", {
			provider: providerId,
			error: error instanceof Error ? error.message : String(error),
		});
		return "checked";
	}
}

/**
 * Refresh all providers concurrently. Fails open per provider. Persists whenever any
 * check completed (freshness window), but returns true only when catalog content changed.
 */
export async function refreshRemoteCatalog(
	store: RemoteCatalogStore,
	providerIds: readonly string[],
	options: { baseUrl?: string; signal?: AbortSignal; force?: boolean } = {},
): Promise<boolean> {
	const baseUrl = options.baseUrl ?? DEFAULT_CATALOG_BASE_URL;
	const results = await Promise.allSettled(
		providerIds.map((id) => refreshProvider(store, id, baseUrl, options.signal, options.force ?? false)),
	);
	const outcomes = results.map((result) => (result.status === "fulfilled" ? result.value : "skipped"));
	if (outcomes.some((outcome) => outcome !== "skipped")) store.save();
	return outcomes.some((outcome) => outcome === "changed");
}
