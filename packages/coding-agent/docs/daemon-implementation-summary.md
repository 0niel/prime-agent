# Daemon and Session Worker Architecture

Prime Agent isolates each persistent root session tree in its own process. Process isolation is internal: interactive, print, JSON, RPC, piped-stdin, and `--no-session` invocations keep their existing commands and public I/O contracts.

## Process Topology

```text
interactive clients
        |
        v
detached supervisor
  |- catalog subprocess
  |- resident worker: root A + RLM descendants + kernels
  `- resident worker: root B + RLM descendants + kernels

print / JSON / RPC / interactive --no-session
        |
        v
frontend process --private owner channel--> owned worker + root tree
```

The supervisor owns public sockets, client attachments, routing, global agent-message routing, worker health, and update coordination. Each resident worker owns scheduling and execution for its root tree. The supervisor does not execute providers, tools, compaction, bash, kernels, session schedules, or session-history scans.

Each worker owns one root `AgentSessionRuntime` and every RLM descendant below it. New, switch, fork, and import operations replace the root runtime inside that worker while preserving the root active-session ID.

The catalog subprocess owns saved-session scans and inactive-session file operations. A catalog failure can make a catalog request fail, but cannot interrupt active workers.

## Resident Workers

Normal interactive sessions use resident workers:

- The supervisor dynamically starts one detached process group per root tree.
- Closing the TUI detaches the client; it does not stop the worker.
- Worker descriptors, authentication tokens, active-session IDs, session paths, and recovery journals are stored with mode `0600` below the agent directory.
- Workers monitor the public supervisor socket. If it disappears, one worker acquires an atomic launch lease and starts a replacement supervisor.
- A replacement supervisor adopts the existing worker PIDs and active-session IDs.
- A worker crash affects only its root tree. Recovery retries after 250 ms, 1 second, and 5 seconds; three failed attempts mark that root failed.
- `prime-agent daemon retry <session>` retries a failed root.
- `prime-agent daemon restart` replaces only the supervisor and adopts workers.
- `prime-agent daemon shutdown` stops workers before the supervisor; `--force` sends `SIGKILL` to workers that do not stop gracefully.

There are no session, worker, client, or workload caps in this layer.

## Owned Workers

Headless and ephemeral modes use the same process isolation without joining the resident daemon registry:

- `prime-agent -p`, piped stdin, and JSON mode proxy stdin/stdout/stderr through an owned worker and return its existing exit status.
- RPC keeps stdin/stdout in the frontend. It forwards strict LF-delimited JSONL to the worker and preserves every public command, response, event, and extension-UI shape.
- If a persisted RPC worker crashes, the frontend reports an ordinary failure for commands whose result is uncertain, reopens the exact persisted session, and continues accepting commands. It never replays an uncertain command.
- RPC EOF and frontend `SIGTERM`/`SIGHUP` stop only the owned worker and its subprocesses.
- Interactive `--no-session` uses an owned in-memory worker and creates no recovery descriptor.
- Owned workers never appear in the agents view and never require the global daemon.
- Direct SDK calls to `runPrintMode(runtime, ...)` and `runRpcMode(runtime)` remain in-process and source-compatible. Non-serializable extension factories therefore continue to work for embedders.

An inherited, unreferenced IPC owner channel links the worker to its frontend. Frontend loss disconnects the channel and terminates the worker, which reaps its kernels and detached children; the unreferenced channel does not prevent clean RPC EOF or print completion.

## Session Ownership

Persisted sessions use process-safe leases keyed by canonical JSONL path. Resident and owned workers both acquire leases.

- Resident workers acquire a target lease before opening an existing session. Owned CLI workers acquire it before runtime writes, and all workers acquire the replacement lease before switching runtimes.
- The previous lease is released only after replacement succeeds.
- Concurrent opens return `session_already_active` with the owning active-session ID.
- Concurrent daemon creates for the same path share one worker launch.

This prevents a script and resident daemon worker from writing the same session concurrently.

## Scheduled Jobs

Each resident worker runs one scheduler for the root and RLM descendant sessions it owns. Schedule state is persisted per session at `session-artifacts/<session-id>/scheduled-jobs.json`; workers never scan or write a shared global cron file.

- Creating or changing a heartbeat writes its session store and wakes the same worker's scheduler.
- Due ticks are claimed and advanced durably before prompt delivery, so a crash never replays an uncertain prompt.
- The timer loop dispatches different target sessions independently and does not wait for complete model or tool turns before scheduling its next pass.
- A still-active claim coalesces later missed ticks instead of accumulating a backlog.
- Supervisor replacement does not pause timers or scheduled work because resident workers remain alive.
- Worker recovery marks uncertain claims interrupted, preserves the advanced schedule, and resumes only future ticks.
- The supervisor routes cron commands to workers and merges their job summaries for global listing.

The first worker-owned release migrates the legacy global `cron-jobs.json` into the corresponding session artifact directories before adopting workers. Archived, deleted, or descriptorless sessions are cancelled rather than revived.

## Public Protocol v2

The public daemon socket remains JSONL-framed. Version 2 adds:

- stable command envelopes carrying protocol version, client ID, and command ID;
- generation-aware event cursors `{ generation, sequence }`;
- worker states `starting`, `ready`, `recovering`, and `failed` in session summaries;
- reconnectable clients that retain their stable identity and cursor;
- attach acknowledgement followed by `session_snapshot_begin`, `session_snapshot_chunk`, and `session_snapshot_end`;
- 512 KiB target transcript chunks;
- file-backed transcript caches above 4 MiB.

The one-release v1 update handoff uses raw v1 requests only to prepare and stop the old daemon. Busy older daemons that cannot produce a recovery manifest are left running.

JSON mode and RPC never expose daemon greetings, envelopes, lifecycle messages, snapshot records, or connection metadata.

## Private Worker Transport

Supervisor-worker traffic uses a binary frame:

```text
4-byte JSON header length
4-byte payload length
small JSON routing header
opaque payload bytes
```

Workers serialize an outbound public event once. The supervisor reads the routing header and writes the same payload buffer to every eligible client.

Assistant streaming uses compact start/delta/end payloads on the private channel. The supervisor reconstructs the existing full public `message_update` once per delta. A growing assistant message is therefore not serialized or transferred in full for every token.

Transcript snapshots are encoded in the worker, not the supervisor. The worker streams opaque chunks to a bounded supervisor cache. The supervisor forwards chunks while they arrive and never parses a history-sized JSON object.

## Backpressure

Backpressure is attachment-local:

- A blocked client stops receiving incremental events.
- Other clients and workers continue normally.
- The supervisor retains no unbounded per-client event queue.
- On drain, that attachment receives a cursor catch-up or a new chunked snapshot.
- Finalized transcript caching is separate from live partial-message reconstruction.

## Recovery and Idempotency

Mutating commands are keyed by `clientId + commandId` and recorded before dispatch in an append-only journal.

- A repeated completed command returns its stored result.
- A received command with no durable result is reported as uncertain and is not replayed.
- Read and mutation envelopes survive transient supervisor reconnects with the same command ID.
- Clients durably acknowledge completed mutations, allowing acknowledged journal entries to be compacted away.

Workers journal operation transitions and detached subprocess identities. After a crash, the supervisor reaps the old process group plus tracked detached bash trees, appends a visible recovery marker to the persisted transcript, restores the root under the same active-session ID, and holds uncertain side effects rather than replaying them.

## Coordinated Updates

Update preparation is two-phase:

1. Every resident worker creates a non-destructive checkpoint in parallel.
2. The supervisor validates and atomically persists the aggregate manifest.
3. Only after all prepares and validation succeed does it commit and stop workers.

If any prepare or manifest validation fails, prepared workers are released and all roots keep running.

## Performance Benchmark

Run from `packages/coding-agent`:

```sh
npx tsx test/daemon-multiclient-bench.ts
npx tsx test/daemon-multiclient-bench.ts --generated-session-mib 100
npx tsx test/daemon-multiclient-bench.ts --generated-session-mib 500
npx tsx test/daemon-multiclient-bench.ts --session-file /path/to/session.jsonl
PRIME_AGENT_STRESS_WORKERS=50 npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-supervisor-process.test.ts -t "hosts resident roots"
```

The benchmark reports legacy and v2 fanout/attach paths side by side, including serialization count, elapsed time, throughput, and sampled RSS growth. The process stress case starts the requested number of resident roots, gives every root a simultaneous heartbeat while its own session is busy, and verifies that all schedules advance independently.
