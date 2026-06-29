---
name: agent-observe
description: Read-only observation of active Prime Agent sessions through the local daemon. Use to list agents, inspect session status, and read bounded recent-message previews without mutating other sessions.
---

# Agent Observe

Observe active Prime Agent sessions through the local daemon. This skill is
read-only: it can list sessions, inspect one session, and fetch bounded recent
message previews. It cannot prompt, steer, clear, kill, rename, or otherwise
mutate another session.

Call directly from the kernel:

```python
agents = await agent_observe.list_agents()
worker = await agent_observe.get_agent("worker")
recent = await agent_observe.recent_messages("worker", limit=6)
```

## API

- `await agent_observe.list_agents()` returns `current` and `agents`. Each
  agent includes active session id, session id, optional name, runtime kind,
  cwd, status, streaming state, message count, pending count, and a latest
  message preview.
- `await agent_observe.get_agent(target)` returns one agent summary. `target`
  is resolved like other live-session selectors: active id, session id/name, or
  unambiguous suffix.
- `await agent_observe.recent_messages(target, limit=8, max_chars=800)`
  returns up to `limit` recent bounded message previews for the target session.
  `limit` must be 1-50, and `max_chars` must be 80-2000.

## Safety

- This skill is read-only and exposes no mutation commands.
- Message access is bounded by count and per-message character limit.
- Prefer status and recent previews for orchestration. Ask the user before
  using observed context to steer or message another session.
