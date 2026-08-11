// Generic OAuth 2.1 (PKCE + dynamic client registration) for remote MCP servers.
// One provider per server, registered as `mcp:<server>` so it reuses auth.json. Node-only (callback server).

import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../utils/oauth/oauth-page.js";
import { generatePKCE } from "../utils/oauth/pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderCredentials, OAuthProviderInterface } from "../utils/oauth/types.js";


const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
// A range (not one port) so a leaked/concurrent login can't wedge all logins with EADDRINUSE.
// Distinct from the Anthropic callback port (53692). All candidates are registered as redirect URIs.
const CALLBACK_PORT_BASE = Number(process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700);
const CALLBACK_PORT_COUNT = 10;
const CALLBACK_PATH = "/callback";
const CALLBACK_PORTS = Array.from({ length: CALLBACK_PORT_COUNT }, (_, i) => CALLBACK_PORT_BASE + i);
const redirectUriFor = (port: number) => `http://localhost:${port}${CALLBACK_PATH}`;
const ALL_REDIRECT_URIS = CALLBACK_PORTS.map(redirectUriFor);
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Authorization-server metadata we rely on (RFC 8414 / OAuth 2.1 + DCR). */
interface AuthServerMetadata {
	issuer?: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
}

export interface McpOAuthConfig {
	/** MCP server name; provider id becomes `mcp:<server>`. */
	server: string;
	/** Human label for UI. */
	label?: string;
	/** The MCP endpoint URL — discovery is rooted at its origin. */
	url: string;
	/** Pre-registered client id (servers without DCR, e.g. Slack). */
	clientId?: string;
	/** Explicit scopes; falls back to the server's advertised scopes. */
	scopes?: string;
	/** Injected Core S01 secret authority; absent means OAuth is unavailable. */
	secretStore?: McpOAuthSecretPort;
}

/** Extra fields we persist alongside the standard credential triple. */
/** AI never interprets secret handles; the coding-agent adapter owns S01 validation. */
export interface McpOAuthBinding {
	mcpEndpoint: string;
	authServer: string;
	tokenEndpoint: string;
	clientId: string;
	scopes: string;
}

export interface McpOAuthSecretPort {
	put(value: Uint8Array): Promise<unknown>;
	/** The adapter validates an opaque S01 handle before returning encrypted secret bytes. */
	get(reference: unknown, expected: McpOAuthBinding): Promise<Uint8Array | undefined>;
	replace(reference: unknown, value: Uint8Array): Promise<unknown>;
	delete(reference: unknown): Promise<void>;
}

export interface McpOAuthKeychainRecord {
	kind: "opaque";
	secretReference: unknown;
	mcpEndpoint: string;
	authServer: string;
	clientId: string;
	scopes: string;
	tokenEndpoint: string;
	expires: number;
}

/** The generic provider surface accepts a legacy OAuth payload or opaque MCP metadata. */
export type McpProviderCredentials = OAuthCredentials | McpOAuthKeychainRecord;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, init);
	if (!res.ok) {
		throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${await res.text()}`);
	}
	return res.json();
}

/** Random, URL-safe CSRF `state` value, independent of the PKCE verifier. */
function randomState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

/** Try the protected-resource and auth-server well-known docs at the URL's origin. */
async function discover(url: string): Promise<AuthServerMetadata> {
	const origin = new URL(url).origin;
	const candidates = [
		`${origin}/.well-known/oauth-authorization-server`,
		`${origin}/.well-known/openid-configuration`,
	];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const meta = (await fetchJson(candidate)) as AuthServerMetadata;
			if (meta.authorization_endpoint && meta.token_endpoint) {
				return meta;
			}
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Could not discover OAuth metadata for ${origin}. ` +
			`Tried ${candidates.join(", ")}. Last error: ${String(lastError)}`,
	);
}

/** Dynamic client registration (RFC 7591). Returns the issued client_id. */
async function registerClient(registrationEndpoint: string, label: string): Promise<string> {
	const body = {
		client_name: label,
		redirect_uris: ALL_REDIRECT_URIS,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	const data = (await fetchJson(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})) as { client_id?: string };
	if (!data.client_id) {
		throw new Error(`Dynamic client registration at ${registrationEndpoint} returned no client_id`);
	}
	return data.client_id;
}

type CallbackResult = { code: string; state: string } | null;

