// Host side of MCP integrations. The protocol itself runs Python-side in the kernel; the host
// only registers OAuth providers, gates integration skills by auth, and serves mcp.* host-requests.

import {
	BUILTIN_MCP_CATALOG,
	createMcpOAuthProvider,
	getMcpOAuthAccessToken,
	getCatalogEntry,
	registerBuiltinMcpOAuthProviders,
} from "@earendil-works/pi-ai/mcp";
import { getOAuthProvider, registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import { MCP_OAUTH_SECRET_NAMESPACE, type McpOAuthSecretStore, type SecretReference } from "./mcp-secret-store.js";
import type { McpOAuthBinding, McpOAuthSecretPort } from "@earendil-works/pi-ai/mcp";
import type { HostRequestContext, HostRequestHandler } from "../kernel/index.js";
import { McpHostBridge, type McpHostBinding } from "./mcp-host-bridge.js";
import type { McpRuntimeDeclarationSnapshot } from "./mcp-runtime-declaration-snapshot.js";

interface McpOAuthPublicRecord {
	type: "mcp_oauth";
	kind: "opaque";
	secretReference: SecretReference;
	mcpEndpoint: string;
	authServer: string;
	clientId: string;
	scopes: string;
	tokenEndpoint: string;
	expires: number;
}

function canonicalEndpoint(value: string): string | undefined {
	try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.href : undefined; } catch { return undefined; }
}


function isS01Reference(value: unknown): value is SecretReference {
	if (!value || typeof value !== "object") return false;
	const reference = value as Partial<SecretReference>;
	return reference.version === 1 && reference.namespace === MCP_OAUTH_SECRET_NAMESPACE &&
		typeof reference.id === "string" && /^[A-Za-z0-9_-]{43}$/.test(reference.id) &&
		typeof reference.revision === "string" && /^[A-Za-z0-9_-]{43}$/.test(reference.revision);
}

function isBoundMcpOAuth(value: unknown, endpoint: string): value is McpOAuthPublicRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<McpOAuthPublicRecord>;
	const ref = record.secretReference;
	return record.type === "mcp_oauth" && record.kind === "opaque" && record.mcpEndpoint === endpoint && typeof record.authServer === "string" && typeof record.tokenEndpoint === "string" && typeof record.clientId === "string" && typeof record.scopes === "string" && typeof record.expires === "number" && !!ref && ref.version === 1 && ref.namespace === "mcp-oauth" && typeof ref.id === "string" && typeof ref.revision === "string";
}

function isCanonicalBinding(value: McpOAuthBinding): boolean {
	return canonicalEndpoint(value.mcpEndpoint) === value.mcpEndpoint &&
		canonicalEndpoint(value.authServer) === value.authServer &&
		canonicalEndpoint(value.tokenEndpoint) === value.tokenEndpoint &&
		typeof value.clientId === "string" && value.clientId.length > 0 && typeof value.scopes === "string";
}

function toOpaqueCredential(value: unknown, expectedEndpoint: string): McpOAuthPublicRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<McpOAuthPublicRecord>;
	if (candidate.kind !== "opaque" || candidate.mcpEndpoint !== expectedEndpoint || !isS01Reference(candidate.secretReference)) return undefined;
	if (typeof candidate.authServer !== "string" || typeof candidate.tokenEndpoint !== "string" || typeof candidate.clientId !== "string" || typeof candidate.scopes !== "string" || typeof candidate.expires !== "number") return undefined;
	const record: McpOAuthPublicRecord = { type: "mcp_oauth", kind: "opaque", secretReference: candidate.secretReference, mcpEndpoint: candidate.mcpEndpoint, authServer: candidate.authServer, tokenEndpoint: candidate.tokenEndpoint, clientId: candidate.clientId, scopes: candidate.scopes, expires: candidate.expires };
	return isBoundMcpOAuth(record, expectedEndpoint) && isCanonicalBinding({ mcpEndpoint: record.mcpEndpoint, authServer: record.authServer, tokenEndpoint: record.tokenEndpoint, clientId: record.clientId, scopes: record.scopes }) ? record : undefined;
}

