# PR-B00 local swarm rehearsal

This directory is **test-only** evidence infrastructure. It has no import path from
production runtime code, does not contact a provider, and does not modify production
agent admission, retries, limits, or scheduling.

Run every supported breadth locally:

```sh
(cd packages/coding-agent && npx tsx test/swarm/rehearsal-bench.ts -- --fanout 1,4,16,64 --output /tmp/prime-agent-b00)
```

Add `--faults` for a deterministic progress/delay/restart/completion schedule and a
second-child failure when present. Each run writes separately inspectable redacted:

- `manifest.json` — canonical scenario, exact requested/resolved role/model/revision/effort, fixed fault schedule, embedded price-card snapshot, SHA-256 fingerprint, and hash/byte-size index for every artifact;
- `events.jsonl` — append-only canonical admission, fake-provider starts, progress, restart, failure,
  terminal delivery, and cleanup facts (content-free);
- `process-samples.json` — process-level samples and summed RSS (inject a sampler
  from future supervised-worker campaigns);
- `cost-attribution.json` — direct and downstream token/cost attribution by node;
- `summary.json` — fanout, terminal accounting, cleanup, delivery, and independent-dispatch proof.

`runSwarmBenchmark()` calls each fake provider directly through `Promise.all`; it has
no shared local admission queue, semaphore, synthetic 429, retry, or provider limit.
The report marks independent dispatch only when every request-start event precedes the
first terminal event. The fixture is deliberately minimal: it supplies evidence for
later runtime integrations rather than pretending to exercise the production RLM path.

The artifact writer recursively redacts sensitive field names, content-bearing fields,
and common credential shapes before writing. It uses owner-only files and `verifySwarmEvidence()`
fails closed on missing, out-of-tree, symlinked, size-mismatched, or hash-mismatched indexed artifacts.
Do not use raw prompt/response secrets in future fault fixtures.

### Explicitly deferred gates

This narrow baseline does not claim to exercise production RLM workers, exact streamed provider
payload order, provider retries, socket backpressure, or cross-platform worker supervision. Unix
uses `ps` to sample the harness process tree; Windows emits an explicit unsupported sampler rather
than a false zero. Future runtime campaigns must inject their supervisor-aware worker sampler, run
warmups/repetitions, and add native Windows/Linux collection before asserting release thresholds.
