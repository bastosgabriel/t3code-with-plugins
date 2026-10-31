#!/usr/bin/env python3
"""Serialize local Linux validation across worktrees and stop its owned scope."""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid


def main():
    command = sys.argv[1:]
    if command[:1] == ["--"]:
        command = command[1:]
    if not command or command == ["--help"]:
        print("Usage: python3 scripts/local-validation.py -- COMMAND [ARGS...]\n"
              "Busy: exit 75. Keep this session open during interactive validation; Ctrl+C cleans up.")
        return 0 if command else 2
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime:
        print("Local validation requires a Linux systemd user session.", file=sys.stderr)
        return 2
    # Never unlink: every worktree must lock the same inode, including after a crash.
    with (Path(runtime) / "t3code-local-validation.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.seek(0)
            print("Validation busy: " + lock.read().strip(), file=sys.stderr)
            return 75
        remaining = subprocess.run([
            "systemctl", "--user", "list-units", "--type=scope",
            "--state=active,activating,deactivating", "--no-legend", "--plain",
            "t3-validation-*.scope",
        ], capture_output=True, text=True, check=True)
        if remaining.stdout.strip():
            print("Validation scope still active; its owner must finish cleanup:\n" + remaining.stdout,
                  file=sys.stderr)
            return 75
        unit = "t3-validation-" + uuid.uuid4().hex + ".scope"
        lock.seek(0)
        lock.truncate()
        lock.write(f"pid={os.getpid()} cwd={Path.cwd()} unit={unit}\n")
        lock.flush()
        env = dict(os.environ, T3CODE_CHECK_ECONOMICAL="1")
        env["PATH"] = str(Path(__file__).resolve().parent.parent / "node_modules/.bin") + os.pathsep + env.get("PATH", "")
        child = None
        interrupted = None

        def interrupt(signum, _frame):
            nonlocal interrupted
            interrupted = signum
            if child is not None:
                subprocess.run(["systemctl", "--user", "stop", unit], capture_output=True)
                if child.poll() is None:
                    child.send_signal(signum)

        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, interrupt)
        try:
            child = subprocess.Popen([
                "systemd-run", "--user", "--scope", "--quiet", "--collect",
                "--expand-environment=no", "--slice=app-t3code-agents.slice",
                "--property=TimeoutStopSec=10s", "--unit=" + unit, "--", *command,
            ], env=env)
            if interrupted:
                child.send_signal(interrupted)
            result = child.wait()
            return 128 + interrupted if interrupted else (result if result >= 0 else 128 - result)
        finally:
            # This unit name was created by this invocation, never discovered by pattern.
            stopped = subprocess.run(["systemctl", "--user", "stop", unit], capture_output=True, text=True)
            if stopped.returncode and "not loaded" not in stopped.stderr:
                print(f"Cleanup failed for {unit}: {stopped.stderr}", file=sys.stderr)
                raise RuntimeError("Validation scope cleanup failed")
            print(f"Validation scope stopped: {unit}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
