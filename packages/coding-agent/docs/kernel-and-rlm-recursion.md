# Kernel and RLM Recursion

This document explains the IPython kernel transport and the recursive `rlm` sub-agent bridge.

The important design constraint is that the Python `rlm` package in the kernel is only a shim. It preserves the model-facing API from `rlm-harness`, but it does not run a child agent loop in Python. Child agents are run by the TypeScript host through the same `AgentSession` machinery as the parent.

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
  | Jupyter comm target "rlm.run"
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
  comm_open / comm_msg handling for rlm.run.

packages/coding-agent/src/core/tools/ipython.ts
  Tool wrapper around KernelManager. Starts the kernel and bootstraps the
  rlm object into the user namespace.

packages/coding-agent/src/core/agent-session.ts
  Parent session owns recursion settings and implements runRlmChild().

packages/coding-agent/src/core/rlm-runtime.ts
  TypeScript request/result types for the rlm.run bridge.

prime-agent-runtime/src/rlm/__init__.py
  Python shim installed into ~/.prime/agent/kernel-venv. Exposes rlm, rlm.run(),
  RLMResult, and TokenUsage.

scripts/setup-kernel-venv.sh
  Thin wrapper around the automatic kernel bootstrap.
```

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
RLMResult
TokenUsage
```

`RLMResult` matches the model-visible shape from `rlm-harness`:

```python
result.answer       # str
result.usage        # TokenUsage
result.turns        # int
result.session_dir  # pathlib.Path | None
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
creates Jupyter Comm target "rlm.run"
registers on_msg callback
opens the comm with:
  {
    "type": "run",
    "prompt": "subtask",
    "kwargs": {}
  }
awaits the Future
```

The callback converts host payloads into `RLMResult` or raises `RuntimeError`.

The shim accepts `**kwargs` for API compatibility with `rlm-harness` and includes them in the comm payload. V1 does not apply any kwargs on the TypeScript side. Unsupported kwargs are rejected with a clear error instead of being ignored.

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
handledRlmCommIds: comm ids already started
```

For target `rlm.run`, it starts work asynchronously:

```text
comm_open target "rlm.run"
  |
  v
startRlmRunFromComm(comm_id, data)
  |
  v
handleRlmRunRequest(data)
  |
  v
options.rlmRunHandler({ prompt, kwargs })
  |
  v
sendCommMessage(comm_id, { status: "ok", ...result })
```

Errors are returned as:

```json
{
  "status": "error",
  "error": "message"
}
```

The send path uses `control` if available, then falls back to `shell`.

## Child AgentSession Execution

The root `AgentSession` passes this handler into the root kernel:

```typescript
rlmRunHandler: ({ prompt, kwargs }) => this.runRlmChild(prompt, kwargs)
```

`runRlmChild()` is the TypeScript owner of actual recursion.

Sequence:

```text
runRlmChild(prompt)
  |
  | check current depth < max depth
  | require selected model
  v
create child session dir
  |
  | <parent rlm session dir>/sub-xxxxxxxx
  v
create child SessionManager
  |
  | append model change
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
}
```

Usage is aggregated from assistant message usage:

```text
prompt_tokens = input + cacheRead + cacheWrite
completion_tokens = output
```

Turns are counted as assistant messages in the child transcript.

The answer is the child's final assistant text. This matches the RLM-1 training surface: the model stops calling tools and the final assistant text is the answer.

### Cost Accounting

`RLMResult.usage` reports the child session's token usage. The parent session's displayed usage and cost do not currently fold child usage into the parent assistant-message totals. Child cost is independent in v1 and should be read from the child result or child session until parent aggregation is added.

## Session Directory Layout

For a persisted root session:

```text
~/.pi/agent/sessions/<project>/
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

child provider error
  -> child agent final error behavior is reflected in its final assistant state

kernel comm reply sent on shell channel
  -> deadlock risk while execute_request is awaiting
  -> current implementation replies over control channel
```

## Validation Commands

Single child:

```bash
./pi-test.sh -p 'use the ipython tool to run `print((await rlm.run('"'"'What is the capital of Japan?'"'"')).answer)`'
```

Parallel children:

```bash
./pi-test.sh -p 'use the ipython tool with asyncio.gather to call rlm.run() three times in parallel for: capital of Japan, capital of Brazil, capital of Egypt. Print only the three answers as a Python list.'
```

Depth cap:

```bash
./pi-test.sh -p 'use the ipython tool to run `result = await rlm.run("use the ipython tool to execute this exact Python code and print the exception message: try:\n    await rlm.run('\''nested'\'')\nexcept Exception as e:\n    print(type(e).__name__, str(e))")\nprint(result.answer)`'
```
