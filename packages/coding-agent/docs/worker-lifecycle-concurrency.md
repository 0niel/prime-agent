# Worker Lifecycle Concurrency Contract

This document is the authoritative contract for the daemon supervisor and worker lifecycle code. It applies to launch, attach/retry, stop, recovery, stale-registration reclaim, RLM child cancellation, and descriptor replay. It deliberately specifies the small shared-state boundary; public protocol semantics remain in [daemon.md](daemon.md).

## State and observability

A worker registration is observable as `starting`, `running`, `recovering`, or a stop tombstone (`stopRequestedAt`). A stop tombstone is observable before signalling begins and remains observable until descriptor deletion. A retry/relaunch replaces the registration's process generation; it must remove a rescinded stop tombstone before publishing the successor. A child run is observable as `queued`, `running`, then exactly one terminal `done`, `error`, or `cancelled`; a cancelled run stays tracked until its detached cleanup settles, so a second cancellation is accepted rather than mistaken for a completed selector.

The immutable authority tuple for a process operation is:

```text
(workerId, pid, processStartId, supervisor generation, stopRevision)
```

Capture it before an asynchronous operation. The worker ID alone is never authority to signal, delete, archive, or reclaim. `processStartId` distinguishes a reused PID, supervisor generation fences an obsolete supervisor, and `stopRevision` fences a rescinded/replaced stop. The operation must revalidate its applicable tuple and tombstone **after every `await`**, immediately before every signal, and immediately before every destructive commit. A failed revalidation is a no-op/abort of that operation, never authority to act on its successor.

## Process truth table

`processIdentity(pid, processStartId)` is conservative. “Signal” means TERM/KILL; “reclaim” means delete a descriptor or release the session lease.

| Observation | Truth | Signal | Reclaim / reuse |
| --- | --- | --- | --- |
| PID absent | dead | no | yes |
| PID present and start ID matches | exact worker | yes, subject to tuple revalidation | no |
| PID present and start ID differs | recycled PID | no | yes; it is not our process |
| PID present but start ID unreadable | unknown/live | no | no |
| Descriptor has no start ID | legacy identity | TERM only while directly observed current; record a fresh ID if available | no until dead is confirmed |

In particular, unreadable is neither dead nor recycled. It cannot justify cleanup or a signal. A caller that needs a result reports the registration still active or cleanup pending.

## Ownership, concurrent stops, retries, and reclaim

`stopWorker` owns the foreground stop attempt. Every concurrent call increments the per-worker stop count for the duration of its own call; decrementation is in `finally`. The count is observability/accounting, **not** a permission to coalesce incompatible calls. Each attempt has a captured authority tuple and must fail closed if a retry/relaunch changes it.

A timed-out descriptor stop schedules exactly one `stopFinalization` promise. That promise owns background escalation and cleanup; concurrent timeouts and stale-reclaim callers join it rather than sending another signal or deleting state. Finalization retries transient cleanup after the process is confirmed gone, but exits if the tuple/tombstone was rescinded. Reclaim first requires `gone` or `recycled`, then joins finalization for a bounded user-visible wait. If cleanup exceeds that wait, it returns an honest retry/pending error; it never returns the stale registration as reusable. Retries/relaunches own publication of the successor and must invalidate all previous stop authority before awaiting startup work.

A foreground request has bounded waits (worker shutdown RPC and liveness deadlines). Long escalation, archival, and retry work continue in the owned finalizer without holding the user request open.

## Locks and awaits

The implementation uses short synchronous mutations and promise ownership, rather than a monitor held across I/O.

1. Mutate one worker's descriptor/map state, stop count, child terminal state, or finalizer slot synchronously.
2. Capture the authority tuple and release that state before any await, RPC, process probe, signal wait, catalog call, socket write, or child disposal.
3. After every await, reacquire only the necessary state and revalidate authority before the next effect.

Allowed ordering is: global supervisor admission/mutation fence -> worker registration -> worker-local snapshot/child bookkeeping. A worker-local operation must not acquire the global fence while holding worker bookkeeping. There is **no await under any of these locks/bookkeeping mutations** and no lock may be retained while calling client, catalog, process, or extension code. Promise slots (`stopFinalization`, snapshot loads, child publication) are single-flight ownership tokens, not locks; await their promise only after publishing the slot.

## Idempotence, compensation, and cancellation winner

Irreversible transitions are guarded by a synchronous winner:

- The first child cancellation changes `queued`/`running` to `cancelled`, records its reason, rejects publication, aborts once, and emits one cancelled update. Later callers while it remains tracked return accepted without repeating abort, rejection, or terminal emission. The terminal cleanup emits at most one notice and removes tracking only after settlement.
- A descriptor tombstone is idempotent; descriptor deletion is conditional on its captured tuple/tombstone.
- Finalization and stale reclaim compensate interrupted foreground stops by completing the same cleanup path, not replaying a second independent stop.
- If cancellation races normal completion, the first synchronous terminal state wins. Later completion may dispose/release resources but cannot overwrite the winner or emit a second terminal event.

Registry replay has the same selector-local rule: a malformed row quarantines only its own `childId`; unrelated valid rows remain published. Only a later complete row for that exact selector recovers it.
