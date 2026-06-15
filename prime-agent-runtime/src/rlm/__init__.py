"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import asyncio
import os
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .harness import HarnessEntry, HarnessState, RefinementEvent, get_harness_state

try:
    from ipykernel.comm import Comm
except Exception:  # pragma: no cover - depends on ipykernel version
    Comm = None  # type: ignore[assignment]

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover - only available in kernels
    get_ipython = None  # type: ignore[assignment]


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass
class RLMResult:
    answer: str
    session_dir: Path | None = None
    usage: TokenUsage = field(default_factory=TokenUsage)
    turns: int = 0


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got {raw!r}") from exc


def _ensure_recursion_allowed() -> None:
    depth = _env_int("RLM_DEPTH", 0)
    max_depth = _env_int("RLM_MAX_DEPTH", 1)
    if depth >= max_depth:
        raise RuntimeError(
            f"RLM recursion depth limit reached "
            f"(RLM_DEPTH={depth}, RLM_MAX_DEPTH={max_depth})"
        )


def _install_control_comm_handlers() -> None:
    """Let comm replies arrive on the control channel during an execute_request."""
    if get_ipython is None:
        return
    shell = get_ipython()
    kernel = getattr(shell, "kernel", None)
    comm_manager = getattr(kernel, "comm_manager", None)
    control_handlers = getattr(kernel, "control_handlers", None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault("comm_msg", comm_manager.comm_msg)
    control_handlers.setdefault("comm_close", comm_manager.comm_close)


def _result_from_payload(payload: dict[str, Any]) -> RLMResult:
    usage_payload = payload.get("usage")
    usage = TokenUsage()
    if isinstance(usage_payload, dict):
        usage = TokenUsage(
            prompt_tokens=int(usage_payload.get("prompt_tokens", 0)),
            completion_tokens=int(usage_payload.get("completion_tokens", 0)),
        )

    session_dir_payload = payload.get("session_dir")
    session_dir = Path(session_dir_payload) if isinstance(session_dir_payload, str) else None
    return RLMResult(
        answer=str(payload.get("answer", "")),
        usage=usage,
        turns=int(payload.get("turns", 0)),
        session_dir=session_dir,
    )


async def _host_request(data: dict[str, Any]) -> dict[str, Any]:
    if Comm is None:
        raise RuntimeError("Jupyter comm support is unavailable in this kernel")
    _install_control_comm_handlers()

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    comm = Comm(target_name="rlm.run", primary=False)

    def _on_msg(msg: dict[str, Any]) -> None:
        content = msg.get("content", {})
        reply = content.get("data", {}) if isinstance(content, dict) else {}
        if not isinstance(reply, dict):
            return

        status = reply.get("status")
        if status == "ok":
            def _resolve_result() -> None:
                if not future.done():
                    future.set_result(reply)
                    comm.close()

            loop.call_soon_threadsafe(_resolve_result)
            return
        if status == "error":
            message = reply.get("error") or "rlm.run failed"
            def _resolve_error() -> None:
                if not future.done():
                    future.set_exception(RuntimeError(str(message)))
                    comm.close()

            loop.call_soon_threadsafe(_resolve_error)

    comm.on_msg(_on_msg)
    comm.open(data=data)
    return await future


async def run(prompt: str, **kwargs: Any) -> RLMResult:
    """Run a recursive Prime Agent child through the TypeScript host."""
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    _ensure_recursion_allowed()
    payload = await _host_request({"type": "run", "prompt": prompt, "kwargs": kwargs})
    return _result_from_payload(payload)


try:
    _harness_state = get_harness_state()
except Exception:  # pragma: no cover - harness state must never break `import rlm`
    # Importing rlm runs inside the kernel; a failure here would take down the whole
    # kernel. Fall back to a true in-memory store (no path resolution, no disk) so the
    # failure cannot recur and refinement is merely degraded, not fatal.
    _harness_state = HarnessState(in_memory=True)


class _RLMCallable:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)

    async def run(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()
harness = _harness_state


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "HarnessEntry",
    "HarnessState",
    "RLMResult",
    "RefinementEvent",
    "TokenUsage",
    "get_harness_state",
    "harness",
    "rlm",
    "run",
]
