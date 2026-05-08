#!/usr/bin/env bash
# Set up the Python venv used by the IPython kernel.
#
# Creates `.kernel-venv` at the repo root with `ipykernel` installed.
# The `ipython` tool's `resolveKernelPython()` finds this venv automatically
# when developing inside the repo; in user installs, the canonical location
# is ~/.prime-agent/kernel-venv (handled in a future PR).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install: https://docs.astral.sh/uv/" >&2
  exit 1
fi

echo ">>> creating .kernel-venv with Python 3.12"
uv venv --python 3.12 .kernel-venv

echo ">>> installing ipykernel"
uv pip install --python .kernel-venv/bin/python ipykernel

echo
echo "Done. The ipython tool will use this venv automatically."
echo "Override with PRIME_AGENT_KERNEL_PYTHON=/path/to/python."
