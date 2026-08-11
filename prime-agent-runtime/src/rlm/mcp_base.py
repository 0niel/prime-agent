"""Base class for MCP-client integrations exposed in the RLM kernel.

An integration is a Python skill package that subclasses :class:`McpIntegration`,
declares the MCP ``server`` it targets, and is imported in the kernel like any
other skill. Tools are auto-discovered from the server and bound as async
methods, so the agent writes ordinary Python:

    import linear
    issues = await linear.list_issues(team="Engineering")

OAuth credentials remain host-only. M02 deliberately has no kernel token path;
interactive login and typed host transport ownership are host-side.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import AsyncExitStack
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


def _resolve_streamable_http():
    """Return an SDK streamable-HTTP transport callable.

    SDK versions vary: some expose ``streamablehttp_client(url, headers=...)``,
    others ``streamable_http_client(url, *, http_client=...)``, and some expose
    both with *different* signatures. Imported lazily so importing an integration
    package never hard-fails when ``mcp`` is absent.
    """
    from mcp.client import streamable_http as mod  # noqa: PLC0415

    for name in ("streamablehttp_client", "streamable_http_client"):
        fn = getattr(mod, name, None)
        if fn is not None:
            return fn
    raise ImportError(
        "the installed `mcp` SDK exposes no streamable-HTTP client; upgrade `mcp`"
    )


class McpIntegration:
    """Subclass and set :attr:`server` (and :attr:`url` for remote servers).

    Tools are discovered on first use and bound as async methods via
    ``__getattr__``; ``await self.call_tool(name, args)`` is the explicit escape
    hatch and the hook for hand-written typed wrappers.
    """

    #: Integration key used solely for host configuration lookups.
    server: str = ""

    #: Remote MCP endpoint. Required unless a subclass overrides ``_open_streams``.
    url: str | None = None

    def __init__(self) -> None:
        if not self.server:
            raise ValueError(f"{type(self).__name__} must set a non-empty `server`")
        self._tools: dict[str, Any] | None = None
        self._lock = asyncio.Lock()

    # -- credentials --------------------------------------------------------

    @property
    def _provider_id(self) -> str:
        return f"mcp:{self.server}"

    async def _resolve_token(self) -> str:
        """M02 has no kernel-visible OAuth token path. M03 owns host transport."""
        raise NotEnabled(self.server)

    # -- connection ---------------------------------------------------------

    async def _resolve_config(self) -> tuple[str | None, dict[str, str], bool]:
        """Host-resolved endpoint configuration. OAuth is never kernel-owned."""
        try:
            cfg = await host_request("mcp.config", {"server": self.server})
        except RuntimeError:
            cfg = {}
        url = cfg.get("url") if isinstance(cfg, dict) else None
        headers = cfg.get("headers") if isinstance(cfg, dict) else None
        host_oauth_only = cfg.get("hostOAuthOnly") is True if isinstance(cfg, dict) else False
        if not (isinstance(url, str) and url):
            url = self.url
        extra = headers if isinstance(headers, dict) else {}
        credential_headers = {"authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key", "x-auth-token", "x-access-token"}
        safe_headers = {str(k): str(v) for k, v in extra.items() if str(k).lower() not in credential_headers}
        return url, safe_headers, host_oauth_only

    async def _open_session(self, stack: AsyncExitStack):
        """Open an initialized MCP ClientSession bound to ``stack``.

        Override for non-HTTP transports (e.g. stdio). The default connects over
        credential-free streamable HTTP. OAuth endpoints fail closed until M03
        provides the host-owned typed transport. The URL is host-resolved.
        """
        # Check host policy before importing the MCP SDK so an OAuth endpoint
        # cannot create a transport or token-adjacent dependency in Python.
        url, extra_headers, host_oauth_only = await self._resolve_config()
        if host_oauth_only:
            raise NotEnabled(self.server)
        if not url:
            raise ValueError(
                f"{type(self).__name__} must set `url` or override `_open_session`"
            )
        import inspect  # noqa: PLC0415
        from mcp import ClientSession  # noqa: PLC0415
        transport = _resolve_streamable_http()
        # M02 never reads OAuth secrets or manufactures authentication headers in Python.
        # Anonymous endpoints retain only explicit non-secret host headers.
        auth_header = dict(extra_headers)

        # SDK signatures vary: some take headers=, others only http_client=.
        params = inspect.signature(transport).parameters
        if "headers" in params:
            cm = transport(url, headers=auth_header)
        elif "http_client" in params:
            import httpx  # noqa: PLC0415

            client = await stack.enter_async_context(httpx.AsyncClient(headers=auth_header))
            cm = transport(url, http_client=client)
        else:
            raise RuntimeError(
                f"unsupported mcp streamable-HTTP client signature: {tuple(params)}"
            )

        read, write, *_ = await stack.enter_async_context(cm)
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        return session

    # -- tools --------------------------------------------------------------

    async def list_tools(self) -> list[dict[str, Any]]:
        """Return the server's tools as ``[{name, description, inputSchema}]``."""
        await self._ensure_tools()
        return [dict(t) for t in (self._tools or {}).values()]

    async def _ensure_tools(self) -> None:
        if self._tools is not None:
            return
        async with self._lock:
            if self._tools is not None:
                return
            async with AsyncExitStack() as stack:
                session = await self._open_session(stack)
                resp = await session.list_tools()
                self._tools = {
                    t.name: {
                        "name": t.name,
                        "description": getattr(t, "description", "") or "",
                        "inputSchema": getattr(t, "inputSchema", None) or {},
                    }
                    for t in resp.tools
                }

    async def call_tool(self, tool: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call ``tool`` on the server and return its parsed result.

        Opens a fresh session per call: MCP sessions are not safe to hold across
        the kernel's snapshot/restore, and per-call connect keeps this robust to
        idle sessions and token rotation at modest latency cost.
        """
        async with AsyncExitStack() as stack:
            session = await self._open_session(stack)
            result = await session.call_tool(tool, arguments or {})
        return _parse_result(result)

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
