from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

SRC_DIR = str(Path(__file__).resolve().parent.parent / "src")

PREAMBLE = """
import os, sys, tempfile
sys.path.insert(0, {src!r})
from rlm import plan_guard
from rlm.plan_guard import PlanModeError

TOKEN = "test-token"
plan_guard.install(TOKEN)

work = tempfile.mkdtemp(dir="/var/tmp") if os.path.isdir("/var/tmp") else tempfile.mkdtemp()

def enable(extra=()):
    plan_guard.set_enabled(TOKEN, True, extra)

def disable():
    plan_guard.set_enabled(TOKEN, False)

def expect_blocked(fn):
    try:
        fn()
    except PlanModeError:
        return
    raise AssertionError("expected PlanModeError")
"""


def run_guarded(body: str) -> subprocess.CompletedProcess[str]:
    script = PREAMBLE.format(src=SRC_DIR) + body
    return subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=120,
    )


class PlanGuardTest(unittest.TestCase):
    def assert_ok(self, body: str) -> None:
        result = run_guarded(body)
        self.assertEqual(result.returncode, 0, msg=f"stdout={result.stdout}\nstderr={result.stderr}")

    def test_write_blocked_outside_allowed_roots(self) -> None:
        # `work` lives outside tempfile.gettempdir() when /var/tmp exists; pass
        # no extra roots so it is unwritable either way once we drop it.
        self.assert_ok("""
target = os.path.join(work, "f.txt")
open(target, "w").write("before")
enable()
expect_blocked(lambda: open(target, "w"))
expect_blocked(lambda: open(target, "a"))
expect_blocked(lambda: os.remove(target))
expect_blocked(lambda: os.rename(target, target + ".bak"))
expect_blocked(lambda: os.mkdir(os.path.join(work, "d")))
import pathlib
expect_blocked(lambda: pathlib.Path(target).write_text("x"))
assert open(target).read() == "before"
""")

    def test_reads_and_temp_writes_allowed(self) -> None:
        self.assert_ok("""
enable()
with open("/etc/os-release") as f:
    f.read()
scratch = os.path.join(tempfile.gettempdir(), "plan_guard_scratch.txt")
open(scratch, "w").write("ok")
os.remove(scratch)
open(os.devnull, "w").write("x")
""")

    def test_extra_roots_and_git_carveout(self) -> None:
        self.assert_ok("""
os.makedirs(os.path.join(work, ".git"))
enable([work])
open(os.path.join(work, "notes.txt"), "w").write("ok")
expect_blocked(lambda: open(os.path.join(work, ".git", "index"), "w"))
""")

    def test_disable_restores_writes(self) -> None:
        self.assert_ok("""
target = os.path.join(work, "f.txt")
enable()
expect_blocked(lambda: open(target, "w"))
disable()
open(target, "w").write("ok")
""")

    def test_token_required(self) -> None:
        self.assert_ok("""
enable()
try:
    plan_guard.set_enabled("wrong", False)
except PermissionError:
    pass
else:
    raise AssertionError("expected PermissionError")
assert plan_guard.is_enabled()
""")

    def test_install_first_caller_wins(self) -> None:
        self.assert_ok("""
plan_guard.install("attacker")
try:
    plan_guard.set_enabled("attacker", True)
except PermissionError:
    pass
else:
    raise AssertionError("expected PermissionError")
enable()
assert plan_guard.is_enabled()
""")

    def test_direct_spawn_blocked(self) -> None:
        self.assert_ok("""
enable()
expect_blocked(lambda: os.system("true"))
expect_blocked(lambda: os.posix_spawn("/bin/true", ["/bin/true"], os.environ))
""")

    def test_subprocess_read_only_command_runs(self) -> None:
        self.assert_ok("""
import subprocess
enable()
out = subprocess.run(["ls", "/"], capture_output=True, text=True)
assert out.returncode == 0, out.stderr
assert "etc" in out.stdout
""")

    def test_subprocess_write_blocked(self) -> None:
        self.assert_ok("""
import shutil, subprocess
target = os.path.join(work, "f.txt")
enable()
if shutil.which("bwrap") or (sys.platform == "darwin" and os.path.exists("/usr/bin/sandbox-exec")):
    out = subprocess.run("echo x > " + target, shell=True, capture_output=True, text=True)
    assert out.returncode != 0, "sandboxed shell write should fail"
    assert not os.path.exists(target)
else:
    expect_blocked(lambda: subprocess.run("echo x > " + target, shell=True))
""")

    def test_fallback_allowlist(self) -> None:
        self.assert_ok("""
import subprocess
import rlm.plan_guard as pg
pg._sandbox_prefix = lambda roots: None
enable()
out = subprocess.run(["git", "version"], capture_output=True, text=True)
assert out.returncode == 0
out = subprocess.run(["git", "-C", "/", "status", "--short"], capture_output=True, text=True)
assert "PlanModeError" not in (out.stderr or ""), out.stderr
expect_blocked(lambda: subprocess.run(["git", "-c", "core.fsmonitor=touch pwned", "status"]))
subprocess.run("git log --oneline | head -2", shell=True, capture_output=True, text=True, cwd="/")
expect_blocked(lambda: subprocess.run(["sed", "-i", "s/a/b/", "f"]))
expect_blocked(lambda: subprocess.run(["touch", "f"]))
expect_blocked(lambda: subprocess.run("echo hi > f", shell=True))
expect_blocked(lambda: subprocess.run(["git", "commit", "-m", "x"]))
""")

    def test_fallback_shell_dash_c(self) -> None:
        self.assert_ok("""
import subprocess
import rlm.plan_guard as pg
pg._sandbox_prefix = lambda roots: None
enable()
out = subprocess.run(["bash", "-c", "git version | head -1"], capture_output=True, text=True)
assert out.returncode == 0 and "git" in out.stdout, out.stderr
expect_blocked(lambda: subprocess.run(["bash", "-c", "touch " + os.path.join(work, "f")]))
""")

    def test_fallback_stdin_shell_script(self) -> None:
        # %%bash cells spawn a bare shell and feed the script over stdin.
        self.assert_ok("""
import subprocess
import rlm.plan_guard as pg
pg._sandbox_prefix = lambda roots: None
enable()
out = subprocess.run(["bash"], input="ls / | head -3", capture_output=True, text=True)
assert out.returncode == 0 and out.stdout.strip(), out.stderr
target = os.path.join(work, "f")
out = subprocess.run(["bash"], input="echo x > " + target, capture_output=True, text=True)
assert out.returncode != 0, "write script should be refused"
assert "PlanModeError" in out.stderr, out.stderr
assert not os.path.exists(target)
""")

    def test_shell_true_wrapped(self) -> None:
        self.assert_ok("""
import subprocess
enable()
out = subprocess.run("echo hello | tr a-z A-Z", shell=True, capture_output=True, text=True)
assert out.returncode == 0, out.stderr
assert out.stdout.strip() == "HELLO"
""")


if __name__ == "__main__":
    unittest.main()
