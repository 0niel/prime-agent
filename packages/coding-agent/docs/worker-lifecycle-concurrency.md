# Worker Lifecycle Concurrency Contract

This document is the authoritative contract for the daemon supervisor and worker lifecycle code. It applies to launch, attach/retry, stop, recovery, stale-registration reclaim, RLM child cancellation, and descriptor replay. It deliberately specifies the small shared-state boundary; public protocol semantics remain in [daemon.md](daemon.md).

## State and observability

A worker descriptor lifecycle is exactly `starting`, `ready`, `recovering`, `stopping`, or `failed`. Descriptor removal is represented by `removed`; session archival is represented by `archive`. A stop tombstone (`stopRequestedAt`) is published before signalling and remains until a successfully authorized removal. A retry/relaunch replaces the process generation and removes a rescinded tombstone before publishing its successor. A child run is observable as `queued`, `running`, then exactly one terminal `done`, `error`, or `cancelled`; a cancelled run stays tracked until detached cleanup settles.

The exact authority tuple for every TERM/KILL and destructive descriptor/archive commit is:

```text
(workerId, pid, processStartId, supervisorGeneration, stopRevision, stopRequestedAt)
```

`supervisorGeneration` is the immutable `this.generation`, and its durable ownership record must match through `await this.assertCurrentOwnership()`. The worker ID alone is never authority to signal, delete, archive, or reclaim. `processStartId` distinguishes a reused PID and `stopRevision`/`stopRequestedAt` fence a rescinded or replaced stop. Immediately before each TERM/KILL and destructive descriptor, artifact, or archive commit, the implementation awaits ownership assertion, then makes the complete tuple assertion and fresh process-identity check with **no await in between**. A failed, unreadable, or lost ownership check fails closed: no signal/delete/archive is performed, and the tombstone/retry record remains for recovery by a new owner.

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

A timed-out descriptor stop schedules exactly one `stopFinalization` promise. That promise owns background escalation and cleanup; concurrent timeouts and stale-reclaim callers join it rather than sending another signal or deleting state. Finalization retries transient cleanup after the process is confirmed gone, but exits if the tuple/tombstone was rescinded **or ownership is lost**. Reclaim first requires `gone` or `recycled`, then joins finalization for a bounded user-visible wait. If ownership is unreadable or lost, it retains the tombstone/retry record for the successor; it never returns the stale registration as reusable. Adoption/recovery asserts ownership only at an actual adjacent commit/signal boundary, while finalizer and foreground stop paths reassert after every wait. Retries/relaunches own publication of the successor and must invalidate all previous stop authority before awaiting startup work.

A foreground request has bounded waits (worker shutdown RPC and liveness deadlines). Long escalation, archival, and retry work continue in the owned finalizer without holding the user request open.

## Locks and awaits

The implementation uses short synchronous mutations and promise ownership, rather than a monitor held across I/O.

1. Mutate one worker's descriptor/map state, stop count, child terminal state, or finalizer slot synchronously.
2. Capture the authority tuple and release that state before any await, RPC, process probe, signal wait, catalog call, socket write, or child disposal.
3. After every await, reacquire only the necessary state and revalidate authority before the next effect. For TERM/KILL or a destructive descriptor/archive commit, `await this.assertCurrentOwnership()` is the final await; the full tuple assertion and fresh process identity follow synchronously and immediately before the effect.

Allowed ordering is: global supervisor admission/mutation fence -> worker registration -> worker-local snapshot/child bookkeeping. A worker-local operation must not acquire the global fence while holding worker bookkeeping. There is **no await under any of these locks/bookkeeping mutations** and no lock may be retained while calling client, catalog, process, or extension code. Promise slots (`stopFinalization`, snapshot loads, child publication) are single-flight ownership tokens, not locks; await their promise only after publishing the slot.

## Idempotence, compensation, and cancellation winner

Irreversible transitions are guarded by a synchronous winner:

- The first child cancellation changes `queued`/`running` to `cancelled`, records its reason, rejects publication, aborts once, and emits one cancelled update. Later callers while it remains tracked return accepted without repeating abort, rejection, or terminal emission. The terminal cleanup emits at most one notice and removes tracking only after settlement.
- A descriptor tombstone is idempotent; descriptor deletion is conditional on its captured tuple/tombstone.
- Finalization and stale reclaim compensate interrupted foreground stops by completing the same cleanup path, not replaying a second independent stop.
- If cancellation races normal completion, the first synchronous terminal state wins. Later completion may dispose/release resources but cannot overwrite the winner or emit a second terminal event.

Registry replay has the same selector-local rule: a malformed row quarantines only its own `childId`; unrelated valid rows remain published. Only a later complete row for that exact selector recovers it.
