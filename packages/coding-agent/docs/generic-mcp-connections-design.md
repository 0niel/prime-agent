# Generic MCP Connections: Minimal Design

> Status: proposal for discussion. This document describes implementation work that has not landed.

## Goal

A user adds an arbitrary MCP server in settings and can immediately call it through Prime Agent's existing single IPython surface. Adding a service must not require a custom skill or Python package.

For example, a streamable HTTP server can use an environment-variable reference rather than storing a credential in settings:

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "bearerTokenEnvVar": "GITHUB_TOKEN"
    }
  }
}
```

A local stdio server uses an argv array and tagged environment references. Prime Agent resolves the reference when it starts the process; the secret value is never part of the declaration:

```jsonc
{
  "mcpServers": {
    "local-github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "cwd": "/Users/me/work",
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": { "fromEnv": "GITHUB_TOKEN" }
      }
    }
  }
}
```

Both become available through one pre-imported generic proxy:

```python
tools = await mcp.list_tools("github")
result = await mcp.call_tool("github", "search_repositories", {"query": "prime-agent"})
```

Service and tool names are passed exactly as declared or reported by the server. Authored skills such as `linear` remain useful convenience wrappers, but are optional.

## Minimal architecture

The existing `mcpServers` settings map feeds one session-owned MCP registry and runtime. The registry validates declarations, applies tool filters, and makes servers addressable by their settings key. The runtime owns transport creation, authentication, reusable connections, calls, cancellation, and cleanup.

A single pre-imported Python object named `mcp` is the kernel-facing API. It lists servers and tools and calls a tool by exact service and tool name. It does not generate a package per service or turn MCP tools into top-level model tools. This preserves IPython as Prime Agent's one model-facing execution surface.

The host-to-kernel boundary should pass normalized, redacted connection metadata and a session-scoped runtime handle. Credentials stay in the existing auth or environment resolution path and are resolved only when a transport needs them. MCP tool schemas must be normalized at this boundary, including repairing the common `input_schema` alias to MCP's `inputSchema` form before exposing tools to Python.

Upstream Pi deliberately has no built-in MCP support, so this runtime and proxy are Prime-owned work.

## First implementation scope

The first implementation PR should include:

- Streamable HTTP for anonymous servers and the existing bearer-token and OAuth flows. It should reuse current OAuth behavior rather than redesign it.
- Stdio declarations with `command`, argv-style `args`, `cwd`, and environment references. Literal secret values should not be accepted in the new reference form.
- Reusable connections owned by the session, rather than reconnecting for every tool call.
- `enabledTools` and `disabledTools` filters, applied to both discovery and calls. Disabled servers remain unavailable.
- Separate bounded startup and call timeouts, with cancellation propagated to in-flight MCP work.
- Failure isolation: one server failing to start, list tools, or answer a call must not break other servers or the IPython session.
- Deterministic stdio shutdown: request close, then terminate and kill within bounded deadlines if the child does not exit.
- Redaction of bearer values, resolved environment values, headers, command errors, and transport diagnostics before they reach logs, exceptions, session files, or telemetry.
- Full cleanup on reload, session replacement, cancellation, startup failure, kernel failure, and every normal or abnormal session exit.

Connection state must not be process-global. A session owns its registry, connections, subprocesses, and cleanup. Reloading a declaration should close the replaced connection before the new one becomes active.

## Trust boundary and non-goals

The initial release accepts declarations from user settings only. Project settings are untrusted executable configuration because stdio can launch a process. Project declarations therefore require a later trust UI and policy. ACP-supplied MCP services are also a later source adapter. Both sources should normalize into the same registry and runtime rather than creating separate MCP implementations.

This work is independent of the causal ordering and resident-session lifecycle work in [#1236](https://github.com/PrimeIntellect-ai/prime-agent/pull/1236) and [#1239](https://github.com/PrimeIntellect-ai/prime-agent/pull/1239). The later ACP adapter should build on those lifecycle guarantees, not conflate them with the generic MCP core.

The first implementation does **not** include:

- project trust UI or execution of project declarations;
- an OAuth rewrite or new general-purpose secret manager;
- one generated package per service or tool;
- exposing every MCP tool as a top-level model tool;
- MCP resources or prompts parity;
- the full Codex plugin framework.

## Existing PRs

The current MCP PRs contain useful work, but should not be merged unchanged:

- Salvage transport behavior and focused tests from [#1175](https://github.com/PrimeIntellect-ai/prime-agent/pull/1175) into the generic core implementation.
- Replace [#1378](https://github.com/PrimeIntellect-ai/prime-agent/pull/1378) later with a small ACP declaration adapter after #1236 and #1239. It should feed the shared runtime instead of generating per-tool packages.
- Defer and rebuild the project-trust and probe work in [#1337](https://github.com/PrimeIntellect-ai/prime-agent/pull/1337) and [#1338](https://github.com/PrimeIntellect-ai/prime-agent/pull/1338) on the generic core.
- Close [#644](https://github.com/PrimeIntellect-ai/prime-agent/pull/644) as superseded.

## Acceptance criteria

The generic core is complete when:

1. A user can add anonymous HTTP, authenticated HTTP, or stdio configuration, start a session, and use `mcp.list_tools` and `mcp.call_tool` without installing a service-specific skill.
2. Exact server and tool names and repaired input schemas are visible in Python; filters prevent both listing and calling excluded tools.
3. Multiple calls reuse a session connection. Timeouts and cancellation stop work without damaging other servers or the kernel.
4. Every session and reload path closes HTTP resources and stdio children, including bounded terminate/kill fallback.
5. Tests cover anonymous and authenticated HTTP, stdio argv/cwd/environment references, alias repair, reuse, filters, isolated failures, cancellation, redaction, and cleanup. No resolved secret appears in errors, logs, or persisted session data.

## Delivery order

1. **Generic core PR:** user settings, shared runtime, HTTP and stdio, the `mcp` proxy, lifecycle controls, redaction, and focused tests.
2. **ACP adapter PR:** after #1236/#1239, translate ACP declarations into the same runtime and test session replacement and teardown.
3. **Project and advanced operations:** project trust, advanced auth needs, and user-facing connection diagnostics, each as separately reviewable work.
