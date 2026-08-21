import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { overlayRemoteModels, RemoteCatalogStore, refreshRemoteCatalog } from "../src/core/remote-catalog.js";

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

const GENERATED_AT = Date.parse("2026-07-23T10:00:00.000Z");

describe("remote catalog", () => {
	let tempDir: string;
	let store: RemoteCatalogStore;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-remote-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		store = RemoteCatalogStore.open(join(tempDir, "models-store.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function refresh(options: { force?: boolean } = {}): Promise<boolean> {
		return refreshRemoteCatalog(store, ["test-provider"], options);
	}

	it("overlays remote models only when the remote catalog is newer than the bundled one", async () => {
		const catalog = {
			remote: model("remote"),
			static: { ...model("static"), name: "updated" },
			plain: { id: "plain" },
			exotic: { ...model("exotic"), api: "definitely-not-registered" },
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(catalog), {
				headers: { "last-modified": new Date(GENERATED_AT + 60_000).toUTCString() },
			}),
		);

		await expect(refresh()).resolves.toBe(true);

		// The malformed id-only entry is dropped at parse time; the well-formed entry
		// with an unregistered api is stored but never overlays the bundled model.
		expect(store.get("test-provider")?.models.map((entry) => entry.id)).toEqual(["remote", "static", "exotic"]);
		const bundled = [model("static"), model("plain"), model("exotic")];
		const merged = overlayRemoteModels(bundled, store.get("test-provider"), GENERATED_AT);
		expect(merged.map((entry) => entry.id)).toEqual(["static", "plain", "exotic", "remote"]);
		expect(merged[0]?.name).toBe("updated");
		expect(merged[1]?.name).toBe("plain");
		expect(merged[2]?.api).toBe("openai-completions");
		expect(overlayRemoteModels(bundled, store.get("test-provider"), GENERATED_AT + 120_000)).toEqual(bundled);
		expect(overlayRemoteModels(bundled, undefined, GENERATED_AT)).toEqual(bundled);
	});

	it("keeps the bundled catalog when the remote last-modified header is older or absent", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(GENERATED_AT - 60_000).toUTCString() },
			}),
		);

		await refresh();

		const bundled = [model("static")];
		expect(overlayRemoteModels(bundled, store.get("test-provider"), GENERATED_AT)).toEqual(bundled);
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ remote: model("remote") }), {
				headers: { etag: '"catalog-1"', "last-modified": new Date(GENERATED_AT + 60_000).toUTCString() },
			}),
			new Response(null, { status: 304 }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);

		await refresh();
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		const first = store.get("test-provider");
		expect(first?.etag).toBe('"catalog-1"');

		await refresh({ force: true });
		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		const second = store.get("test-provider");
		expect(second?.models.map((entry) => entry.id)).toEqual(["remote"]);
		expect(second?.etag).toBe('"catalog-1"');
		expect(second?.checkedAt).toBeGreaterThanOrEqual(first?.checkedAt ?? 0);
	});

	it("fails open on transport errors and server errors, keeping the stored overlay", async () => {
		const responses = [
			new Response(JSON.stringify({ remote: model("remote") }), {
				headers: { etag: '"catalog-1"', "last-modified": new Date(GENERATED_AT + 60_000).toUTCString() },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const response = responses.shift();
			if (!response) throw new Error("connection refused");
			return response;
		});

		await expect(refresh()).resolves.toBe(true);
		await expect(refresh({ force: true })).resolves.toBe(false);

		const stored = store.get("test-provider");
		expect(stored?.models.map((entry) => entry.id)).toEqual(["remote"]);
		expect(stored?.etag).toBe('"catalog-1"');

		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
		await expect(refresh({ force: true })).resolves.toBe(false);
		expect(store.get("test-provider")?.models.map((entry) => entry.id)).toEqual(["remote"]);
		expect(store.get("test-provider")?.etag).toBe('"catalog-1"');
	});

	it("drops the overlay and stale etag on 404", async () => {
		const responses = [
			new Response(JSON.stringify({ remote: model("remote") }), {
				headers: { etag: '"catalog-1"', "last-modified": new Date(GENERATED_AT + 60_000).toUTCString() },
			}),
			new Response("gone", { status: 404 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);

		await refresh();
		await refresh({ force: true });

		expect(store.get("test-provider")).toMatchObject({ models: [], lastModified: 0, etag: undefined });
	});

	it("observes the freshness window unless forced", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ remote: model("remote") }), {
					headers: { "last-modified": new Date().toUTCString() },
				}),
		);

		await refresh();
		await refresh();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const stored = store.get("test-provider");
		store.set("test-provider", {
			...stored,
			models: stored?.models ?? [],
			checkedAt: Date.now() - 5 * 60 * 60 * 1000,
		});
		await refresh();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("reload drops the in-memory overlay when the store file is removed or corrupt", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ remote: model("remote") }), {
				headers: { "last-modified": new Date(GENERATED_AT + 60_000).toUTCString() },
			}),
		);
		await refresh();
		expect(store.get("test-provider")?.models).toHaveLength(1);

		rmSync(join(tempDir, "models-store.json"));
		store.reload();
		expect(store.get("test-provider")).toBeUndefined();

		const corruptEntries = [
			{ models: "corrupt" },
			{ models: [null] },
			{ models: [], lastModified: "yesterday" },
			{ models: [{ ...model("no-reasoning"), reasoning: "yes" }] },
			{ models: [{ ...model("no-input"), input: undefined }] },
		];
		for (const entry of corruptEntries) {
			writeFileSync(join(tempDir, "models-store.json"), JSON.stringify({ "test-provider": entry }));
			store.reload();
			expect(store.get("test-provider")).toBeUndefined();
		}
	});

	it("settles in bounded time when a fetch hangs until aborted", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		);

		await expect(refreshRemoteCatalog(store, ["test-provider"], { signal: AbortSignal.timeout(500) })).resolves.toBe(
			false,
		);
		expect(store.get("test-provider")?.models).toEqual([]);
	});
});
