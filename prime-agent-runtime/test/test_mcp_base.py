from __future__ import annotations

import asyncio
import unittest
from unittest import mock

from rlm import mcp_base
from rlm.mcp_base import McpIntegration, McpToolError, NotEnabled


def _run(coro):
    return asyncio.run(coro)


class _Integration(McpIntegration):
    server = "demo"
    url = "https://example.test/mcp"


class McpIntegrationTest(unittest.TestCase):
    def test_oauth_kernel_boundary_is_not_enabled(self):
        with self.assertRaises(NotEnabled):
            _run(_Integration()._resolve_token())

    def test_empty_structured_result_preserved(self):
        for payload in ({}, []):
            result = type("R", (), {"structuredContent": payload, "content": [], "isError": False})()
            self.assertEqual(mcp_base._parse_result(result), payload)
            self.assertEqual(mcp_base._parse_host_result({"structuredContent": payload, "content": []}), payload)

    def test_error_result_raises(self):
        block = type("B", (), {"text": "boom"})()
        result = type("R", (), {"isError": True, "content": [block], "structuredContent": None})()
        with self.assertRaises(McpToolError) as ctx:
            mcp_base._parse_result(result)
        self.assertIn("boom", str(ctx.exception))
        with self.assertRaises(McpToolError):
            mcp_base._parse_host_result({"isError": True, "content": [{"text": "boom"}]})

    def test_requires_server_attribute(self):
        class Bad(McpIntegration):
            server = ""
        with self.assertRaises(ValueError):
            Bad()

    def test_default_calls_are_typed_host_requests_without_sdk_or_transport(self):
        calls = []

        async def host_request(request_type, payload):
            calls.append((request_type, payload))
            self.assertEqual(request_type, "mcp.request")
            # Kernel does not receive endpoint, headers, or authorization material.
            self.assertEqual(set(payload), {"server", "method", "params"})
            if payload["method"] == "tools/list":
                return {"result": {"tools": [{"name": "list_issues", "description": "x", "inputSchema": {}}]}}
            return {"result": {"structuredContent": {"issues": [1, 2]}, "content": []}}

        with mock.patch.object(mcp_base, "host_request", host_request):
            integration = _Integration()
            self.assertEqual(_run(integration.list_issues(team="Eng")), {"issues": [1, 2]})
        self.assertEqual(calls, [
            ("mcp.request", {"server": "demo", "method": "tools/list", "params": {}}),
            ("mcp.request", {"server": "demo", "method": "tools/call", "params": {"name": "list_issues", "arguments": {"team": "Eng"}}}),
        ])

    def test_unknown_tool_raises_with_available_list(self):
        async def host_request(_type, payload):
            self.assertEqual(payload["method"], "tools/list")
            return {"result": {"tools": [{"name": "list_issues", "description": "", "inputSchema": {}}]}}
        with mock.patch.object(mcp_base, "host_request", host_request):
            with self.assertRaises(AttributeError) as ctx:
                _run(_Integration().nonexistent_tool())
        self.assertIn("list_issues", str(ctx.exception))

    def test_host_result_text_and_non_text_normalization(self):
        self.assertEqual(mcp_base._parse_host_result({"content": [{"text": "hello"}]}), "hello")
        self.assertEqual(mcp_base._parse_host_result({"content": [{"type": "image"}]}), [{"type": "image"}])

    def test_explicit_subclass_escape_hatch_remains_possible_but_default_never_uses_it(self):
        class ExplicitTransportIntegration(McpIntegration):
            server = "explicit"
            async def _open_session(self, _stack):
                return "custom transport"

        integration = ExplicitTransportIntegration()
        self.assertEqual(_run(integration._open_session(None)), "custom transport")
        self.assertFalse(hasattr(_Integration, "_open_session"))


if __name__ == "__main__":
    unittest.main()
