---
name: agent-message
description: Message other active Prime Agent sessions, including completed retained subagents, through the daemon. Use to discover active agents and send a direct text message without spoofing sender identity.
---

# Agent Message

Send direct messages to other active Prime Agent sessions through the local
daemon. The daemon derives your sender identity from the current session; do
not try to include a `from` field.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    receipt = await agent_message.send(
        child.session_name,
        "Please inspect the latest result.",
        mode="auto",
    )
    # Keep the child until this follow-up finishes so its result remains observable.
```

## API

- `await agent_message.roster()` — returns `current` (`name`, `id`, `depth`) and
  relationship-scoped `entries` (`relationship`, `name`, `id`, `depth`, `status`)
  for the current agent's parent, siblings, and children. It includes inactive
  family members and sorts parent, siblings by name, then children by name.
- `await agent_message.list_agents()` — returns `current` and `agents`, where
  each agent includes active session id, session id, optional name, runtime
  kind, cwd, streaming state, and pending message count. This includes live
  subagents and successful completed subagents retained by an open parent.
  For the current parent session's direct children, prefer
  `await rlm.list_subagents()` over filtering this global list. Every RLM child
  gets a readable unique `session_name`, or the orchestrator can choose one with
  `rlm("task", name="api-reviewer")`; use that name directly as a target.
- `await agent_message.send(target, message, mode="auto")` — sends one direct
  text message to an active session. Sending to an idle completed subagent
  starts an ordinary follow-up turn in that same child session and context.
  The child remains available only until its parent session closes. `target`
  is resolved by the daemon like other live-session selectors. `mode` is
  `"auto"`, `"follow_up"`, or `"steer"`. In `auto` mode, messages to busy sessions are queued as steering
  messages so the target sees them during the active run; use `"follow_up"` for
  intentionally delayed delivery. Returns a receipt with a `deliveryStatus`
  field: `"delivered"` means the message reached an idle target's context;
  `"queued"` means it was accepted and will deliver when the target's current
  work allows (`send` does not block waiting for that). Delivered receipts
  carry `deliveredAt`, queued receipts carry `queuedAt`.

## Safety

- Do not delete a child immediately after `send`: delivered follow-ups may still
  be running and queued receipts have not run yet. Wait until observation shows
  the child is idle and its context is no longer needed before calling
  `await rlm.delete_subagent(child)`.
- Broadcast sends are not supported.
- Sender identity is daemon-derived and cannot be spoofed from Python.
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
