"""Integration checks using tiny processes in the actual systemd user session."""
from pathlib import Path
import os
import signal
import subprocess
import sys
import unittest

WRAPPER = str(Path(__file__).with_name("local-validation.py"))


class LocalValidationTest(unittest.TestCase):
    def run_command(self, code):
        return subprocess.run([sys.executable, WRAPPER, "--", sys.executable, "-c", code],
                              text=True, capture_output=True, timeout=20)

    def test_exit_status_and_argument_preservation(self):
        result = self.run_command("import os,sys; print('$HOME', os.environ['T3CODE_CHECK_ECONOMICAL']); sys.exit(7)")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertIn("$HOME 1", result.stdout)
        self.assertIn("Validation scope stopped:", result.stderr)
        self.assertEqual(self.run_command("pass").returncode, 0)

    def test_cross_worktree_exclusion_and_cancellation(self):
        process = subprocess.Popen([sys.executable, WRAPPER, "--", sys.executable, "-u", "-c",
                                    "import signal; print('ready', flush=True); signal.pause()"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            contender = subprocess.run([sys.executable, WRAPPER, "--", "/bin/true"], cwd="/tmp",
                                       capture_output=True, text=True, timeout=10)
            self.assertEqual(contender.returncode, 75, contender.stderr)
            process.send_signal(signal.SIGTERM)
            _, errors = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 143, errors)
            self.assertIn("Validation scope stopped:", errors)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=20)
        self.assertEqual(self.run_command("pass").returncode, 0)

    def test_background_descendant_is_stopped(self):
        result = self.run_command("import subprocess; p=subprocess.Popen(['sleep','300'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid)")
        self.assertEqual(result.returncode, 0, result.stderr)
        pid = int(result.stdout.strip())
        stat = Path(f"/proc/{pid}/stat")
        self.assertTrue(not stat.exists() or stat.read_text().split()[2] == "Z")


if __name__ == "__main__":
    unittest.main()
