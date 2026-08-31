# AISuite bridge

This extension makes an AISuite-generated project behave consistently in Prime Agent:

- discovers the nearest AISuite project root from nested working directories;
- exposes all generated skills through `resources_discover`;
- eagerly injects generated rules and selected skill contracts before the first model step;
- enables configured host tools and teaches the model Prime Agent's native `await bash(...)` shell contract;
- executes generated `SessionStart`, `PreToolUse`, `PostToolUseFailure`, `Stop`, and `SessionEnd` hooks with bounded runtime and output;
- persists selected skills and the external read-only gate across session resume;
- blocks known Tracker, review, HTTP, and MCP mutation routes when the prompt asks for read-only work.

## All-in-one installer

The fork includes a macOS/Linux bootstrap that installs the stable Prime Agent binary, clones or safely fast-forwards the AISuite bridge branch, validates and regenerates project AISuite artifacts, configures Eliza models, creates `prime-agent-aisuite`, and runs a no-session live completion smoke:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/0niel/prime-agent/353be37c23b022d6f7cfd5abba4f8ae4903bfb1c/scripts/install-aisuite-eliza.sh \
  | bash -s -- --project-dir "$HOME/arcadia/flutter/pro/yxpro/professions/eats"
```

When `ya` is installed, the recommended authentication mode resolves a fresh token at request time with `ya tool fetch-token -preset eliza`. Otherwise the installer asks for a token without echo and stores it in `~/.prime/agent/secrets/eliza-token` with mode `0600`; `models.json` stores only a shell lookup command. Use `--token-source prompt` to force manual entry.

The installer is idempotent. It preserves unrelated custom providers, refuses to update a dirty or unexpected checkout, merges JSON atomically, and only fast-forwards the fork branch. Run with `--help` for non-interactive and skip options.

Load it from the repository:

```bash
./prime-agent.sh --extension packages/coding-agent/examples/extensions/aisuite
```

Or copy/symlink the directory to `~/.prime/agent/extensions/aisuite` for automatic discovery.

Use `/aisuite-status` to verify discovery and `/aisuite-readonly on|off|status` to control the write gate explicitly. Read-only language such as `do not comment on the ticket`, `read-only`, or `не отвечай в тикете` also enables the gate for the session.

The read-only gate is defense in depth for supported tool routes, not an operating-system sandbox. Keep Prime Agent inside a restricted checkout and do not enable unreviewed tools or extensions when a hard write boundary is required.

Optional configuration can be stored globally at `~/.prime/agent/extensions/aisuite.json` or in a project at `.prime/agent/aisuite.json`:

```json
{
  "enabledTools": ["ipython", "bash", "edit"],
  "eagerRules": true,
  "hooksFile": ".codex/hooks.json",
  "maxPromptBytes": 262144,
  "skillBundles": {
    "duty-cracker": ["tracker", "community-intrasearch", "wiki", "monium"]
  }
}
```

`maxPromptBytes` must be positive and is capped at 1 MiB. Resource files are read only up to the remaining budget; SessionStart hook context has a separate 64 KiB cap.

Hook commands come from generated project configuration and therefore execute with the user's permissions. Review the AISuite preset before enabling the extension in an untrusted repository. Hook processes are terminated after their configured timeout (three seconds by default), and combined stdout/stderr is capped at 1 MiB.
