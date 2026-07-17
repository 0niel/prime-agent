# Kernel and RLM Recursion

This document explains the IPython kernel transport and the recursive `rlm` sub-agent bridge.

The important design constraint is that the Python `rlm` package in the kernel is only a shim. It preserves the model-facing API from `rlm-harness`, but it does not run a child agent loop in Python. Child agents are run by the TypeScript host through the same `AgentSession` machinery as the parent.

The same comm transport doubles as a generic host bridge: kernel-side Python (skills such as the bundled `goal` skill) can call `rlm.host_request("<type>", {...})` and the TypeScript host dispatches the typed request to a registered handler. `rlm.run` is just the first registered request type.

## High-Level Shape

```text
AgentSession (TypeScript)
  |
  | owns an ipython tool
  v
KernelManager (TypeScript)
  |
  | ZeroMQ Jupyter protocol
  v
IPython kernel process (Python)
  |
  | has prime-agent-runtime installed as module "rlm"
  v
model-executed Python code
```

When the model calls recursion:

```python
result = await rlm.run("subtask")
print(result.answer)
```

the flow becomes:

```text
Python rlm shim
  |
  | Jupyter comm target "host.request", payload type "rlm.run"
  v
KernelManager comm handler
  |
  | calls parent AgentSession.runRlmChild(prompt)
  v
child AgentSession
  |
  | same TS agent loop, providers, tools, skills, session storage
  v
final assistant text
  |
  | Jupyter comm reply
  v
Python RLMResult
```

## Files

```text
packages/coding-agent/src/core/kernel/index.ts
  ZeroMQ connection setup, Jupyter wire encoding, execute_request handling,
  comm_open / comm_msg handling for the "host.request" bridge, dispatching
  typed requests (rlm.run, goal.*) to registered host handlers.

packages/coding-agent/src/core/tools/ipython.ts
  Tool wrapper around KernelManager. Starts the kernel and bootstraps the
  rlm object into the user namespace.

packages/coding-agent/src/core/agent-session.ts
  Parent session owns recursion settings and implements runRlmChild().

packages/coding-agent/src/core/rlm-runtime.ts
  TypeScript request/result types for rlm.run, rlm.find_models,
  rlm.list_subagents, and rlm.delete_subagent plus their typed host request
  handlers.

prime-agent-runtime/src/rlm/__init__.py
  Python shim installed into ~/.prime/agent/kernel-venv. Exposes rlm, rlm.run(),
  rlm.find_models(), rlm.list_subagents(), rlm.delete_subagent(),
  host_request(), RLMResult, RLMModel, RLMSubagent, TokenUsage, and the
  session-backed harness state helper.

prime-agent-runtime/src/rlm/harness.py
  Session-backed JSON store for reset-free harness refinement notes: prompt
  notes, memory entries, reusable skill descriptions, subagent specs, and
  refinement events.

packages/coding-agent/skills/goal
  Bundled Python skill exposing goal.get / goal.create / goal.complete in the
  kernel. A thin wrapper over host_request; all goal state stays in the host.

scripts/setup-kernel-venv.sh
  Thin wrapper around the automatic kernel bootstrap.
```

## Continual Harness State

Prime Agent exposes a lightweight continual-harness state store in the kernel:

```python
import rlm

rlm.harness.remember(
    "Validation failure",
    "The package import only matters when run through the project environment.",
    path="repo/testing",
)
rlm.harness.upsert_skill(
    "Run native Python import checks",
    "Use `uv run python -c ...` or the repo's documented interpreter.",
)
rlm.harness.upsert_subagent(
    "Focused reviewer",
    "Review the current patch for regressions and missing focused tests.",
)
rlm.harness.record_refinement(
    "Repeated import-check confusion",
    ["added repo/testing memory", "added native import-check skill"],
    evidence="two failed checks were run in the IPython kernel instead of the repo env",
)
print(rlm.harness.overview())
```

The store writes `harness_state.json` in the session-local harness directory by
default (`RLM_HARNESS_STATE_DIR`, falling back to `RLM_SESSION_DIR/harness`), so
learned state stays with the session. Explicitly global edits go to the global
agent harness directory (`RLM_GLOBAL_HARNESS_STATE_DIR`, e.g.
`~/.prime/agent/harness/`), which is shared across sessions. Because the
long-lived kernel and the host `/refine`
command write the same file from separate processes, the kernel-side store
reloads the file whenever its on-disk mtime changes before reading or mutating,
so concurrent host edits are merged rather than clobbered. It is intentionally a
state ledger, not a second execution engine: child-agent execution still uses
`await rlm(...)`, installed Python skills still use the configured skill surface,
and file/code edits still go through the normal Prime Agent tools.

