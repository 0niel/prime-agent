import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthProvider, getMcpOAuthAccessToken, type McpOAuthKeychainRecord } from "../src/mcp/oauth.js";
import type { McpOAuthSecretPort } from "../src/mcp/oauth.js";

class FakeSecretPort implements McpOAuthSecretPort {
	readonly values = new Map<string, Uint8Array>();
	private next = 0;
	async put(value: Uint8Array): Promise<unknown> { const key = String(++this.next); this.values.set(key, Uint8Array.from(value)); return { key }; }
	async get(reference: unknown, _expected: { mcpEndpoint: string; authServer: string; tokenEndpoint: string; clientId: string; scopes: string }): Promise<Uint8Array | undefined> { const key = (reference as { key?: string }).key; const value = key && this.values.get(key); return value && Uint8Array.from(value); }
	async replace(reference: unknown, value: Uint8Array): Promise<unknown> { const key = (reference as { key?: string }).key; if (!key || !this.values.has(key)) throw new Error("missing"); this.values.set(key, Uint8Array.from(value)); return { key }; }
	async delete(reference: unknown): Promise<void> { const key = (reference as { key?: string }).key; if (key) this.values.delete(key); }
}
function fakeStore() { const store = new FakeSecretPort(); return { store, keychain: store }; }

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

const META = {
	issuer: "https://srv.test",
	authorization_endpoint: "https://srv.test/authorize",
	token_endpoint: "https://srv.test/token",
	registration_endpoint: "https://srv.test/register",
	scopes_supported: ["read", "write"],
};

