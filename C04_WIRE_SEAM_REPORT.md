# C04 wire seam report — C03 integration

**Order / dependency.** This narrowly completes the C03-to-C04 terminal wire seam on top of C03 `d9b58451e012774f5d4e5b708668cd3e413994f1`. It is intentionally earlier than, and does not substitute for, the C04 artifact store/resolver described in `terra-c04-contract.md`; C03 remains the sole ledger/outbox/inbox/consumed transport authority. There are no provider, stream, queue, daemon protocol, or limiter changes.

## Contract delivered

- Added the closed `RlmTerminalMessage` `rlm_child_result_reference` variant, with `details.kind: "child_result_v1"` and a `RlmChildResultReferenceV1` projection only.
- `assertChildResultReference` is recursive and fail-closed: exact keys at every object level, canonical UUIDv4 result/handle IDs, lower-case 64-hex SHA-256, safe artifact byte integers through 512 MiB, at most 16 unique handles bound to the outer `resultId`, closed status/kind/content-type/error/retention sets, required summary/preview, and scalar-value plus UTF-8 byte limits.
- The projection is capped at 64 KiB. Legacy terminal messages retain their pre-existing 16,384-character / 24-KiB envelope cap. The result-reference branch validates its projection cap instead and never loosens legacy acceptance.
- `formatRlmChildResultReference` and `createRlmChildResultReferenceTerminalMessage` make `content` exactly the canonical projection. Validation rejects arbitrary or mismatching content. A completed result rejects `error`; every non-completed result requires a closed `{ code, message }` safe error.
- No owner/correlation ID, filesystem path, payload/body, or unknown nested field can enter this C03 public projection.

## Focused proof

`rlm-c04-wire-seam.test.ts` adds five deterministic tests for exact acceptance/formatting, legacy-cap isolation, outbox/terminal/inbox/restart/materialization and digest idempotence, malicious nested fields/malformed recovery, and character/byte/64-KiB boundaries. It uses only temporary local artifacts.

The source is a C03 adapter seam, not C04 artifact creation or authorization. The full C04 implementation must use the contract-owned `rlm-child-results.ts` authority and then hand only this validated projection to C03.