async function startCallbackServer(label: string): Promise<{
	server: Server;
	redirectUri: string;
	cancel: () => void;
	waitForCode: () => Promise<CallbackResult>;
}> {
	const { createServer } = await import("node:http");
	let settle: ((value: CallbackResult) => void) | undefined;
	const waitPromise = new Promise<CallbackResult>((resolve) => {
		let settled = false;
		settle = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
	});

	const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
		const url = new URL(req.url || "", "http://localhost");
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthErrorHtml("Callback route not found."));
			return;
		}
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		res.writeHead(error || !code ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
		if (error) {
			res.end(oauthErrorHtml(`${label} authentication failed.`, `Error: ${error}`));
			settle?.(null);
			return;
		}
		if (!code || !state) {
			res.end(oauthErrorHtml("Missing code or state parameter."));
			settle?.(null);
			return;
		}
		res.end(oauthSuccessHtml(`${label} authentication completed. You can close this window.`));
		settle?.({ code, state });
	};

	// Try each candidate port with a FRESH server (a server that failed to listen
	// can't be reused), so a leaked/concurrent login can't block us with EADDRINUSE.
	let lastError: unknown;
	for (const port of CALLBACK_PORTS) {
		const server = createServer(handler);
		// Persistent handler so a post-bind 'error' is never an unhandled crash.
		let bindErr: ((err: unknown) => void) | undefined;
		server.on("error", (err) => bindErr?.(err));
		try {
			const bound = await new Promise<boolean>((resolve) => {
				bindErr = () => resolve(false);
				server.listen(port, CALLBACK_HOST, () => {
					bindErr = undefined;
					resolve(true);
				});
			});
			if (bound) {
				return {
					server,
					redirectUri: redirectUriFor(port),
					cancel: () => settle?.(null),
					waitForCode: () => waitPromise,
				};
			}
			lastError = `port ${port} in use`;
			server.close();
		} catch (err) {
			lastError = err;
			server.close();
		}
	}
	throw new Error(
		`Could not start the OAuth callback server: ports ${CALLBACK_PORT_BASE}-${
			CALLBACK_PORT_BASE + CALLBACK_PORT_COUNT - 1
		} are all in use. Close other login attempts and retry. (${String(lastError)})`,
	);
}

function parseRedirectInput(input: string, expectedState: string): { code: string; state: string } {
	const value = input.trim();
	let code: string | undefined;
	let state: string | undefined;
	try {
		const url = new URL(value);
		code = url.searchParams.get("code") ?? undefined;
		state = url.searchParams.get("state") ?? undefined;
	} catch {
		const params = new URLSearchParams(value);
		code = params.get("code") ?? value;
		state = params.get("state") ?? undefined;
	}
	if (state && state !== expectedState) {
		throw new Error("OAuth state mismatch");
	}
	if (!code) {
		throw new Error("Missing authorization code");
	}
	return { code, state: state ?? expectedState };
}