describe.sequential("MCP OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("has a namespaced id and label", () => {
		const provider = createMcpOAuthProvider({ server: "linear", label: "Linear", url: "https://srv.test/mcp", secretStore: fakeStore().store });
		expect(provider.id).toBe("mcp:linear");
		expect(provider.name).toBe("Linear");
		expect(provider.usesCallbackServer).toBe(true);
	});

	it("discovers, registers a client, and exchanges the code for tokens", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
			if (url === META.registration_endpoint) return jsonResponse({ client_id: "client-xyz" });
			if (url === META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("client-xyz");
				expect(params.get("code")).toBe("the-code");
				expect(params.get("code_verifier")).toBeTruthy();
				return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { store, keychain } = fakeStore();
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", secretStore: store });
		const creds = (await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			// Headless: supply the redirect URL via the manual-input path, which
			// races (and wins against) the local callback server.
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=the-code&state=${state}`;
			},
		})) as unknown as McpOAuthKeychainRecord;

		expect("access" in creds).toBe(false);
		expect("refresh" in creds).toBe(false);
		expect(creds.secretReference).toBeDefined();
		expect(JSON.stringify(creds)).not.toContain("access-1");
		expect(JSON.stringify(creds)).not.toContain("refresh-1");
		expect([...keychain.values.values()].map((value) => new TextDecoder().decode(value)).join("\n")).toContain("access-1");
		expect(creds.expires).toBeGreaterThan(Date.now());
		// auth URL carries PKCE challenge + registered client id
		const authParams = new URL(authUrl).searchParams;
		expect(authParams.get("client_id")).toBe("client-xyz");
		expect(authParams.get("code_challenge")).toBeTruthy();
		expect(authParams.get("scope")).toBe("read write");
	});

	it("falls back to the next port when the base callback port is in use", async () => {
		const http = await import("node:http");
		// Occupy the base callback port. If something already holds it (e.g. a stray
		// local daemon), that satisfies the precondition too — bind best-effort.
		const blocker = http.createServer();
		const blockerBound = await new Promise<boolean>((resolve) => {
			blocker.once("error", () => resolve(false));
			blocker.listen(53700, "127.0.0.1", () => resolve(true));
		});
		try {
			let authUrl = "";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown): Promise<Response> => {
					const url = urlOf(input);
					if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
					if (url === META.registration_endpoint) return jsonResponse({ client_id: "c" });
					if (url === META.token_endpoint) return jsonResponse({ access_token: "a", expires_in: 60 });
					throw new Error(`unexpected fetch: ${url}`);
				}),
			);
			const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", secretStore: fakeStore().store });
			const creds = await provider.login({
				onAuth: (info) => {
					authUrl = info.url;
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => {
					const p = new URL(authUrl).searchParams;
					return `${p.get("redirect_uri")}?code=x&state=${p.get("state")}`;
				},
			});
			expect("access" in creds).toBe(false);
			// Did NOT use the blocked base port.
			const redirect = new URL(authUrl).searchParams.get("redirect_uri") ?? "";
			expect(redirect).not.toContain(":53700/");
			expect(redirect).toContain(":5370");
		} finally {
			if (blockerBound) await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("rejects a sealed binding edited beneath valid opaque metadata", async () => {
		const { store } = fakeStore();
		const reference = await store.put(new TextEncoder().encode(JSON.stringify({
			access: "sealed-access", refresh: "sealed-refresh",
			binding: { mcpEndpoint: "https://other.test/mcp", authServer: "https://srv.test/", tokenEndpoint: "https://srv.test/token", clientId: "client", scopes: "read" },
		})));
		const record: McpOAuthKeychainRecord = { kind: "opaque", secretReference: reference, mcpEndpoint: "https://srv.test/mcp", authServer: "https://srv.test/", tokenEndpoint: "https://srv.test/token", clientId: "client", scopes: "read", expires: Date.now() + 1_000 };
		await expect(getMcpOAuthAccessToken(record, { mcpEndpoint: "https://srv.test/mcp", authServer: "https://srv.test/", tokenEndpoint: "https://srv.test/token", clientId: "client", scopes: "read" }, store)).rejects.toThrow("binding is invalid");
	});

	it("rejects an invalid opaque reference and token endpoint before an operation", async () => {
		const { store } = fakeStore();
		const record: McpOAuthKeychainRecord = { kind: "opaque", secretReference: undefined, mcpEndpoint: "https://srv.test/mcp", authServer: "https://srv.test/", tokenEndpoint: "https://srv.test/token", clientId: "client", scopes: "read", expires: Date.now() + 1_000 };
		await expect(getMcpOAuthAccessToken(record, { mcpEndpoint: "https://srv.test/mcp", authServer: "https://srv.test/", tokenEndpoint: "https://edited.test/token", clientId: "client", scopes: "read" }, store)).rejects.toThrow("binding is invalid");
	});

	it("rejects an edited public endpoint binding before refresh network I/O", async () => {
		const { store } = fakeStore();
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", secretStore: store });
		await expect(provider.refreshToken({ kind: "opaque", secretReference: { version: 1, namespace: "mcp-oauth", id: "a".repeat(43), revision: "b".repeat(43) }, mcpEndpoint: "https://edited.test/mcp", authServer: "https://srv.test/", tokenEndpoint: "https://srv.test/token", clientId: "c", scopes: "", expires: 0 } as never)).rejects.toThrow("binding is invalid");
	});

	it("fails closed when the Core secret store is unavailable", async () => {
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		await expect(provider.refreshToken({ kind: "opaque", secretReference: { opaque: true }, mcpEndpoint: "https://srv.test/mcp", authServer: "https://srv.test/", tokenEndpoint: "https://srv.test/token", clientId: "client", scopes: "", expires: 0 })).rejects.toThrow("secret storage is unavailable");
	});

	it("fails clearly when DCR is unavailable and no clientId is set", async () => {
		const noReg = { ...META, registration_endpoint: undefined };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(noReg);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "slackish", url: "https://srv.test/mcp", secretStore: fakeStore().store });
		await expect(provider.login({ onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(
			"dynamic client registration",
		);
	});
});

const REDIRECT = `http://localhost:${process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700}/callback`;
