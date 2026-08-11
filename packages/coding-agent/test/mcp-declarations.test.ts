import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addMcpDeclaration,
	emptyMcpDeclarationDocument,
	parseMcpDeclarationDocument,
} from "../src/core/mcp/mcp-declarations.js";
import { executeMcpDeclarationCommand, parseMcpDeclarationCommand } from "../src/core/mcp/mcp-declaration-command.js";
import {
	admitProjectMcpDeclarations,
	resolveProjectMcpDeclarations,
} from "../src/core/mcp/mcp-project-trust.js";
import { redactMcpValue } from "../src/core/mcp/mcp-redaction.js";
import { createMcpProjectTrustAuthority } from "../src/core/index.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const projectDocument = {
	version: 1 as const,
	servers: { catalog: { name: "catalog", url: "https://catalog.test/mcp", enabled: true } },
};

function fixture(): { directory: string; authority: McpProjectTrustAuthority; dispose(): void } {
	const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "m01-project-")));
	return {
		directory,
		authority: createMcpProjectTrustAuthority({ revision: "test-policy", allowedProjectDirectories: [directory] }),
		dispose: () => rmSync(directory, { recursive: true, force: true }),
	};
}

describe("M01 declarative MCP contract", () => {
	it("accepts only canonical credential-free declarations", () => {
		const document = addMcpDeclaration(emptyMcpDeclarationDocument(), "public-docs", "HTTPS://Example.test:443/mcp");
		expect(document).toEqual({ version: 1, servers: { "public-docs": { name: "public-docs", url: "https://example.test/mcp", enabled: true } } });
		for (const url of ["https://user:secret@example.test/mcp", "https://example.test/mcp?token=secret", "https://example.test/mcp#token", "file:///tmp/mcp"]) {
			expect(() => addMcpDeclaration(emptyMcpDeclarationDocument(), "safe", url)).toThrow();
		}
		expect(() => parseMcpDeclarationDocument({ version: 1, servers: { x: { name: "x", url: "https://x.test", enabled: true, headers: {} } } })).toThrow();
	});

	it("parses non-starting command routing without touching settings or a runtime", () => {
		expect(parseMcpDeclarationCommand(["add", "catalog", "https://catalog.test/mcp"])).toEqual({ kind: "add", scope: "user", name: "catalog", url: "https://catalog.test/mcp" });
		expect(parseMcpDeclarationCommand(["preview", "catalog", "--project"])).toEqual({ kind: "preview", scope: "project", name: "catalog" });
	});

	it("keeps user scope unchanged and routes a test only through an explicitly injected local transport", async () => {
		const settings = SettingsManager.inMemory({ mcpDeclarations: projectDocument });
		const command = parseMcpDeclarationCommand(["test", "catalog"]);
		await expect(executeMcpDeclarationCommand(command, settings)).rejects.toThrow("unavailable");
		const methods: string[] = [];
		await expect(executeMcpDeclarationCommand(command, settings, undefined, { probeTransport: { async open() { return { request: async ({ method }) => void methods.push(method), close: () => undefined }; } } })).resolves.toEqual({ initialized: true, toolsListed: true });
		expect(methods).toEqual(["initialize", "tools/list"]);
	});

	it("makes exactly one raw-path authorization at admission and validates an opaque Core binding for project reads", () => {
		const f = fixture();
		try {
			// The actual Core authority returns a single opaque binding at admission.
			// Subsequent uses only receive that binding; they have no raw path to reauthorize.
			const admission = admitProjectMcpDeclarations(f.directory, f.authority);
			expect(admission).toBeDefined();
			expect(resolveProjectMcpDeclarations(projectDocument, admission)).toEqual({ document: projectDocument, effective: true });
			expect(resolveProjectMcpDeclarations(projectDocument, admission)).toEqual({ document: projectDocument, effective: true });
		} finally { f.dispose(); }
	});

	it("denies missing, forged, stale, and foreign bindings before project reads, writes, or probe opens", async () => {
		const f = fixture();
		const other = fixture();
		try {
			const settings = SettingsManager.inMemory();
			const list = parseMcpDeclarationCommand(["list", "--project"]);
			const add = parseMcpDeclarationCommand(["add", "new", "https://new.test/mcp", "--project"]);
			const test = parseMcpDeclarationCommand(["test", "new", "--project"]);
			const granted = admitProjectMcpDeclarations(f.directory, f.authority)!;
			const foreignBinding = admitProjectMcpDeclarations(other.directory, other.authority)!.binding;
			const forged = { ...granted, binding: {} as never };
			// Keep the original authority and substitute another authority's grant:
			// Core rejects this foreign opaque binding.
			const foreign = { ...granted, binding: foreignBinding };
			for (const admission of [undefined, forged, foreign]) {
				await expect(executeMcpDeclarationCommand(list, settings, admission)).rejects.toThrow("Project MCP declarations are unavailable.");
				await expect(executeMcpDeclarationCommand(add, settings, admission)).rejects.toThrow("Project MCP declarations are unavailable.");
				let opens = 0;
				await expect(executeMcpDeclarationCommand(test, settings, admission, { probeTransport: { async open() { opens++; throw new Error("must not open"); } } })).rejects.toThrow("Project MCP declarations are unavailable.");
				expect(opens).toBe(0);
			}
			// A binding becomes stale once its bound directory no longer exists.
			rmSync(f.directory, { recursive: true, force: true });
			await expect(executeMcpDeclarationCommand(list, settings, granted)).rejects.toThrow("Project MCP declarations are unavailable.");
		} finally { f.dispose(); other.dispose(); }
	});

	it("opens a project test probe only after a validated Core grant", async () => {
		const f = fixture();
		try {
			const admission = admitProjectMcpDeclarations(f.directory, f.authority)!;
			const settings = SettingsManager.inMemory();
			await executeMcpDeclarationCommand(parseMcpDeclarationCommand(["add", "catalog", "https://catalog.test/mcp", "--project"]), settings, admission);
			const calls: string[] = [];
			await expect(executeMcpDeclarationCommand(parseMcpDeclarationCommand(["test", "catalog", "--project"]), settings, admission, { probeTransport: { async open() { calls.push("open"); return { async request({ method }) { calls.push(method); }, close() {} }; } } })).resolves.toEqual({ initialized: true, toolsListed: true });
			expect(calls).toEqual(["open", "initialize", "tools/list"]);
		} finally { f.dispose(); }
	});

	it("redacts credential-shaped fields and unsafe URLs before public rendering", () => {
		const redacted = redactMcpValue({ authorization: "Bearer secret", headers: { "X-Api-Key": "secret" }, nested: { token: "secret" }, url: "https://u:secret@example.test/mcp" });
		expect(redacted).toEqual({ authorization: "<redacted>", headers: "<redacted>", nested: { token: "<redacted>" }, url: "<redacted-url>" });
		expect(JSON.stringify(redacted)).not.toContain("secret");
	});
});