/** The only bridge from AI OAuth to Core S01. AI receives opaque unknown handles. */
function createS01SecretPort(store: McpOAuthSecretStore): McpOAuthSecretPort {
	return {
		put: (value) => store.put(MCP_OAUTH_SECRET_NAMESPACE, value),
		get: (reference, expected) => {
			if (!isS01Reference(reference) || !isCanonicalBinding(expected)) return Promise.resolve(undefined);
			return store.get(reference);
		},
		replace: (reference, value) => {
			if (!isS01Reference(reference)) return Promise.reject(new Error("MCP OAuth secret reference is invalid."));
			return store.replace(reference, reference.revision, value);
		},
		delete: (reference) => {
			if (!isS01Reference(reference)) return Promise.reject(new Error("MCP OAuth secret reference is invalid."));
			return store.delete(reference, reference.revision);
		},
	};
}



export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
	/** Core S01 store; absent is an explicit unavailable OAuth state. */
	secretStore?: McpOAuthSecretStore;
	/** Immutable Core admission snapshot. Its records are the only declaration inputs consumed here. */
	runtimeDeclarationSnapshot?: McpRuntimeDeclarationSnapshot;
}

/** A resolved integration: a catalog/user entry plus its provider id. */
interface ResolvedIntegration {
	server: string;
	label: string;
	url: string;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	enabled?: boolean;
	/** True when this came from Settings.mcpServers (may override a catalog name). */
	userDeclared?: boolean;
}

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private readonly secretStore?: McpOAuthSecretStore;
	private integrations = new Map<string, ResolvedIntegration>();
	/** Provider ids we registered for user servers, so refresh can drop removed ones. */
	private registeredUserProviderIds = new Set<string>();
	private readonly hostBridge: McpHostBridge;
	private readonly runtimeDeclarationSnapshot?: McpRuntimeDeclarationSnapshot;
	/** Allows an authenticated close to use the old sealed access token before rotation. */
	private readonly closingCredentialServers = new Set<string>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.secretStore = options.secretStore;
		this.runtimeDeclarationSnapshot = options.runtimeDeclarationSnapshot;
		this.hostBridge = new McpHostBridge({
			withOAuthAccessToken: (server, operation, forceRefresh) => this.withOAuthAccessToken(server, operation, forceRefresh),
			resolveBinding: (binding) => {
				const integration = this.integrations.get(binding.server);
				const endpoint = integration && canonicalEndpoint(integration.url);
				return integration && endpoint === binding.endpoint ? this.bindingFor(binding.server, integration, endpoint) : binding;
			},
			beforeForceRefresh: (binding) => this.hostBridge.closeBinding(binding),
		});
		this.resolveIntegrations();
		this.registerProviders();
	}

	/** Re-read settings and re-register providers; call after a session reload. */
	refresh(): void {
		this.resolveIntegrations();
		this.registerProviders();
	}

	private providerId(server: string): string {
		return `mcp:${server}`;
	}

	private resolveIntegrations(): void {
		const integrations = new Map<string, ResolvedIntegration>();
		for (const entry of BUILTIN_MCP_CATALOG) {
			integrations.set(entry.server, {
				server: entry.server,
				label: entry.label,
				url: entry.url,
				usesOAuth: entry.oauth?.kind === "oauth",
			});
		}
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
			if (config.type !== "http") continue; // stdio servers self-manage in Python
			integrations.set(server, {
				server,
				label: server,
				url: config.url,
				usesOAuth: config.oauth === true,
				bearerTokenEnvVar: config.bearerTokenEnvVar,
				enabled: config.enabled,
								userDeclared: true,
			});
		}
		// M01/Core declarations are already parsed, selected, collision-checked,
		// and frozen. Never reread project settings here: denial/collision has
		// already made that contribution inert before this host is constructed.
		for (const declaration of Object.values(this.runtimeDeclarationSnapshot?.declarations ?? {})) {
			const existing = integrations.get(declaration.name);
			integrations.set(declaration.name, {
				server: declaration.name,
				label: existing?.label ?? declaration.name,
				url: declaration.endpoint,
				// A declaration can replace a catalog endpoint. Never carry OAuth
				// authority across endpoint bindings: a changed URL is anonymous until
				// separately authenticated for that exact endpoint.
				usesOAuth: existing?.usesOAuth === true && canonicalEndpoint(existing.url) === declaration.endpoint,
				enabled: declaration.enabled,
								userDeclared: declaration.source === "user" || existing?.userDeclared,
			});
		}
		this.integrations = integrations;
	}

	private registerProviders(): void {
		registerBuiltinMcpOAuthProviders(this.secretStore ? createS01SecretPort(this.secretStore) : undefined);
		this.registerUserProviders();
	}

	/**
	 * Register OAuth providers for user-declared (non-catalog) servers. Public so it
	 * can run after ModelRegistry.refresh() resets the registry — otherwise custom
	 * `mcp:<server>` providers vanish on every refresh (e.g. post-login).
	 */
	registerUserProviders(): void {
		const current = new Set<string>();
		for (const integration of this.integrations.values()) {
			if (!integration.userDeclared) continue;
			const id = this.providerId(integration.server);
			if (integration.usesOAuth) {
				// Register pointing at the user's URL (overrides a catalog default too).
				current.add(id);
				registerOAuthProvider(
					createMcpOAuthProvider({
						server: integration.server,
						label: integration.label,
						url: integration.url,
					secretStore: this.secretStore ? createS01SecretPort(this.secretStore) : undefined,
					}),
				);
			} else if (getCatalogEntry(integration.server)) {
				// User overrode a catalog server with a custom URL but no oauth: drop the
				// built-in provider so we never send the official token to that URL.
				unregisterOAuthProvider(id);
			}
		}
		// Drop providers for user servers removed since the last registration.
		for (const id of this.registeredUserProviderIds) {
			if (!current.has(id)) unregisterOAuthProvider(id);
		}
		this.registeredUserProviderIds = current;
	}

	/** True when valid credentials exist for the integration (drives enablement). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.enabled === false) return false;
		if (!integration.usesOAuth || !this.secretStore) return false;
		const endpoint = canonicalEndpoint(integration.url);
		return endpoint !== undefined && isBoundMcpOAuth(this.authStorage.get(this.providerId(integration.server)), endpoint);
	}

	/** `-<server>/SKILL.md` overrides for every built-in integration the user isn't logged into. */
	getDisabledBuiltinSkillOverrides(): string[] {
		const overrides: string[] = [];
		for (const entry of BUILTIN_MCP_CATALOG) {
			const integration = this.integrations.get(entry.server);
			if (integration && !this.isAuthed(integration)) {
				overrides.push(`-${entry.server}/SKILL.md`);
			}
		}
		return overrides;
	}

	private async refreshOpaqueRecord(server: string, integration: ResolvedIntegration, current: McpOAuthPublicRecord): Promise<McpOAuthPublicRecord> {
		const endpoint = canonicalEndpoint(integration.url);
		const provider = getOAuthProvider(this.providerId(server));
		if (!endpoint || !provider || !this.secretStore) throw new Error("MCP OAuth credentials are unavailable.");
		this.closingCredentialServers.add(server);
		try { await this.hostBridge.closeBinding(this.bindingFor(server, integration, endpoint)); }
		catch { /* old-session cleanup is non-authoritative; refresh remains authoritative */ }
		finally { this.closingCredentialServers.delete(server); }
		const refreshed = await provider.refreshToken({ kind: "opaque", secretReference: current.secretReference, mcpEndpoint: current.mcpEndpoint, authServer: current.authServer, tokenEndpoint: current.tokenEndpoint, clientId: current.clientId, scopes: current.scopes, expires: current.expires });
		const rotated = toOpaqueCredential(refreshed, endpoint);
		if (!rotated || !this.authStorage.replaceMcpOAuthCredential(this.providerId(server), current.secretReference, rotated)) throw new Error("MCP OAuth credentials changed during refresh.");
		return rotated;
	}

	/** Host-only transient token retrieval. Never expose this through a kernel/RPC handler. */
	async withOAuthAccessToken<T>(server: string, operation: (accessToken: string) => Promise<T>, forceRefresh = false): Promise<T> {
		const integration = this.integrations.get(server);
		const endpoint = integration && canonicalEndpoint(integration.url);
		const stored = this.authStorage.get(this.providerId(server));
		if (!integration || !endpoint || !this.secretStore || !isBoundMcpOAuth(stored, endpoint)) throw new Error("MCP OAuth credentials are unavailable.");
		const record = forceRefresh || (Date.now() >= stored.expires && !this.closingCredentialServers.has(server)) ? await this.refreshOpaqueRecord(server, integration, stored) : stored;
		const expected: McpOAuthBinding = { mcpEndpoint: endpoint, authServer: record.authServer, tokenEndpoint: record.tokenEndpoint, clientId: record.clientId, scopes: record.scopes };
		const accessToken = await getMcpOAuthAccessToken(record, expected, createS01SecretPort(this.secretStore));
		return operation(accessToken);
	}

	private bindingFor(server: string, integration: ResolvedIntegration, endpoint: string): McpHostBinding {
		const credential = this.authStorage.get(this.providerId(server));
		return {
			server, endpoint, oauth: integration.usesOAuth,
			declarationRevision: this.runtimeDeclarationSnapshot?.revision ?? "legacy",
			authRevision: integration.usesOAuth && isBoundMcpOAuth(credential, endpoint) ? credential.secretReference.revision : undefined,
		};
	}

	/** Delete the endpoint-bound Core secret before deleting its public metadata. */
	async logout(server: string): Promise<boolean> {
		const integration = this.integrations.get(server);
		const endpoint = integration && canonicalEndpoint(integration.url);
		const credential = this.authStorage.get(this.providerId(server));
		if (!integration || !endpoint || !isBoundMcpOAuth(credential, endpoint)) return false;
		if (!this.secretStore) throw new Error("MCP OAuth secret storage is unavailable.");
		await this.hostBridge.closeBinding(this.bindingFor(server, integration, endpoint));
		await this.secretStore.delete(credential.secretReference, credential.secretReference.revision);
		this.authStorage.remove(this.providerId(server));
		return true;
	}

	/** Host-request handlers exposed to the kernel. */
	hostHandlers(): Record<string, HostRequestHandler> {
		const requireCurrent = (context: HostRequestContext): void => {
			if (context.signal.aborted || !context.isCurrent()) throw new Error("MCP request was cancelled.");
		};
		const handlers: Record<string, HostRequestHandler> = {
			"mcp.refresh": async (payload, context) => {
				requireCurrent(context);
				const server = typeof payload.server === "string" ? payload.server : "";
				if (!server) throw new Error("mcp.refresh requires a server");
				// Forced access retrieval closes/fences the old binding before rotation;
				// it returns no endpoint or credential material to Python.
				await this.withOAuthAccessToken(server, async () => undefined, true);
				requireCurrent(context);
				return {};
			},
			"mcp.request": async (payload, context) => {
				requireCurrent(context);
				const server = typeof payload.server === "string" ? payload.server : "";
				const method = typeof payload.method === "string" ? payload.method : "";
				if (!server || !method) throw new Error("mcp.request requires server and method");
				const integration = this.integrations.get(server);
				if (!integration || integration.enabled === false) throw new Error("MCP integration is unavailable.");
				const endpoint = canonicalEndpoint(integration.url);
				if (!endpoint) throw new Error("MCP integration endpoint is invalid.");
				if (integration.usesOAuth && !this.isAuthed(integration)) throw new Error("MCP OAuth credentials are unavailable.");
				return { result: await this.hostBridge.request(this.bindingFor(server, integration, endpoint), method, payload.params, context) };
			},
		};
		if (this.beginLogin) {
			handlers["mcp.begin_login"] = async (payload, context) => {
				requireCurrent(context);
				const server = typeof payload.server === "string" ? payload.server : "";
				if (!server) throw new Error("mcp.begin_login requires a server");
				await this.beginLogin!(server);
				requireCurrent(context);
				return {};
			};
		}
		return handlers;
	}

	/** Await host transport close and fence every binding. */
	async dispose(): Promise<void> { await this.hostBridge.dispose(); }

	/** Status for the /mcp list command. */
	listStatus(): Array<{ server: string; label: string; enabled: boolean; usesOAuth: boolean }> {
		return Array.from(this.integrations.values()).map((integration) => ({
			server: integration.server,
			label: integration.label,
			enabled: this.isAuthed(integration),
			usesOAuth: integration.usesOAuth,
		}));
	}
}
