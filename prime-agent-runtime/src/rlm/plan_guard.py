"""Plan-mode (no-edit) guard for the Prime Agent kernel.

While enabled, filesystem mutations raise ``PlanModeError`` and subprocesses
are re-run inside a read-only OS sandbox (bwrap / sandbox-exec) so read-only
commands keep working. Enforcement uses ``sys.addaudithook``: hooks cannot be
removed once installed, and the enabled flag lives in a closure keyed to a
host-held token, so kernel code cannot switch the guard off.
"""

from __future__ import annotations

import contextvars
import hashlib
import hmac
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

_PLAN_MODE_MESSAGE = (
    "Plan mode is active: {action} is blocked. You may read files, run "
    "read-only commands, and write only under temp/cache directories. Do not "
    "attempt to work around this. Present your plan or answer, and ask the "
    "user to exit plan mode if edits are needed."
)


class PlanModeError(RuntimeError):
    def __init__(self, action: str) -> None:
        super().__init__(_PLAN_MODE_MESSAGE.format(action=action))


_FALLBACK_BLOCK_ACTION = (
    "running this command (no bwrap/sandbox-exec on this machine, so only "
    "classifiable read-only commands run: git log/diff/status, rg, grep, ls, cat, ...)"
)


# io.open write intent letters / os.open write intent flags.
_WRITE_MODE_CHARS = frozenset("wax+")
_WRITE_OPEN_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

# Audit events that mutate the filesystem; every str/bytes/PathLike argument is
# treated as a target path (rename/link must have BOTH ends writable).
_FS_MUTATION_EVENTS = frozenset(
    {
        "os.remove",
        "os.rename",
        "os.rmdir",
        "os.mkdir",
        "os.chmod",
        "os.chown",
        "os.chflags",
        "os.link",
        "os.symlink",
        "os.truncate",
        "os.utime",
        "shutil.rmtree",
        "shutil.move",
        "shutil.chown",
    }
)

# Process spawns must go through the mediated subprocess wrapper.
_SPAWN_EVENTS = frozenset(
    {
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.posix_spawn",
        "os.spawn",
        "os.startfile",
    }
)

# ctypes could patch the guard out of process memory.
_CTYPES_EVENTS = frozenset(
    {"ctypes.dlopen", "ctypes.dlsym", "ctypes.dlsym/handle", "ctypes.call_function", "ctypes.cdata"}
)

# Read-only commands permitted when no OS sandbox binary is available.
_FALLBACK_ALLOWED_COMMANDS = frozenset(
    {
        "awk",
        "basename",
        "cat",
        "column",
        "cut",
        "df",
        "diff",
        "dirname",
        "du",
        "echo",
        "env",
        "file",
        "find",
        "grep",
        "head",
        "hostname",
        "jq",
        "ls",
        "nl",
        "printf",
        "ps",
        "pwd",
        "readlink",
        "realpath",
        "rg",
        "sort",
        "stat",
        "tail",
        "tr",
        "tree",
        "uname",
        "uniq",
        "wc",
        "which",
        "whoami",
    }
)

_FALLBACK_GIT_SUBCOMMANDS = frozenset(
    {
        "blame",
        "branch",
        "describe",
        "diff",
        "grep",
        "log",
        "ls-files",
        "ls-remote",
        "ls-tree",
        "remote",
        "rev-list",
        "rev-parse",
        "shortlog",
        "show",
        "status",
        "var",
        "version",
        "worktree",
    }
)

# Set while the mediated Popen wrapper is invoking the original Popen, so the
# audit hook can tell wrapped spawns from direct os.exec/posix_spawn calls.
_mediated_spawn: contextvars.ContextVar[bool] = contextvars.ContextVar("plan_guard_mediated", default=False)


def _norm(path: Any) -> str | None:
    try:
        if isinstance(path, int):
            return None
        return os.path.abspath(os.fsdecode(path))
    except (TypeError, ValueError):
        return None


def _default_writable_roots() -> tuple[str, ...]:
    roots = {tempfile.gettempdir(), "/tmp", "/dev", str(Path.home() / ".cache")}
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        roots.add(tmpdir)
    return tuple(os.path.abspath(r) for r in roots if r)


def _is_write_allowed(path: str, roots: tuple[str, ...]) -> bool:
    parts = path.split(os.sep)
    if "__pycache__" in parts or path.endswith(".pyc"):
        return True
    for root in roots:
        if path == root or path.startswith(root + os.sep):
            # Protected metadata stays read-only even inside writable roots.
            rest = path[len(root) :].split(os.sep)
            return ".git" not in rest
    return False


