"""CLI integration tests: disposable Git checkouts and vaults, no network calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml

ROOT = Path(os.environ.get('T3_OBSIDIAN_WORKFLOW_DIR', Path.home() / '.codex/skills/vault-manage-ticket')).expanduser().resolve().parent
CLI = ROOT / 'vault-manage-ticket/scripts/tickets.py'
VAULT_CLI = ROOT / 'vault-core/scripts/vault.py'
SCHEMA = json.loads((ROOT / 'vault-core/references/schema.json').read_text())
BODY = """## Context
The request worker retries failed requests.

## Problem
A failed request can be processed twice.

## Proposed solution
**Expected outcome:** Recovery without duplicate processing.
**Approach status:** Proposed

Investigate whether preserving the request key prevents duplicates.

## Acceptance criteria
- [ ] The recovery scenario processes each request once; record the regression result.

## Open decisions before starting
None.

## Additional notes
None.
"""


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


class Workspace:
    def __init__(self, root):
        self.root = root
        self.repo = root / 'project'
        self.repo.mkdir()
        git(self.repo, 'init', '-b', 'main')
        git(self.repo, 'config', 'user.name', 'Fixture')
        git(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        git(self.repo, 'remote', 'add', 'origin', 'git@example.invalid:org/project.git')
        git(self.repo, 'commit', '--allow-empty', '-m', 'Fixture')
        self.vault = root / 'vault'
        self.vault.mkdir()
        self.config = root / 'config'
        self.env = {**os.environ, 'XDG_CONFIG_HOME': str(self.config), 'PYTHONDONTWRITEBYTECODE': '1'}
        self.registry = {'version': 2, 'timezone': 'UTC', 'projects': {}}
        for board in ('alpha', 'beta', 'notes'):
            (self.vault / board / 'tasks').mkdir(parents=True)
            self.registry['projects'][board] = {
                'prefix': board.upper(), 'board': f'{board}/Board.base', 'tickets': f'{board}/tasks',
                'repositories': [] if board == 'notes' else ['example.invalid/org/project'],
                'ticket_policy': {
                    'repository': None if board == 'notes' else 'example.invalid/org/project',
                    'path': f'{board}/ticket-policy.yaml' if board == 'notes' else f'.vault/boards/{board}.yaml',
                },
            }
        self.save_registry()
        self.body = root / 'body.md'
        self.body.write_text(BODY)

    def save_registry(self):
        (self.vault / 'boards.json').write_text(json.dumps(self.registry))

    def call(self, *args, board='alpha', repo=None, script=CLI):
        return subprocess.run(
            [sys.executable, str(script), *map(str, args), '--vault', str(self.vault),
             '--project', board, '--repo', str(repo or self.repo)],
            cwd=self.root, env=self.env, capture_output=True, text=True,
        )

    def ok(self, *args, **kwargs):
        result = self.call(*args, **kwargs)
        assert result.returncode == 0, result.stderr
        return result

    def profile(self, board='alpha', rules=False):
        data = {'version': 1, 'board': board, 'acceptance': {'always': [], 'conditional': []}}
        if rules:
            data['acceptance'] = {
                'always': [{'id': 'local-commit', 'criterion': 'Changes are committed locally.', 'evidence': 'Commit SHA.'}],
                'conditional': [
                    {'id': 'regression', 'when': 'Runtime behavior changes.', 'criterion': 'The regression test passes.', 'evidence': 'Command and result.'},
                    {'id': 'device', 'when': 'Physical behavior is part of the outcome.', 'criterion': 'The device scenario passes.', 'evidence': 'Device observations.'},
                ],
            }
        return data

    def install(self, profile=None, board='alpha'):
        locator = self.registry['projects'][board]['ticket_policy']
        path = (self.vault if locator['repository'] is None else self.repo) / locator['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml.safe_dump(profile or self.profile(board)))
        return path

    def decisions(self, values=None):
        path = self.root / 'acceptance.json'
        path.write_text(json.dumps(values if values is not None else {
            'regression': {'applies': True, 'reason': 'Runtime recovery changes.'},
            'device': {'applies': False, 'reason': 'Physical behavior is outside the agreed outcome.'},
        }))
        return path

    def create(self, *args, **kwargs):
        return self.call('create', '--title', 'Recover failed requests', '--body-file', self.body, *args, **kwargs)

    @property
    def ticket(self):
        return self.vault / 'alpha/tasks/Recover failed requests.md'

    def patch(self, values):
        path = self.root / 'patch.json'
        path.write_text(json.dumps(values))
        return path

    def update(self, values, *args):
        digest = hashlib.sha256(self.ticket.read_bytes()).hexdigest()
        return self.call('update', '--id', 'ALPHA-001', '--fields-file', self.patch(values), '--expect-sha256', digest, *args)


@pytest.fixture
def ws(tmp_path):
    return Workspace(tmp_path)