This mirrors the useful, domain-independent part of Continual Harness: the agent
can make small online updates to its prompt notes, memory, skill descriptions,
and subagent specs after observing trajectory evidence, then record the outcome
without resetting the run.

The same state can be updated from the TUI or RPC with `/refine`. The command
runs a dedicated refiner prompt over the current trajectory, existing harness
state, and prior refinement history, then applies JSON Create/Update/Delete
edits to the editable components only:

```text
/refine
/refine focus on improving validation behavior
/refine rollback refine_20260608142312
```

Rollback uses the before/after snapshots stored for each refinement. Because the
harness state is global, the snapshots are appended to a global
`refinements.jsonl` log in the harness directory (in addition to a
`prime-agent.refinement` custom entry in the originating session), so a
refinement applied in one session can be rolled back from any later session. The
base system prompt remains immutable; `/refine` can only create or update
supplemental prompt notes.

## ZeroMQ Jupyter Kernel Setup

### Connection File

`KernelManager` creates a temporary Jupyter connection file before spawning the kernel.

The file contains local TCP ports and signing settings:

```json
{
  "ip": "127.0.0.1",
  "transport": "tcp",
  "shell_port": 50000,
  "iopub_port": 50001,
  "stdin_port": 50002,
  "control_port": 50003,
  "hb_port": 50004,
  "signature_scheme": "hmac-sha256",
  "key": "...",
  "kernel_name": "python3"
}
```

The current implementation picks a random high port range, writes the file under a temp directory, and starts:

```bash
python -m ipykernel_launcher -f /tmp/prime-agent-kernel-.../connection.json
```

The kernel process inherits:

- `cwd`: the agent session working directory.
- `env`: the process environment plus kernel-specific overrides such as `RLM_DEPTH`, `RLM_MAX_DEPTH`, and `RLM_SESSION_DIR`.

### Channels Used

Jupyter defines several channels. Prime Agent currently uses three:

```text
shell channel
  request/reply channel for execute_request and kernel_info_request

iopub channel
  publish/subscribe channel for stdout, stderr, execute_result, errors,
  status changes, and comm_open messages from the kernel

control channel
  request/reply channel for interrupt_request, shutdown_request, and rlm
  comm replies that must be delivered while execute_request is still active
```

The code creates:

```text
shell   -> ZeroMQ Dealer
iopub   -> ZeroMQ Subscriber
control -> ZeroMQ Dealer
```

The Subscriber subscribes to the empty topic, which means it receives all IOPub messages.

### Jupyter Message Encoding

Each Jupyter message is sent as multipart ZeroMQ frames:

```text
<IDS|MSG>
signature
header
parent_header
metadata
content
```

`KernelManager.encode()` serializes the JSON parts and signs them with HMAC-SHA256 using the connection file key. `decode()` finds the `<IDS|MSG>` delimiter and parses the four JSON frames after the signature.

The header includes:

```json
{
  "msg_id": "...",
  "session": "...",
  "username": "prime-agent",
  "date": "...",
  "msg_type": "execute_request",
  "version": "5.3"
}
```

The `msg_id` is important because IOPub is shared. For ordinary execution output, the host only accepts messages whose `parent_header.msg_id` matches the active `execute_request`.

### Kernel Startup

Startup sequence:

```text
KernelManager.start()
  |
  | ensureKernelPython()
  |   bootstraps ~/.prime/agent/kernel-venv with uv if needed
  v
resolved python with ipykernel and prime-agent-runtime
  |
  v
makeConnection()
  |
  | writes connection.json
  v
spawn python -m ipykernel_launcher -f connection.json
  |
  v
connect shell, iopub, control sockets
  |
  v
subscribe to iopub
  |
  v
sleep briefly for ZeroMQ slow-joiner behavior
  |
  v
start persistent iopub pump
  |
  v
probeReady()
  |
  | sends kernel_info_request on shell
  | waits for kernel_info_reply
  v
state = "running"
```

The startup probe catches a common failure mode: the Python process starts but the kernel never binds or responds. If the probe times out, the manager shuts down and includes the kernel stderr tail in the error.

### Executing Code

The ipython tool calls:

```typescript
KernelManager.execute(code, opts)
```

