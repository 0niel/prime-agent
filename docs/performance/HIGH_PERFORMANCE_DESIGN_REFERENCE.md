> **Reference document.** The primary review surface is [HIGH_PERFORMANCE_DESIGN.md](./HIGH_PERFORMANCE_DESIGN.md). This file keeps the detailed contracts, evidence, security rules, and fault matrices behind the PR topology.

# High-Performance Prime Agent Design

**Status:** Proposed design. This document does not change runtime behavior.

**Baseline:** Prime Agent `main` at [`a18809e00`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a18809e0) (v0.7.1 issue reports).  
**Review date:** 2026-08-09.  
**Owners:** `TBD` for each phase.  
**Evidence policy:** Facts below cite a source. Items marked **Target**, **Hypothesis**, or **Untested** need validation before release.  
**Writing policy:** This draft uses ASD-STE100-oriented simple technical English. No approved ASD checker has certified it.

## 1. Executive decision

Prime Agent must scale by making lifecycle state small, durable, and correct.

Prime Agent must keep IPython as the production compatibility executor.

Prime Agent must keep TypeScript for the control loop and model loop.

Prime Agent must use Rust only for narrow, measured data services.

Prime Agent must keep default RLM recursion at `1` now.

Prime Agent may set default recursion to `2` only after the gates in section 7 pass.

Prime Agent must not use production batching as a main agent or CLI performance feature.

Production batching means synthetic grouping of separate executor operations into one hidden executor call.

Synthetic executor batching changes API boundaries, timing, cancellation, streaming, errors, and user visibility.

Prime Agent may coalesce internal parent state, events, usage records, and persistence writes.

Internal coalescing must preserve the logical record order and terminal delivery rules.

Prime Agent must make arbitrary user-defined role policy a native RLM configuration.

The runtime must not require a built-in planner, researcher, implementation, or review vocabulary.

Users must be able to select provider-neutral models, effort, allowed role edges, structural breadth, structural depth, output schemas, and attenuated capabilities.

The planning model or user chooses the task-specific decomposition, roles, and dependency graph within that policy.

Prime Agent must record the exact requested and resolved role, model, revision, effort, fallback, and policy version.

Prime Agent must not hard-code any provider model family or model-profile alias into routing policy.

Prime Agent must dispatch independent model requests independently.

Prime Agent must not add a global or client-side concurrency cap, admission queue, synthetic `429`, or provider throttle for independent model requests.

The system must instead remove avoidable parent work and retain only bounded live state.

The near-term product outcome is a responsive agent tree during large fanout and long sessions.

## 2. Goals and non-goals

### Goals

1. Keep interactive CLI input responsive while child agents run.
2. Keep root, nested, daemon, and ACP session lifecycle recoverable.
3. Bound whole-swarm memory by active work plus configured retained summaries, artifacts, and database-backed indexes.
4. Deliver terminal child results through a durable inbox with idempotent materialization.
5. Preserve enough raw data to debug, replay, and compare a run.
6. Make a stalled child visible without treating normal long work as failure.
7. Show the exact provider and model for every live and persisted agent row.
8. Support large fanout without changing model-request independence.
9. Preserve IPython, Python packages, host communication, and magics.
10. Preserve the Continual Harness abstraction while adding a correct storage adapter, reversible SQLite backend, separately evaluated bounded selection, and a measured Rust data service.
11. Make MCP setup a supported first-class CLI flow.
12. Compare Prime Agent with capability-matched alternative agent systems under one fair protocol.

### Non-goals

1. This plan does not replace IPython with Bun, minimal Python, QuickJS, or Rust.
2. This plan does not claim an end-to-end model-task speedup from executor microbenchmarks.
3. This plan does not introduce automatic language guessing for a REPL.
4. This plan does not launch paid evaluations without approval.
5. This plan does not merge an open PR only because its CI is green.
6. This plan does not copy provider throttles, global caps, in-process assumptions, or unsafe `yolo` behavior from other agents.
7. This plan does not promise an implementation schedule or measured results that do not exist.

### Required technical terms

- **Artifact reference:** An opaque identifier for durable data that is outside hot process memory.
- **Generation fence:** A monotonic assignment number that rejects messages from an old worker assignment.
- **Passivation:** The release of heavy live runtime objects after durable state is safe.
- **Terminal envelope:** A small durable record that describes the final result of one operation.
- **Materialization:** The durable creation of one parent inbox or turn item from a terminal envelope.
- **Linearization point:** The durable append that decides whether materialization exists.
- **Progress event:** A bounded record that proves useful work or a state change occurred.

## 3. Architecture baseline and evidence

Prime Agent has a TypeScript control plane, a daemon and worker lifecycle, an agent loop, session JSONL, and an IPython kernel path.

The repository contains daemon supervisor, lifecycle, catalog, recovery, snapshot, Agents UI, MCP, and RLM components at the baseline revision.

Relevant source paths include:

