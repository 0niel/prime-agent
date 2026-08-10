import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthProvider } from "../src/mcp/oauth.js";

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
		const provider = createMcpOAuthProvider({ server: "linear", label: "Linear", url: "https://srv.test/mcp" });
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

		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		const creds = await provider.login({
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
		});

		expect(creds.access).toBe("access-1");
		expect(creds.refresh).toBe("refresh-1");
		expect(creds.expires).toBeGreaterThan(Date.now());
		// auth URL carries PKCE challenge + registered client id
		const authParams = new URL(authUrl).searchParams;
		expect(authParams.get("client_id")).toBe("client-xyz");
		expect(authParams.get("code_challenge")).toBeTruthy();
		expect(authParams.get("scope")).toBe("read write");
	});

	it("follows path-suffixed protected-resource metadata to an external issuer", async () => {
		let authUrl = "";
		const requested: string[] = [];
		const externalMeta = {
			...META,
			issuer: "https://auth.test/tenant",
			authorization_endpoint: "https://auth.test/authorize",
			token_endpoint: "https://auth.test/token",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				requested.push(url);
				if (url === "https://resource.test/.well-known/oauth-protected-resource/mcp/v1?tenant=a") {
					return jsonResponse({
						resource: "https://resource.test/mcp/v1?tenant=a",
						authorization_servers: ["https://auth.test/tenant"],
					});
				}
				if (url === "https://auth.test/.well-known/oauth-authorization-server/tenant") {
					return jsonResponse(externalMeta);
				}
				if (url === externalMeta.token_endpoint) {
					return jsonResponse({ access_token: "external-access", expires_in: 3600 });
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);

		const provider = createMcpOAuthProvider({
			server: "external",
			url: "https://resource.test/mcp/v1?tenant=a",
			clientId: "configured-client",
		});
		const credentials = await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=external-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("external-access");
		expect(new URL(authUrl).origin).toBe("https://auth.test");
		expect(requested.slice(0, 2)).toEqual([
			"https://resource.test/.well-known/oauth-protected-resource/mcp/v1?tenant=a",
			"https://auth.test/.well-known/oauth-authorization-server/tenant",
		]);
	});

	it("uses OIDC path-append discovery for pathful issuers", async () => {
		let authUrl = "";
		const requested: string[] = [];
		const issuer = "https://auth.test/tenant";
		const oidcMeta = {
			...META,
			issuer,
			authorization_endpoint: "https://auth.test/tenant/authorize",
			token_endpoint: "https://auth.test/tenant/token",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				requested.push(url);
				if (url === "https://resource.test/.well-known/oauth-protected-resource/mcp") {
					return jsonResponse({ resource: "https://resource.test/mcp", authorization_servers: [issuer] });
				}
				if (url === "https://auth.test/tenant/.well-known/openid-configuration") return jsonResponse(oidcMeta);
				if (url === oidcMeta.token_endpoint) return jsonResponse({ access_token: "oidc-access", expires_in: 3600 });
				return new Response("not found", { status: 404 });
			}),
		);

		const provider = createMcpOAuthProvider({
			server: "oidc-path",
			url: "https://resource.test/mcp",
			clientId: "configured-client",
		});
		const credentials = await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=oidc-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("oidc-access");
		expect(requested.slice(0, 4)).toEqual([
			"https://resource.test/.well-known/oauth-protected-resource/mcp",
			"https://auth.test/.well-known/oauth-authorization-server/tenant",
			"https://auth.test/.well-known/openid-configuration/tenant",
			"https://auth.test/tenant/.well-known/openid-configuration",
		]);
	});

	it("falls back from path-suffixed to root protected-resource metadata", async () => {
		let authUrl = "";
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				requested.push(url);
				if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
					return new Response("not found", { status: 404 });
				}
				if (url.endsWith("/.well-known/oauth-protected-resource")) {
					return jsonResponse({ resource: "https://srv.test/mcp", authorization_servers: ["https://srv.test"] });
				}
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(META);
				if (url === META.token_endpoint) return jsonResponse({ access_token: "root-access", expires_in: 3600 });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);

		const provider = createMcpOAuthProvider({
			server: "root-resource",
			url: "https://srv.test/mcp",
			clientId: "configured-client",
		});
		const credentials = await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=root-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("root-access");
		expect(requested.slice(0, 3)).toEqual([
			"https://srv.test/.well-known/oauth-protected-resource/mcp",
			"https://srv.test/.well-known/oauth-protected-resource",
			"https://srv.test/.well-known/oauth-authorization-server",
		]);
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
			const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
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
			expect(creds.access).toBe("a");
			// Did NOT use the blocked base port.
			const redirect = new URL(authUrl).searchParams.get("redirect_uri") ?? "";
			expect(redirect).not.toContain(":53700/");
			expect(redirect).toContain(":5370");
		} finally {
			if (blockerBound) await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("refreshes tokens, keeping the prior refresh token when omitted", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("old-refresh");
				return jsonResponse({ access_token: "access-2", expires_in: 1800 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		const refreshed = await provider.refreshToken({
			access: "access-1",
			refresh: "old-refresh",
			expires: Date.now() - 1000,
			tokenEndpoint: META.token_endpoint,
			clientId: "client-xyz",
		} as never);

		expect(refreshed.access).toBe("access-2");
		expect(refreshed.refresh).toBe("old-refresh");
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
		const provider = createMcpOAuthProvider({ server: "slackish", url: "https://srv.test/mcp" });
		await expect(provider.login({ onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(
			"dynamic client registration",
		);
	});
});

const REDIRECT = `http://localhost:${process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700}/callback`;