`execute()` serializes calls with `executionQueue`. This matters because the shell channel is a request/reply channel and the IPython kernel user namespace is shared. Two ordinary IPython cells should not execute concurrently in one kernel.

Execution sequence:

```text
execute(code)
  |
  v
send execute_request on shell
  |
  v
wait for persistent iopub pump to finish active execution
  |
  | stream        -> stdout / stderr
  | execute_result -> final expression repr
  | error         -> traceback
  | status idle   -> cell is complete
  v
return ExecuteResult
```

The returned shape is:

```typescript
{
  stdout: string;
  stderr: string;
  result?: string;
  status: "ok" | "error" | "aborted";
  error?: { ename: string; evalue: string; traceback: string[] };
  durationMs: number;
}
```

Abort handling sends `interrupt_request` on the control channel. The execute call then marks the result as aborted if the `AbortSignal` fired.

### Kernel Restart And Cleanup

`KernelManager.shutdown()` sends `shutdown_request` on the control channel, waits briefly, closes sockets, kills the child process as a fallback, removes the temp connection directory, and clears `startPromise`.

`KernelManager.restart()` serializes behind any active execute call, shuts down, resets state to idle, clears stderr, and starts again.

Process-wide cleanup is registered through `registerSessionResourceCleanup()`. Kernel managers carry an owner session id, so `cleanupSessionResources(sessionId)` only disposes kernels for that session.

## IPython Tool Bootstrapping

The ipython tool constructs a `KernelManager` lazily on first use. `KernelManager.start()` resolves Python in this order:

```text
PRIME_AGENT_KERNEL_PYTHON, if set and able to import ipykernel
~/.prime/agent/kernel-venv/bin/python, bootstrapped by uv if needed
$XDG_DATA_HOME/prime/agent/kernel-venv/bin/python, only if ~/.prime is not writable
```

The automatic bootstrap installs Python 3.11, `ipykernel`, and `prime-agent-runtime`, then writes `.bootstrap-version` in the venv. Missing or stale markers cause a rebuild.

After the kernel starts, the tool bootstraps `rlm` into the user namespace:

```python
try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
except Exception:
    rlm = _PrimeAgentMissingRlm()
```

This puts the callable `rlm` object in the global IPython namespace. The model can use either:

```python
await rlm("subtask")
await rlm.run("subtask")
```

Both delegate to the same shim implementation.

If `prime-agent-runtime` is missing from the kernel environment, startup remains non-fatal. The fallback `rlm` object raises a clear `RuntimeError` only when code actually calls `rlm.run(...)` or `rlm(...)`.

## Python RLM Shim

The Python shim lives in `prime-agent-runtime` and installs as import namespace `rlm`.

It exports:

```python
rlm
run(prompt: str, **kwargs)
find_models(query: str = "", limit: int = 8)
list_subagents()
host_request(request_type: str, payload: dict | None = None)
RLMResult
RLMModel
RLMSubagent
TokenUsage
```

`RLMResult` matches the model-visible shape from `rlm-harness`:

```python
result.answer       # str
result.usage        # TokenUsage
result.turns        # int
result.session_dir  # pathlib.Path | None
result.model        # exact provider/model selector
result.warning      # fallback notice to surface to the user, or None
```

The shim also makes the module callable so `import rlm; await rlm("...")` can work, but the ipython tool normally injects the callable object directly as `rlm`.

### Depth Check

Before opening a comm, the shim reads:

```text
RLM_DEPTH
RLM_MAX_DEPTH
```

Default max depth is 1. If `RLM_DEPTH >= RLM_MAX_DEPTH`, it raises:

```text
RLM recursion depth limit reached (RLM_DEPTH=1, RLM_MAX_DEPTH=1)
```

This prevents depth-1 children from spawning grandchildren in v1.

### Comm Open

For an allowed call:

```python
await rlm.run("subtask")
```

the shim:

```text
creates asyncio Future
creates Jupyter Comm target "host.request"
registers on_msg callback
opens the comm with:
  {
    "type": "rlm.run",
    "prompt": "subtask",
    "kwargs": {}
  }
awaits the Future
```

The callback strips the reply's `status` field and converts the payload into `RLMResult`, or raises `RuntimeError` when the host reports an error. The comm-open/await machinery is the public `host_request()`; `run()` is a typed wrapper around it, and other kernel-side skills reuse `host_request()` for their own request types.

The shim accepts `**kwargs` and includes them in the comm payload. The TypeScript host supports `name="..."` for an orchestrator-chosen child session name and `model="provider/model"` for an exact model selection; all other kwargs are rejected with a clear error instead of being ignored. `find_models()` searches a bounded catalog containing only models backed by active, non-expired credentials and returns `provider`, `id`, `name`, and exact `selector` fields.

