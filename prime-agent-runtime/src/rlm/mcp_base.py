"""Base class for MCP-client integrations exposed in the RLM kernel.

An integration is a Python skill package that subclasses :class:`McpIntegration`,
declares the MCP ``server`` it targets, and is imported in the kernel like any
other skill. Tools are auto-discovered from the server and bound as async
methods, so the agent writes ordinary Python:

    import linear
    issues = await linear.list_issues(team="Engineering")

OAuth credentials and transport remain host-only. The kernel issues typed requests
only; it does not import an MCP SDK or construct an HTTP connection.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from . import host_request

__all__ = ["McpIntegration", "McpToolError", "NotEnabled"]

# Stored access tokens are treated as expired this many seconds early so a token
# never dies mid-request. Mirrors the host's refresh buffer.
_EXPIRY_SKEW_SECONDS = 30


class NotEnabled(RuntimeError):
    """Raised when an integration has no usable credentials.

    The integration is installed but not logged in. The message tells the agent
    how to enable it so it can relay that to the user rather than retrying.
    """

    def __init__(self, server: str):
        self.server = server
        super().__init__(
            f"The '{server}' integration is not enabled: no credentials found. "
            f"Tell the user to run `/mcp login {server}` in Prime Agent to connect it. "
            f"Do not ask them to set environment variables."
        )


class McpToolError(RuntimeError):
    """Raised when an MCP tool call returns a result flagged as an error."""



class McpIntegration:
    """Subclass and set :attr:`server` (for the host-owned remote endpoint).

    Tools are discovered on first use and bound as async methods via
    ``__getattr__``; ``await self.call_tool(name, args)`` is the explicit escape
    hatch and the hook for hand-written typed wrappers.
    """

    #: Integration key used solely for host configuration lookups.
    server: str = ""


    def __init__(self) -> None:
        if not self.server:
            raise ValueError(f"{type(self).__name__} must set a non-empty `server`")
        self._tools: dict[str, Any] | None = None
        self._lock = asyncio.Lock()

    # -- host-owned transport ---------------------------------------------

    async def _request(self, method: str, params: Any = None) -> Any:
        """Perform one typed MCP request through the host.

        The kernel never opens an MCP transport or reads auth metadata.  This
        intentionally keeps both anonymous and OAuth traffic on one host path.
        """
        if not isinstance(method, str) or not method:
            raise TypeError("method must be a non-empty str")
        reply = await host_request(
            "mcp.request", {"server": self.server, "method": method, "params": params}
        )
        if not isinstance(reply, dict) or "result" not in reply:
            raise RuntimeError("mcp.request returned an invalid response")
        return reply["result"]

    async def _resolve_token(self) -> str:
        """OAuth bearer material is host-only and cannot be resolved in Python."""
        raise NotEnabled(self.server)

    # -- tools --------------------------------------------------------------

    async def list_tools(self) -> list[dict[str, Any]]:
        """Return server tools as ``[{name, description, inputSchema}]``."""
        await self._ensure_tools()
        return [dict(t) for t in (self._tools or {}).values()]

    async def _ensure_tools(self) -> None:
        if self._tools is not None:
            return
        async with self._lock:
            if self._tools is not None:
                return
            response = await self._request("tools/list", {})
            if not isinstance(response, dict) or not isinstance(response.get("tools"), list):
                raise RuntimeError("MCP tools/list returned an invalid result")
            tools: dict[str, dict[str, Any]] = {}
            for tool in response["tools"]:
                if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                    raise RuntimeError("MCP tools/list returned an invalid tool")
                tools[tool["name"]] = {
                    "name": tool["name"],
                    "description": tool.get("description") if isinstance(tool.get("description"), str) else "",
                    "inputSchema": tool.get("inputSchema") if isinstance(tool.get("inputSchema"), dict) else {},
                }
            self._tools = tools

    async def call_tool(self, tool: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call one tool through the host and normalize its JSON-RPC result."""
        if not isinstance(tool, str) or not tool:
            raise TypeError("tool must be a non-empty str")
        if arguments is not None and not isinstance(arguments, dict):
            raise TypeError("arguments must be a dict or None")
        return _parse_host_result(await self._request("tools/call", {"name": tool, "arguments": arguments or {}}))

    def __getattr__(self, name: str):
        # Only reached for names not found normally; bind as an async tool call.
        if name.startswith("_"):
            raise AttributeError(name)

        async def _call(**kwargs: Any) -> Any:
            await self._ensure_tools()
            if self._tools is not None and name not in self._tools:
                available = ", ".join(sorted(self._tools)) or "(none)"
                raise AttributeError(
                    f"'{self.server}' has no tool '{name}'. Available: {available}"
                )
            return await self.call_tool(name, kwargs)

        _call.__name__ = name
        _call.__qualname__ = f"{type(self).__name__}.{name}"
        if self._tools and name in self._tools:
            schema = self._tools[name].get("inputSchema") or {}
            desc = self._tools[name].get("description") or ""
            _call.__doc__ = f"{desc}\n\nArguments (JSON Schema):\n{json.dumps(schema, indent=2)}"
        return _call


def _parse_host_result(result: Any) -> Any:
    """Normalize the JSON shape returned by host-owned MCP transport."""
    if not isinstance(result, dict):
        return result
    content = result.get("content")
    texts = [block.get("text") for block in content if isinstance(block, dict) and isinstance(block.get("text"), str)] if isinstance(content, list) else []
    if result.get("isError") is True:
        raise McpToolError("\n".join(texts) or "MCP tool returned an error")
    if "structuredContent" in result and result["structuredContent"] is not None:
        return result["structuredContent"]
    if texts:
        return "\n".join(texts)
    return content if content is not None else result


def _parse_result(result: Any) -> Any:
    """Normalize a CallToolResult into plain Python (structured output preferred).

    Raises McpToolError when the server flags the result as an error, so a failed
    tool call doesn't look like a successful one to the caller.
    """
    texts: list[str] = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text is not None:
            texts.append(text)
    if getattr(result, "isError", False):
        raise McpToolError("\n".join(texts) or "MCP tool returned an error")

    structured = getattr(result, "structuredContent", None)
    if structured is not None:  # falsy-but-valid payloads ({} / []) are real results
        return structured
    if texts:
        return "\n".join(texts)

    # Non-text content (images, embedded resources): return them as plain dicts
    # rather than the opaque SDK object so callers get usable data.
    blocks = getattr(result, "content", None) or []
    if blocks:
        return [b.model_dump(mode="json") if hasattr(b, "model_dump") else b for b in blocks]
    return result
