"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import asyncio
import os
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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


@dataclass
class RLMBackgroundStatus:
    id: str
    state: str
    session_dir: Path | None = None
    result: RLMResult | None = None
    error: str | None = None
    timed_out: bool = False


@dataclass
class RLMBackgroundHandle:
    id: str
    session_dir: Path | None = None

    async def status(self) -> RLMBackgroundStatus:
        return await background_status(self.id)

    async def wait(self, timeout: float | None = None) -> RLMBackgroundStatus:
        return await background_wait(self.id, timeout=timeout)

    async def result(self, timeout: float | None = None) -> RLMResult:
        status = await self.wait(timeout=timeout)
        if status.result is not None:
            return status.result
        if status.timed_out:
            raise TimeoutError(f"background rlm child {self.id!r} is still running")
        if status.error:
            raise RuntimeError(status.error)
        raise RuntimeError(f"background rlm child {self.id!r} has no result")


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


def _status_from_payload(payload: dict[str, Any]) -> RLMBackgroundStatus:
    session_dir_payload = payload.get("session_dir")
    session_dir = Path(session_dir_payload) if isinstance(session_dir_payload, str) else None
    result_payload = payload.get("result")
    result = _result_from_payload(result_payload) if isinstance(result_payload, dict) else None
    error_payload = payload.get("error")
    return RLMBackgroundStatus(
        id=str(payload.get("id", "")),
        state=str(payload.get("state", "")),
        session_dir=session_dir,
        result=result,
        error=str(error_payload) if error_payload is not None else None,
        timed_out=bool(payload.get("timed_out", False)),
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


async def background(prompt: str, **kwargs: Any) -> RLMBackgroundHandle:
    """Start a recursive Prime Agent child and return immediately with a handle.

    notify controls parent notification behavior:
    - "passive" (default): make the result available to a later parent turn.
    - "wake": wake the parent agent so it can report the result.
    - "silent": do not notify the parent agent; poll the returned handle.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    _ensure_recursion_allowed()
    payload = await _host_request({"type": "background", "prompt": prompt, "kwargs": kwargs})
    session_dir_payload = payload.get("session_dir")
    session_dir = Path(session_dir_payload) if isinstance(session_dir_payload, str) else None
    child_id = payload.get("id")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError("rlm.background response did not include a child id")
    return RLMBackgroundHandle(id=child_id, session_dir=session_dir)


async def background_status(child_id: str) -> RLMBackgroundStatus:
    if not isinstance(child_id, str):
        raise TypeError(f"child_id must be str, got {type(child_id).__name__}")
    payload = await _host_request({"type": "background_status", "id": child_id})
    return _status_from_payload(payload)


async def background_wait(child_id: str, timeout: float | None = None) -> RLMBackgroundStatus:
    if not isinstance(child_id, str):
        raise TypeError(f"child_id must be str, got {type(child_id).__name__}")
    if timeout is not None and timeout < 0:
        raise ValueError("timeout must be non-negative")
    timeout_ms = None if timeout is None else int(timeout * 1000)
    payload = await _host_request({"type": "background_wait", "id": child_id, "timeout_ms": timeout_ms})
    return _status_from_payload(payload)


class _RLMCallable:
    async def run(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)

    async def background(self, prompt: str, **kwargs: Any) -> RLMBackgroundHandle:
        return await background(prompt, **kwargs)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "RLMBackgroundHandle",
    "RLMBackgroundStatus",
    "RLMResult",
    "TokenUsage",
    "background",
    "background_status",
    "background_wait",
    "rlm",
    "run",
]