### Why Control-Channel Comm Replies Exist

IPython handles shell-channel messages serially. While a cell is running:

```python
await rlm.run("subtask")
```

the kernel is still inside the active `execute_request` handler. If the TypeScript host replies with a normal shell-channel `comm_msg`, the kernel may not dispatch that message until the current execute request finishes. But the execute request cannot finish because it is awaiting the comm reply.

That is a deadlock.

The shim fixes the kernel side by registering `comm_msg` and `comm_close` handlers on the kernel control channel. The TypeScript host sends recursion replies over the control channel. The control channel can be processed while shell execution is still awaiting.

Because control handlers may wake the Future from a different thread, the shim resolves with:

```python
loop.call_soon_threadsafe(...)
```

## TypeScript Comm Handling

`KernelManager` starts a persistent IOPub pump when the kernel starts. Comm messages are handled before the active execution `msg_id` filter:

```text
for each iopub message:
  if msg_type is comm_open / comm_msg / comm_close:
    handleCommMessage(incoming)
    continue

  if no active execution:
    ignore

  if parent_header.msg_id != active execute_request:
    ignore

  handle stdout / stderr / result / error / idle
```

This matters because `comm_open` messages may not use the active execute request as their parent, and Python `asyncio` tasks can open RLM comms after the scheduling cell has already returned to idle.

The comm handler tracks:

```text
commTargets: comm_id -> target_name
handledHostRequestCommIds: comm ids already started
```

For target `host.request`, it starts work asynchronously and dispatches on the payload `type`:

```text
comm_open target "host.request"
  |
  v
startHostRequestFromComm(comm_id, data)
  |
  v
handleHostRequest(data)
  |
  v
options.hostHandlers[data.type](data)
  |
  v
sendCommMessage(comm_id, { status: "ok", ...result })
```

The RLM handlers include `rlm.run` for child creation, `rlm.find_models` for bounded authenticated model discovery, and `rlm.list_subagents` for the current parent session's automatic child registry.

Unknown types fail with `host request type "<type>" is not available in this session`.

Errors are returned as:

```json
{
  "status": "error",
  "error": "message"
}
```

The send path uses `control` if available, then falls back to `shell`.

## Child AgentSession Execution

The root `AgentSession` registers typed handlers into the root kernel:

```typescript
hostHandlers: {
  "rlm.run": createRlmRunHostHandler(({ prompt, kwargs }) => this.runRlmChild(prompt, kwargs)),
  "goal.get": ...,      // only when goals are enabled
  "goal.create": ...,
  "goal.complete": ...,
}
```

`runRlmChild()` is the TypeScript owner of actual recursion.

Sequence:

```text
runRlmChild(prompt, kwargs)
  |
  | check current depth < max depth
  | resolve an exact optional model selector against authenticated models
  | fall back to the parent model with a user-facing warning if unavailable
  | otherwise inherit the parent model
  v
create child session dir
  |
  | <parent rlm session dir>/sub-xxxxxxxx
  v
create child SessionManager
  |
  | append selected model change
  | append thinking level change
  v
create child Agent
  |
  | copies parent streamFn, convertToLlm, provider hooks,
  | transport settings, thinking budgets, retry settings
  v
create child AgentSession
  |
  | own KernelManager
  | same tools by name
  | same resource loader and model registry
  | RLM_DEPTH = parent depth + 1
  | RLM_MAX_DEPTH = parent max depth
  | RLM_SESSION_DIR = child dir
  v
child.prompt(prompt)
  |
  v
wait for idle
  |
  v
return final assistant text as answer
```

The child returns:

```typescript
{
  answer: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  turns: number;
  session_dir: string | null;
  model: string;
  warning?: string;
}
```

Usage is aggregated from assistant message usage:

```text
prompt_tokens = input + cacheRead + cacheWrite
completion_tokens = output
```

Turns are counted as assistant messages in the child transcript.

The answer is the child's final assistant text. This matches the RLM-1 training surface: the model stops calling tools and the final assistant text is the answer.

By default, a child inherits the parent's current model. When a user or skill
requests a different model, the orchestrator first searches the bounded
authenticated catalog, chooses a candidate, and passes its exact selector:

```python
matches = await rlm.find_models("DeepSeek V4 Flash")
result = await rlm(
    "Check the API",
    model=matches[0].selector,
)
```