- [`packages/coding-agent/src/modes/daemon/daemon-supervisor.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/coding-agent/src/modes/daemon/daemon-supervisor.ts)
- [`packages/coding-agent/src/modes/daemon/daemon-protocol.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/coding-agent/src/modes/daemon/daemon-protocol.ts)
- [`packages/coding-agent/src/modes/agents-view/agents-view-mode.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/coding-agent/src/modes/agents-view/agents-view-mode.ts)
- [`packages/coding-agent/src/core/mcp/mcp-manager.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/coding-agent/src/core/mcp/mcp-manager.ts)
- [`packages/ai/src/mcp/index.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/ai/src/mcp/index.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/agent/src/agent-loop.ts)

The executor benchmark used production v0.7.0, not v0.7.1.

The benchmark therefore informs substrate decisions but does not measure this exact baseline.

The benchmark ran on one macOS arm64 host in a sequential single-session setting.

It did not measure model inference, remote tools, multi-agent contention, cancellation races, or task success.

Read the full evidence at [`BENCHMARK_RESULTS.md`](../prime-agent-executor-bench/BENCHMARK_RESULTS.md).

### Measured executor facts

The benchmark recorded 28,520 timed correctness checks and all passed their benchmark oracles.

This is not a full production compatibility proof.

The production IPython tiny `1 + 1` p50 was 2.053 ms.

Persistent minimal Python, Bun, and native QuickJS p50 values were 0.021 ms, 0.020 ms, and 0.020 ms.

The production 28-operation synthetic trace p50 was 105.944 ms.

The minimal Python, Bun, and native QuickJS trace p50 values were 30.027 ms, 24.371 ms, and 30.451 ms.

Production first-ready startup p50 was 840.852 ms.

Production worker RSS after initialization was 65.16 MiB.

The sampled production worker RSS after 10,000 calls was 79.42 MiB.

These are snapshots and do not prove a memory leak or peak RSS.

Production `git status` mean was 154.751 ms.

Bun `git status` mean was 151.127 ms.

This shows that executor savings can disappear behind real process work.

Production 10 MiB file-read mean was 31.182 ms.

Native 10 MiB file-read mean was 87.684 ms.

This rejects a broad “native is always faster” claim.

The benchmark showed a 1,005x reduction for 1,000 tiny production operations when one synthetic in-executor batch replaced 1,000 crossings.

That result changes the API boundary.

It is evidence about crossing costs, not permission to hide or batch user-visible agent actions.

The benchmark conclusion is correct for this plan: retain production IPython and consider a narrow typed sidecar only after compatibility, safety, and agent-success validation.

### Benchmark commands

Run these commands only from the benchmark checkout and record its revision, environment, raw JSONL, and manifest.

```bash
npm run benchmark:executors
# Equivalent full profile command from the benchmark report:
bash scripts/run-execution-substrate-bench.sh --profile full
```

These commands are documentation only.

This design does not claim that they ran for this proposal.

## 4. Root scaling blockers

The following reports are live evidence, not inferred implementation facts.

| Blocker | Evidence | Design response |
|---|---|---|
| Usage attribution flood | [#1054](https://github.com/PrimeIntellect-ai/prime-agent/issues/1054) reports 553 `child_usage_attributed` entries in 20.1 minutes, a 73/minute peak, 97–99% CPU, and 3.1 GB RSS for one parent tree. | Coalesce internal usage state and durable summaries. Do not write one parent transcript entry per child message. |
| Long-session heap OOM | [#1063](https://github.com/PrimeIntellect-ai/prime-agent/issues/1063) reports a roughly 4 GB Node heap OOM after 1h 52m at 79% context. | Bound resident state. Passivate cold data. Use artifacts and snapshots. Test long sessions. |
| Stuck lifecycle and orphans | [#1072](https://github.com/PrimeIntellect-ai/prime-agent/issues/1072) reports failed idle eviction, stuck closing/executing states, and worker plus `ipykernel` orphans while JSONL remains intact. | Use a durable typed lifecycle ledger, progress-based stall logic, idempotent close, and an orphan reaper. |
| PID reuse and poisoned global heartbeat list | [#1045](https://github.com/PrimeIntellect-ai/prime-agent/issues/1045) reports `EPERM` false-alive handling after PID reuse and one failed descriptor poisoning global `heartbeats_list`. | Bind liveness to process start identity. Isolate unhealthy row errors from aggregate results. |
| Queued programmatic prompts | [#1000](https://github.com/PrimeIntellect-ai/prime-agent/issues/1000) reports idle programmatic prompts queued for more than eight hours until a human types. | Use a durable operation registry with callback events. Wake the input pump on every accepted or coalesced programmatic delivery. |
| One-shot child loss | [#792](https://github.com/PrimeIntellect-ai/prime-agent/issues/792) reports `-p` exits that discard RLM children and auto-refine work. | Define an explicit one-shot terminal policy. Persist unresolved operations. Exit nonzero or await according to a selected contract. |
| Poisoned kernel | [#764](https://github.com/PrimeIntellect-ai/prime-agent/issues/764) reports repeated kernel crash and manual shutdown recovery. | Keep a typed kernel state and quarantine/recreate a poisoned kernel without corrupting session state. |
| Retained update promises | [#957](https://github.com/PrimeIntellect-ai/prime-agent/issues/957) identifies one retained promise per tool update at [`agent-loop.ts:850-896`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/agent/src/agent-loop.ts#L850-L896). | Use a serialized coalescing drain or bounded in-flight set. Remove settled promises. |
| Streamed JSON reparsing | [#942](https://github.com/PrimeIntellect-ai/prime-agent/issues/942) identifies full-prefix parse and repair work per streamed delta. | Use an incremental accumulator. Keep raw deltas. Perform one authoritative final parse. |

No issue report alone proves a general root cause.

Each proposed response needs a reproducer and a regression test.

## 5. Target actor and lifecycle design

### 5.1 Core rule

A session, turn, child, tool operation, kernel, and worker must each have a durable identity and a typed lifecycle.

The runtime may rebuild in-memory indexes from the durable ledger.

The runtime must never require an old in-memory promise to decide a terminal outcome.

Use this common lifecycle shape:

`created → admitted → starting → running ↔ quiescent → passivating → passive | stopping → stopped`

Use `failed`, `timed_out`, `stalled`, and `unknown_after_crash` as explicit outcome states.

Each entity type must define which transitions it supports.

### 5.2 Typed lifecycle ledger

**Target:** Store append-only typed lifecycle records beside session data.

Each record must contain:

```ts
type LifecycleState =
  | "created"
  | "admitted"
  | "starting"
  | "running"
  | "quiescent"
  | "passivating"
  | "passive"
  | "stopping"
  | "stopped"
  | "failed"
  | "timed_out"
  | "stalled"
  | "unknown_after_crash";

type LifecycleRecord = {
  schemaVersion: 1;
  operationId: string;
  entity: "session" | "turn" | "child" | "tool" | "kernel" | "worker" | "delivery";
  generation: number;
  assignmentId: string;
  sequence: number;
  at: string;
  state: LifecycleState;
  cause?: string;
  parentOperationId?: string;
  process?: { pid: number; startId: string };
  payloadRef?: ArtifactRef;
};
```

The implementation must define closed state enums before it writes these records.

The implementation must reject an invalid state transition.

The implementation must make a duplicate record harmless.

The implementation must keep state snapshots as accelerators rather than authorities.

A snapshot must identify the highest applied ledger sequence.

A recovery process must replay from that sequence.

Materialize a rebuildable active-operation index at the checkpoint sequence.

Store the current `(operationId, childId, generation, assignmentId)` token in that index.

Passivate, revive, close, progress, and terminal actions must compare that token with the durable current assignment.

A stale action must do no work and must append a bounded audit record.

The ledger remains authoritative when the index is missing or corrupt.

### 5.3 Generation fencing

The supervisor must allocate each generation and append that allocation before it starts or adopts a worker.

Every session-worker assignment must have a monotonic generation.

Use wall-clock UTC for audit timestamps.

Use one monotonic clock per process for durations and lease expiry.

Do not subtract timestamps from different process clocks.

Every worker command, progress event, close request, and terminal event must carry that generation.

The supervisor must ignore a message from an old generation.

The supervisor must not kill or trust a process only because its PID matches.

The supervisor must compare `(pid, processStartId)` with the recorded process identity.

Define `processStartId` for Linux, macOS, and Windows.

Fail safe and do not signal when the platform cannot prove process identity.

A process with an unmatched start ID is not the owned worker.

This directly addresses the PID reuse and `EPERM` failure reported in [#1045](https://github.com/PrimeIntellect-ai/prime-agent/issues/1045).

### 5.4 Durable terminal envelope and idempotent materialization

A child terminal result must use a durable envelope.

```ts
type TerminalEnvelope = {
  deliveryId: string;
  childId: string;
  childGeneration: number;
  terminal: "completed" | "failed" | "cancelled" | "timed_out" | "stalled" | "unknown_after_crash";
  resultRef?: ArtifactRef;
  summary: string;
  model: ModelMetadata;
  completedAt: string;
};
```

The child must persist the terminal envelope before it sends delivery.

The parent must append a durable inbox record before it schedules a turn.

That inbox append is the materialization linearization point.

The turn scheduler must use `deliveryId` as its idempotency key.

The scheduler must append a durable consumed record in the same session log as the turn action.

Recovery must schedule each unconsumed inbox record once.

Recovery must not schedule an inbox record that has a consumed record.

The parent must acknowledge `deliveryId` after the durable inbox append.

The child may retry the same `deliveryId` until acknowledgement.

The parent must deduplicate by `deliveryId`.

The parent must not create a second follow-up from a duplicate terminal delivery.

This provides at-least-once transport with idempotent parent materialization.

It does not claim exactly-once network delivery.

Fault tests must stop the process before and after each outbox, inbox, acknowledgement, schedule, and consumed append.

The terminal envelope must be small.

Large text, logs, tool output, and trajectories must use artifact references.

### 5.5 Progress, stalls, close, and reaping

A timer alone must not declare a child stalled.

The runtime must update `lastProgressAt` for meaningful state changes.

Meaningful progress includes a model event, a tool lifecycle event, a child event, an artifact checkpoint, or a state transition.

The runtime must record a reason for each update.

A stall policy must use operation type, configured expected duration, and last progress.

A stall event must first request diagnostic state.

A stall event must not silently delete a session.

`close(operationId, generation)` must be idempotent.

Passivation must first mark a precommit state with the current assignment token.

A same-generation use may cancel passivation before commit.

After commit, remove the live worker or kernel handle from lookup before asynchronous disposal.

A revival after commit must await disposal and create a fresh generation.

Concurrent revivals must share one single-flight operation.

A late dispose, progress, close, or terminal action from the old token must not change the revived child.

An idle timeout may request passivation.

It must not declare failure.

The close path must converge to one terminal state after retries or crashes.

The orphan reaper must scan the ledger and process table.

The reaper must verify process start identity before signaling a process.

The reaper must record its action and outcome in the ledger.

The reaper must clean only resources owned by the matching generation.

A visible close wait may end before cleanup completes.

The durable reaper obligation must remain until every owned worker, kernel, MCP stdio process, socket, artifact writer, and lease is reconciled.

A failed session row must not poison a global status operation.

Global status must return healthy rows and isolated row errors.

### 5.6 Scheduling

The scheduler must put a human prompt ahead of background follow-ups at the next safe turn boundary.

The scheduler must preserve FIFO order within one priority class unless a documented coalescing key merges work.

The scheduler must persist a queued programmatic operation before it returns acceptance.

Terminal, `follow_up`, and progress dispatch views may coalesce only after the durable inbox append.

Terminal materialization must not use a volatile dead-letter list as recovery truth.

The scheduler must schedule or wake the input pump for every accepted operation.

The scheduler must schedule or wake the input pump when it coalesces an operation.

This corrects the idle starvation shape reported in [#1000](https://github.com/PrimeIntellect-ai/prime-agent/issues/1000).

The scheduler must not busy wait.

The scheduler must not use `time.sleep()` polling as a completion mechanism.

### 5.7 Storage and replay limits

The ledger must not become a second unbounded transcript.

Lifecycle transitions, terminal envelopes, inbox records, consumed records, and audit records are durable facts.

The system must not coalesce those facts.

The system may coalesce repeated progress and UI status by `(entityId, generation, eventKind)`.

**Initial target:** Keep at most 128 progress events or 32 KiB of progress text in hot memory for one child.

Store older diagnostic progress in a bounded artifact when policy requires it.

**Initial target:** Create a compact index checkpoint after 1,000 ledger records or 8 MiB of new ledger data.

Make these thresholds configuration values and record them in the run manifest.

Compaction must preserve terminal, inbox, consumed, ownership, and audit facts.

A replay benchmark must measure index rebuild time for 1 MiB, 100 MiB, and 500 MiB sessions.

An artifact policy must define per-item bytes, per-session bytes, retention time, and deletion state.

The system must return a typed limit result when it cannot retain required data.

The system must not silently discard a terminal result or required audit fact.

Test artifacts may keep full raw trajectories under an explicit test retention policy.

Production telemetry must use a separate retention and access policy.

### 5.8 Identity-bound approval

Persist an approval proposal with an opaque ID, normalized action, target, owner family, generation, policy, expiry, and redacted preview.

Approval must consume that exact proposal ID once.

A changed action, stale generation, changed target, or expired proposal must require a new approval.

Headless mode must fail closed when required approval is absent.

Do not infer approval from a prior action with similar text.

## 6. Massive subagent design

### 6.1 Dispatch and ownership

Each child is an actor with an immutable identity, parent identity, generation, model metadata, lifecycle state, and artifact root.

Independent child model requests must dispatch independently.

Prime Agent must not add a shared semaphore, global queue, synthetic local rate-limit response, or client-side cap for those independent requests.

The provider remains responsible for provider-specific limits.

The child must surface a genuine provider response unchanged enough for diagnosis.

The parent must coalesce only its own derived state, UI events, usage accounting, and persistence writes.

The parent must not hide child work by placing calls into a synthetic executor batch.

Prepare one immutable `PreparedFamilyContext` for approved shared discovery data.

It may reference project instructions, a workspace index, skills, tool declarations, model metadata, and safe task policy.

It must not contain raw credentials, approval grants, live promises, mutable parent objects, or runtime handles.

A child must bind actual tools and runtimes under its own identity and generation.

Rebuild the context when workspace, settings, skills, tools, or model policy versions change.

Use a durable family ACL for status, history, message, cancel, result, and artifact access.

No model-visible API may discover or act on an unrelated family.

### 6.2 Bounded memory

The parent memory target is **O(active children)** plus bounded UI summaries and durable artifact handles.

The parent must not retain every child message, every update promise, or complete tool output in arrays.

Each child summary must have a bounded size.

Each child must write large outputs to a content-addressed or session-scoped artifact store.

Each artifact handle must include integrity metadata, content type, size, creator, owner scope, and retention policy.

Use an opaque owner-scoped identifier instead of a raw path or public content hash.

Check owner and session access on every read.

Keep storage paths inside a fixed root.

Reject path traversal and symlink escape.

Use authenticated integrity metadata.

Define encryption and key handling for secret-bearing artifacts.

Record create, read, export, and delete actions in an audit log.

Do not expose cross-user content equality through an artifact identifier.

The parent should retain the latest progress, a bounded event tail, counters, terminal envelope, and references.

The parent must passivate a completed or idle child.

Passivation must release heavy runtime objects while retaining the ledger index, bounded summary, model metadata, and artifact handles.

Lazy kernel creation must start a kernel only when the selected action needs it.

An idle kernel may be passivated or closed by a documented policy.

The policy must preserve session semantics or report that a fresh kernel is required.

A shared family service must record its owner, generation, lease, and borrowers.

A borrower must not close an owner kernel, MCP session, memory service, or artifact writer.

Root close and the durable reaper own final teardown.

A child that needs isolation must use its own supervised service generation.

The TypeScript host must own persisted Continual Harness writes. Children use the current `rlm.harness` API through the host bridge.

Children may submit candidate facts with evidence references.

Children must not run separate unbounded memory loops or write global memory without the existing approval policy.

Accepted `HarnessEntry` records are authoritative Continual Harness state. Generated refinement proposals are not accepted state until the existing apply path commits them. Neither replaces the session ledger for session replay.

A successful store commit is the Continual Harness durability boundary.

### 6.3 Structured result contract

A child must return a structured result through its terminal envelope.

```ts
type ChildResult = {
  schemaVersion: 1;
  status: "completed" | "failed" | "cancelled" | "timed_out" | "stalled" | "unknown_after_crash";
  summary: string;
  artifacts: ArtifactRef[];
  facts: Array<{ claim: string; evidenceRef?: ArtifactRef }>;
  nextActions: string[];
  error?: { code: string; message: string; diagnosticRef?: ArtifactRef };
  model: ModelMetadata;
};

type ModelMetadata = {
  requestedSelector?: string;
  initialResolvedSelector: string;
  terminalResolvedSelector: string;
  fallbackHistory?: string[];
};
```

The system must persist model metadata on child creation and terminal delivery.

The parent must use the structured result instead of scraping unbounded transcript text.

The system must preserve raw trajectories as artifacts for inspection and benchmark analysis.

Set byte and item limits for `summary`, `facts`, `nextActions`, and `error`.

Validate the result before terminal-envelope persistence.

Put raw, malformed, or oversize output in a diagnostic artifact.

Return one typed `invalid_result` failure when validation fails.

Do not scrape the full transcript or start an unbounded retry loop.

A missing live parent must not dead-letter or discard the terminal envelope.

### 6.4 Tree UI

The Agents UI must show root and nested children as a tree.

Each live row must show the current exact `provider/model` badge.

Show requested and resolved selectors when they differ.

Each persisted row must show the terminal resolved model that produced its result.

Do not infer the terminal model from only the session start model.

The current model metadata exists, but the detailed Agents row drops its subtitle according to this task’s source review.

The implementation must carry the subtitle through the detailed row renderer.

The implementation must test root rows, nested rows, active rows, completed rows, and follow-up rows after reload.

The implementation must test model inheritance, explicit child override, provider fallback, and terminal model persistence.

The implementation must test long provider and model names without breaking layout.

### 6.5 Execution isolation tiers

Current descendants share the root session worker process and event loop.

This keeps startup cost low.

It also lets one noisy child raise parent CPU and heap use.

Prime Agent must not start one Node process and one Python kernel for every child by default.

That design would make large fanout expensive before useful work starts.

Use three explicit tiers:

1. A model-only child uses a lightweight logical actor and no kernel.
2. A tool child starts IPython, Bun, or a process runner only when it needs that runtime.
3. A high-memory or crash-prone child may use a supervised worker process with the same ledger and terminal envelope.

Profile each tier under 1, 4, 16, and 64 children.

Promote a child to another process only when isolation improves the measured failure or memory case.

Do not use process isolation as a hidden model-request admission limit.

### 6.6 Replay-safe provider retry

Retry only the affected child request.

Retry only a typed transient provider failure.

Honor a genuine provider retry hint when policy permits it.

Use bounded, abortable, jittered delay.

Do not retry after visible text, an image, a tool call, or another replay-unsafe side effect.

Keep the provider status, body class, and retry hint in a redacted diagnostic artifact.

Do not turn this policy into a shared request queue, client rate limit, or synthetic `429`.

### 6.7 Native swarm roles and profiles

Prime Agent must make arbitrary user-defined role policy a native RLM concept.

A swarm profile is a versioned immutable catalog of allowed role labels, role edges, model selectors, effort, capabilities, output contracts, and graph limits.

It does not predeclare a task graph.

The planning model or user proposes the task graph for each task.

It is not a new provider scheduler.

It must preserve nonblocking `rlm()` admission and independent request dispatch.

#### Configuration surface

Use the provider-neutral schema `prime-agent.swarm/v1`.

The graph-first document contains a complete [role and model-profile alias example](./HIGH_PERFORMANCE_DESIGN.md#swarm-profile-example).

The schema must support:

- a root role;
- named provider and model selectors;
- requested reasoning effort and unsupported-effort policy;
- ordered compatible fallbacks;
- optional user-defined phase metadata;
- allowed child roles;
- model allow-lists per role;
- structural depth, node, edge, and child bounds;
- output schemas and terminal policy;
- tool, filesystem, process, MCP, artifact, and spawn capabilities;
- runtime policy;
- planned token and cost visibility;
- data-classification and provider capability requirements.

Keep role labels separate from model-profile aliases.

A role label defines authority and allowed role edges.

A model-profile alias defines capabilities, candidate models, effort, and fallback policy.

Aliases such as `deliberate`, `general`, or `fast` are user data.

They must not trigger built-in behavior.

A selector must use an adapter-neutral identity:

```ts
type SwarmModelSelector = {
  provider: string;
  model: string;
  revision?: string;
  effort?: string;
  onUnsupportedEffort: "error" | "omit";
  requestParameters?: Record<string, unknown>;
  requiredCapabilities?: string[];
  dataClassification?: string;
};
```

The resolved assignment must add the adapter version, effective parameters, exact resolved model and revision, exact resolved effort, fallback reason, timing, usage, and cost.

The runtime must persist requested and resolved values separately.

Do not add routing logic for a named provider model or model-profile alias.

A user must be able to bind the same role graph to different providers.

#### Scope and trust

Support user profiles and trusted project profiles.

Proposed commands are `swarm init`, `list`, `get`, `validate`, `doctor`, and `remove`.

A session selects a profile with an explicit CLI or settings value.

A project profile such as `.prime-agent/swarm.yaml` must require project trust.

It must not interpolate environment secrets.

Credentials must remain endpoint-bound secret references outside the profile.

Compile the effective profile to canonical JSON at root acceptance.

Persist its redacted form, fingerprint, schema version, policy versions, and source scopes before child admission.

Use this precedence order:

1. Hard platform and release policy.
2. Parent live grants and generation-bound approvals.
3. Root session or approved evaluation policy.
4. Selected role and task node.
5. Versioned schema defaults.

A lower level may narrow authority.

It must not widen authority.

Reject unknown fields, missing selectors, fallback cycles, graph cycles, unknown roles, missing schemas, unsupported effort according to policy, and invalid structural bounds.

#### Structural breadth and depth

`maxNodes`, `maxEdges`, `maxChildrenPerNode`, and `maxChildDepth` bound the accepted graph shape.

They are not request-concurrency limits.

After a node is accepted and its dependencies are complete, dispatch it independently.

Do not hold it behind a swarm-wide semaphore, token bucket, provider queue, hidden batch, or synthetic `429`.

The release default for `maxChildDepth` remains `1` until the recorded depth-2 gate passes.

An explicit larger expert value remains subject to the host hard safety ceiling and current release policy.

Only a role with an allowed child-role edge may spawn at the next depth.

#### Plan graph

Use a bounded schema such as `PlanGraphV1`.

The planning model or user proposes its task-specific nodes and edges.

The role policy does not predeclare them.

A node must contain:

- a stable `nodeId`;
- a named role;
- dependency node IDs;
- a bounded task packet or artifact references;
- an output schema;
- a terminal policy;
- an optional selector override from the role allow-list.

Persist and validate the whole plan before worker admission.

A planner model's prose is not executable authority.

Only the validated plan record can create assignments.

A node becomes eligible after durable terminal results exist for every dependency.

Record its `operationId`, `childId`, `generation`, `assignmentId`, role, selector, requested model, and policy fingerprint before `rlm()` admission.

Admit all eligible independent nodes immediately.

Terminal delivery must use the durable outbox, inbox, acknowledgement, and consumed path.

A callback must wake the input pump.

#### Capability attenuation

Resolve child authority with set intersection:

```text
platform ∩ parent grant ∩ role policy ∩ node request ∩ active approval
```

A child must not gain a model, tool, filesystem root, process right, MCP server, spawn role, secret, artifact right, or approval that the parent cannot grant.

Reuse only `PreparedFamilyContext` references that match current workspace and policy versions.

Keep family-scoped messaging and observation rules.

Do not create a process-global model-visible swarm registry.

#### Fallback and effort

Fallback is per assignment.

It must use the replay-safe provider retry rule in section 6.6.

A fallback must be in the role allow-list.

It must meet the original capability, data, context, tool, output, and residency requirements.

Do not fall back after visible text, an image, a tool call, or another replay-unsafe action.

Record the decision and the redacted original provider diagnosis.

Do not silently change or omit requested effort.

Use the selector's explicit unsupported-effort policy.

#### Budget visibility

Budget is an estimate and operator boundary.

It is not a hidden dispatch throttle.

Show planned and actual tokens and cost per node, role, family, and run.

Emit typed `budget_at_risk` and `budget_exceeded` events.

The operator may stop or cancel future unstarted expansion.

Do not hold or rate-limit an already admitted independent request.

Hosted evaluation still requires a signed manifest and explicit budget approval.

#### Durable replay

The append-only ledger remains authoritative.

Persist config acceptance, the canonical fingerprint, plan acceptance, assignments, resolver decisions, approvals, terminals, inbox and consumed records, fallback decisions, usage, and audit facts.

Replay uses the assignment and generation token.

Do not re-resolve a recorded assignment after restart.

An explicit reassignment must create a new generation and record the reason.

If an external effect is ambiguous after a crash, return `unknown_after_crash` or request operator action.

Do not duplicate the effect.

#### Potential PR sequence

1. `PR-SW01`: config types, arbitrary role policy, decision and implementation scopes, bounded shared context, trust, and validation.
2. `PR-SW02`: exact model and effort resolver plus candidate set, price card, estimate, rationale, and durable metadata.
3. `PR-SW03`: role graph, decision-scope validation, shared-context limits, and monotonic capability compiler.
4. `PR-SW04`: durable model-proposed task graph, decision lineage, conflict reconciliation, and ordinary `rlm()` admission.
5. `PR-SW05`: per-child replay-safe fallback with revised cost attribution.
6. `PR-SW06`: role, model, effort, direct and downstream economics, state, and control in the Agents tree.
7. `PR-SW07`: deterministic breadth, depth, coordination, model-mix, replay, fault, quality, and total-cost campaign.

Each PR needs a separate rollback flag.

Existing direct `rlm()` callers must keep working while swarm-profile enforcement is off.

#### Required tests

Test canonicalization and fingerprint stability.

Test precedence and unknown configuration.

Test selector and fallback cycles.

Test graph cycles and every structural limit.

Use property tests to prove monotonic authority across generated role trees.

Test cross-family denial and stale approval denial.

Use fake adapters to test requested and resolved model, revision, effort, fallback, and unsupported effort.

Prove that every dependency-ready sibling starts without waiting for another sibling.

Instrument the runtime to prove that no shared model admission object exists.

Fault every plan, assignment, outbox, inbox, consumed, callback, and fallback boundary.

Require zero lost and zero duplicate node materializations after replay.

Test exact model and effort visibility for root, child, fallback, reload, and terminal rows.

Test that no secret appears in a canonical manifest, artifact preview, UI, log, error, or telemetry record.

Run the existing 1, 4, 16, and 64 child gates with role mixes and a fixed model-proposed depth-2 role tree.

Only `PR-SW07` plus the full core scale campaign can permit the default depth decision.

### 6.8 Swarm coordination and model economics

The [Cursor swarm economics study](https://cursor.com/blog/agent-swarm-model-economics) is relevant evidence for this design.

It reports one long implementation experiment using a hidden acceptance suite and several model mixes.

The publisher reports that workers used at least 69% of tokens and more than 90% in most runs.

It reports a large total-cost difference across mixes with broadly similar eventual quality.

It also reports that the older harness produced far more changes and conflicts while performing worse.

Treat these results as hypotheses from one publisher-authored task.

They are not an independent replication or a universal model-routing rule.

The article did not test the full model-by-role matrix.

One candidate model was excluded after prompt-sensitive runaway behavior.

Pin and test each model revision, effort, prompt version, and role policy.

#### Context specialization

Allow users to configure roles that keep global intent separate from bounded execution detail.

Do not require this split.

Do not assign it from a model name.

Measure context use, task quality, and downstream work to decide whether it helps a given profile.

#### Decision ownership

A role or task node may claim a bounded decision scope or implementation scope.

Store append-only records for:

```text
scope_claim
decision_proposed
decision_accepted
decision_superseded
decision_conflict
reconciliation
shared_context_revision
```

Each record must include operation, child, graph node, assignment, generation, policy fingerprint, author, and immutable artifact references.

An exclusive decision scope has one accepted version at a time.

Dependent nodes receive that version by reference.

A conflict creates a typed coordination state.

A model-proposed reconciliation task or operator creates a new accepted version.

Do not rewrite the older record.

A conflict in one scope must not block unrelated ready work.

This is coordination state.

It is not a model-request admission controller.

#### Shared successor context

A user may enable a bounded shared guide for one family or task graph.

Use the existing session-local Continual Harness or an owner-scoped artifact.

Set line, byte, token, item, writer, and revision limits.

Record author, evidence, version, and graph generation.

Do not inject arbitrary shared content as privileged system policy.

Prompt notes remain supplemental to the immutable base prompt.

A review is an ordinary model-proposed node with normal authority, cost, and lifecycle.

Do not add an always-on reviewer service.

#### Total-cost attribution

For each assignment, store:

- all eligible model profiles and the selected candidate;
- routing rationale and estimate provenance;
- requested and resolved provider, model, revision, effort, and prompt version;
- estimated input, output, cached, and reasoning tokens when available;
- price-card version, currency, effective time, and uncertainty;
- actual direct tokens and provider cost;
- retry and fallback cost;
- downstream tokens and cost in the decision subtree;
- measured storage, review, and other execution cost separately.

Mark unavailable provider fields as unavailable.

Do not infer or fabricate them.

Show direct cost, downstream cost, and estimate variance separately.

A low direct planning price is not a saving when it causes more downstream work.

#### Evaluation

Extend deterministic provider fixtures with role-specific prices, token types, output size, failures before output, and downstream task expansion.

Prove that every unrelated ready sibling dispatches independently.

Prove that only declared dependencies and conflicting exclusive scopes constrain work.

Replay must reproduce cost, decision, conflict, reconciliation, and shared-context records.

For an approved real-model campaign, compare the user-selected single-model and mixed-profile policies on the same task and budget.

Use hidden acceptance tests when feasible.

Pre-register:

- verified task quality;
- wall time;
- direct and downstream cost;
- token and context mix;
- recovery;
- duplicated decision rate;
- conflict and reconciliation rate;
- rework and abandoned-output rate;
- review yield;
- total memory.

Raw event, tool-call, change, or commit count is diagnostic.

It is not a productivity score.

A real-model campaign requires an approved manifest and budget.

## 7. Recursion policy

Prime Agent must keep the default recursion value at `1` now.

A four-way tree has these total agent counts:

| Maximum child depth | Total agents | Formula |
|---:|---:|---|
| 1 | 5 | `1 + 4` |
| 2 | 21 | `1 + 4 + 16` |
| 3 | 85 | `1 + 4 + 16 + 64` |
| 4 | 341 | `1 + 4 + 16 + 64 + 256` |

A default value of `2` permits 21 agents in the four-way example.

A default value of `4` permits 341 agents in the same example.

The number alone is not a capacity claim.

The real cost also includes model calls, tools, artifacts, events, sessions, and recovery work.

A default depth of `2` is a **target**, not a current commitment.

Prime Agent may raise the default to `2` only after these gates pass:

1. Run explicit fanout tests at 1, 4, 16, and 64 active children.
2. Run depth-2 tree tests with terminal delivery, cancellation, and restart.
3. Pass lifecycle fault tests for crash, duplicate delivery, stale generation, PID reuse, and orphan reaping.
4. Show bounded parent RSS and CPU under a fixed workload.
5. Show responsive interactive prompt admission while children run.
6. Show no lost programmatic prompt under idle, coalesced, and abort-resume cases.
7. Preserve raw trajectories and artifacts for every test run.
8. Complete a review of provider cost and operator controls.

A default depth of `5` is not defensible now.

The supplied gates do not yet establish safe behavior at depth `2`.

A depth of `5` would increase a four-way tree to 1,365 total agents.

That is an arithmetic observation, not a safe operating point.

Depth greater than `2` must remain an expert-only explicit setting.

The expert setting must show its requested maximum depth and projected fanout warning.

## 8. Executor and REPL plan

### 8.1 Decision

Prime Agent must retain IPython and Python as the compatibility path.

IPython supports existing Python packages, host communication, magics, notebook-style state, and existing user expectations.

The benchmark alternatives do not prove these semantics.

Prime Agent may offer an explicit Bun or JavaScript runtime.

The user or caller must select that runtime explicitly.

Prime Agent must not guess a language automatically from text.

Each session must create the selected runtime lazily.

An IPython lease must serialize only cells that use the same mutable kernel.

A borrower must not close the owner kernel.

Interrupt a stuck cell cooperatively first.

Use a grace period next.

Terminate the owned process group only after the grace period.

Mark an unresponsive or crashed kernel as poisoned.

Quarantine that generation and provision a fresh generation for the next cell.

Preserve packages, magics, host communication, rich output, and supported state semantics in compatibility tests.

### 8.2 Native process runner

Prime Agent should add a direct native process runner for bounded shell output.

This runner must have an explicit executable, argument vector, environment policy, working directory, timeout, output byte limit, and cancellation protocol.

Resolve the executable before launch.

Apply a symlink and allowlist policy to that resolved path.

Use a minimal inherited environment.

Keep the working directory inside an approved root.

Start a process group or platform job object.

Cancel the full descendant group with TERM, a grace period, and KILL.

Limit stdout bytes, stderr bytes, total buffered bytes, wall time, and supported resource limits.

This runner must stream or truncate output according to an explicit policy.

This runner must record exit status and truncation metadata.

This runner must not claim shell, Python, IPython, or arbitrary language semantics.

Its capability set must not exceed the current session tool policy.

The runner can reduce process-result overhead in selected bounded cases.

This is a **Hypothesis** until a profile and task study validate it.

### 8.3 Cross-runtime artifacts

Every runtime must use the same artifact handle contract.

A Python result, Bun result, direct process result, and future native sidecar result must refer to durable bytes in the same way.

The artifact reference must not require another runtime to deserialize an in-memory object.

### 8.4 Semantic limit

The benchmark shows large tiny-crossing costs.

The benchmark also shows semantic gaps and output-path reversals.

Therefore Prime Agent must improve production behavior without presenting a prototype as an IPython replacement.

The benchmark’s synthetic batch result must not become hidden main-agent batching.

A user-facing explicit bulk API can be considered later only with a new semantic contract and user review.

## 9. Continual Harness storage and Rust data service

### 9.1 Current abstraction

Prime Agent already has a Continual Harness state abstraction.

`memory` is one `HarnessKind` beside `prompt`, `skill`, and `subagent`.

All four use `HarnessEntry` with ID, kind, title, content, path, scope, reference, arguments, metadata, source, timestamps, and entry version.

The public kernel surface includes generic CRUD plus `create_memory`, `update_memory`, and `delete_memory`.

The host exposes those calls in the RLM prompt and kernel bootstrap contract.

Keep this public surface unchanged.

Do not create a second agent-visible memory API.

Current local state resolves through the session harness directory.

Current global state resolves through the global agent harness directory.

Both use `harness_state.json`.

The host merges both stores for prompt construction.

It preserves ID collisions as separate visible local and global records.

Current prompt injection sorts by path, title, and ID.

It emits a small fixed number per kind and truncates content.

This is deterministic capped listing.

It is not relevance retrieval.

### 9.2 Current storage risks

Python and TypeScript both read and write the same JSON shape.

Python writes directly to the target file.

The host uses temporary-file replacement.

The Python cache checks file modification time before writes.

This check does not make two read-modify-write operations atomic.

Two writers can still lose one update.

Python and TypeScript also treat unknown entry fields differently.

Both can interpret corrupt JSON as empty and later overwrite the file.

Fix these compatibility and recovery rules before a schema or backend change.

### 9.3 Private store contract

Extract file I/O behind a private `HarnessStore` contract.

Keep `HarnessState` as the public facade and domain model.

The store must support:

- load by existing scope and location;
- atomic commit with expected store generation;
- transactional application of edits;
- entry-version conflict checks;
- JSON v1 import and export;
- snapshots and refinement before/after state;
- current local/global merge behavior;
- current sorting, errors, IDs, and prompt formatting.

Use one canonical normalizer and compatibility fixture suite for Python and TypeScript.

Make the TypeScript host the authoritative production writer.

Kernel CRUD should cross the existing host bridge.

Do not create independent Python and TypeScript database writers.

Keep the in-memory no-session fallback.

### 9.4 JSON reference backend

`PR-MEM01` keeps JSON as the first backend.

Make every write use atomic replacement, permissions, store generation, locking or compare-and-swap, and explicit corrupt-file recovery.

Do not silently replace a corrupt file with empty state.

Keep an inspectable recovery copy.

Preserve the current JSON v1 import and export contract.

This PR changes reliability only.

It must not change memory selection, prompt ordering, or content.

### 9.5 SQLite candidate backend

SQLite is the leading next backend for this local-first per-session and per-user ledger.

It provides transactions, crash recovery, indexed deterministic reads, and one local file without a service.

Use one database per existing harness directory so physical scope and portability remain familiar.

The host should be the only database owner.

Suggested tables are:

```text
meta(schema_version, generation)
entries(kind, id, title, content, path, scope,
        reference_json, arguments_json, metadata_json, source,
        created_at, updated_at, version,
        primary key(kind, id))
refinements(id, trigger, changes_json, evidence, outcome, created_at)
```

Index the current sort order `(kind, path, title, id)`.

Use store generation and entry version for conflicts.

If the database does not exist and JSON does, parse JSON through the canonical v1 normalizer.

Import all rows in one transaction.

Compare the canonical database export with the source snapshot.

Keep the original JSON as an immutable migration backup.

Do not dual-write forever.

Continue to produce JSON v1 export for diagnostics, portability, and rollback.

SQLite is not assumed to be faster at current small sizes.

Benchmark cold and warm prompt construction, concurrent host and kernel mutation, and 1,000, 10,000, and 100,000 entries.

Its immediate expected benefit is correctness and concurrent durability.

Keep JSON when measurements or deployment constraints make it the better backend.

Do not require a remote database for local sessions.

### 9.6 Separate memory-selection product change

A database backend must not silently change what the model remembers.

Any tags, full-text selection, relevance ranking, recency scoring, evidence ranking, or token-budget selection belongs in `PR-MEM03`.

That PR needs a separate API, prompt behavior decision, and answer-quality evaluation.

It must set item, token, byte, scan, and time limits.

It must respect current local and global scopes and future ACL policy.

It must retain evidence and retrieval IDs.

The current deterministic capped listing stays the default until the product evaluation passes.

### 9.7 Rust data service

SQLite already uses mature native storage code.

Rust is not justified only to serialize the current small harness ledger.

Use `PR-MEM04` for the larger whole-swarm memory problem.

Place any Rust component behind the same store, artifact, transcript, and index contracts.

The service may own measured large transcript indexes, artifact indexes, bounded caches, streaming codecs, and harness queries.

Node must release complete transcripts, tool payloads, result histories, and large indexes after durable storage.

Return IDs, small previews, pages, or bounded streams.

Do not copy complete JSON bodies through both heaps.

Use short-lived owned workers for measured bulky parsing, compression, export, or index rebuild work when process exit returns memory reliably.

A Rust service can increase total memory.

Measure Node, Rust, database, worker, kernel, and mapped-page memory together.

### 9.8 PR sequence

1. `PR-MEM01`: private store adapter, canonical compatibility rules, correct atomic JSON, conflicts, and cross-runtime tests.
2. `PR-MEM02`: host-owned SQLite backend, reversible migration, backups, export, rollback, and benchmark evidence.
3. `PR-MEM03`: separately reviewed bounded memory selection only if product evaluation justifies semantic change.
4. `PR-MEM04`: profile-gated Rust transcript, artifact, index, or harness-query ownership behind stable interfaces.

### 9.9 Acceptance gates

For `PR-MEM01` and `PR-MEM02`:

- all current public Python signatures and error conditions remain compatible;
- local and global routing remains compatible;
- sorting, collision display, snapshots, overview, prompt output, and refinement rollback remain compatible;
- concurrent host and kernel writes lose zero accepted edits;
- corrupt-state recovery does not silently replace evidence with empty state;
- migration export matches the canonical input snapshot;
- rollback selects the JSON adapter and preserved export;
- no secret appears in database, export, log, or error output beyond existing governed entry content.

For `PR-MEM03`:

- retrieval never exceeds item, token, byte, scan, or time limits;
- answer quality meets the approved evaluation threshold;
- disabled retrieval reproduces current deterministic prompt injection.

For `PR-MEM04`:

- steady-state p95 summed RSS is at most 80% of baseline;
- peak summed RSS is at most 90% of baseline and below 75% of the process or container memory limit;
- incremental RSS per active agent is at most 50% of baseline;
- a 10,000-turn or 24-hour run has no OOM or restart;
- final-half RSS does not have an unbounded positive slope;
- queue depth, cached bytes, index generations, database connections, and response bytes remain bounded;
- the TypeScript and JSON or SQLite reference path remains selectable.

## 10. Performance patterns absorbed into Prime Agent RLM

This section records the performance mechanisms that the PR topology absorbs.

They are Prime Agent design requirements.

They are not ports of another runtime.

### 10.1 Patterns to implement

| Pattern | Prime Agent RLM implementation | Expected value | PR |
|---|---|---|---|
| Nonblocking background child handle | Keep `rlm()` admission nonblocking. Register accepted work durably. | The parent stays interactive during child work. | `PR-C03`, `PR-C07` |
| Bounded progress updates | Coalesce by child, generation, and event kind. Keep a bounded recent tail. | Progress floods do not dominate the root worker. | `PR-C02` |
| Explicit passive and terminal states | Use generation-fenced lifecycle and terminal types. | Idle and complete children release heavy runtime state. | `PR-C01`, `PR-C06` |
| CAS passivation and single-flight revival | Compare the durable assignment token. Detach before disposal. Share one concurrent revival. | Late cleanup cannot destroy a revived child. | `PR-C06` |
| Structured terminal result | Validate one bounded schema-versioned result. Put large data in an artifact. | Parents consume small predictable results. | `PR-C04` |
| Owner-scoped resource references | Refer to bounded history, results, artifacts, and status through family ACLs. | Prompts use references instead of copied transcripts. | `PR-C04`, `PR-C05` |
| User-defined role policy | Compile arbitrary role labels, model and effort selectors, allowed role edges, outputs, and attenuated capabilities. | Users can configure different model teams without hard-coded routing. | `PR-SW01`–`PR-SW03` |
| Model-proposed task graph | Validate and persist task-specific nodes and dependencies before dispatch. | The model stays open-ended while execution is durable and safe. | `PR-SW04` |
| Persistent explicit runtimes | Keep IPython as default. Add explicit Bun. Start runtimes lazily. | Selected tasks retain useful state without repeated startup. | `PR-R01`, `PR-R03` |
| Managed timers and hooks | Give every timer and background promise an owner, cancellation, error sink, and shutdown policy. | Close does not retain orphan background work. | `PR-C02` |
| Event-driven completion | Persist the callback and wake the input pump. | Completion does not depend on sleep polling. | `PR-C07` |
| Replay-safe per-task retry | Retry only a transient failure before visible or side-effecting output. | A brief provider failure does not restart the full task. | `PR-C08` |
| Deferred MCP startup | Connect an approved server only when needed. Fence late results by lifecycle epoch. | One slow server does not block ready state. | `PR-M03` |
| Pluggable Continual Harness storage | Keep `rlm.harness` semantics. Add correct JSON and a reversible host-owned SQLite backend. Evaluate relevance selection separately. | Harness state becomes transaction-safe without silently changing what the model remembers. | `PR-MEM01`–`PR-MEM03` |
| Rust data ownership | Move only measured transcript, artifact, index, or harness-query state behind bounded handles and streams. | Node actors release large object graphs and total swarm RSS falls. | `PR-MEM04` |
| Rebuildable active index | Checkpoint child, parent, leaf, and operation indexes at a ledger sequence. | Reattach does not expand the full transcript. | `PR-C03` |

### 10.2 Patterns this design rejects

Do not add a shared model-request semaphore.

Do not add a global client admission queue.

Do not return a synthetic local `429` for an independent request.

Do not use a process-global model-visible agent registry.

Do not use a volatile completion list or short dead-letter retention as recovery truth.

Do not use sleep polling as the completion mechanism.

Do not grant headless approval by default.

Do not use a raw global content hash as an artifact authorization handle.

Do not replace IPython with plain Python or JavaScript.

Do not add a new worktree manager or patch protocol.

Coding agents retain their existing model-directed Git worktree behavior.

Do not make a Rust path the default until total memory and compatibility gates pass.

## 11. Prompt callbacks and PR #1034

[PR #1034](https://github.com/PrimeIntellect-ai/prime-agent/pull/1034) is open and draft.

The PR is prompt-only.

All 16 reported checks were green at the review date.

Those checks validate prompt text and existing code paths.

They do not test the requested callback behavior.

The PR gives useful guidance against blocking `time.sleep()` polling in the RLM control loop.

The PR is not a tested runtime fix for callback delivery, queued prompts, or lifecycle completion.

Prime Agent should merge it only as scoped prompt guidance after normal review.

Prime Agent must build the runtime solution separately.

The runtime solution must add a durable operation registry and callback events.

```ts
type OperationRecord = {
  operationId: string;
  kind: "child" | "eval" | "sandbox" | "tool" | "follow_up";
  state: "queued" | "running" | "parked" | "completed" | "failed" | "cancelled" | "timed_out" | "stalled" | "unknown_after_crash";
  callback: { type: "follow_up" | "event"; targetSessionId: string };
  resultRef?: ArtifactRef;
};
```

The default callback action must be `follow_up`.

A completed background operation must enqueue one durable follow-up event.

The interactive CLI must remain responsive while the callback waits.

The runtime must not sleep poll.

The runtime must not require a human prompt to flush a queued callback.

Tests must cover completion while idle, duplicate callback, callback after restart, coalesced follow-up, user-prompt priority, cancellation, and one-shot mode.

### Separate ASD-STE100 prompt PR

No existing rule or PR covers the full simplified-English requirement for agent-written review documents.

Create a separate scoped prompt PR.

Do not mix this wording with [PR #1034](https://github.com/PrimeIntellect-ai/prime-agent/pull/1034).

Use this exact scoped prompt wording:

> For prose that you write yourself, use ASD-STE100 simplified technical English unless the user asks for another style. Use short direct sentences. Use active voice. Put one instruction in each sentence. Use common approved words. Keep required technical terms, code, commands, identifiers, quotations, and URLs unchanged. Do not change user-provided text.

A fully custom system prompt must keep its current replacement behavior.

That custom prompt does not receive this default rule unless its author adds the rule.

Tests must assert the exact default system-prompt block.

Tests must assert that a fully custom system prompt remains unchanged.

Tests must not alter user-provided text.

## 12. ACP and evaluation plan

ACP work extends and hardens the existing ACP stack.

It does not create a parallel protocol, session stack, or new ACP implementation.

[PR #805](https://github.com/PrimeIntellect-ai/prime-agent/pull/805) is open and not a draft.

The PR head is [`72266c8`](https://github.com/PrimeIntellect-ai/prime-agent/commit/72266c897ad63d881eef456a2e1d44406b03276e).

The PR merge state is `DIRTY`.

The PR needs rebase, conflict resolution, review, and current validation before merge.

The PR’s resident ACP design is relevant because it keeps a live kernel across disconnect and reconnect.

Resident descriptors can outlive the client that supplied launch environment data.

Persist secret references instead of plaintext bearer tokens, API keys, proxy credentials, or authorization headers.

Allow only named non-secret launch values in a descriptor.

Resolve secret references in the worker at launch time.

Store descriptors with owner-only permissions.

Redact descriptor, log, snapshot, telemetry, and error output.

Block ACP residency until tests prove that these outputs contain no supplied secret value.

This design must also test recovery and lifecycle failure paths from sections 4 and 5.

### Required evaluation lane

Use deterministic fake-provider CI for unit, integration, fault, and replay tests.

Treat GSM8K and long-horizon model results as stochastic evaluation.

Add resident reconnect and environment propagation tests.

Keep the existing kernel identity test concept.

Run 10 fixed GSM8K items as the first model-backed smoke test.

Run 50–100 fixed GSM8K items for release acceptance when the approved budget permits.

Use exact-match scoring and the same items, model, prompt, seed policy, and limits for control and candidate.

Report infrastructure errors separately from wrong answers.

Report a confidence interval for task accuracy.

Add a long-horizon Verifiers lane with 20–30 tasks and 8–16 turns per task.

Choose one exact task count, task ID list, and turn limit in the signed run manifest before launch.

Record the Verifiers revision, environment wheel hash, scorer revision, model endpoint, decoding parameters, retry policy, and corpus permission.

Keep the primary quality lane free of injected faults.

Run lifecycle and callback faults in a separate lane.

The primary lane must reattach the same logical session and preserve required kernel state.

Every lane must reconcile the durable inbox and turn log for zero lost or duplicate materializations.

The fault matrix must include:

- supervisor restart;
- worker crash;
- kernel crash;
- client disconnect and reconnect;
- stale generation event;
- duplicate terminal delivery;
- PID reuse or mismatched start identity;
- provider error;
- huge tool output;
- streamed malformed JSON;
- idle callback delivery;
- user prompt during background work;
- one-shot exit with unresolved children;
- passivation racing with revival or completion;
- invalid and oversize terminal result;
- completion while the parent is absent, followed by restart;
- stale `PreparedFamilyContext` after workspace change;
- cross-family status, message, cancel, and artifact access;
- borrower close against an owner kernel or MCP session;
- poisoned IPython interrupt and fresh-generation recovery;
- workspace-index stale and invalidation cases;
- slow MCP connection followed by an epoch change;
- provider retry before and after replay-unsafe output.

Collect these metrics:

- task correctness;
- completion rate;
- delivery latency;
- startup time;
- root and child RSS;
- parent CPU;
- event volume;
- stale-event count;
- duplicate-delivery count;
- orphan count;
- recovery success;
- model token and request cost;
- artifact bytes;
- interactive prompt latency.

Store raw trajectories, session ledgers, snapshots, logs, configuration, revision, environment manifest, and result artifacts.

Set go/no-go thresholds before execution.

Do not launch a paid evaluation without explicit approval.

## 13. First-class MCP flow

The current custom setup requires settings JSON and a Python package according to the task scope.

That creates a hard-to-discover setup path.

Prime Agent should provide these commands:

```bash
prime-agent mcp add
prime-agent mcp list
prime-agent mcp get
prime-agent mcp remove
prime-agent mcp login
prime-agent mcp logout
prime-agent mcp enable
prime-agent mcp disable
prime-agent mcp test
prime-agent mcp doctor
```

Use a scriptable command shape that is close to Codex and Claude Code:

```bash
prime-agent mcp add notion --url https://mcp.notion.com/mcp --scope user
prime-agent mcp add github --url https://example.com/mcp --bearer-token-env-var GITHUB_TOKEN --scope project
prime-agent mcp add localfs --scope user -- python -m my_mcp_server
prime-agent mcp list --json
prime-agent mcp test notion --json
```

`add` must support user and project scope.

An explicit project `add` command must show the endpoint, transport, auth method, and scope before it writes.

A discovered project configuration must require project trust before Prime Agent connects or starts a process.

The design must make one server declaration usable without a hand-written Python package.

Use a generic kernel bridge such as `mcp.server("github")` for direct access.

Keep optional typed Python skill wrappers as an advanced layer.

The design must support a generic runtime bridge.

The bridge must support HTTP and supervised stdio transports.

`mcp list` must use local metadata and must not contact servers by default.

`mcp list --check` and `mcp test` may run bounded independent health checks.

The runtime should connect lazily on first use.

The runtime should reuse one healthy session per server and live agent session.

Invalidate that session on config, credential, endpoint, disconnect, or MCP `list_changed` events.

Increment a server lifecycle epoch for each invalidation.

A connection or discovery result from an old epoch must not register tools or revive a server.

A slow approved server must not block root or CLI readiness.

A call for that server may await or cancel its own deferred connection.

One failed server must not disable another server.

Use owner and borrower leases for shared healthy sessions.

Do not use MCP connection work to limit independent model requests.

The bridge must not hard-code a Python-only setup path.

The bridge should use the existing MCP surfaces as a migration base:

- [`packages/ai/src/mcp/index.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/ai/src/mcp/index.ts)
- [`packages/ai/src/mcp/oauth.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/ai/src/mcp/oauth.ts)
- [`packages/coding-agent/src/core/mcp/mcp-manager.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e0/packages/coding-agent/src/core/mcp/mcp-manager.ts)

