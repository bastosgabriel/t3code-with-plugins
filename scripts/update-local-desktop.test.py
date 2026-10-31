import sys
sys.dont_write_bytecode = True

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('update-local-desktop.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateLocalDesktopTest(unittest.TestCase):
    def test_launcher_preserves_environment_and_rejects_unrecognized_targets(self):
        original = "from pathlib import Path\nenv = {'T3CODE_HOME': 'keep'}\napp = Path.home() / '.local/share/t3code-with-plugins/releases/old/app.AppImage'\nlaunch(app, env)\n"
        result = updater.launcher_update(original, Path('/new/app.AppImage'))
        self.assertIn("env = {'T3CODE_HOME': 'keep'}", result)
        self.assertIn('launch(app, env)', result)
        self.assertIn("app = Path('/new/app.AppImage')", result)
        with self.assertRaises(ValueError):
            updater.launcher_update(original.replace('releases/', 'unrelated/'), Path('/new'))
        with self.assertRaises(RuntimeError):
            updater.launcher_update(original + 'app = other\n', Path('/new'))

    def test_build_failure_leaves_launcher_and_installation_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            launcher = home / '.local/state/t3p-006/launch.py'
            launcher.parent.mkdir(parents=True)
            original = "from pathlib import Path\napp = Path.home() / '.local/share/t3code-with-plugins/releases/old/app.AppImage'\n"
            launcher.write_text(original)
            def output(args):
                if args[1] == 'branch':
                    return 'main'
                if args[1] == 'rev-parse':
                    return 'a' * 40
                return ''
            def run(args, **kwargs):
                if args[0] == 'node':
                    raise subprocess.CalledProcessError(101, args)
            with patch.object(Path, 'home', return_value=home), patch.object(updater, 'output', output), patch.object(updater, 'run', run):
                with self.assertRaises(subprocess.CalledProcessError):
                    updater.update(3773)
            self.assertEqual(launcher.read_text(), original)
            self.assertFalse((home / '.local/share').exists())

    def test_install_verifies_content_and_never_overwrites_a_previous_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'source', root / 'release/app'
            source.write_bytes(b'first release')
            source.chmod(0o755)
            updater.install_file(source, target)
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertEqual(target.stat().st_mode & 0o777, 0o755)
            updater.install_file(source, target)
            source.write_bytes(b'different release')
            with self.assertRaises(RuntimeError):
                updater.install_file(source, target)
            self.assertEqual(target.read_bytes(), b'first release')
            self.assertEqual([p.name for p in target.parent.iterdir()], ['app'])

    def test_concurrent_launcher_change_is_preserved_and_backup_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            launcher, backup = Path(directory) / 'launcher.py', Path(directory) / 'backup.py'
            launcher.write_text('changed by user')
            with self.assertRaises(RuntimeError):
                updater.replace_launcher(launcher, 'reviewed', 'updated', backup)
            self.assertEqual(launcher.read_text(), 'changed by user')
            self.assertFalse(backup.exists())
            updater.replace_launcher(launcher, 'changed by user', 'updated', backup)
            self.assertEqual(launcher.read_text(), 'updated')
            self.assertEqual(backup.read_text(), 'changed by user')


if __name__ == '__main__':
    unittest.main()
