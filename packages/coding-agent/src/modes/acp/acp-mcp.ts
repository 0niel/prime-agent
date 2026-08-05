import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../../core/agent-session.js";

type AcpMcpServerConfig =
	| { type: "http"; url: string; headers: Record<string, string> }
	| { type: "stdio"; command: string; args: string[]; env: Record<string, string> };

function resolveServers(servers: readonly McpServer[]): Record<string, AcpMcpServerConfig> {
	const resolved = Object.create(null) as Record<string, AcpMcpServerConfig>;
	for (const server of servers) {
		if (Object.hasOwn(resolved, server.name)) {
			throw RequestError.invalidParams({ reason: `duplicate MCP server name: ${server.name}` });
		}
		if (!server.name) {
			throw RequestError.invalidParams({ reason: "MCP server names must not be empty" });
		}
		if ("command" in server) {
			if (!server.command) {
				throw RequestError.invalidParams({ reason: `MCP server ${server.name} has no stdio command` });
			}
			resolved[server.name] = {
				type: "stdio",
				command: server.command,
				args: [...server.args],
				env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
			};
			continue;
		}
		if (server.type === "http") {
			if (!server.url) {
				throw RequestError.invalidParams({ reason: `MCP server ${server.name} has no HTTP URL` });
			}
			resolved[server.name] = {
				type: "http",
				url: server.url,
				headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
			};
			continue;
		}
		throw RequestError.invalidParams({
			reason: `MCP server ${server.name} uses unsupported ${server.type} transport`,
		});
	}
	return resolved;
}

function pythonModule(config: Record<string, AcpMcpServerConfig>): string {
	const encoded = JSON.stringify(JSON.stringify(config));
	return `"""MCP servers supplied by the ACP client for this session."""

import json

from rlm import AcpMcpIntegration

_CONFIG = json.loads(${encoded})
_SERVERS = {name: AcpMcpIntegration(name, spec) for name, spec in _CONFIG.items()}


def list_servers():
    return sorted(_SERVERS)


def server(name):
    try:
        return _SERVERS[name]
    except KeyError as exc:
        raise KeyError(f"Unknown ACP MCP server {name!r}; available: {list_servers()}") from exc


async def list_tools(name):
    return await server(name).list_tools()


async def call_tool(name, tool, arguments=None):
    return await server(name).call_tool(tool, arguments or {})


def __getattr__(name):
    if name.startswith("_"):
        raise AttributeError(name)
    try:
        return _SERVERS[name]
    except KeyError as exc:
        raise AttributeError(name) from exc
`;
}

function skillMarkdown(names: string[]): string {
	const listed = names.map((name) => JSON.stringify(name)).join(", ");
	const summary = names.map((name) => JSON.stringify(name)).join(", ");
	const description = `Use MCP tools supplied by the ACP client: ${summary}`.slice(0, 1024);
	return `---
name: acp-mcp
description: ${JSON.stringify(description)}
---

# ACP MCP servers

The ACP client supplied these MCP servers for this session: ${listed}.

Use them from IPython through the pre-imported \`acp_mcp\` module:

\`\`\`python
acp_mcp.list_servers()
await acp_mcp.list_tools("server-name")
await acp_mcp.call_tool("server-name", "tool-name", {"argument": "value"})
\`\`\`

When a server name is a valid Python identifier, its tools are also available as
dynamic async methods, for example \`await acp_mcp.github.search(query="ACP")\`.
Call \`list_tools\` before choosing a tool or arguments; do not guess its schema.
`;
}

const PYPROJECT = `[project]
name = "prime-agent-acp-mcp"
version = "0.0.0"
requires-python = ">=3.10"
dependencies = ["mcp>=1.28,<2", "httpx>=0.27,<1"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/acp_mcp"]
`;

export class AcpMcpSkillInstaller {
	private root: string | undefined;

	constructor(private readonly session: AgentSession) {}

	configure(servers: readonly McpServer[]): void {
		if (servers.length === 0) return;
		const config = resolveServers(servers);
		this.root ??= mkdtempSync(join(tmpdir(), "prime-agent-acp-mcp-"));
		const skillDir = join(this.root, "acp-mcp");
		const packageDir = join(skillDir, "src", "acp_mcp");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), skillMarkdown(Object.keys(config)), { encoding: "utf-8", mode: 0o600 });
		writeFileSync(join(skillDir, "pyproject.toml"), PYPROJECT, { encoding: "utf-8", mode: 0o600 });
		writeFileSync(join(packageDir, "__init__.py"), pythonModule(config), { encoding: "utf-8", mode: 0o600 });
		const source = `acp:${createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)}`;
		this.session.extendTemporarySkills([join(skillDir, "SKILL.md")], source);
	}

	dispose(): void {
		if (!this.root) return;
		rmSync(this.root, { recursive: true, force: true });
		this.root = undefined;
	}
}