`find_models()` returns up to eight matches by default and never more than 20.
Each match exposes `provider`, `id`, `name`, and the exact `provider/model`
`selector`; only models backed by active, non-expired credentials are included.
The full catalog is never injected into the system prompt.

`rlm.run(model=...)` intentionally accepts only an exact selector. If that
selector is unknown, unauthenticated, expired, unavailable, or fails auth
preflight, the child uses the parent model and the result returns the actual
`.model` plus a `.warning` that the parent must surface to the user. A selected
model is persisted with the child and remains active on later turns; changing
the parent model does not update existing children.

### Parent-Scoped Subagent Registry

The host exposes the current parent session's direct children without relying on
Python task handles or a model-maintained file:

```python
children = await rlm.list_subagents()
for child in children:
    print(
        child.rlm_child_id,
        child.active_session_id,
        child.session_id,
        child.session_name,
        child.session_dir,
        child.status,
    )
```

Entries have status `running` while the initial `rlm()` call is active and
`completed` after a successful call returns. Every child also gets a readable,
collision-resistant default `session_name` derived from its task and child ID,
for example `subagent-check-the-http-api-a1b2c3d4`. The orchestrator can choose
an exact name at spawn time with `await rlm("Check the API", name="api-reviewer")`;
empty, overlong, or already-addressable names are rejected. Users and
orchestrators can rename it later without changing the child ID. Failed or
cancelled children are
removed. Because the registry is owned by the TypeScript parent session, it
remains available after kernel restart, state restore, or compaction even if the
original Python `asyncio.Task` handle was lost.

In daemon mode `active_session_id` identifies the retained child session. The
same parent/orchestrator can continue it directly:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    await agent_message.send(child.session_name, "Check the latest change.")
```

That message starts an ordinary follow-up turn in the existing child context; it
does not reopen or alter the completed `rlm()` result. Inline and in-process
children have `active_session_id=None`, so they remain inspectable but are not
addressable through daemon agent messaging.

Delete a direct child by passing its registry entry or any exact registry
identifier (`session_name`, `rlm_child_id`, `session_id`, or
`active_session_id`):

```python
child = (await rlm.list_subagents())[0]
deleted = await rlm.delete_subagent(child)
# Equivalent when the child has a chosen name:
# deleted = await rlm.delete_subagent("api-reviewer")
```

Deletion cancels a running child and waits for its runtime to close. A completed
retained child closes immediately. In both cases it is removed from
`rlm.list_subagents()` and, in daemon mode, from agent messaging and observation.
Deletion does not erase the child's session transcript or artifacts on disk.
Only direct children in the current parent registry can be selected; unknown or
ambiguous selectors raise an error. The returned `RLMSubagent` is the deleted
entry's final registry snapshot.

Together these APIs provide the parent-scoped lifecycle operations: create with
`rlm(...)`, read with `rlm.list_subagents()` and `agent_observe`, continue/update
with `agent_message.send(...)`, and delete with `rlm.delete_subagent(...)`.

The registry is scoped to the parent session transcript. Closing or replacing a
daemon runtime cascades cleanup to its resident children; reopening that same
parent session rehydrates its successfully completed children from the
parent's artifact registry so they remain listable, messageable, and deletable.
An unrelated new parent session inherits nothing, and inline children are not
rehydrated. Deletion writes a durable tombstone before it reports success, so a
deleted child stays removed while its transcript and artifacts remain on disk.
There is no task/result migration or general cross-session reopen API.

### Cost Accounting

`RLMResult.usage` reports the child session's token usage. The parent session's displayed usage and cost do not currently fold child usage into the parent assistant-message totals. Child cost is independent in v1 and should be read from the child result or child session until parent aggregation is added.

## Goal Skill Over the Host Bridge

Goals are not harness tools. The model's only built-in tool is `ipython`; the goal feature is exposed as the bundled Python skill `goal`, which the kernel bootstrap imports into the user namespace like any other Python skill:

```python
await goal.get()
await goal.create("ship the release notes", token_budget=200000)
await goal.complete()
```

Each call is a thin wrapper over `rlm.host_request("goal.<op>", {...})`. All goal state — status transitions, token/wall-clock accounting, persistence, continuation re-prompting — lives in the TypeScript `AgentSession`:

```text
model runs `await goal.complete()` inside an ipython cell
  |
  | comm target "host.request", payload { "type": "goal.complete" }
  v
KernelManager dispatches to hostHandlers["goal.complete"]
  |
  v
