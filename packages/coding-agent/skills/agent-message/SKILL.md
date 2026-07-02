---
name: agent-message
description: Message other active Prime Agent sessions through the daemon. Use to discover active agents and send a direct text message without spoofing sender identity.
---

# Agent Message

Send direct messages to other active Prime Agent sessions through the local
daemon. The daemon derives your sender identity from the current session; do
not try to include a `from` field.

Call directly from the kernel:

```python
agents = await agent_message.list_agents()
receipt = await agent_message.send("worker", "Please inspect the latest result.", mode="auto")
```

## API

- `await agent_message.list_agents()` — returns `current` and `agents`, where
  each agent includes active session id, session id, optional name, runtime
  kind, cwd, streaming state, and pending message count.
- `await agent_message.send(target, message, mode="auto")` — sends one direct
  text message to an active session. `target` is resolved by the daemon like
  other live-session selectors. `mode` is `"auto"`, `"follow_up"`, or
  `"steer"`. Returns a receipt with a `deliveryStatus` field: `"delivered"`
  means the message reached an idle target's context; `"queued"` means it was
  accepted and will deliver when the target's current work allows (`send`
  does not block waiting for that). Delivered receipts carry `deliveredAt`,
  queued receipts carry `queuedAt`.

## Safety

- Broadcast sends are not supported.
- Sender identity is daemon-derived and cannot be spoofed from Python.
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
