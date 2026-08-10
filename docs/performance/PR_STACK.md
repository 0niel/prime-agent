# High-Performance Design PR Stack

This is the review index for the high-performance design and implementation stack. It uses **native Git branches and GitHub pull-request base branches** as a stacked-PR DAG. Graphite is neither installed nor required.

## Review and merge discipline

Review **parent first**: a child assumes the behavior and review outcome of its base. Do not merge any member of this stack yet. After a parent lands, rebase or retarget its direct child as appropriate, revalidate that child, and proceed in dependency order. A linked PR being published/open means it is available for review, not that it has been approved or merged.

Validation remains per-PR: each non-draft item must retain its required CI and review evidence after its parent changes. Draft PRs are explicitly not review-ready. In particular, C04, N01, and MEM01 are currently Draft; MEM02 is local and security-blocked, with no review-ready PR.

## DAG

```text
core:    B00A ──> C00 ──> B00B ──> C01 ──> C02 ──> C03 ──> C04
                                      │
 swarm:                               └──> SW01
 runtime:                       B00B ──> N01
 memory:                        B00B ──> MEM01 ──> MEM02
```

## Core lane — review in this order

| Order | Item | Pull request | Status | Base → head | Head commit |
| ---: | --- | --- | --- | --- | --- |
| 1 | B00A | [#1106](https://github.com/PrimeIntellect-ai/prime-agent/pull/1106) | Published; open | `main` → `perf/b00-swarm-benchmark` | `95762cdaa446412137614eee4adba73d1525c9d3` |
| 2 | C00 | [#1107](https://github.com/PrimeIntellect-ai/prime-agent/pull/1107) | Published; open | `perf/b00-swarm-benchmark` → `perf/c00-session-lifecycle` | `bd22fc3ce0306212047d1d0a5c50d1153ff7907b` |
| 3 | B00B | [#1115](https://github.com/PrimeIntellect-ai/prime-agent/pull/1115) | Published; open | `perf/c00-session-lifecycle` → `perf/b00b-production-gate` | `9d9cf28d51490ef06efba738c3fff788463acdff` |
| 4 | C01 | [#1123](https://github.com/PrimeIntellect-ai/prime-agent/pull/1123) | Published; open | `perf/b00b-production-gate` → `perf/c01-identity-fencing` | `821a180763e2fd20b6134fe8e661e5308f6b4af0` |
| 5 | C02 | [#1130](https://github.com/PrimeIntellect-ai/prime-agent/pull/1130) | Published; closed (not merged) | `perf/c01-identity-fencing` → `perf/c02-event-coalescing` | `d2223258fa362e8fed5c5209cabf59d0eacc6e98` |
| 6 | C03 | [#1166](https://github.com/PrimeIntellect-ai/prime-agent/pull/1166) | Published; open | `perf/c02-event-coalescing` → `perf/c03-durable-terminal-delivery` | `42afc919f0e43ded880aa8a2d7088f31b264da95` |
| 7 | C04 | [#1168](https://github.com/PrimeIntellect-ai/prime-agent/pull/1168) | **Draft; validation/review pending** | `perf/c03-durable-terminal-delivery` → `perf/c04-bounded-child-results` | `24829835e60cfffc9e134ca112ba85262801c8a9` |

## Dependent lanes

| Parent | Item | Pull request | Status | Base → head | Head commit |
| --- | --- | --- | --- | --- | --- |
| C01 | SW01 | [#1157](https://github.com/PrimeIntellect-ai/prime-agent/pull/1157) | Published; open | `perf/c01-identity-fencing` → `perf/sw01-role-policy` | `2c61c246b2ba7b30d7e60b45bf511af45ef19ba6` |
| B00B | N01 | [#1169](https://github.com/PrimeIntellect-ai/prime-agent/pull/1169) | **Draft; remote final attempt rerunning after retained preflight failure** | `perf/b00b-production-gate` → `perf/n01-incremental-structured-output` | `5835416078b7440cbf479c007e43b63d4ae55416` |
| B00B | MEM01 | [#1170](https://github.com/PrimeIntellect-ai/prime-agent/pull/1170) | **Draft; validation/review pending** | `perf/b00b-production-gate` → `perf/mem01-storage-adapter` | `b529552f10c8000fa8cf9bab0b51626d844cd78f` |
| MEM01 | MEM02 | — | **Local / security-blocked; not review-ready** | `perf/mem01-storage-adapter` → `perf/mem02-sqlite-backend` | local head `6e24fedcc8b451763fca7a6b390b9af6384d649d` |

The GitHub status above was checked when this index was published. This document intentionally records the exact branch relationship and tip SHA for review traceability; refresh it if a branch is rebased or a PR is retargeted.
