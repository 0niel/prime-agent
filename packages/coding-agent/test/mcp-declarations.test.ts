import { describe, expect, it } from "vitest";
import {
	addMcpDeclaration,
	emptyMcpDeclarationDocument,
	parseMcpDeclarationDocument,
	previewMcpProbe,
} from "../src/core/mcp/mcp-declarations.js";
import { executeMcpDeclarationCommand, parseMcpDeclarationCommand } from "../src/core/mcp/mcp-declaration-command.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { redactMcpValue } from "../src/core/mcp/mcp-redaction.js";
import { resolveProjectMcpDeclarations } from "../src/core/mcp/mcp-project-trust.js";

describe("M01 declarative MCP contract", () => {
	it("accepts only canonical credential-free declarations", () => {
		const document = addMcpDeclaration(emptyMcpDeclarationDocument(), "public-docs", "HTTPS://Example.test:443/mcp");
		expect(document).toEqual({
			version: 1,
			servers: { "public-docs": { name: "public-docs", url: "https://example.test/mcp", enabled: true } },
		});
		for (const url of [
			"https://user:secret@example.test/mcp",
			"https://example.test/mcp?token=secret",
			"https://example.test/mcp#token",
			"file:///tmp/mcp",
		]) {
			expect(() => addMcpDeclaration(emptyMcpDeclarationDocument(), "safe", url)).toThrow();
		}
		expect(() => parseMcpDeclarationDocument({ version: 1, servers: { x: { name: "x", url: "https://x.test", enabled: true, headers: {} } } })).toThrow();
	});

	it("parses non-starting command routing without touching settings or a runtime", () => {
		expect(parseMcpDeclarationCommand(["add", "catalog", "https://catalog.test/mcp"])).toEqual({
			kind: "add",
			scope: "user",
			name: "catalog",
			url: "https://catalog.test/mcp",
		});
		expect(parseMcpDeclarationCommand(["preview", "catalog", "--project"])).toEqual({
			kind: "preview",
			scope: "project",
			name: "catalog",
		});
	});

	it("routes a test only through an explicitly injected local transport", async () => {
		const settings = SettingsManager.inMemory({
			mcpDeclarations: { version: 1, servers: { catalog: { name: "catalog", url: "https://catalog.test/mcp", enabled: true } } },
		});
		const command = parseMcpDeclarationCommand(["test", "catalog"]);
		await expect(executeMcpDeclarationCommand(command, settings, "/project")).rejects.toThrow("unavailable");
		const methods: string[] = [];
		await expect(
			executeMcpDeclarationCommand(command, settings, "/project", undefined, {
				probeTransport: {
					async open() {
						return { request: async ({ method }) => void methods.push(method), close: () => undefined };
					},
				},
			}),
		).resolves.toEqual({ initialized: true, toolsListed: true });
		expect(methods).toEqual(["initialize", "tools/list"]);
	});

	it("fails closed for project declarations without an admitted C05 capability", () => {
		const document = addMcpDeclaration(emptyMcpDeclarationDocument(), "project", "https://project.test/mcp");
		expect(resolveProjectMcpDeclarations("/project", document, undefined)).toEqual({
			document: emptyMcpDeclarationDocument(),
			effective: false,
		});
		expect(resolveProjectMcpDeclarations("/project", document, { allowsProjectMcpDeclarations: () => false })).toMatchObject({
			effective: false,
		});
		expect(resolveProjectMcpDeclarations("/project", document, { allowsProjectMcpDeclarations: (directory) => directory === "/project" })).toEqual({
			document,
			effective: true,
		});
	});

	it("redacts credential-shaped fields and unsafe URLs before public rendering", () => {
		const redacted = redactMcpValue({
			authorization: "Bearer secret",
			headers: { "X-Api-Key": "secret" },
			nested: { token: "secret" },
			url: "https://u:secret@example.test/mcp",
		});
		expect(redacted).toEqual({
			authorization: "<redacted>",
			headers: "<redacted>",
			nested: { token: "<redacted>" },
			url: "<redacted-url>",
		});
		expect(JSON.stringify(redacted)).not.toContain("secret");
	});
});