def _open_wants_write(mode: Any, flags: Any) -> bool:
    if isinstance(mode, str):
        return bool(_WRITE_MODE_CHARS.intersection(mode))
    if isinstance(flags, int):
        return bool(flags & _WRITE_OPEN_FLAGS)
    return False


def _sandbox_prefix(roots: Iterable[str]) -> list[str] | None:
    """Read-only OS sandbox argv prefix for subprocesses, or None if unavailable."""
    if sys.platform == "linux":
        bwrap = shutil.which("bwrap")
        if not bwrap:
            return None
        prefix = [bwrap, "--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev"]
        for root in roots:
            if root != "/dev" and os.path.isdir(root):
                prefix += ["--bind", root, root]
        prefix += ["--die-with-parent", "--"]
        return prefix
    if sys.platform == "darwin" and os.path.exists("/usr/bin/sandbox-exec"):
        writes = " ".join(f'(subpath "{r}")' for r in roots)
        profile = (
            "(version 1) (allow default) (deny file-write*) "
            f"(allow file-write* {writes} (subpath \"/private/tmp\") (subpath \"/private/var/folders\"))"
        )
        return ["/usr/bin/sandbox-exec", "-p", profile]
    return None


# Shells whose script can be classified: `sh -c <script>` inline, or a bare
# shell fed its script over stdin (how IPython's %%bash cells run).
_SHELL_NAMES = frozenset({"bash", "dash", "sh", "zsh"})

# Runs as `python -c _STDIN_SHIM <shell> <rlm-src-dir>`: buffer the stdin
# script, classify it with the same fallback rules, then exec the real shell.
_STDIN_SHIM = """
import os, sys
sys.path.insert(0, sys.argv[2])
from rlm.plan_guard import _fallback_shell_allowed
script = sys.stdin.read()
if not _fallback_shell_allowed(script):
    sys.stderr.write(
        "PlanModeError: this shell script is blocked in plan mode. "
        "Read-only commands (git log/diff/status, rg, grep, ls, cat, ...) are allowed.\\n"
    )
    sys.exit(1)
os.execvp(sys.argv[1], [sys.argv[1], "-c", script])
""".strip()


def _stdin_shim_argv(shell_name: str) -> list[str]:
    src_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return [sys.executable, "-c", _STDIN_SHIM, shell_name, src_dir]


def _fallback_command_allowed(argv: list[str]) -> bool:
    if not argv:
        return False
    name = os.path.basename(argv[0])
    if name in _SHELL_NAMES:
        return len(argv) >= 3 and argv[1] == "-c" and _fallback_shell_allowed(argv[2])
    if name == "git":
        # Only known-harmless global options may precede the subcommand; -c,
        # --exec-path, etc. can make even read subcommands run arbitrary code.
        rest = argv[1:]
        i = 0
        while i < len(rest):
            arg = rest[i]
            if arg == "-C":
                i += 2
                continue
            if arg in ("-P", "--no-pager", "--no-optional-locks", "--literal-pathspecs"):
                i += 1
                continue
            if arg.startswith("-"):
                return False
            return arg in _FALLBACK_GIT_SUBCOMMANDS
        return False
    if name == "find":
        return not any(a in ("-delete", "-exec", "-execdir", "-ok", "-okdir") for a in argv[1:])
    if name == "sed":
        return not any(a == "-i" or a.startswith("-i") or a.startswith("--in-place") for a in argv[1:])
    return name in _FALLBACK_ALLOWED_COMMANDS


def _fallback_shell_allowed(command: str) -> bool:
    if ">" in command:
        return False
    # Evaluate each pipeline/sequence segment independently; fail closed.
    for op in ("&&", "||", ";", "|", "\n"):
        command = command.replace(op, "\x00")
    for segment in filter(None, (s.strip() for s in command.split("\x00"))):
        if "$(" in segment or "`" in segment:
            return False
        try:
            argv = shlex.split(segment)
        except ValueError:
            return False
        if argv and not _fallback_command_allowed(argv):
            return False
    return True


