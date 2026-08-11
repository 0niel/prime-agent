import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { MCP_OAUTH_SECRET_NAMESPACE, McpOAuthSecretStore, type McpKeychainAdapter } from "../src/core/mcp/mcp-secret-store.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

class MemoryKeychain implements McpKeychainAdapter {
	readonly values = new Map<string, Uint8Array>();
	async create(id: string, value: Uint8Array) { this.values.set(id, Uint8Array.from(value)); }
	async read(id: string) { const value = this.values.get(id); return value && Uint8Array.from(value); }
	async replace(id: string, expected: Uint8Array, value: Uint8Array) { const current = this.values.get(id); if (!current || current.length !== expected.length || current.some((byte, index) => byte !== expected[index])) return false; this.values.set(id, Uint8Array.from(value)); return true; }
	async delete(id: string, expected: Uint8Array) { const current = this.values.get(id); if (!current || current.length !== expected.length || current.some((byte, index) => byte !== expected[index])) return false; this.values.delete(id); return true; }
}

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists MCP OAuth public metadata without credential bytes", () => {
		authStorage.set("mcp:demo", {
			type: "mcp_oauth",
			kind: "opaque",
			secretReference: { version: 1, namespace: "mcp-oauth", id: "a".repeat(43), revision: "b".repeat(43) },
			mcpEndpoint: "https://demo.test/mcp", authServer: "https://auth.demo.test/", clientId: "client", scopes: "tools", tokenEndpoint: "https://auth.demo.test/token", expires: Date.now() + 3600_000,
		});
		const serialized = readFileSync(join(tempDir, "auth.json"), "utf8");
		expect(serialized).toContain('"mcp_oauth"');
		expect(serialized).not.toMatch(/"access"\s*:/);
		expect(serialized).not.toMatch(/"refresh"\s*:/);
	});

	it("disables every built-in integration when no credentials exist", () => {
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");
	});

	it("enables an integration once credentials are stored", () => {
		authStorage.set("mcp:linear", {
			type: "mcp_oauth",
			kind: "opaque",
			secretReference: { version: 1, namespace: "mcp-oauth", id: "a".repeat(43), revision: "b".repeat(43) },
			mcpEndpoint: "https://mcp.linear.app/mcp", authServer: "https://auth.linear.test/", clientId: "client", scopes: "read", tokenEndpoint: "https://auth.linear.test/token",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({ authStorage, secretStore: {} as McpOAuthSecretStore });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).not.toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");

		const status = manager.listStatus().find((s) => s.server === "linear");
		expect(status?.enabled).toBe(true);
	});

	it("registers an OAuth provider per built-in integration", () => {
		new McpManager({ authStorage });
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("keeps MCP providers registered after ModelRegistry.refresh() resets the registry", () => {
		new McpManager({ authStorage });
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.refresh(); // calls resetOAuthProviders(); must re-add MCP providers
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("re-registers user-declared OAuth servers after ModelRegistry.refresh via the reset hook", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.setOnOAuthProvidersReset(() => manager.registerUserProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("exposes typed refresh/request and rejects absent or stale contexts", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.refresh", "mcp.request"]);
		await expect((handlers["mcp.request"] as unknown as (payload: Record<string, unknown>) => Promise<Record<string, unknown>>)({ server: "linear", method: "tools/list" })).rejects.toThrow();
		const stale = { requestId: "r", generation: 1, signal: new AbortController().signal, isCurrent: () => false };
		await expect(handlers["mcp.refresh"]!({ server: "linear" }, stale)).rejects.toThrow("cancelled");
	});

	it("conditionally exposes begin_login with context fencing and no credential output", async () => {
		let called = "";
		const manager = new McpManager({ authStorage, beginLogin: async (server) => { called = server; } });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.begin_login", "mcp.refresh", "mcp.request"]);
		const live = { requestId: "r", generation: 1, signal: new AbortController().signal, isCurrent: () => true };
		await expect(handlers["mcp.begin_login"]!({ server: "linear" }, live)).resolves.toEqual({});
		expect(called).toBe("linear");
	});

	it("has no public configuration or header handler", () => {
		const manager = new McpManager({ authStorage, getUserServers: () => ({ public: { type: "http", url: "https://public.test/mcp", headers: { Authorization: "secret", "X-Extra": "safe" } } }) });
		expect(Object.keys(manager.hostHandlers())).not.toContain("mcp.config");
		expect(JSON.stringify(manager.hostHandlers())).not.toContain("Authorization");
	});

	it("does not treat an oauth override of a catalog name as authed via the official stored cred", () => {
		// Pre-existing official Linear cred from a prior login.
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "official",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp", oauth: true } }),
		});
		// Must NOT be enabled — else the official token would be sent to the override URL.
		expect(manager.listStatus().find((s) => s.server === "linear")?.enabled).toBe(false);
	});

	it("does not accept bearer-token environment variables as MCP credentials", () => {
		process.env.MY_MCP_TOKEN = "secret";
		try {
			const manager = new McpManager({ authStorage, getUserServers: () => ({ custom: { type: "http", url: "https://example.test/mcp", bearerTokenEnvVar: "MY_MCP_TOKEN" } }) });
			expect(manager.listStatus().find((item) => item.server === "custom")?.enabled).toBe(false);
		} finally { delete process.env.MY_MCP_TOKEN; }
	});

	it("picks up mcpServers added after construction on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeUndefined();

		servers = { acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } };
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("drops the built-in provider when a catalog name is overridden without oauth", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp" } }),
		});
		void manager;
		// Built-in linear provider must be gone so we don't send the official token to the override URL.
		expect(getOAuthProvider("mcp:linear")).toBeUndefined();
	});

	it("unregisters a user server's OAuth provider when it's removed on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {
			acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true },
		};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(getOAuthProvider("mcp:acme")).toBeDefined();

		servers = {};
		manager.refresh();
		expect(getOAuthProvider("mcp:acme")).toBeUndefined();
	});
	it("force-refreshes expired opaque credentials, persists the rotated reference, and returns only a host token", async () => {
		const store = new McpOAuthSecretStore(new MemoryKeychain());
		const binding = { mcpEndpoint: "https://mcp.linear.app/mcp", authServer: "https://auth.linear.test/", tokenEndpoint: "https://auth.linear.test/token", clientId: "client", scopes: "read" };
		const oldReference = await store.put(MCP_OAUTH_SECRET_NAMESPACE, new TextEncoder().encode(JSON.stringify({ access: "old", refresh: "old-refresh", binding })));
		authStorage.set("mcp:linear", { type: "mcp_oauth", kind: "opaque", secretReference: oldReference, ...binding, expires: Date.now() - 1 });
		let refreshCalls = 0;
		const manager = new McpManager({ authStorage, secretStore: store });
		registerOAuthProvider({
			id: "mcp:linear", name: "Linear", login: async () => { throw new Error("unused"); }, getApiKey: () => { throw new Error("must not use generic api key"); },
			refreshToken: async () => {
				refreshCalls += 1;
				const reference = await store.put(MCP_OAUTH_SECRET_NAMESPACE, new TextEncoder().encode(JSON.stringify({ access: "rotated-access", refresh: "old-refresh", binding })));
				return { kind: "opaque", secretReference: reference, ...binding, expires: Date.now() + 60_000 };
			},
		});
		await expect(manager.withOAuthAccessToken("linear", async (token) => token)).resolves.toBe("rotated-access");
		expect(refreshCalls).toBe(1);
		const rotated = authStorage.get("mcp:linear");
		expect(rotated).toMatchObject({ type: "mcp_oauth", kind: "opaque" });
		expect((rotated as { secretReference: { revision: string } }).secretReference.revision).not.toBe(oldReference.revision);
	});

});
