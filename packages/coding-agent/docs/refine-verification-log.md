# /refine verification log

This log records manual benchmark-verification checks for PrimeAgent continual
harness features. It is intentionally artifact-oriented so later benchmark runs
can replay the same surfaces.

Current design note: refined prompt notes, memories, skills, subagent specs, and
refinement events are global by default under the agent harness directory, for
example `~/.prime/agent/harness/harness_state.json`. Session JSONL entries still
record refinement results for auditability and rollback evidence. A compact
overview of the global harness state is injected into the default system prompt
so the agent can use learned state without first calling `rlm.harness.overview()`.
The model-facing `rlm.harness` API uses explicit `create_*`, `update_*`, and
`delete_*` calls for memory, skill, subagent, and prompt-note entries.

## 2026-06-08 manual CLI session

- Branch: `continual-harness-capabilities`
- Repo: `/Users/milkkarten/Research/prime-agent`
- CLI launch: `./prime-agent.sh` in tmux session `PrimeAgentCLI`
- Model shown by CLI: `openai/gpt-5.5`
- Session file:
  `/Users/milkkarten/.prime/agent/sessions/--Users-milkkarten-Research-prime-agent--/2026-06-08T19-08-33-915Z_019ea8a2-fafa-741b-902a-c00b6b8b997d.jsonl`
- Harness state file:
  `/Users/milkkarten/.prime/agent/sessions/--Users-milkkarten-Research-prime-agent--/2026-06-08T19-08-33-915Z_019ea8a2-fafa-741b-902a-c00b6b8b997d/harness_state.json`

Historical note: this manual run happened before the harness store was switched
from session-backed to global-by-default persistence.

### Harness availability

Prompt sent:

```text
Use exactly one IPython tool call to run: print(hasattr(rlm, "harness")); print(type(rlm.harness).__name__); print(rlm.harness.overview()). Then summarize whether harness access works.
```

Expected result:

- `rlm.harness` is available to the model-facing callable object.
- `type(rlm.harness).__name__` is `HarnessState`.
- `rlm.harness.overview()` prints the active `harness_state.json` path.

Observed result:

- Pass after patching callable `rlm` to expose `harness` and
  `get_harness_state`.
- Before that patch, the same prompt failed with
  `AttributeError: '_RLMCallable' object has no attribute 'harness'`.

### Direct CRUD through `rlm.harness`

Prompt sent:

```text
Use exactly one IPython tool call to create one prompt note, one memory, one skill, one subagent, and one refinement event in rlm.harness with ids prefixed manual_cli_test_. Print rlm.harness.overview() and summarize the created ids.
```

Expected result:

- One prompt, memory, skill, subagent, and refinement event are persisted.

Observed result:

- Pass. Created `manual_cli_test_prompt`, `manual_cli_test_memory`,
  `manual_cli_test_skill`, `manual_cli_test_subagent`, and `refine_0001`.
- Defect found: `record_refinement(..., "single change")` stored a character
  list because the helper called `list(changes)`. Patched runtime helper to
  normalize a single string into a one-item list and added a Python unit test.

### `/refine` create, update, delete

Command sent:

```text
/refine benchmark verification: create prompt note manual_cli_test_refine_prompt saying manual CLI benchmark checks should capture state paths and validation commands; update skill manual_cli_test_skill to require npm run check after PrimeAgent code changes; delete memory manual_cli_test_memory; create subagent manual_cli_test_refine_subagent for reviewing refinement results and rollback safety.
```

Expected result:

- Create prompt `manual_cli_test_refine_prompt`.
- Update skill `manual_cli_test_skill`.
- Delete memory `manual_cli_test_memory`.
- Create or update subagent `manual_cli_test_refine_subagent`.
- Append `prime-agent.refinement` custom session history with applied edits and
  before/after snapshots.

Observed result:

- Pass. The session file includes refinement records:
  `refine_20260608191027670` and `refine_20260608191328216`.