def _make_guard():
    state: dict[str, Any] = {
        "token_hash": None,
        "enabled": False,
        "roots": _default_writable_roots(),
        "hook_added": False,
        "popen_patched": False,
    }

    def _check_token(token: str) -> None:
        expected = state["token_hash"]
        given = hashlib.sha256(token.encode()).digest() if isinstance(token, str) else b""
        if expected is None or not hmac.compare_digest(expected, given):
            raise PermissionError("plan_guard: invalid token")

    def _hook(event: str, args: tuple[Any, ...]) -> None:
        if not state["enabled"]:
            return
        if event == "open":
            path = _norm(args[0]) if args else None
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else None
            if _open_wants_write(mode, flags) and path is not None and not _is_write_allowed(path, state["roots"]):
                raise PlanModeError(f"writing to {path}")
        elif event in _FS_MUTATION_EVENTS:
            for arg in args:
                path = _norm(arg)
                if path is not None and not _is_write_allowed(path, state["roots"]):
                    raise PlanModeError(f"{event} on {path}")
        elif event in _SPAWN_EVENTS:
            if not _mediated_spawn.get():
                raise PlanModeError(f"direct process spawn ({event})")
        elif event in _CTYPES_EVENTS:
            raise PlanModeError("ctypes access")

    def _wrap_popen_args(args: Any, kwargs: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
        shell = bool(kwargs.get("shell"))
        executable = kwargs.pop("executable", None)
        prefix = _sandbox_prefix(state["roots"])
        if prefix is None:
            if shell:
                if isinstance(args, (str, bytes)) and _fallback_shell_allowed(os.fsdecode(args)):
                    if executable:
                        kwargs["executable"] = executable
                    return args, kwargs
                raise PlanModeError(_FALLBACK_BLOCK_ACTION)
            argv = [os.fsdecode(a) for a in ([args] if isinstance(args, (str, bytes, os.PathLike)) else list(args))]
            if executable:
                argv[0] = os.fsdecode(executable)
            if len(argv) == 1 and os.path.basename(argv[0]) in _SHELL_NAMES:
                # %%bash-style: the script arrives on stdin, so classify it there.
                return _stdin_shim_argv(argv[0]), kwargs
            if not _fallback_command_allowed(argv):
                raise PlanModeError(_FALLBACK_BLOCK_ACTION)
            return argv, kwargs
        kwargs["shell"] = False
        if shell:
            sh = os.fsdecode(executable) if executable else "/bin/sh"
            return [*prefix, sh, "-c", os.fsdecode(args)], kwargs
        argv = [os.fsdecode(a) for a in ([args] if isinstance(args, (str, bytes, os.PathLike)) else list(args))]
        if executable:
            argv[0] = os.fsdecode(executable)
        return [*prefix, *argv], kwargs

    def _patch_popen() -> None:
        if state["popen_patched"]:
            return
        original_init = subprocess.Popen.__init__

        def guarded_init(self: subprocess.Popen, args: Any = None, *pargs: Any, **kwargs: Any) -> None:
            if state["enabled"]:
                if pargs:
                    # Positional bufsize/executable/etc. are never used by the
                    # stdlib helpers the kernel relies on; keep the wrapper simple.
                    raise PlanModeError("subprocess with positional options in plan mode (use keyword arguments)")
                args, kwargs = _wrap_popen_args(args, kwargs)
                token = _mediated_spawn.set(True)
                try:
                    original_init(self, args, **kwargs)
                finally:
                    _mediated_spawn.reset(token)
                return
            original_init(self, args, *pargs, **kwargs)

        subprocess.Popen.__init__ = guarded_init  # type: ignore[method-assign]
        state["popen_patched"] = True

    def install(token: str) -> None:
        # First caller wins; the host installs right after kernel bootstrap so
        # later calls (including from user code) cannot rebind the token.
        if isinstance(token, str) and token and state["token_hash"] is None:
            state["token_hash"] = hashlib.sha256(token.encode()).digest()

    def set_enabled(token: str, enabled: bool, extra_writable_roots: Iterable[str] = ()) -> None:
        _check_token(token)
        if enabled:
            roots = set(_default_writable_roots())
            roots.update(os.path.abspath(r) for r in extra_writable_roots if r)
            state["roots"] = tuple(roots)
            _patch_popen()
            if not state["hook_added"]:
                sys.addaudithook(_hook)
                state["hook_added"] = True
        state["enabled"] = bool(enabled)

    def is_enabled() -> bool:
        return bool(state["enabled"])

    return install, set_enabled, is_enabled


install, set_enabled, is_enabled = _make_guard()

__all__ = ["PlanModeError", "install", "is_enabled", "set_enabled"]
