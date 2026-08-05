"""Prime Agent session-to-session messaging skill.

All routing and sender identity live in the TypeScript daemon. These functions
only call the host bridge exposed inside the Prime Agent IPython kernel.
"""

from __future__ import annotations

from typing import Any, Literal

from IPython.display import display
from rlm import host_request

MessageMode = Literal["auto", "follow_up", "steer"]
ReceiverRole = Literal["parent", "sibling", "child"]
_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json"


async def list_agents() -> dict[str, Any]:
    """List active daemon sessions addressable by agent_message.send()."""
    return await host_request("agent_message.list")


async def roster() -> dict[str, Any]:
    """List this agent's parent, siblings, and children, including inactive family."""
    return await host_request("agent_message.roster")


async def send(
    message: str,
    *legacy_args: str,
    receiver_role: ReceiverRole | str | None = None,
    receiver_name: str | None = None,
    mode: MessageMode = "auto",
) -> dict[str, Any]:
    """Send one direct message, preferably using a nuclear-family role.

    New form: ``send(message, receiver_role="parent" | "sibling" | "child",
    receiver_name=...)``. A name or id is required for siblings and children and
    must be omitted for the unique parent. The legacy positional
    ``send(target, message, mode)`` form remains available during migration.
    """
    roles = ("parent", "sibling", "child")
    payload: dict[str, Any]
    if legacy_args:
        if receiver_role is not None or receiver_name is not None:
            raise TypeError(
                "legacy agent_message.send cannot combine positional target/message "
                "with receiver_role or receiver_name"
            )
        if len(legacy_args) > 2:
            raise TypeError("legacy agent_message.send accepts target, message, and optional mode")
        target = message
        legacy_message = legacy_args[0]
        if len(legacy_args) == 2:
            mode = legacy_args[1]  # type: ignore[assignment]
        if not isinstance(target, str):
            raise TypeError(f"target must be str, got {type(target).__name__}")
        if not isinstance(legacy_message, str):
            raise TypeError("legacy agent_message.send requires target and message strings")
        payload = {"target": target, "message": legacy_message, "mode": mode}
    else:
        if receiver_role not in roles:
            raise ValueError('receiver_role must be "parent", "sibling", or "child"')
        if not isinstance(message, str):
            raise TypeError(f"message must be str, got {type(message).__name__}")
        if receiver_role == "parent":
            if receiver_name is not None:
                raise ValueError("receiver_name must be omitted for parent messages")
        elif not isinstance(receiver_name, str) or not receiver_name.strip():
            raise ValueError("receiver_name is required for sibling and child messages")
        payload = {
            "message": message,
            "receiver_role": receiver_role,
            "receiver_name": receiver_name,
            "mode": mode,
        }
    if mode not in ("auto", "follow_up", "steer"):
        raise ValueError('mode must be "auto", "follow_up", or "steer"')
    receipt = await host_request("agent_message.send", payload)
    _emit_sent_message(receipt, receiver_role)
    return receipt


def _emit_sent_message(receipt: dict[str, Any], receiver_role: str | None = None) -> None:
    try:
        label = (
            "Agent message queued"
            if receipt.get("deliveryStatus") == "queued"
            else "Agent message sent"
        )
        display_receipt = dict(receipt)
        if receiver_role in ("parent", "sibling", "child"):
            display_receipt["receiverRole"] = receiver_role
        display(
            {
                _MESSAGE_DISPLAY_MIME: display_receipt,
                "text/plain": label,
            },
            raw=True,
        )
    except Exception:
        pass
