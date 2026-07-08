"""Prime Agent session-to-session messaging skill.

All routing and sender identity live in the TypeScript daemon. These functions
only call the host bridge exposed inside the Prime Agent IPython kernel.
"""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

MessageMode = Literal["auto", "follow_up", "steer"]


async def list_agents() -> dict[str, Any]:
    """List active daemon sessions addressable by agent_message.send()."""
    return await host_request("agent_message.list")


async def send(target: str, message: str, mode: MessageMode = "auto") -> dict[str, Any]:
    """Send one direct text message to another active Prime Agent session.

    Args:
        target: Active session id, session id/name, or unambiguous suffix.
        message: Text payload to deliver.
        mode: "auto" steers into a busy/streaming target so the message is visible promptly;
            "follow_up" always uses follow-up when the target is streaming;
            "steer" interrupts a streaming target.

    Returns a receipt dict whose "deliveryStatus" is "delivered" (reached an
    idle target's context) or "queued" (accepted; delivers when the target's
    current work allows -- this call does not block waiting for that).
    """
    if not isinstance(target, str):
        raise TypeError(f"target must be str, got {type(target).__name__}")
    if not isinstance(message, str):
        raise TypeError(f"message must be str, got {type(message).__name__}")
    if mode not in ("auto", "follow_up", "steer"):
        raise ValueError('mode must be "auto", "follow_up", or "steer"')
    return await host_request(
        "agent_message.send",
        {
            "target": target,
            "message": message,
            "mode": mode,
        },
    )
