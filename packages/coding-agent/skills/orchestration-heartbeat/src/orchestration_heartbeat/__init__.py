"""Prime Agent orchestration heartbeat skill.

This skill composes the bundled agent_observe and rlm_heartbeat skills. It
creates or refreshes one internal heartbeat for the current orchestrator
session; it never touches the user's visible /heartbeat.
"""

from __future__ import annotations

from typing import Any

import agent_observe
import rlm_heartbeat

DEFAULT_INTERVAL = "5m"
DEFAULT_LABEL = "orchestrator"


def _first_value(agent: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = agent.get(key)
        if value is not None:
            return value
    return None


def _session_label(agent: dict[str, Any]) -> str:
    name = _first_value(agent, "sessionName", "name")
    session_id = _first_value(agent, "sessionId", "session_id")
    active_session_id = _first_value(agent, "activeSessionId", "active_session_id")
    cwd = agent.get("cwd")
    status = agent.get("status")
    streaming = _first_value(agent, "isStreaming", "streaming")
    pending = _first_value(agent, "pendingMessageCount", "pending_message_count")
    parts = [
        f"name={name}" if name else None,
        f"session_id={session_id}" if session_id else None,
        f"active_session_id={active_session_id}" if active_session_id else None,
        f"cwd={cwd}" if cwd else None,
        f"status={status}" if status else None,
        f"streaming={streaming}" if streaming is not None else None,
        f"pending_messages={pending}" if pending is not None else None,
    ]
    return "- " + ", ".join(part for part in parts if part)


def _format_sessions(agents: list[dict[str, Any]]) -> str:
    if not agents:
        return "- No other active sessions were visible when this heartbeat was initialized."
    return "\n".join(_session_label(agent) for agent in agents)


def _same_session(left: dict[str, Any], right: dict[str, Any]) -> bool:
    for keys in (
        ("activeSessionId", "active_session_id"),
        ("sessionId", "session_id"),
    ):
        left_value = _first_value(left, *keys)
        right_value = _first_value(right, *keys)
        if left_value is not None and right_value is not None and left_value == right_value:
            return True
    return False


def _other_agents(roster: dict[str, Any]) -> list[dict[str, Any]]:
    agents = roster.get("agents", [])
    if not isinstance(agents, list):
        return []
    current = roster.get("current")
    if not isinstance(current, dict):
        return agents
    return [agent for agent in agents if not _same_session(agent, current)]


def _normalize_interval_expression(value: str) -> str:
    normalized = " ".join(value.strip().lower().split())
    if normalized.startswith("every "):
        return normalized[6:].strip()
    return normalized


def _interval_matches_schedule(interval: str, schedule: Any) -> bool:
    if not isinstance(schedule, dict):
        return False
    expression = schedule.get("expression")
    if not isinstance(expression, str):
        return False
    return _normalize_interval_expression(expression) == _normalize_interval_expression(interval)


def build_instruction(
    sessions: list[dict[str, Any]] | None = None,
    focus: str | None = None,
    require_user_approval: bool = True,
) -> str:
    """Build the recurring orchestration heartbeat instruction."""
    if sessions is not None and not isinstance(sessions, list):
        raise TypeError(f"sessions must be list or None, got {type(sessions).__name__}")
    if focus is not None and not isinstance(focus, str):
        raise TypeError(f"focus must be str or None, got {type(focus).__name__}")
    if not isinstance(require_user_approval, bool):
        raise TypeError(
            f"require_user_approval must be bool, got {type(require_user_approval).__name__}"
        )

    session_block = _format_sessions(sessions or [])
    focus_line = f"\nCurrent focus: {focus.strip()}\n" if focus and focus.strip() else ""
    approval_rule = (
        "Do not send cross-session messages until the user approves the specific target and message, "
        "unless the user has already granted an explicit messaging policy for this run."
        if require_user_approval
        else "You may send cross-session messages when they are clearly necessary and within the user's policy."
    )

    return f"""Orchestration heartbeat.

Use agent_observe to inspect active Prime Agent sessions. For each relevant session, summarize:
- state: active, waiting, blocked, error, or completed
- current progress
- explicit blockers, separating task blockers from auth/tooling/infrastructure blockers
- recommended next action

If a session needs intervention, recommend the exact action and draft the target message. {approval_rule}

Keep the update compact and operational. Prefer session-by-session status over log detail. If a session's status is ambiguous, say what evidence is missing and what to inspect next.
{focus_line}
Sessions visible when this heartbeat was initialized or refreshed:
{session_block}

Before finalizing the heartbeat update, check whether new active sessions appeared since initialization and include them in the summary."""


async def initialize(
    interval: str = DEFAULT_INTERVAL,
    label: str = DEFAULT_LABEL,
    focus: str | None = None,
    require_user_approval: bool = True,
) -> dict[str, Any]:
    """Create or update this session's internal orchestrator heartbeat."""
    if not isinstance(interval, str):
        raise TypeError(f"interval must be str, got {type(interval).__name__}")
    if not isinstance(label, str):
        raise TypeError(f"label must be str, got {type(label).__name__}")

    roster = await agent_observe.list_agents()
    agents = _other_agents(roster)
    instruction = build_instruction(
        sessions=agents,
        focus=focus,
        require_user_approval=require_user_approval,
    )
    existing = await rlm_heartbeat.list(include_inactive=False)
    for heartbeat in existing.get("heartbeats", []):
        if heartbeat.get("label") == label:
            update_args: dict[str, Any] = {
                "instruction": instruction,
                "label": label,
            }
            if heartbeat.get("status") == "paused":
                update_args["status"] = "resume"
            if not _interval_matches_schedule(interval, heartbeat.get("schedule")):
                update_args["interval"] = interval
            updated = await rlm_heartbeat.update(heartbeat["id"], **update_args)
            updated_heartbeat = updated.get("heartbeat")
            if updated_heartbeat is None:
                raise RuntimeError(
                    f"RLM heartbeat {heartbeat['id']} disappeared before it could be updated"
                )
            return {
                "action": "updated",
                "heartbeat": updated_heartbeat,
                "sessions": agents,
                "instruction": instruction,
            }

    created = await rlm_heartbeat.create(instruction, interval=interval, label=label)
    return {
        "action": "created",
        "heartbeat": created.get("heartbeat"),
        "sessions": agents,
        "instruction": instruction,
    }


async def ensure(
    interval: str = DEFAULT_INTERVAL,
    label: str = DEFAULT_LABEL,
    focus: str | None = None,
    require_user_approval: bool = True,
) -> dict[str, Any]:
    """Alias for initialize()."""
    return await initialize(
        interval=interval,
        label=label,
        focus=focus,
        require_user_approval=require_user_approval,
    )