- The harness state recorded memory deletion, skill update, subagent creation,
  and prompt-note creation.
- Tmux paste-buffer did not reliably submit the command in the TUI; literal
  `tmux send-keys -l ... && tmux send-keys C-m` worked.
- The first failed paste appears to have later queued duplicate/no-op refine
  attempts. The persisted history made this visible even when TUI status lines
  were not present in the captured pane.

### `/refine rollback`

Command sent:

```text
/refine rollback refine_20260608191328216
```

Expected result:

- Append a new refinement with `rollbackOf: refine_20260608191328216`.
- Restore before-snapshots for updated entries.
- Delete entries created by the rolled-back refinement.

Observed result:

- Pass. The session file includes `refine_20260608191633157` with
  `rollbackOf: refine_20260608191328216`.
- The harness state removed `manual_cli_test_refine_prompt`.
- `manual_cli_test_skill` reverted to the earlier `npm run check when
  applicable` text.
- `manual_cli_test_refine_subagent` reverted to its earlier review-focused
  content.

### Immutable base system prompt guardrail

Command sent:

```text
/refine benchmark guardrail test: attempt to update prompt id base_system_prompt with title Base system prompt and content SHOULD_NOT_APPLY. This should be rejected by the immutable base prompt guardrail; do not create alternate prompt ids.
```

Expected result:

- No `base_system_prompt` entry in editable harness prompt notes.
- No alternate prompt entry created.
- Refinement history records a no-op or failed edit rationale.

Observed result:

- Pass. `base_system_prompt` is absent from `entries.prompt`.
- The only prompt entry after rollback remained `manual_cli_test_prompt`.
- The session file includes `refine_20260608191730440` with no applied edits and
  rationale explaining the immutable base prompt guardrail.

## Validation commands

Run these after changes to refinement or harness runtime code:

```bash
PYTHONPATH=prime-agent-runtime/src python3 -m unittest discover prime-agent-runtime/test
npx tsx ../../node_modules/vitest/dist/cli.js --run test/refinement.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/system-prompt.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/kernel-bootstrap.test.ts
npm run check
```

## Automated matrix coverage

`packages/coding-agent/test/refinement.test.ts` covers the deterministic
refinement engine used by both interactive `/refine` and RPC `refine`.
`prime-agent-runtime/test/test_harness.py` covers the Python `rlm.harness`
runtime store exposed to model IPython calls.

Covered action/kind combinations:

- `create prompt`
- `create memory`
- `create skill`
- `create subagent`
- `update prompt`
- `update memory`
- `update skill`
- `update subagent`
- `delete prompt`
- `delete memory`
- `delete skill`
- `delete subagent`

Covered validation and recovery cases:

- Generated ids for create edits without ids.
- Default `path`, `metadata`, `source`, and version handling.
- Global harness state directory resolution under the agent dir.
- Compact global harness overview injection into the default system prompt.
- `/refine` usage guidance in the injected harness overview.
- Bounded harness prompt injection with entry overflow and content truncation.
- Persistence to and reload from `harness_state.json`.
- Refinement history extraction from `prime-agent.refinement` custom entries.
- Duplicate create rejection for every editable kind.
- Missing update target rejection for every editable kind.
- Missing delete target rejection for every editable kind.
- Required title/content validation for create and update.
- Required id validation for update and delete.
- Unsupported action rejection.
- Unsupported kind rejection.
- Immutable `base_system_prompt` rejection.
- Rollback restoration for one created entry, one updated entry, and one deleted
  entry in the same target refinement.
- Missing rollback target error.
- Python runtime create, read, update, list, and delete for prompt, memory,
  skill, and subagent entries.
- Python runtime explicit `create_*`, `update_*`, and `delete_*` model-facing
  methods.
- Python runtime default backing store through `RLM_HARNESS_STATE_DIR`.
- Python runtime unknown-kind rejection for `upsert`, `get`, `delete`, and
  `list`.
