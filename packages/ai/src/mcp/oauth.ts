// Generic OAuth 2.1 (PKCE + dynamic client registration) for remote MCP servers.
// One provider per server, registered as `mcp:<server>` so it reuses auth.json. Node-only (callback server).

import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../utils/oauth/oauth-page.js";
import { generatePKCE } from "../utils/oauth/pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "../utils/oauth/types.js";
import {
	createOAuthFetchPolicy,
	type OAuthFetchPolicy,
	probeMcpOAuthChallenge,
	safeFetchJson,
	validateOAuthNetworkUrl,
} from "./safe-fetch.js";

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
	code_challenge_methods_supported?: string[];
}

/** OAuth protected-resource metadata (RFC 9728). */
interface ProtectedResourceMetadata {
	resource: string;
	authorization_servers?: string[];
	scopes_supported?: string[];
}

interface OAuthDiscovery {
	metadata: AuthServerMetadata;
	resource: string;
	resourceScopes?: string[];
	challengedScope?: string;
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
	/** Explicit scopes; otherwise resource scopes are preferred over AS-wide scopes. */
	scopes?: string;
	/**
	 * Optional raw WWW-Authenticate challenge obtained from this MCP resource.
	 * The current login command does not yet surface challenges automatically;
	 * integrations that have the 401 response can pass it through this field.
	 */
	authorizationChallenge?: string;
	/** Optional operator-provided RFC 6052 NAT64 prefixes for this network context. */
	nat64Prefixes?: string[];
}

/** Extra fields we persist alongside the standard credential triple. */
interface McpCredentials extends OAuthCredentials {
	tokenEndpoint?: string;
	clientId?: string;
	issuer?: string;
	resource?: string;
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

function splitAuthenticateHeader(header: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < header.length; index++) {
		const char = header[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') quoted = !quoted;
		else if (char === "," && !quoted) {
			parts.push(header.slice(start, index).trim());
			start = index + 1;
		}
	}
	if (quoted || escaped) throw new Error("Malformed WWW-Authenticate header");
	parts.push(header.slice(start).trim());
	return parts.filter(Boolean);
}

function decodeAuthParameter(value: string): string {
	if (!value.startsWith('"')) return value.trim();
	if (!value.endsWith('"')) throw new Error("Malformed WWW-Authenticate parameter");
	let decoded = "";
	for (let index = 1; index < value.length - 1; index++) {
		const char = value[index];
		if (char === "\\") {
			index++;
			if (index >= value.length - 1) throw new Error("Malformed WWW-Authenticate escape");
			decoded += value[index];
		} else {
			decoded += char;
		}
	}
	if (/[\u0000-\u001f\u007f]/.test(decoded)) throw new Error("Invalid WWW-Authenticate parameter");
	return decoded;
}

export interface McpOAuthChallenge {
	resourceMetadataUrl?: string;
	scope?: string;
}

/** Parse Bearer auth-params from an MCP 401 WWW-Authenticate value. */
export function parseMcpOAuthChallenge(header: string): McpOAuthChallenge | undefined {
	if (header.length > 8192 || /[\r\n]/.test(header)) throw new Error("Invalid WWW-Authenticate header");
	let scheme: string | undefined;
	const result: McpOAuthChallenge = {};
	const parts = splitAuthenticateHeader(header);
	if (parts.length > 64) throw new Error("WWW-Authenticate contains too many parameters");
	for (const part of parts) {
		const challenge = part.match(/^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s+(.+)$/);
		let parameter = part;
		if (challenge && !challenge[2].trimStart().startsWith("=")) {
			scheme = challenge[1].toLowerCase();
			parameter = challenge[2];
		}
		if (scheme !== "bearer") continue;
		const equals = parameter.indexOf("=");
		if (equals < 1) continue;
		const name = parameter.slice(0, equals).trim().toLowerCase();
		if (name !== "resource_metadata" && name !== "scope") continue;
		const value = decodeAuthParameter(parameter.slice(equals + 1).trim());
		if (!value) throw new Error(`Bearer ${name} is empty`);
		if (value.length > 4096) throw new Error(`Bearer ${name} is too long`);
		if (
			name === "scope" &&
			(value.split(/\s+/).length > 128 || value.split(/\s+/).some((scope) => scope.length > 256))
		) {
			throw new Error("Bearer scope is invalid");
		}
		const key = name === "resource_metadata" ? "resourceMetadataUrl" : "scope";
		const previous = result[key];
		if (previous && previous !== value) throw new Error(`Conflicting Bearer ${name} values`);
		result[key] = value;
	}
	return result.resourceMetadataUrl || result.scope ? result : undefined;
}

/** Extract only the RFC 9728 resource_metadata URL for compatibility callers. */
export function parseMcpOAuthResourceMetadataChallenge(header: string): string | undefined {
	return parseMcpOAuthChallenge(header)?.resourceMetadataUrl;
}

function displayOAuthUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		return `${url.origin}${url.pathname}`;
	} catch {
		return "(invalid OAuth URL)";
	}
}

