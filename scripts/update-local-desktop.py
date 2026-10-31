#!/usr/bin/env python3
"""Build and install the existing Ubuntu fork without restarting its live server."""
import argparse
import ast
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def output(args):
    return run(args, capture_output=True, text=True).stdout.strip()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def launcher_update(source, destination):
    tree = ast.parse(source)
    assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == 'app' for t in node.targets)]
    if len(assignments) != 1:
        raise RuntimeError('Unsupported launcher: expected one app assignment; left unchanged.')
    node = assignments[0]
    value = node.value
    if (isinstance(value, ast.BinOp) and isinstance(value.op, ast.Div)
            and ast.unparse(value.left) == 'Path.home()'
            and isinstance(value.right, ast.Constant)):
        old_path = Path.home() / value.right.value
    elif (isinstance(value, ast.Call) and ast.unparse(value.func) == 'Path'
          and len(value.args) == 1 and isinstance(value.args[0], ast.Constant)):
        old_path = Path(value.args[0].value)
    else:
        raise RuntimeError('Unsupported launcher app path; left unchanged.')
    old_path.resolve().relative_to(Path.home() / '.local/share/t3code-with-plugins/releases')
    lines = source.splitlines(keepends=True)
    lines[node.lineno - 1:node.end_lineno] = [f'app = Path({str(destination)!r})\n']
    updated = ''.join(lines)
    ast.parse(updated)
    return updated


def install_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if digest(source) != digest(destination):
            raise RuntimeError(f'Refusing to overwrite a different release: {destination}')
        return
    fd, name = tempfile.mkstemp(dir=destination.parent, prefix='.install-')
    os.close(fd)
    temporary = Path(name)
    try:
        shutil.copy2(source, temporary)
        if digest(source) != digest(temporary):
            raise RuntimeError('Installed file checksum mismatch.')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def replace_launcher(launcher, reviewed, updated, backup):
    if launcher.read_text() != reviewed:
        raise RuntimeError('Launcher changed during the build; installation retained, launcher untouched.')
    if not backup.exists():
        backup.write_text(reviewed)
    fd, name = tempfile.mkstemp(dir=launcher.parent, prefix='.launcher-')
    os.close(fd)
    temporary = Path(name)
    try:
        temporary.write_text(updated)
        temporary.chmod(launcher.stat().st_mode)
        os.replace(temporary, launcher)
    finally:
        temporary.unlink(missing_ok=True)


def stage_plugin(directory, home, port):
    cli = [shutil.which('node'), str(ROOT / 'apps/server/src/bin.ts'), 'auth', 'session']
    issued = json.loads(output(cli + ['issue', '--base-dir', str(home), '--scope',
                                    'environment:maintain', '--scope', 'orchestration:read',
                                    '--ttl', '5m', '--label', 'local-desktop-update', '--json']))
    try:
        request = json.dumps({'token': issued['token'], 'directory': str(directory), 'port': port})
        run([shutil.which('node'), str(ROOT / 'scripts/stage-local-plugin.mjs')],
            input=request, text=True)
    finally:
        run(cli + ['revoke', '--base-dir', str(home), issued['sessionId']],
            stdout=subprocess.DEVNULL)


def update(port):
    home = Path.home()
    launcher = home / '.local/state/t3p-006/launch.py'
    reviewed = launcher.read_text()
    launcher_update(reviewed, home / '.local/share/t3code-with-plugins/releases/preflight/app.AppImage')
    if output(['git', 'branch', '--show-current']) != 'main':
        raise RuntimeError('Run this command from main.')
    run(['git', 'fetch', 'origin', 'main'])
    revision = output(['git', 'rev-parse', 'HEAD'])
    if revision != output(['git', 'rev-parse', 'origin/main']):
        raise RuntimeError('Local main and origin/main differ. Integrate/push before installing.')
    packaged = ['apps', 'packages', 'plugins', 'native', 'package.json', 'pnpm-lock.yaml',
                'pnpm-workspace.yaml', 'patches', 'vite.config.ts']
    if output(['git', 'status', '--porcelain', '--untracked-files=all', '--', *packaged]):
        raise RuntimeError('Packaged sources contain uncommitted changes; preserve them and commit before installing.')
    with tempfile.TemporaryDirectory(prefix='t3-fork-update-') as temporary:
        run(['node', 'scripts/build-desktop-artifact.ts', '--platform', 'linux', '--target',
             'AppImage', '--arch', 'x64', '--output-dir', temporary])
        run(['vp', 'run', '--filter', '@t3plugins/obsidian-tickets', 'build'])
        if output(['git', 'rev-parse', 'HEAD']) != revision or output(
                ['git', 'status', '--porcelain', '--untracked-files=all', '--', *packaged]):
            raise RuntimeError('Sources changed during the build; nothing installed.')
        images = list(Path(temporary).glob('*.AppImage'))
        if len(images) != 1:
            raise RuntimeError('Expected exactly one AppImage from this build.')
        checksum = digest(images[0])
        release = home / '.local/share/t3code-with-plugins/releases' / f'{revision[:9]}-{checksum[:12]}'
        target = release / 'T3-Code-with-Plugins.AppImage'
        updated = launcher_update(reviewed, target)
        install_file(images[0], target)
        plugin = ROOT / 'plugins/obsidian-tickets/dist'
        for name in ['manifest.json', 'index.mjs']:
            install_file(plugin / name, release / 'obsidian-tickets' / name)
        stage_plugin(release / 'obsidian-tickets', home / '.t3code-with-plugins', port)
        with (launcher.parent / 'launch.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            replace_launcher(launcher, reviewed, updated, release / 'previous-launcher.py')
        (release / 'delivery.json').write_text(json.dumps({
            'commit': revision, 'appimage_sha256': checksum,
            'plugin_sha256': digest(release / 'obsidian-tickets/index.mjs'),
            'activation': 'pending restart',
        }, indent=2) + '\n')
        print(f'Installed {revision[:9]}: {target}\nPlugin update staged. Previous release preserved.\n'
              'Close and reopen T3 Code with Plugins when your active turns finish.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=3773, help='Running local fork server port (default: 3773)')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    env = os.environ.copy()
    candidates = list((Path.home() / '.nvm/versions/node').glob('v*'))
    candidates = [p for p in candidates if re.fullmatch(r'v\d+\.\d+\.\d+', p.name)
                  and int(p.name[1:].split('.')[0]) >= 24]
    candidates.sort(key=lambda p: tuple(map(int, p.name[1:].split('.'))), reverse=True)
    paths = [ROOT / 'node_modules/.bin', Path.home() / '.cargo/bin']
    if candidates:
        paths.append(candidates[0] / 'bin')
    env['PATH'] = os.pathsep.join(map(str, paths)) + os.pathsep + env.get('PATH', '')
    os.environ.update(env)
    if os.environ.get('_T3_LOCAL_UPDATE_LOCKED') != '1':
        env['_T3_LOCAL_UPDATE_LOCKED'] = '1'
        return subprocess.call([sys.executable, str(ROOT / 'scripts/local-validation.py'), '--',
                                sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]], env=env)
    update(args.port)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Update stopped: {error}', file=sys.stderr)
        sys.exit(1)
