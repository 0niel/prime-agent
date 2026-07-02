---
name: orchestration-heartbeat
description: Initialize or refresh an internal orchestrator heartbeat that observes active Prime Agent sessions, summarizes progress and blockers, and recommends next actions or messages.
---

# Orchestration Heartbeat

Use this skill from an orchestrator session to create or refresh a recurring
internal heartbeat for supervising multiple active Prime Agent sessions.

The heartbeat is an RLM heartbeat, not the user's visible `/heartbeat`. It
cannot read, replace, pause, resume, or clear the user-level heartbeat.

Call directly from IPython:

```python
await orchestration_heartbeat.initialize()
await orchestration_heartbeat.initialize(interval="10m", focus="EmulatorBench and AutoEnv")
```

## API

- `await orchestration_heartbeat.initialize(interval="5m", label="orchestrator",
  focus=None, require_user_approval=True)` creates or updates the labeled
  orchestrator heartbeat for the current session.
- `await orchestration_heartbeat.ensure(...)` is an alias for `initialize`.
- `orchestration_heartbeat.build_instruction(...)` returns the prompt text
  without creating or updating a heartbeat.

## Heartbeat Behavior

Each recurring orchestration heartbeat should:

- Inspect active sessions with `agent_observe`.
- Summarize each relevant session as `active`, `waiting`, `blocked`, `error`,
  or `completed`.
- Include current progress and explicit blockers.
- Recommend the next action and, when useful, draft a target message.
- Ask for user approval before sending cross-session messages unless the user
  has already approved that specific messaging policy.
- Keep the update compact and operational instead of dumping logs.