function protectedResourceCandidates(url: URL): string[] {
	const path = url.pathname === "/" ? "" : url.pathname;
	return [
		...new Set([
			`${url.origin}/.well-known/oauth-protected-resource${path}${url.search}`,
			`${url.origin}/.well-known/oauth-protected-resource`,
		]),
	];
}

function authorizationServerCandidates(issuer: string): string[] {
	const parsed = new URL(issuer);
	if (parsed.search || parsed.hash) throw new Error(`OAuth issuer must not contain a query or fragment: ${issuer}`);
	const path = parsed.pathname === "/" ? "" : parsed.pathname;
	const candidates = [
		`${parsed.origin}/.well-known/oauth-authorization-server${path}`,
		`${parsed.origin}/.well-known/openid-configuration${path}`,
	];
	if (path) {
		candidates.push(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
	}
	return [...new Set(candidates)];
}

function isAuthServerMetadata(value: unknown): value is AuthServerMetadata {
	if (!value || typeof value !== "object") return false;
	const metadata = value as Partial<AuthServerMetadata>;
	return typeof metadata.authorization_endpoint === "string" && typeof metadata.token_endpoint === "string";
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > 128 ||
		value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 2048)
	) {
		throw new Error(`Invalid OAuth metadata ${field}`);
	}
	return value.length > 0 ? [...new Set(value)] : undefined;
}

async function validateAuthorizationServerMetadata(
	metadata: AuthServerMetadata,
	issuer: string,
	policy: OAuthFetchPolicy,
): Promise<void> {
	if (metadata.issuer !== issuer) {
		throw new Error(`OAuth metadata issuer mismatch (expected ${issuer}, received ${String(metadata.issuer)})`);
	}
	const methods = metadata.code_challenge_methods_supported;
	if (!Array.isArray(methods) || !methods.includes("S256")) {
		throw new Error("OAuth authorization server does not advertise required PKCE S256 support");
	}
	const issuerOrigin = new URL(issuer).origin;
	const endpoints = [metadata.authorization_endpoint, metadata.token_endpoint];
	if (metadata.registration_endpoint !== undefined) {
		if (typeof metadata.registration_endpoint !== "string") throw new Error("Invalid OAuth registration_endpoint");
		endpoints.push(metadata.registration_endpoint);
	}
	for (const endpoint of endpoints) {
		const validated = await validateOAuthNetworkUrl(endpoint, policy);
		if (validated.origin !== issuerOrigin) {
			throw new Error("OAuth endpoints must share the validated issuer origin");
		}
	}
}

async function discoverAuthorizationServer(
	issuer: string,
	attempts: string[],
	errors: string[],
	policy: OAuthFetchPolicy,
): Promise<AuthServerMetadata | undefined> {
	await validateOAuthNetworkUrl(issuer, policy);
	for (const candidate of authorizationServerCandidates(issuer)) {
		attempts.push(displayOAuthUrl(candidate));
		try {
			const metadata = await safeFetchJson(candidate, undefined, policy);
			if (!isAuthServerMetadata(metadata)) {
				errors.push(`${displayOAuthUrl(candidate)}: missing authorization_endpoint or token_endpoint`);
				continue;
			}
			await validateAuthorizationServerMetadata(metadata, issuer, policy);
			return metadata;
		} catch (error) {
			errors.push(String(error));
		}
	}
	return undefined;
}