AgentSession.handleGoalHostRequest("goal.complete")
  |  flips goal state to complete, marks the run for usage accounting,
  |  emits goal_update to connected clients
  v
comm reply { status: "ok", goal: {...}, completion_budget_report: ... }
```

Replies use snake_case keys (`tokens_used`, `remaining_tokens`, `completion_budget_report`) since they are a Python-facing API.

The re-prompting loop is unchanged and entirely host-side: while a goal is active the session injects `goal_context` continuation messages after each turn, steers a budget-limit context when the token budget is exhausted, and stops continuing once `goal.complete` arrives over the bridge (or the user pauses/clears the goal). Because completion arrives mid-cell rather than as a detectable tool call, the session records that completion was requested during the run so the completing turn's tokens still count toward the goal budget.

When goals are disabled for a session (`includeGoals: false`), the goal skill is filtered out of the kernel and the system prompt, and the `goal.*` handlers are not registered — calls fail with the unknown-type error above.

## Session Directory Layout

For a persisted root session:

```text
~/.prime/agent/sessions/<project>/
  2026-..._<root-session-id>.jsonl
  2026-..._<root-session-id>/
    sub-dccb69c8/
      2026-..._<child-session-id>.jsonl
      sub-.../
```

The root RLM session dir is derived from the root JSONL session file path by removing `.jsonl`. Child directories are named `sub-xxxxxxxx`, matching the `rlm-harness` child directory convention.

Each child kernel sees:

```text
RLM_DEPTH=1
RLM_MAX_DEPTH=1
RLM_SESSION_DIR=<root session dir>/sub-xxxxxxxx
```

With the default max depth, a child attempting another `rlm.run()` fails before opening a comm.

## Parallel Sub-Agents

Python parallelism uses normal asyncio:

```python
results = await asyncio.gather(
    rlm("capital of Japan"),
    rlm("capital of Brazil"),
    rlm("capital of Egypt"),
)
print([r.answer for r in results])
```

The flow is:

```text
one IPython execute_request
  |
  v
three Python rlm calls
  |
  | each opens its own comm_id
  v
KernelManager starts three runRlmChild() promises
  |
  v
three independent child AgentSessions
  |
  v
three comm replies
  |
  v
asyncio.gather resolves in the IPython cell
```

The root kernel still executes one cell. The concurrency comes from multiple comms and multiple child `AgentSession` instances, each with its own kernel.

## What This Deliberately Does Not Do

The runtime does not import or subprocess `rlm-harness`.

The Python shim does not:

- create child sessions itself
- call model providers
- run an agent loop
- know about TUI state
- know about skills beyond being importable in the kernel
- do cost tracking

Those stay in TypeScript so children share the parent harness implementation:

- `AgentSession`
- `KernelManager`
- provider registry and auth
- session storage
- cost and usage accounting
- skills loader
- slash-command and extension environment

## Failure Modes

Common failures and where they surface:

```text
prime-agent-runtime missing from the kernel environment
  -> kernel startup succeeds
  -> rlm.run raises RuntimeError with rebuild or PRIME_AGENT_KERNEL_PYTHON instructions when called

RLM_DEPTH >= RLM_MAX_DEPTH
  -> Python RuntimeError before comm_open

no selected model
  -> TS runRlmChild throws, Python receives RuntimeError

unsupported rlm.run kwargs
  -> TS runRlmChild throws "Unsupported rlm.run kwargs: ..."

unknown, unauthenticated, expired, or unavailable rlm.run model
  -> TS runRlmChild uses the parent model and returns RLMResult.warning

child provider error
  -> child agent final error behavior is reflected in its final assistant state

kernel comm reply sent on shell channel
  -> deadlock risk while execute_request is awaiting
  -> current implementation replies over control channel
```

## Validation Commands

Single child:

```bash
./prime-agent.sh -p 'use the ipython tool to run `print((await rlm.run('"'"'What is the capital of Japan?'"'"')).answer)`'
```

Parallel children:

```bash
./prime-agent.sh -p 'use the ipython tool with asyncio.gather to call rlm.run() three times in parallel for: capital of Japan, capital of Brazil, capital of Egypt. Print only the three answers as a Python list.'
```

Depth cap:

```bash
./prime-agent.sh -p 'use the ipython tool to run `result = await rlm.run("use the ipython tool to execute this exact Python code and print the exception message: try:\n    await rlm.run('\''nested'\'')\nexcept Exception as e:\n    print(type(e).__name__, str(e))")\nprint(result.answer)`'
```
