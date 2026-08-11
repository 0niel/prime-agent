from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from unittest import mock

from rlm import mcp_base
from rlm.mcp_base import McpIntegration, McpToolError, NotEnabled


def _run(coro):
    return asyncio.run(coro)


class _FakeSession:
    """Stand-in for an mcp ClientSession with canned tools/results."""

    def __init__(self, tools, result):
        self._tools = tools
        self._result = result
        self.calls = []

    async def list_tools(self):
        Tool = type("Tool", (), {})

        def make(name, desc, schema):
            t = Tool()
            t.name = name
            t.description = desc
            t.inputSchema = schema
            return t

        resp = type("Resp", (), {})()
        resp.tools = [make(*t) for t in self._tools]
        return resp

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self._result


class _Integration(McpIntegration):
    server = "demo"
    url = "https://example.test/mcp"


class McpIntegrationTest(unittest.TestCase):
    def test_oauth_records_never_make_kernel_tokens_available(self):
        with self.assertRaises(NotEnabled):
            _run(_Integration()._resolve_token())

    def test_host_oauth_only_fails_before_transport(self):
        called = False

        async def host_config(req_type, payload):
            self.assertEqual((req_type, payload), ("mcp.config", {"server": "demo"}))
            return {"url": _Integration.url, "hostOAuthOnly": True}

        def transport(*args, **kwargs):
            nonlocal called
            called = True
            raise AssertionError("must not transport")

        with mock.patch.object(mcp_base, "host_request", host_config), mock.patch.object(
            mcp_base, "_resolve_streamable_http", lambda: transport
        ):
            with self.assertRaises(NotEnabled):
                _run(_Integration().call_tool("noop", {}))
        self.assertFalse(called)

    def test_anonymous_config_keeps_only_host_headers(self):
        async def host_config(req_type, payload):
            return {"url": _Integration.url, "headers": {"X-Extra": "1"}}

        with mock.patch.object(mcp_base, "host_request", host_config):
            url, headers, host_oauth_only = _run(_Integration()._resolve_config())
        self.assertEqual(url, _Integration.url)
        self.assertEqual(headers, {"X-Extra": "1"})
        self.assertFalse(host_oauth_only)

    def test_result_parsing_stays_credential_free(self):
        self.assertEqual(mcp_base._parse_result(type("R", (), {"structuredContent": {}, "content": [], "isError": False})()), {})
        with self.assertRaises(McpToolError):
            mcp_base._parse_result(type("R", (), {"structuredContent": None, "content": [], "isError": True})())


if __name__ == "__main__":
    unittest.main()