async function exchangeToken(
	tokenEndpoint: string,
	params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
	const res = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Token request to ${tokenEndpoint} failed: ${res.status} ${text}`);
	}
	return JSON.parse(text);
}

function zero(bytes: Uint8Array): void { bytes.fill(0); }

function requireStore(store: McpOAuthSecretPort | undefined): McpOAuthSecretPort {
	if (!store) throw new Error("MCP OAuth secret storage is unavailable.");
	return store;
}

function canonicalHttpsUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
		throw new Error("MCP OAuth binding requires a canonical HTTPS URL.");
	}
	return url.href;
}

async function toCredentials(token: { access_token: string; refresh_token?: string; expires_in?: number }, binding: { endpoint: string; authServer: string; tokenEndpoint: string; clientId: string; scopes: string }, store: McpOAuthSecretPort, previous?: McpOAuthKeychainRecord): Promise<McpOAuthKeychainRecord> {
	if (!token.access_token) throw new Error("OAuth token response omitted access_token.");
	const sealedBinding: OAuthBinding = { mcpEndpoint: binding.endpoint, authServer: binding.authServer, tokenEndpoint: binding.tokenEndpoint, clientId: binding.clientId, scopes: binding.scopes };
	const bytes = new TextEncoder().encode(JSON.stringify({ access: token.access_token, refresh: token.refresh_token ?? "", binding: sealedBinding } satisfies StoredTokens));
	try {
		const secretReference = previous
			? await store.replace(previous.secretReference, bytes)
			: await store.put(bytes);
		return { kind: "opaque", expires: token.expires_in ? Date.now() + token.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS : Date.now() + 3300_000, secretReference, mcpEndpoint: binding.endpoint, authServer: binding.authServer, tokenEndpoint: binding.tokenEndpoint, clientId: binding.clientId, scopes: binding.scopes };
	} finally { zero(bytes); }
}

function isCanonicalHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try { return canonicalHttpsUrl(value) === value; } catch { return false; }
}

function isBinding(value: unknown): value is OAuthBinding {
	if (!value || typeof value !== "object") return false;
	const binding = value as Partial<OAuthBinding>;
	return isCanonicalHttpsUrl(binding.mcpEndpoint) && isCanonicalHttpsUrl(binding.authServer) &&
		isCanonicalHttpsUrl(binding.tokenEndpoint) && typeof binding.clientId === "string" &&
		binding.clientId.length > 0 && typeof binding.scopes === "string";
}

function sameBinding(left: OAuthBinding | undefined, right: OAuthBinding | undefined): boolean {
	return !!left && !!right && left.mcpEndpoint === right.mcpEndpoint && left.authServer === right.authServer && left.tokenEndpoint === right.tokenEndpoint && left.clientId === right.clientId && left.scopes === right.scopes;
}

function isOpaqueRecord(value: unknown): value is McpOAuthKeychainRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<McpOAuthKeychainRecord>;
	return record.kind === "opaque" && record.secretReference !== undefined &&
		isBinding({ mcpEndpoint: record.mcpEndpoint, authServer: record.authServer, tokenEndpoint: record.tokenEndpoint, clientId: record.clientId, scopes: record.scopes }) &&
		typeof record.expires === "number" && Number.isFinite(record.expires);
}

function decodeTokens(bytes: Uint8Array): StoredTokens {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!parsed || typeof parsed !== "object") throw new Error();
		const stored = parsed as Partial<StoredTokens>;
		if (typeof stored.access !== "string" || typeof stored.refresh !== "string" || !isBinding(stored.binding)) throw new Error();
		return stored as StoredTokens;
	} catch { throw new Error("MCP OAuth secret is unavailable or invalid."); }
}

/**
 * Host-only access retrieval. It validates both public and sealed bindings
 * before exposing a transient bearer string to the host transport.
 */
export async function getMcpOAuthAccessToken(
	record: McpOAuthKeychainRecord,
	expected: McpOAuthBinding,
	store: McpOAuthSecretPort,
): Promise<string> {
	if (!isOpaqueRecord(record) || !sameBinding({ mcpEndpoint: record.mcpEndpoint, authServer: record.authServer, tokenEndpoint: record.tokenEndpoint, clientId: record.clientId, scopes: record.scopes }, expected)) {
		throw new Error("MCP OAuth credential binding is invalid.");
	}
	const bytes = await store.get(record.secretReference, expected);
	if (!bytes) throw new Error("MCP OAuth secret is unavailable.");
	try {
		const stored = decodeTokens(bytes);
		if (!sameBinding(stored.binding, expected) || !stored.access) throw new Error("MCP OAuth credential binding is invalid.");
		return stored.access;
	} finally { zero(bytes); }
}

/** Build a provider for one MCP server. Register it with registerOAuthProvider(). */
export function createMcpOAuthProvider(config: McpOAuthConfig): OAuthProviderInterface {
	const label = config.label ?? config.server;
	const mcpEndpoint = canonicalHttpsUrl(config.url);

	async function login(callbacks: OAuthLoginCallbacks): Promise<McpProviderCredentials> {
		const meta = await discover(config.url);
		callbacks.onProgress?.(`Discovered ${meta.issuer ?? new URL(config.url).origin}`);

		let clientId = config.clientId;
		if (!clientId) {
			if (!meta.registration_endpoint) {
				throw new Error(
					`${label} does not support dynamic client registration and no clientId was configured. ` +
						`Set a pre-registered client id for this server.`,
				);
			}
			callbacks.onProgress?.("Registering OAuth client…");
			clientId = await registerClient(meta.registration_endpoint, `Prime Agent (${label})`);
		}

		const { verifier, challenge } = await generatePKCE();
		// `state` must be independent of the PKCE verifier — the verifier is the
		// secret used at token exchange, while `state` is echoed on the redirect URL.
		const state = randomState();
		const scope = config.scopes ?? meta.scopes_supported?.join(" ");
		const cb = await startCallbackServer(label);
		try {
			const authParams = new URLSearchParams({
				client_id: clientId,
				response_type: "code",
				redirect_uri: cb.redirectUri,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
			});
			if (scope) authParams.set("scope", scope);

			callbacks.onAuth({
				url: `${meta.authorization_endpoint}?${authParams.toString()}`,
				instructions:
					"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
			});

			// Race the local callback server against a manual paste (browser on
			// another machine). The login dialog supplies onManualCodeInput; when
			// absent we fall back to a blocking prompt after the callback resolves.
			let result: { code: string; state: string } | null;
			let manualCancelled = false;
			let manualError: Error | undefined;
			if (callbacks.onManualCodeInput) {
				// Manual paste races the browser callback. A real paste cancels the
				// callback waiter (we're done). On manual cancellation we still settle
				// the waiter to avoid hanging when no redirect arrives — but only after
				// a short grace period so an in-flight browser redirect can win first.
				const manual = callbacks
					.onManualCodeInput()
					.then((input) => {
						const parsed = parseRedirectInput(input, state); // may throw a validation error
						cb.cancel();
						return parsed;
					})
					.catch(async (err) => {
						// A validation error on a real paste (bad state / no code) is a genuine
						// failure to surface; a UI cancellation is not. .catch also prevents an
						// unhandled rejection when the callback wins the race.
						if (err instanceof Error && /state mismatch|authorization code/i.test(err.message)) {
							manualError = err;
						} else {
							manualCancelled = true;
						}
						await new Promise((r) => setTimeout(r, 500));
						cb.cancel();
						return null;
					});
				const fromCallback = await cb.waitForCode();
				result = fromCallback ?? (await manual);
				if (!result && manualError) throw manualError;
			} else {
				result = await cb.waitForCode();
				if (!result) {
					const input = await callbacks.onPrompt({
						message: "Paste the authorization code or full redirect URL:",
						placeholder: cb.redirectUri,
					});
					result = parseRedirectInput(input, state);
				}
			}
			if (!result) {
				throw new Error(manualCancelled ? "Login cancelled" : "Missing authorization code");
			}
			if (result.state !== state) {
				throw new Error("OAuth state mismatch");
			}

			callbacks.onProgress?.("Exchanging authorization code for tokens…");
			const token = await exchangeToken(meta.token_endpoint, {
				grant_type: "authorization_code",
				code: result.code,
				redirect_uri: cb.redirectUri,
				client_id: clientId,
				code_verifier: verifier,
			});
			return await toCredentials(token, { endpoint: mcpEndpoint, authServer: canonicalHttpsUrl(meta.issuer ?? new URL(config.url).origin), tokenEndpoint: canonicalHttpsUrl(meta.token_endpoint), clientId, scopes: scope ?? "" }, requireStore(config.secretStore));
		} finally {
			cb.server.close();
		}
	}

	async function refreshToken(credentials: McpProviderCredentials): Promise<McpProviderCredentials> {
		if (!isOpaqueRecord(credentials)) throw new Error("MCP OAuth credential binding is invalid.");
		const creds = credentials;
		const store = requireStore(config.secretStore);
		if (creds.mcpEndpoint !== mcpEndpoint) {
			throw new Error("MCP OAuth credential binding is invalid.");
		}
		const publicBinding: OAuthBinding = { mcpEndpoint: creds.mcpEndpoint, authServer: creds.authServer, tokenEndpoint: creds.tokenEndpoint, clientId: creds.clientId, scopes: creds.scopes };
		const bytes = await store.get(creds.secretReference, publicBinding);
		if (!bytes) throw new Error("MCP OAuth secret is unavailable.");
		try {
			const stored = decodeTokens(bytes);
			if (!sameBinding(stored.binding, publicBinding)) throw new Error("MCP OAuth credential binding is invalid.");
			if (!stored.refresh) throw new Error(`No refresh token stored for ${label}; re-run /mcp login ${config.server}`);
			const token = await exchangeToken(stored.binding.tokenEndpoint, { grant_type: "refresh_token", refresh_token: stored.refresh, client_id: stored.binding.clientId });
			if (!token.refresh_token) token.refresh_token = stored.refresh;
			return await toCredentials(token, { endpoint: stored.binding.mcpEndpoint, authServer: stored.binding.authServer, tokenEndpoint: stored.binding.tokenEndpoint, clientId: stored.binding.clientId, scopes: stored.binding.scopes }, store, creds);
		} finally { zero(bytes); }
	}

	return {
		id: `mcp:${config.server}`,
		name: label,
		usesCallbackServer: true,
		login,
		refreshToken,
		// MCP bearer material is available only through host-owned transient retrieval.
		getApiKey: () => { throw new Error("MCP OAuth tokens require the host secret adapter."); },
	};
}