/** Follow RFC 9728 resource metadata, then fall back to co-located AS discovery. */
async function discover(
	url: string,
	resourcePolicy: OAuthFetchPolicy,
	oauthPolicy: OAuthFetchPolicy,
	authorizationChallenge?: string,
): Promise<OAuthDiscovery> {
	const resourceUrl = new URL(url);
	resourceUrl.hash = "";
	const resourceIdentifier = resourceUrl.toString();
	const attempts: string[] = [];
	const errors: string[] = [];
	let sawAdvertisedIssuers = false;
	let challenge: McpOAuthChallenge | undefined;
	if (authorizationChallenge !== undefined) {
		try {
			challenge = parseMcpOAuthChallenge(authorizationChallenge);
			if (challenge?.resourceMetadataUrl) new URL(challenge.resourceMetadataUrl);
		} catch (cause) {
			throw new Error("Supplied MCP OAuth authorization challenge was invalid", { cause });
		}
		if (!challenge?.resourceMetadataUrl) {
			throw new Error("Supplied MCP OAuth authorization challenge omitted Bearer resource_metadata");
		}
	}
	if (authorizationChallenge === undefined) {
		try {
			const probe = await probeMcpOAuthChallenge(resourceIdentifier, resourcePolicy);
			if (probe.challenged) {
				if (!probe.header) throw new Error("MCP OAuth challenge omitted WWW-Authenticate");
				try {
					challenge = parseMcpOAuthChallenge(probe.header);
				} catch (cause) {
					throw new Error("MCP OAuth challenge was invalid", { cause });
				}
				if (!challenge?.resourceMetadataUrl) {
					throw new Error("MCP OAuth 401 did not advertise Bearer resource_metadata");
				}
			}
		} catch (error) {
			// A syntactically valid 401 is authoritative; transport failures and
			// non-MCP endpoints may still use RFC 9728 well-known discovery.
			if (error instanceof Error && /MCP OAuth (challenge|401)/.test(error.message)) throw error;
		}
	}
	// An actual RFC 9728 challenge is authoritative. Never downgrade to a
	// synthesized well-known location if its supplied metadata URL fails.
	const resourceCandidates = challenge?.resourceMetadataUrl
		? [challenge.resourceMetadataUrl]
		: protectedResourceCandidates(resourceUrl);

	for (const candidate of resourceCandidates) {
		attempts.push(displayOAuthUrl(candidate));
		let resource: ProtectedResourceMetadata;
		try {
			resource = (await safeFetchJson(candidate, undefined, resourcePolicy)) as ProtectedResourceMetadata;
		} catch (error) {
			if (challenge?.resourceMetadataUrl) {
				throw new Error("Challenged OAuth resource metadata could not be fetched or validated", { cause: error });
			}
			errors.push(String(error));
			continue;
		}
		if (resource?.resource !== resourceIdentifier) {
			throw new Error(
				`${displayOAuthUrl(candidate)}: resource mismatch (expected ${resourceIdentifier}, received ${String(resource?.resource)})`,
			);
		}
		const issuers = optionalStringArray(resource.authorization_servers, "authorization_servers")?.slice(0, 10) ?? [];
		if (issuers.length === 0) {
			if (challenge?.resourceMetadataUrl) {
				throw new Error("Challenged OAuth resource metadata omitted authorization_servers");
			}
			errors.push(`${displayOAuthUrl(candidate)}: missing authorization_servers`);
			continue;
		}
		sawAdvertisedIssuers = true;
		const resourceScopes = optionalStringArray(resource.scopes_supported, "scopes_supported");
		for (const issuer of [...new Set(issuers)]) {
			try {
				const metadata = await discoverAuthorizationServer(issuer, attempts, errors, oauthPolicy);
				if (metadata) {
					return {
						metadata,
						resource: resourceIdentifier,
						resourceScopes,
						challengedScope: challenge?.scope,
					};
				}
			} catch (error) {
				errors.push(`${displayOAuthUrl(issuer)}: ${String(error)}`);
			}
		}
	}

	if (sawAdvertisedIssuers) {
		throw new Error(
			`Could not discover OAuth metadata for ${resourceUrl.origin}. ` +
				`Tried ${attempts.join(", ")}. Errors: ${errors.join("; ")}`,
		);
	}

	const colocated = await discoverAuthorizationServer(resourceUrl.origin, attempts, errors, oauthPolicy);
	if (colocated) return { metadata: colocated, resource: resourceIdentifier };

	throw new Error(
		`Could not discover OAuth metadata for ${resourceUrl.origin}. ` +
			`Tried ${attempts.join(", ")}. Errors: ${errors.join("; ")}`,
	);
}

