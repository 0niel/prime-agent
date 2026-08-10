import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthFetchPolicy, safeFetchJson } from "../src/mcp/safe-fetch.js";

const dnsLookup = vi.hoisted(() => vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));

const originalFetch = global.fetch;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
}

afterEach(() => {
	vi.useRealTimers();
	global.fetch = originalFetch;
	dnsLookup.mockReset();
	dnsLookup.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 as const }]);
	vi.restoreAllMocks();
});

describe("MCP OAuth safe fetch", () => {
	it.each([
		"https://127.0.0.1/metadata",
		"https://10.1.2.3/metadata",
		"https://169.254.169.254/latest/meta-data",
		"https://224.0.0.1/metadata",
		"https://[::1]/metadata",
		"https://[::ffff:127.0.0.1]/metadata",
		"https://[fe80::1]/metadata",
		"https://[ff02::1]/metadata",
		"https://[3fff::1]/metadata",
		"https://[5f00::1]/metadata",
	])("rejects non-public IP literal %s before fetch", async (url) => {
		global.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
		await expect(safeFetchJson(url, undefined, {})).rejects.toThrow(/non-public/);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("rejects a hostname when any DNS answer is private", async () => {
		dnsLookup.mockResolvedValueOnce([
			{ address: "93.184.216.34", family: 4 as const },
			{ address: "10.0.0.5", family: 4 as const },
		]);
		global.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
		await expect(safeFetchJson("https://public.test/metadata", undefined, {})).rejects.toThrow(/non-public/);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("bounds DNS resolution time", async () => {
		vi.useFakeTimers();
		dnsLookup.mockImplementationOnce(() => new Promise(() => {}));
		global.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
		const pending = safeFetchJson("https://slow.test/metadata", undefined, { timeoutMs: 5 });
		const rejected = expect(pending).rejects.toThrow("could not be resolved");
		await vi.advanceTimersByTimeAsync(6);
		await rejected;
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("validates every redirect hop and blocks a private pivot", async () => {
		global.fetch = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } }),
		) as typeof fetch;
		await expect(safeFetchJson("https://public.test/metadata", undefined, {})).rejects.toThrow(
			/Cross-origin|non-public/,
		);
		expect(global.fetch).toHaveBeenCalledOnce();
	});

	it("revalidates same-origin DNS on every redirect hop", async () => {
		dnsLookup
			.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 as const }])
			.mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 as const }]);
		global.fetch = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "/next" } }),
		) as typeof fetch;
		await expect(safeFetchJson("https://public.test/metadata", undefined, {})).rejects.toThrow("non-public");
		expect(global.fetch).toHaveBeenCalledOnce();
	});

	it("never follows POST redirects containing OAuth secrets", async () => {
		global.fetch = vi.fn(
			async () => new Response(null, { status: 307, headers: { location: "https://public.test/other" } }),
		) as typeof fetch;
		await expect(
			safeFetchJson("https://public.test/token", { method: "POST", body: "refresh_token=top-secret" }, {}),
		).rejects.toThrow("POST redirects are not allowed");
		expect(global.fetch).toHaveBeenCalledOnce();
	});

	it("bounds response bodies without reflecting their contents", async () => {
		const secret = "do-not-reflect";
		global.fetch = vi.fn(async () => new Response(secret.repeat(100))) as typeof fetch;
		let error: Error | undefined;
		try {
			await safeFetchJson("https://public.test/metadata", undefined, { maxBodyBytes: 32 });
		} catch (value) {
			error = value as Error;
		}
		expect(error?.message).toContain("exceeded 32 bytes");
		expect(error?.message).not.toContain(secret);
	});

	it("allows HTTP only for an explicitly configured loopback resource origin", async () => {
		const policy = createOAuthFetchPolicy("http://localhost:8080/mcp");
		global.fetch = vi.fn(async () => jsonResponse({ ok: true })) as typeof fetch;
		await expect(safeFetchJson("http://localhost:8080/metadata", undefined, policy)).resolves.toEqual({ ok: true });
		await expect(safeFetchJson("http://localhost:9090/metadata", undefined, policy)).rejects.toThrow("HTTPS");
		expect(() => createOAuthFetchPolicy("http://public.test/mcp")).toThrow("explicit loopback");
	});
});
