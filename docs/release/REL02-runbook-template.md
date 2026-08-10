# REL02 release runbook (draft template)

> Complete this record for exactly one release candidate. REL02 approval is **HOLD** until every required record below is complete and its observed values match. This template does not authorize a version bump, tag, publication, or pointer update.

## 0. Gate rule and evidence format

Use an immutable, access-controlled evidence store. Every evidence row must contain an immutable object path or URL, the SHA-256 of the exact bytes at that path, the UTC time, and the operator or workflow run ID. A dashboard, branch name, mutable `latest` URL, abbreviated SHA, or prose assertion is not evidence.

A required check has only these decision values:

| Value | Meaning | Release action |
| --- | --- | --- |
| **PASS** | The required fresh observation is present and matches the expected value. | Continue only when every preceding required check is also PASS. |
| **HOLD** | The observation is missing, stale, failed, differs, cannot be reproduced, or its immutable evidence cannot be read. | Do not tag, publish, or advance a pointer; record the discrepancy and resolve it in a new attempt. |

Do not overwrite a completed record. A correction is a new immutable record that links the superseded record and retains its digest.

## 1. Release identity, canonical immutable manifest, and source freeze

Set `<VERSION>` before any release action. REL01's canonical release manifest is the immutable versioned object:

```text
releases/v<VERSION>/manifest.json
```

The manifest is append-only/WORM after publication. It must contain the full Prime Agent and Verifiers SHAs, candidate version/channel, build command and immutable toolchain/image identities, ordered GSM8K IDs and lifecycle seeds, every distributable filename/size/SHA-256 **and immutable stored-object path/version**, and the REL01 dry-run digest. Its exact SHA-256 must be recorded as the `manifest.json` entry in the immutable versioned checksum file:

```text
releases/v<VERSION>/SHA256SUMS
```

For example, the required checksum entry is `<MANIFEST_SHA256>  manifest.json`. Store each subsequent freeze, build, publication, and verification record in the immutable evidence index; do not mutate the frozen manifest to add later evidence.

| Field | Required recorded value |
| --- | --- |
| Release channel and candidate version | `<stable-or-beta> / <VERSION>` |
| Prime Agent selected commit | `<PA_SHA: exactly 40 lowercase hex>` |
| Verifiers selected commit | `<VERIFIERS_SHA: exactly 40 lowercase hex>` |
| Canonical immutable manifest path | `releases/v<VERSION>/manifest.json` |
| Manifest SHA-256 | `<MANIFEST_SHA256: 64 lowercase hex>` |
| Immutable checksum path and manifest entry | `releases/v<VERSION>/SHA256SUMS / <MANIFEST_SHA256  manifest.json>` |
| Root pointer binding | `<ROOT_POINTER_PATH> / {"manifest":"releases/v<VERSION>/manifest.json","sha256":"<MANIFEST_SHA256>"}` |
| Freeze record path and SHA-256 | `releases/v<VERSION>/freeze/source-freeze.json / <FREEZE_RECORD_SHA256>` |
| Exact REL01 dry-run output path and SHA-256 | `<IMMUTABLE_PATH> / <REL01_DRY_RUN_SHA256>` |

### Paired SHA, freeze, and rebuild checks

The Prime Agent and Verifiers SHAs are a pair. Never replace one SHA while retaining the other side's freeze, manifest, build, or approval evidence.

| Required check | Required method and immutable evidence | Result (`PASS` / `HOLD`) |
| --- | --- | --- |
| Paired source selection | Resolve both selected refs to the two recorded 40-character SHAs; record the resolver transcript path + SHA-256. | `<PASS / HOLD>` |
| Paired freeze | Create `source-freeze.json` containing both SHAs, `<VERSION>`, manifest SHA-256, ordered inputs, and toolchain/image IDs; record its path + SHA-256 and the create-or-verify record below. | `<PASS / HOLD>` |
| Freeze read-back | Read the immutable freeze record after creation and verify both SHAs and the manifest SHA-256 byte-for-byte; record the read-back transcript path + SHA-256. | `<PASS / HOLD>` |
| Primary clean-room build from freeze | In a newly created workspace with no prior build outputs or artifact cache, check out exactly both frozen SHAs, build using the frozen command/toolchain, and compare every output SHA-256 with the manifest; record the raw build transcript path + SHA-256 and the output-hash report path + SHA-256. | `<PASS / HOLD>` |
| Second independent clean-room rebuild from freeze | In a separately created fresh workspace (not the primary build directory and not reusing its outputs or cache), repeat the frozen build from exactly both frozen SHAs and compare every output SHA-256 with both the primary clean-room build and manifest; record the raw rebuild transcript path + SHA-256 and the output-hash report path + SHA-256. | `<PASS / HOLD>` |
| Artifact read-back | Download each stored artifact by immutable object version/URL, recompute SHA-256, and compare it to the manifest; record transcript path + SHA-256. | `<PASS / HOLD>` |