/** Dynamic client registration (RFC 7591). Returns the issued client_id. */
async function registerClient(registrationEndpoint: string, label: string, policy: OAuthFetchPolicy): Promise<string> {
	const body = {
		client_name: label,
		redirect_uris: ALL_REDIRECT_URIS,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	const data = (await safeFetchJson(
		registrationEndpoint,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		policy,
	)) as { client_id?: string };
	if (typeof data.client_id !== "string" || data.client_id.length === 0 || data.client_id.length > 4096) {
		throw new Error(
			`Dynamic client registration at ${displayOAuthUrl(registrationEndpoint)} returned no valid client_id`,
		);
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

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

async function exchangeToken(
	tokenEndpoint: string,
	params: Record<string, string>,
	policy: OAuthFetchPolicy,
): Promise<TokenResponse> {
	const data = await safeFetchJson(
		tokenEndpoint,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params).toString(),
		},
		policy,
	);
	if (!data || typeof data !== "object" || typeof (data as Partial<TokenResponse>).access_token !== "string") {
		throw new Error("OAuth token endpoint returned an invalid token response");
	}
	const token = data as TokenResponse;
	if (token.refresh_token !== undefined && typeof token.refresh_token !== "string") {
		throw new Error("OAuth token endpoint returned an invalid refresh_token");
	}
	if (token.expires_in !== undefined && (!Number.isFinite(token.expires_in) || token.expires_in <= 0)) {
		throw new Error("OAuth token endpoint returned an invalid expires_in");
	}
	return token;
}

function toCredentials(
	token: TokenResponse,
	tokenEndpoint: string,
	clientId: string,
	issuer: string,
	resource: string,
	previousRefresh?: string,
): McpCredentials {
	return {
		access: token.access_token,
		// Some servers omit refresh_token on refresh; keep the prior one.
		refresh: token.refresh_token ?? previousRefresh ?? "",
		expires: token.expires_in
			? Date.now() + token.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS
			: Date.now() + 3600 * 1000 - TOKEN_EXPIRY_BUFFER_MS,
		tokenEndpoint,
		clientId,
		issuer,
		resource,
	};
}

/** Build a provider for one MCP server. Register it with registerOAuthProvider(). */
export function createMcpOAuthProvider(config: McpOAuthConfig): OAuthProviderInterface {
	const label = config.label ?? config.server;
	const nat64Prefixes = config.nat64Prefixes ? [...config.nat64Prefixes] : undefined;
	const nat64CacheKey = {};
	const resourcePolicy: OAuthFetchPolicy = { ...createOAuthFetchPolicy(config.url), nat64Prefixes, nat64CacheKey };
	const oauthPolicy: OAuthFetchPolicy = { nat64Prefixes, nat64CacheKey };

	async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const discovery = await discover(config.url, resourcePolicy, oauthPolicy, config.authorizationChallenge);
		const meta = discovery.metadata;
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
			clientId = await registerClient(meta.registration_endpoint, `Prime Agent (${label})`, oauthPolicy);
		}

		const { verifier, challenge } = await generatePKCE();
		// `state` must be independent of the PKCE verifier — the verifier is the
		// secret used at token exchange, while `state` is echoed on the redirect URL.
		const state = randomState();
		const scope = discovery.challengedScope ?? config.scopes ?? discovery.resourceScopes?.join(" ");
		const cb = await startCallbackServer(label);
		try {
			const authorizationUrl = new URL(meta.authorization_endpoint);
			for (const [name, value] of Object.entries({
				client_id: clientId,
				response_type: "code",
				redirect_uri: cb.redirectUri,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
				resource: discovery.resource,
			})) {
				authorizationUrl.searchParams.set(name, value);
			}
			if (scope) authorizationUrl.searchParams.set("scope", scope);

			callbacks.onAuth({
				url: authorizationUrl.toString(),
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
			const token = await exchangeToken(
				meta.token_endpoint,
				{
					grant_type: "authorization_code",
					code: result.code,
					redirect_uri: cb.redirectUri,
					client_id: clientId,
					code_verifier: verifier,
					resource: discovery.resource,
				},
				oauthPolicy,
			);
			return toCredentials(token, meta.token_endpoint, clientId, meta.issuer!, discovery.resource);
		} finally {
			cb.server.close();
		}
	}

	async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as McpCredentials;
		if (!creds.refresh) {
			throw new Error(`No refresh token stored for ${label}; re-run /mcp login ${config.server}`);
		}
		if (!creds.resource || !creds.issuer || !creds.tokenEndpoint) {
			throw new Error(`OAuth credential binding is missing for ${label}; re-run /mcp login ${config.server}`);
		}
		const discovery = await discover(config.url, resourcePolicy, oauthPolicy, config.authorizationChallenge);
		const meta = discovery.metadata;
		if (creds.resource && creds.resource !== discovery.resource) {
			throw new Error(`OAuth resource changed for ${label}; re-run /mcp login ${config.server}`);
		}
		if (creds.issuer && creds.issuer !== meta.issuer) {
			throw new Error(`OAuth issuer changed for ${label}; re-run /mcp login ${config.server}`);
		}
		if (creds.tokenEndpoint && creds.tokenEndpoint !== meta.token_endpoint) {
			throw new Error(`OAuth token endpoint changed for ${label}; re-run /mcp login ${config.server}`);
		}
		const clientId = creds.clientId ?? config.clientId;
		const token = await exchangeToken(
			meta.token_endpoint,
			{
				grant_type: "refresh_token",
				refresh_token: creds.refresh,
				resource: discovery.resource,
				...(clientId ? { client_id: clientId } : {}),
			},
			oauthPolicy,
		);
		return toCredentials(token, meta.token_endpoint, clientId ?? "", meta.issuer!, discovery.resource, creds.refresh);
	}

	return {
		id: `mcp:${config.server}`,
		name: label,
		usesCallbackServer: true,
		login,
		refreshToken,
		getApiKey: (credentials) => credentials.access,
	};
}
