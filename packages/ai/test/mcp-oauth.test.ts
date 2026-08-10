import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthProvider, parseMcpOAuthChallenge } from "../src/mcp/oauth.js";

const dnsLookup = vi.hoisted(() => vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));

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
	code_challenge_methods_supported: ["S256"],
};

describe.sequential("MCP OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		dnsLookup.mockReset();
		dnsLookup.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 as const }]);
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
				expect(params.get("resource")).toBe("https://srv.test/mcp");
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
		expect(authParams.get("scope")).toBeNull();
		expect(authParams.get("resource")).toBe("https://srv.test/mcp");
	});

	it("does not downgrade a native 401 that omits its OAuth challenge", async () => {
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				requested.push(urlOf(input));
				if (urlOf(input) === "https://srv.test/mcp") return new Response(null, { status: 401 });
				return jsonResponse(META);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "missing-challenge", url: "https://srv.test/mcp" });
		await expect(provider.login({ onAuth: vi.fn(), onPrompt: async () => "" })).rejects.toThrow(
			"omitted WWW-Authenticate",
		);
		expect(requested).toEqual(["https://srv.test/mcp"]);
	});

	it("uses the native initialize challenge for login and refresh discovery", async () => {
		let authUrl = "";
		let probes = 0;
		const metadataUrl = "https://metadata.test/prm";
		const externalMeta = {
			...META,
			issuer: "https://auth.test",
			authorization_endpoint: "https://auth.test/authorize",
			token_endpoint: "https://auth.test/token",
			registration_endpoint: undefined,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = urlOf(input);
				if (url === "https://resource.test/mcp" && init?.method === "POST") {
					probes++;
					expect(new Headers(init.headers).get("authorization")).toBeNull();
					expect(new Headers(init.headers).get("accept")).toBe("application/json, text/event-stream");
					expect(JSON.parse(String(init.body))).toMatchObject({
						jsonrpc: "2.0",
						method: "initialize",
						params: { capabilities: {}, clientInfo: { name: "prime-agent-oauth-discovery" } },
					});
					return new Response("ignored".repeat(200_000), {
						status: 401,
						headers: {
							"WWW-Authenticate": `Basic realm="decoy", Bearer resource_metadata="${metadataUrl}", scope="challenge.read"`,
						},
					});
				}
				if (url === metadataUrl) {
					return jsonResponse({
						resource: "https://resource.test/mcp",
						authorization_servers: [externalMeta.issuer],
					});
				}
				if (url === "https://auth.test/.well-known/oauth-authorization-server") return jsonResponse(externalMeta);
				if (url === externalMeta.token_endpoint) {
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("resource")).toBe("https://resource.test/mcp");
					if (params.get("grant_type") === "refresh_token") {
						expect(params.get("refresh_token")).toBe("refresh-native");
						return jsonResponse({
							access_token: "refreshed-native",
							refresh_token: "refresh-native",
							expires_in: 3600,
						});
					}
					return jsonResponse({
						access_token: "access-native",
						refresh_token: "refresh-native",
						expires_in: 3600,
					});
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({
			server: "challenge-native",
			url: "https://resource.test/mcp",
			clientId: "configured-client",
			scopes: "configured.scope",
		});
		const credentials = await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=native-code&state=${state}`;
			},
		});
		expect(new URL(authUrl).searchParams.get("scope")).toBe("challenge.read");
		expect(credentials.access).toBe("access-native");
		const refreshed = await provider.refreshToken(credentials);
		expect(refreshed.access).toBe("refreshed-native");
		expect(probes).toBe(2);
	});

	it("follows path-suffixed protected-resource metadata to an external issuer", async () => {
		let authUrl = "";
		const requested: string[] = [];
		const externalMeta = {
			...META,
			issuer: "https://auth.test/tenant",
			authorization_endpoint: "https://auth.test/authorize",
			token_endpoint: "https://auth.test/token",
			registration_endpoint: undefined,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
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
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("resource")).toBe("https://resource.test/mcp/v1?tenant=a");
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
		expect(new URL(authUrl).searchParams.get("resource")).toBe("https://resource.test/mcp/v1?tenant=a");
		expect(requested.slice(0, 3)).toEqual([
			"https://resource.test/mcp/v1?tenant=a",
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
			registration_endpoint: undefined,
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
		expect(requested.slice(0, 5)).toEqual([
			"https://resource.test/mcp",
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
					return jsonResponse({
						resource: "https://srv.test/mcp",
						authorization_servers: ["https://srv.test"],
						scopes_supported: ["resource.read"],
					});
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
		expect(new URL(authUrl).searchParams.get("scope")).toBe("resource.read");
		expect(new URL(authUrl).searchParams.get("resource")).toBe("https://srv.test/mcp");
		expect(requested.slice(0, 4)).toEqual([
			"https://srv.test/mcp",
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

	it("refreshes tokens, keeping the prior refresh token and resource binding", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
				return jsonResponse({ resource: "https://srv.test/mcp", authorization_servers: [META.issuer] });
			}
			if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
			if (url === META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("old-refresh");
				expect(params.get("resource")).toBe("https://srv.test/mcp");
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
			issuer: META.issuer,
			resource: "https://srv.test/mcp",
		} as never);

		expect(refreshed.access).toBe("access-2");
		expect(refreshed.refresh).toBe("old-refresh");
	});

	it("fails closed before network access when refresh bindings are missing", async () => {
		global.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
		const provider = createMcpOAuthProvider({ server: "legacy", url: "https://srv.test/mcp" });
		await expect(
			provider.refreshToken({ access: "old", refresh: "legacy-secret", expires: Date.now() - 1 }),
		).rejects.toThrow("credential binding is missing");
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("never sends a refresh token to a changed persisted endpoint", async () => {
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				requested.push(url);
				if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
					return jsonResponse({ resource: "https://srv.test/mcp", authorization_servers: [META.issuer] });
				}
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		await expect(
			provider.refreshToken({
				access: "old",
				refresh: "top-secret-refresh",
				expires: Date.now() - 1,
				tokenEndpoint: "https://evil.test/token",
				issuer: META.issuer,
				resource: "https://srv.test/mcp",
			} as never),
		).rejects.toThrow("token endpoint changed");
		expect(requested).not.toContain("https://evil.test/token");
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

	it("parses only Bearer resource metadata and scope parameters", () => {
		expect(
			parseMcpOAuthChallenge(
				'Basic realm="resource_metadata=fake", Bearer realm="files, api", resource_metadata = "https://hint.test/prm", scope = "files.read files.write"',
			),
		).toEqual({ resourceMetadataUrl: "https://hint.test/prm", scope: "files.read files.write" });
		expect(parseMcpOAuthChallenge('Basic resource_metadata="https://evil.test"')).toBeUndefined();
		expect(() =>
			parseMcpOAuthChallenge('Bearer resource_metadata="https://a.test", resource_metadata="https://b.test"'),
		).toThrow("Conflicting");
		expect(() => parseMcpOAuthChallenge("Bearer realm=x\r\nInjected: yes")).toThrow("Invalid");
	});

	it("uses a surfaced challenge metadata URL and challenged scope", async () => {
		let authUrl = "";
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = urlOf(input);
				requested.push(url);
				if (url === "https://hint.test/prm") {
					return jsonResponse({
						resource: "https://srv.test/mcp",
						authorization_servers: [META.issuer],
						scopes_supported: ["resource.scope"],
					});
				}
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				if (url === META.token_endpoint) {
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("resource")).toBe("https://srv.test/mcp");
					return jsonResponse({ access_token: "challenge-access", expires_in: 3600 });
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({
			server: "challenge",
			url: "https://srv.test/mcp",
			clientId: "configured-client",
			scopes: "configured.scope",
			authorizationChallenge: 'Bearer resource_metadata="https://hint.test/prm", scope="challenge.scope"',
		});
		await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=challenge-code&state=${state}`;
			},
		});
		expect(requested[0]).toBe("https://hint.test/prm");
		expect(new URL(authUrl).searchParams.get("scope")).toBe("challenge.scope");
	});

	it("fails closed when authoritative challenged resource metadata is unavailable", async () => {
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				requested.push(url);
				if (url === "https://hint.test/missing") return new Response("not found", { status: 404 });
				if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
					return jsonResponse({ resource: "https://srv.test/mcp", authorization_servers: [META.issuer] });
				}
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({
			server: "challenge-fail-closed",
			url: "https://srv.test/mcp",
			clientId: "client",
			authorizationChallenge: 'Bearer resource_metadata="https://hint.test/missing"',
		});
		await expect(provider.login({ onAuth: vi.fn(), onPrompt: async () => "" })).rejects.toThrow(
			"Challenged OAuth resource metadata",
		);
		expect(requested).toEqual(["https://hint.test/missing"]);
	});

	it("rejects authoritative challenged metadata without authorization servers", async () => {
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				requested.push(url);
				if (url === "https://hint.test/no-issuer") return jsonResponse({ resource: "https://srv.test/mcp" });
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({
			server: "challenge-no-issuer",
			url: "https://srv.test/mcp",
			clientId: "client",
			authorizationChallenge: 'Bearer resource_metadata="https://hint.test/no-issuer"',
		});
		await expect(provider.login({ onAuth: vi.fn(), onPrompt: async () => "" })).rejects.toThrow(
			"omitted authorization_servers",
		);
		expect(requested).toEqual(["https://hint.test/no-issuer"]);
	});

	it("rejects mismatched protected-resource metadata without discovery downgrade", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
					return jsonResponse({ resource: "https://other.test/mcp", authorization_servers: [META.issuer] });
				}
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				return new Response("not found", { status: 404 });
			}),
		);
		const provider = createMcpOAuthProvider({ server: "mismatch", url: "https://srv.test/mcp", clientId: "client" });
		await expect(provider.login({ onAuth: vi.fn(), onPrompt: async () => "" })).rejects.toThrow("resource mismatch");
	});

	it("rejects authorization servers without required PKCE S256 support", async () => {
		const onAuth = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
					return jsonResponse({ resource: "https://srv.test/mcp", authorization_servers: [META.issuer] });
				}
				if (url.endsWith("/.well-known/oauth-authorization-server")) {
					return jsonResponse({ ...META, code_challenge_methods_supported: ["plain"] });
				}
				return new Response("not found", { status: 404 });
			}),
		);
		const provider = createMcpOAuthProvider({ server: "no-pkce", url: "https://srv.test/mcp", clientId: "client" });
		await expect(provider.login({ onAuth, onPrompt: async () => "" })).rejects.toThrow("PKCE S256");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("rejects cross-origin authorization-server endpoints before exposing auth UI", async () => {
		const onAuth = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
					return jsonResponse({ resource: "https://srv.test/mcp", authorization_servers: [META.issuer] });
				}
				if (url.endsWith("/.well-known/oauth-authorization-server")) {
					return jsonResponse({ ...META, token_endpoint: "https://evil.test/token" });
				}
				return new Response("not found", { status: 404 });
			}),
		);
		const provider = createMcpOAuthProvider({
			server: "cross-origin",
			url: "https://srv.test/mcp",
			clientId: "client",
		});
		await expect(provider.login({ onAuth, onPrompt: async () => "" })).rejects.toThrow("issuer origin");
		expect(onAuth).not.toHaveBeenCalled();
	});
});

const REDIRECT = `http://localhost:${process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700}/callback`;