Any change to either source SHA, the manifest, inputs, toolchain, or artifact digest invalidates the paired freeze and both build checks. Set all affected rows to **HOLD** and start a new versioned attempt; do not amend the old manifest.

## 2. Fixed evaluation plan and retained raw evidence

| Control | Required value |
| --- | --- |
| Fixed GSM8K example IDs, ordered | `<ID_1>, <ID_2>, ...` |
| Lifecycle seeds, ordered | `<SEED_1>, <SEED_2>, ...` |
| Verifiers command and configuration digest | `<COMMAND> / <CONFIG_SHA256>` |
| Environment/image/toolchain immutable identity | `<DIGEST_OR_LOCKFILE_SHA256>` |
| Canary start/end timestamps (UTC) | `<TIMESTAMPS>` |
| Raw logs, traces, outputs, and metrics path + SHA-256 | `<IMMUTABLE_PATH> / <EVIDENCE_SHA256>` |
| Retention owner and minimum retention period | `<OWNER_AND_PERIOD>` |

Attach the exact input list, unmodified command transcript, and raw result bytes before writing any summary or decision. A rerun must use the same ordered IDs and seeds.

### Depth-1 S01 decision

| Item | Record |
| --- | --- |
| Depth-1 S01 fresh result | `<PASS / HOLD>` |
| Evaluated frozen SHA pair and manifest SHA-256 | `<PA_SHA> / <VERIFIERS_SHA> / <MANIFEST_SHA256>` |
| Raw evaluation evidence path + SHA-256 | `<IMMUTABLE_PATH> / <EVIDENCE_SHA256>` |
| Approver and UTC timestamp | `<NAME_AND_TIME>` |
| Decision rationale | `<RATIONALE>` |

A missing, failed, stale, or non-reproducible depth-1 result is **HOLD**, never implicit approval.

## 3. Create-or-verify records and ordered release actions

For every external action, first use an idempotent **create-or-verify** operation. If the object already exists, read it back and verify that its immutable identity and all expected values match. Never force-update, move, delete, or silently reuse a mismatched object. Record each operation as an immutable JSON or transcript object containing action, target, expected identity, observed identity, UTC time, actor/run ID, and outcome; enter its path + SHA-256 here.

| Ordered step | Target and required verification | Create-or-verify record path + SHA-256 | Result (`PASS` / `HOLD`) |
| --- | --- | --- | --- |
| 1. Freeze and manifest | Create-or-verify `releases/v<VERSION>/manifest.json`, its `releases/v<VERSION>/SHA256SUMS` entry, and the paired source freeze. Read each back; recompute the manifest SHA-256 and require it to equal the `SHA256SUMS` `manifest.json` entry. | `<IMMUTABLE_PATH> / <SHA256>` | `<PASS / HOLD>` |
| 2. Artifact storage | Create-or-verify every versioned artifact object at the manifest's immutable object path/version; read back exact bytes and match every manifest SHA-256. Record each artifact object's immutable path/version, object metadata/read-back outcome, and hash in the operation record. | `<IMMUTABLE_PATH> / <SHA256>` | `<PASS / HOLD>` |
| 3. Protected production tag | Create-or-verify `v<VERSION>` by non-force ref API. Peel annotated or lightweight tag and require exactly `<PA_SHA>`; record remote tag read-back. | `<IMMUTABLE_PATH> / <SHA256>` | `<PASS / HOLD>` |
| 4. Release publication | Only after step 3 PASS, create-or-verify the release entry bound to `v<VERSION>` and the manifest digest; read it back. | `<IMMUTABLE_PATH> / <SHA256>` | `<PASS / HOLD>` |
| 5. Fresh distribution verification | Only after step 4 PASS, perform and record the fresh checks in section 4. | `<IMMUTABLE_PATH> / <SHA256>` | `<PASS / HOLD>` |
| 6. Final channel/pointer advance | Only after steps 1–5 PASS, create-or-verify the root channel pointer/deployment. It must bind `{"manifest":"releases/v<VERSION>/manifest.json","sha256":"<MANIFEST_SHA256>"}` and resolve to the tagged `v<VERSION>` artifact/commit; immediately read it back and verify both fields. | `<IMMUTABLE_PATH> / <SHA256>` | `<PASS / HOLD>` |

**Ordering is mandatory:** the protected tag is established and verified before publication; the channel pointer/deployment is the final external mutation, after tagged publication and fresh distribution verification PASS. An existing tag is acceptable only if it peels exactly to `<PA_SHA>`; a mismatch is **HOLD**. Repository protection must prohibit tag mutation and deletion for the release credential. Re-fetch/re-read the tag immediately before the final pointer action and again after it; either mismatch is **HOLD**.

## 4. Fresh distribution verification (after publication, before pointer)

Run these checks after step 4 completes. They must be newly executed for this attempt: their start time must be later than the publication read-back time, and their evidence must name `<VERSION>`, `<MANIFEST_SHA256>`, and the frozen SHA pair. Do not reuse a prior candidate's cache, install, test result, or dashboard status.

