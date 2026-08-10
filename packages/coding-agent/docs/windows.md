# Windows Setup

Prime Agent requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Native Verification

Before a Windows release, verify from a clean PowerShell session with no `uv` on `PATH` that `PRIME_AGENT_INSTALL_UV=1` installs `uv`, creates `~\.prime\agent\kernel-venv\Scripts\python.exe`, and starts an IPython cell. Also repeat with an existing populated venv to confirm startup reuses it rather than rebuilding it.

Run daemon smoke tests from both PowerShell and Git Bash. Confirm the supervisor becomes ready without waiting for the optional session catalog, a new worker completes `worker_auth`, and an RPC `get_state` round-trip succeeds. Repeat once with a cold PowerShell process launch and once with Defender enabled because process startup latency is not faithfully reproducible through platform mocks.

These process, installer, and named-pipe checks require native Windows; platform-selection, cache, and timeout unit tests run on every platform.
