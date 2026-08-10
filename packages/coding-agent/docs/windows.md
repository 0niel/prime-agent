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

Before a Windows release, verify from a clean PowerShell session with no `uv` on `PATH` that `PRIME_AGENT_INSTALL_UV=1` installs `uv`, creates `~\.prime\agent\kernel-venv\Scripts\python.exe`, and starts an IPython cell. Also repeat with an existing populated venv to confirm startup reuses it rather than rebuilding it. These process and installer checks require native Windows; the interpreter-layout and installer-selection unit tests run on every platform.