Credentials must use OAuth, OS keychain storage, or secret references.

Configuration must bind credentials to an endpoint identity.

The system must not reuse a credential silently for another endpoint.

`list`, `get`, `test`, and `doctor` must return redacted JSON status.

The JSON must not print secrets, tokens, authorization headers, or raw keychain values.

Stdio processes must have a supervised lifecycle, bounded restart policy, logs, and clean shutdown.

Start stdio with an executable and argument vector.

Do not pass the command through a shell.

Resolve the executable under an explicit policy.

Use a fixed working-directory boundary and a minimal environment allowlist.

Terminate the full process group on remove, logout, daemon stop, or timeout.

HTTP URL validation must canonicalize the scheme, host, port, path, and credential audience.

Project servers must not reach loopback, link-local, or private networks unless the user approves that network scope.

OAuth must bind issuer, resource, client identity, redirect URI, and endpoint fingerprint.

`list`, `get`, `test`, and `doctor` must not load, connect, or start an unapproved project server.

HTTP connections must expose endpoint health without exposing secrets.

Migration must import existing settings JSON only after preview and approval.

Migration must preserve a backup.

Tests must cover scopes, approval, redaction, OAuth login/logout, endpoint binding, HTTP, stdio, restart, migration, and failed authentication.

Review lessons from [Codex](https://github.com/openai/codex) and [Claude Code](https://code.claude.com/docs/en/mcp) before final CLI design.

Do not copy their credential model without a threat-model review.

## 14. Capability-matched evaluation protocol

Prime Agent and each selected alternative agent system must use the same model, task suite, machine class, environment, repository fixture, and budget when capabilities permit it.

Pin every compared revision and dependency.

Record a capability matrix before the run.

If a system lacks a tested capability, mark that lane unsupported.

Do not silently emulate a missing capability in only one system.

Measure:

- task success and verifier score;
- wall time and model time;
- tokens and provider cost;
- startup and attach latency;
- peak and steady summed RSS;
- incremental memory per active agent;
- fanout responsiveness;
- exact result delivery;
- restart and reconnect behavior;
- cleanup and orphan count;
- long-session memory slope;
- retained trajectory size;
- operator work required to diagnose and recover a failure.

Use the same seeds and retain complete redacted trajectories.

Publish exclusions and unsupported lanes.

Do not claim one system is faster from a single executor microbenchmark.

A hosted run requires an approved manifest and budget.

### Requirements traceability

| Requirement | Design location | Evidence artifact |
|---|---|---|
| High fanout and recursion | Sections 6, 6.7, and 7 | Deterministic 1/4/16/64 and depth-2 reports |
| Memory and long sessions | Sections 5.7 and 9 | Total-RSS samples, database metrics, and long-session slopes |
| IPython, Bun, and process execution | Section 8 | Runtime compatibility and lifecycle reports |
| Narrow Rust adoption | Section 9 | Whole-swarm RSS comparison and rollback evidence |
| Model visibility and swarm policy | Sections 6.4 and 6.7 | Requested and resolved role, model, revision, and effort records |
| Swarm coordination and economics | Section 6.8 | Decision lineage, price-card, direct/downstream cost, quality, conflict, and rework records |
| ACP | Section 12 | Existing-stack reconnect and fault reports |
| MCP | Section 13 | Trust, OAuth, transport, lifecycle, and cleanup reports |
| Alternative-system comparison | Section 14 | Pinned capability matrix, manifests, and trajectories |

## 15. Phased PR stack

### P0: Correctness and observability foundation

**Owner:** Daemon lifecycle DRI. Name required before P0 starts.  
**Approver:** Agent architecture owner. Name required before P0 starts.  
**Dependencies:** none.

1. Define lifecycle state enums, generation fields, operation IDs, and terminal envelope schema.
2. Add process start identity checks to all worker liveness and stop paths.
3. Make global heartbeat and status aggregation isolate per-row errors.
4. Add bounded tool-update drain behavior for [#957](https://github.com/PrimeIntellect-ai/prime-agent/issues/957).
5. Fix programmatic input-pump wake and coalesced wake behavior for [#1000](https://github.com/PrimeIntellect-ai/prime-agent/issues/1000).
6. Add model badges to detailed root and nested Agents rows.
7. Add telemetry with redaction and raw artifact references.
8. Add old-session migration, downgrade-readability, partial-write, corruption, and concurrent-supervisor tests.
9. Add Linux, macOS, and Windows process-identity fallback tests where those platforms are supported.
10. Merge PR #1034 only as prompt guidance after review. Keep it separate from the ASD-STE100 prompt PR.
11. Add bounded progress coalescing and a managed timer/background-task owner contract.
12. Define the typed extension event order and hook-failure isolation contract.

**Risks:** State migration can expose old descriptors. New telemetry can create load.

**Acceptance gate:** Fault tests pass for stale generation, PID mismatch, failed row aggregation, coalesced programmatic prompt, and tool-update flood. Relevant section 16 responsiveness and delivery gates also pass.

**Rollback:** Feature-flag new ledger readers. Preserve legacy JSONL. Disable new telemetry emitter without deleting data.

### P1: Durable delivery and scalable child state

**Owner:** Session and orchestration DRI. Name required before P1 starts.  
**Approver:** Daemon lifecycle DRI.  
**Dependencies:** P0 schema and identity work.

1. Add the durable operation registry.
2. Add terminal envelope persist-send-ack flow.
3. Add artifact references and bounded parent child summaries.
4. Add passivation and lazy kernel policy.
5. Add progress-based stall detection and orphan reaper.
6. Make one-shot unresolved child behavior explicit.
7. Build the callback event and default `follow_up` path.
8. Add assignment-token CAS passivation and single-flight revival.
9. Add validated structured terminal results and owner-scoped RLM resources.
10. Add `PreparedFamilyContext` and family ACL enforcement.
11. Add `PR-SW01` through `PR-SW04` for arbitrary role policy, exact assignment, attenuated authority, and durable model-proposed RLM task graphs.

**Risks:** Duplicate or missed legacy delivery during migration. Artifact retention can raise storage cost.

**Acceptance gate:** Crash/restart replay passes durable inbox reconciliation with zero lost or duplicate materializations. Section 16 scale gates pass. No unresolved one-shot operation exits silently.

**Rollback:** Read old and new records. Disable passivation and use old runtime residency while retaining terminal envelopes.

### P2: Targeted parsing, storage, runtime choices, and ACP

**Owner:** Runtime performance and ACP DRI. Name required before P2 starts.  
**Approver:** Security and evaluation owners.  
**Dependencies:** P1 artifacts and replay.

1. Profile [#942](https://github.com/PrimeIntellect-ai/prime-agent/issues/942) and implement an incremental parser reference path.
2. Add `PR-MEM01` for the private Continual Harness store adapter and correct atomic JSON.
3. Add `PR-MEM02` for the host-owned SQLite backend and reversible JSON migration.
4. Evaluate `PR-MEM03` bounded memory selection as a separate semantic product change.
5. Add `PR-MEM04` only for measured Rust transcript, artifact, index, or harness-query ownership.
6. Add explicit Bun/JS runtime selection.
7. Add the direct native process runner with bounded output.
8. Rebase, harden, review, and validate the existing ACP stack in [PR #805](https://github.com/PrimeIntellect-ai/prime-agent/pull/805).
9. Create the deterministic ACP evaluation lane.
10. Add replay-safe per-request provider retry rules.
11. Evaluate the active-operation checkpoint.
12. Add `PR-SW05` and `PR-SW06` for safe fallback and full swarm visibility.
13. Extend the deterministic lane with arbitrary configured role mixes and model-proposed task graphs.

**Risks:** Native packaging. Semantic drift. Resident environment security.

**Acceptance gate:** Differential tests and profiling gates pass. ACP reconnect and environment tests pass. No paid evaluation has launched without approval.

**Rollback:** Keep TypeScript parser and storage fallback. Disable optional runtime and native runner independently. Revert ACP behavior behind lifecycle compatibility tests.

### P3: Scale policy and MCP product flow

**Owner:** Agent architecture and MCP product DRI. Names required before P3 starts.  
**Approver:** Security and product owners.  
**Dependencies:** P0–P2 gates.

1. Execute the 1/4/16/64 fanout and depth-2 lifecycle campaign.
2. Decide whether to change default recursion from 1 to 2.
3. Build MCP add/list/get/remove/login/logout/enable/disable/test/doctor.
4. Add user/project migration and approval flow.
5. Run the approved capability-matched alternative-system comparison.
6. Review retention cost and operator documentation.
7. Run `PR-SW07` before any default recursion change.
8. Review whole-swarm memory evidence before enabling the Rust data service by default.

**Risks:** Cost growth at scale. MCP security mistakes. Incorrect capacity extrapolation.

**Acceptance gate:** All section 7 gates pass. MCP security and migration tests pass. Comparison data includes raw trajectories.

**Rollback:** Keep recursion default at 1. Disable MCP project writes. Preserve imported configuration backup.

## 16. Telemetry, benchmarks, and decision log

### Telemetry

Telemetry must use stable operation IDs and generations.

Telemetry must record counts, durations, sizes, and state transitions.

Telemetry must redact prompts, secret values, tokens, authorization headers, and artifact content by default.

Telemetry must use artifact references for inspectable raw data.

Telemetry must track:

- active child count;
- parent retained summary bytes;
- child event coalescing ratio;
- ledger write latency;
- callback queue age;
- terminal delivery attempts and acknowledgement latency;
- stale generation drops;
- process identity mismatches;
- orphan reaper actions;
- kernel create, passivate, crash, and recovery;
- tool update drain depth;
- JSON accumulator bytes and parse cost;
- UI input latency during fanout;
- passivation cancellation and stale assignment drops;
- prepared-family-context reuse and rebuild;
- invalid and oversize terminal envelopes;
- kernel lease, poison, restart, and generation changes;
- family ACL denials and stale approval tickets;
- artifact bytes, retention, and deletion;
- workspace-index hits, stale checks, and invalidations;
- MCP deferred connections and late-epoch drops;
- replay-safe provider retry decisions;
- swarm manifest fingerprint and policy versions;
- requested and resolved role, provider, model, revision, and effort;
- task-graph node, edge, dependency, depth, and eligibility transitions;
- capability attenuation decisions and denials;
- fallback cause and adapter version;
- scope claims, accepted decision versions, conflicts, supersession, and reconciliation;
- shared-context revisions, bytes, items, authors, and evidence references;
- candidate model profiles and routing rationale;
- price-card version, currency, effective time, and unavailable billing fields;
- estimated and actual input, output, cached, and reasoning tokens when available;
- direct, retry, fallback, downstream-subtree, review, storage, and total cost;
- estimate variance, duplicated-decision rate, rework, abandoned output, and review yield;
- verified task quality beside activity and change counts.

### Benchmark protocol

Every benchmark must record revision, dirty state, machine, OS, runtime versions, model, provider, configuration, seed, task fixture, raw events, and raw trajectories.

Every benchmark report must state its semantic limits.

Every benchmark must distinguish a measured fact from a scenario calculation.

Every performance change must include a correctness and failure-path test.

### Proposed scale release gates

Approve or change these targets before implementation.

Record any change before the deciding run.

Use a deterministic fake provider for control-plane gates.

Run 5 warmups and 10 measured campaigns at each fanout level.

Use fixed event counts, payload bytes, tool timings, and fault schedules.

| Gate | Proposed pass rule |
|---|---|
| Independent dispatch | Every fake-provider request starts without a Prime Agent global admission queue or synthetic rate response. |
| Fanout responsiveness | At 64 active model-only children, human prompt admission p95 is below 250 ms and p99 is below 1 s. |
| Event-loop health | Root worker event-loop delay p99 is below 100 ms during the fixed 64-child event load. |
| Attach and heartbeat | Attach and heartbeat responses have p99 below 1 s during the same load. |
| Durable delivery | Inbox, consumed, and terminal audit reconciliation reports zero lost and zero duplicate materializations in every campaign. |
| Parent record growth | Child usage and status records grow with children plus configured checkpoints, not with child message count. |
| Heap recovery | After child completion and passivation, forced-GC test heap is within 20% of its pre-fanout value. |
| Whole-swarm memory | With the Rust data path enabled, steady-state summed RSS is at most 80% of baseline, peak is at most 90% of baseline, and incremental RSS per agent is at most 50% of baseline. |
| Continual Harness compatibility | JSON and SQLite backends preserve current `rlm.harness`, local/global scope, prompt rendering, refinement, migration, export, and rollback behavior. |
| Memory selection | Any new relevance retrieval passes a separate quality and latency evaluation before it changes current deterministic capped injection. |
| Long session | The control-plane lane passes the fixed 2-hour, 200k-context run. The memory lane also passes 10,000 turns or 24 hours without OOM or an unbounded final-half summed-RSS slope. |
| Teardown | Worker, kernel, stdio MCP, socket, lease, and descriptor leak count is zero within 30 s after close. |
| Recovery | Supervisor, worker, and kernel fault fixtures reach a correct typed state within 5 s p95. |
| Swarm manifest | The same effective profile produces the same fingerprint. Replay keeps exact requested and resolved role, model, revision, effort, and policy version. |
| Swarm authority | Generated and faulted role trees report zero child grants wider than parent authority. |
| Swarm dispatch | Every eligible admitted sibling starts independently. Structural limits, economics, and coordination records do not create a model concurrency queue. |
| Decision integrity | An exclusive scope has one accepted version. Dependent nodes reference it. Conflicts create durable reconciliation without blocking unrelated work. |
| Total-cost attribution | Direct and downstream estimates and actual usage reconcile by node, role, subtree, and routing decision with a pinned price card. Unknown billing fields stay unknown. |
| Economic evaluation | The report pairs verified task quality with total cost, context, token mix, conflicts, rework, and review yield. Activity count is not a productivity score. |
| Depth 2 | A fixed model-proposed depth-2 role tree passes all core and swarm rules above. |

These thresholds are initial engineering targets.

They are not measured facts.

The benchmark collector must compute each rule from raw events and process samples.

### Decision log

| Decision | Status | Reason |
|---|---|---|
| Retain IPython | Decided | The benchmark does not prove a compatible replacement. |
| Reject hidden production executor batching | Decided | It changes semantic boundaries. Internal coalescing is safe only under explicit delivery rules. |
| Keep default recursion at 1 | Decided | Current evidence includes scaling and lifecycle failures. |
| Target default recursion at 2 after gates | Conditional | 1/4/16/64, depth-2, lifecycle, memory, and responsiveness gates must pass. |
| Use Rust for bounded data ownership | Conditional | The memory and transcript service must reduce whole-swarm RSS and keep a reversible reference path. |
| Merge #1034 as guidance only | Conditional | It is draft and prompt-only. Runtime callback work remains required. |
| Rebase and validate #805 before merge | Decided | Its merge state is `DIRTY`; resident behavior needs current tests. |
| Add model badges | Recommended | Model metadata must remain visible in root and nested rows. |
| Create a separate ASD-STE100 PR | Recommended | No existing scoped rule covers it. |
| Build first-class MCP add flow | Recommended | Current custom setup is too manual. |

## 17. Open questions

1. What exact ledger location and retention policy best fits existing session JSONL?
2. What bounded event-tail size preserves useful debugging without increasing heap risk?
3. Which lifecycle transitions need user confirmation versus automatic recovery?
4. What artifact encryption and local access policy is required for provider outputs?
5. What defines meaningful progress for a long silent model request?
6. Which child state can passivate without changing expected IPython semantics?
7. What one-shot contract best serves CI: wait, explicit detached mode, or nonzero unresolved exit?
8. What platform support and binary distribution policy can maintain the Rust memory service safely?
9. What exact go/no-go thresholds apply to the depth-2 campaign?
10. What model and task budget is approved for the fair comparison?
11. Which MCP transports and OAuth providers are in the first release scope?
12. Does a direct native process runner improve real task success enough to justify a new surface?

## 18. Review checklist

Work through this list together before implementation.

- [ ] Confirm that `a18809e00` is the source baseline for every cited current implementation fact.
- [ ] Confirm the issue and PR status again before opening any implementation PR.
- [ ] Confirm the no-global-cap and no-synthetic-429 rule for independent model requests.
- [ ] Confirm the distinction between internal coalescing and synthetic executor batching.
- [ ] Approve the lifecycle ledger schema, generation fence, and terminal acknowledgement contract.
- [ ] Approve bounded child state, artifact retention, and passivation policy.
- [ ] Approve the 1/4/16/64 and depth-2 gates before changing default recursion.
- [ ] Approve the IPython compatibility decision and optional explicit Bun/JS scope.
- [ ] Approve `PR-MEM01` Continual Harness store, JSON compatibility, atomicity, and conflict contracts.
- [ ] Approve `PR-MEM02` host-owned SQLite migration, export, and rollback contracts.
- [ ] Review `PR-MEM03` memory selection as a separate semantic product change.
- [ ] Approve the whole-swarm RSS, per-agent slope, long-session, and rollback gates for `PR-MEM04`.
- [ ] Confirm that Node releases large graphs when the Rust service takes ownership.
- [ ] Review P0 tests for PID reuse, input-pump wake, update-promise bounds, and poisoned aggregation.
- [ ] Review P1 tests for durable terminal delivery, idempotent materialization, and one-shot behavior.
- [ ] Rebase and review [PR #805](https://github.com/PrimeIntellect-ai/prime-agent/pull/805) before evaluation.
- [ ] Review [PR #1034](https://github.com/PrimeIntellect-ai/prime-agent/pull/1034) only as prompt guidance.
- [ ] Approve the separate ASD-STE100 prompt wording and override tests.
- [ ] Approve the model-badge UI contract for root and nested agents.
- [ ] Approve the MCP credential, scope, migration, and redaction threat model.
- [ ] Approve the capability-matched alternative-system evaluation protocol.
- [ ] Confirm the rejected patterns in section 10 remain absent.
- [ ] Approve assignment-token passivation, single-flight revival, `PreparedFamilyContext`, structured terminal validation, and owner/borrower service leases.
- [ ] Approve the provider-neutral swarm schema, role graph, effort policy, structural bounds, capability attenuation, exact assignment replay, and Agents-tree metadata.
- [ ] Confirm that structural breadth, depth, node, edge, and budget bounds never become a shared model request queue or client rate limit.
- [ ] Approve `PR-SW07` as a required predecessor to any default depth-2 change.
- [ ] Approve IPython interrupt, poison, restart, and generation tests.
- [ ] Approve deferred MCP epoch and replay-safe provider retry tests.
- [ ] Approve any paid evaluation before it starts.
