# AISuite bridge

This extension makes an AISuite-generated project behave consistently in Prime Agent:

- discovers the nearest AISuite project root from nested working directories;
- exposes all generated skills through `resources_discover`;
- eagerly injects generated rules and selected skill contracts before the first model step;
- enables configured host tools and teaches the model Prime Agent's native `await bash(...)` shell contract;
- executes generated `SessionStart`, `PreToolUse`, `PostToolUseFailure`, `Stop`, and `SessionEnd` hooks with bounded runtime and output;
- persists selected skills and the external read-only gate across session resume;
- blocks known Tracker, review, HTTP, and MCP mutation routes when the prompt asks for read-only work.

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