| Fresh check | Required observation and evidence | Result (`PASS` / `HOLD`) |
| --- | --- | --- |
| Clean retrieval | From a fresh temporary directory with an empty package/artifact cache, retrieve the published distribution from the public release endpoint and record endpoint, UTC start/end, artifact byte SHA-256, raw transcript path, and transcript SHA-256. The byte SHA-256 must equal the manifest. | `<PASS / HOLD>` |
| Clean install | In a new environment with no local source checkout or preinstalled candidate, install exactly the retrieved distribution; record environment/tool identity and full raw install transcript path + SHA-256. | `<PASS / HOLD>` |
| Installed identity | Query the installed package/version and its installed artifact metadata; record raw output path + SHA-256 and require `<VERSION>` plus the manifest artifact SHA-256. | `<PASS / HOLD>` |
| Published smoke/evaluation | Run the frozen smoke/evaluation command against the clean install and record exact inputs, raw output path + SHA-256, and result. | `<PASS / HOLD>` |
| Independent repeat | A second fresh retrieval and SHA-256 calculation from the published endpoint matches the manifest; record raw transcript path + SHA-256. | `<PASS / HOLD>` |

### Distribution decision

| Decision field | Required record |
| --- | --- |
| Publication read-back time (UTC) | `<TIME>` |
| All five fresh distribution checks | `<all PASS / otherwise HOLD>` |
| Distribution decision | `<PASS / HOLD>` |
| Decision evidence paths + SHA-256 values | `<PATH_AND_DIGESTS>` |
| Operator/approver and UTC timestamp | `<NAME_AND_TIME>` |
| If HOLD, blocking discrepancy and remediation owner | `<DISCREPANCY_AND_OWNER>` |

The distribution decision is **PASS** only when all five rows are PASS and their evidence is fresh. Otherwise write **HOLD** and do not perform step 6.

## 5. Final REL02 approval (after all evidence, tag, publication, verification, and pointer read-back)

Do not infer approval from completed rows. The designated release approver must write exactly one explicit final decision after step 6's immediate pointer read-back. **PASS** authorizes this completed attempt only when every required row in sections 1–4 is PASS and all referenced immutable evidence can be read and matches; otherwise the final decision is **HOLD**. A HOLD authorizes no tag, publication, or pointer mutation and must name the blocking evidence and remediation owner. Any subsequent correction or retry is a new immutable record/attempt.

| Final approval field | Required record |
| --- | --- |
| Final REL02 decision | `<PASS / HOLD>` |
| Release candidate identity | `<VERSION> / <PA_SHA> / <VERIFIERS_SHA> / <MANIFEST_SHA256>` |
| Required evidence index path + SHA-256 | `<IMMUTABLE_PATH> / <EVIDENCE_INDEX_SHA256>` |
| Tag, publication, and final pointer read-back evidence paths + SHA-256 | `<PATH_AND_DIGESTS>` |
| Approver identity and UTC timestamp | `<NAME_AND_TIME>` |
| Explicit approval rationale, or HOLD blockers and remediation owner | `<RATIONALE_OR_DISCREPANCY_AND_OWNER>` |

### Raw evidence index

Create an immutable evidence index for this attempt before final approval. It must enumerate every raw resolver, freeze create/read-back, primary and independent clean-room build/hash report, artifact create/read-back, tag, publication, distribution, S01, pointer, and rollback transcript/object; for each entry record its purpose, immutable path or URL (including object version when applicable), SHA-256, UTC observation time, and operator/workflow run ID. The final-approval table records the index path and digest; because the manifest is frozen before these later observations, do not mutate it to add the index. Missing raw evidence is **HOLD**.

## 6. Rollback plan

- Trigger(s): `<TRIGGERS>`
- Exact immutable tag/artifact/pointer to restore: `<IMMUTABLE_PREVIOUS_REFERENCE>`
- Operator and approval path: `<OWNER_AND_APPROVER>`
- Verification command and expected artifact hash after rollback: `<COMMAND_AND_SHA256>`
- Immutable raw rollback transcript path + SHA-256: `<IMMUTABLE_PATH> / <SHA256>`

## Completion

- [ ] Canonical `releases/v<VERSION>/manifest.json`, its `SHA256SUMS` manifest entry, and their read-back evidence are recorded.
- [ ] The paired Prime Agent and Verifiers SHA freeze, two separate clean-room builds, and their output-hash comparisons all PASS with immutable evidence.
- [ ] Fixed GSM8K IDs, lifecycle seeds, and raw canary evidence are recorded.
- [ ] Every external action has a create-or-verify record.
- [ ] Protected tag and tagged publication PASS before the final pointer action.
- [ ] Fresh distribution retrieval, clean install, identity, smoke, and independent repeat all PASS; the distribution decision is explicit.
- [ ] Depth-1 S01 decision is explicit and PASS.
- [ ] The immutable raw-evidence index is complete and its path and digest are recorded in final approval without mutating the frozen manifest.
- [ ] An explicit final REL02 PASS/HOLD approval with approver and UTC timestamp is recorded after the final pointer read-back.
- [ ] Rollback reference and verification are ready.
