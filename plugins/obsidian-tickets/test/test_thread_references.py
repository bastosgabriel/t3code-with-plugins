"""Reference edits preserve ticket bytes and use the shared writer's lock/CAS boundary."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from conftest import git

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import thread_references as refs

REFERENCE = {'environmentId': 'env-1', 'threadId': 'thread-1', 'link': 't3-thread://v2/env-1/thread-1'}
CONTENT = b'---\nid: ALPHA-001\nupdated_at: 2026-10-01 # original\nstatus: open\n---\n\n# Ticket\n\n## Progresso atual do ticket\n- [x] Immutable\n'


def test_add_switch_remove_preserves_other_environments_and_progress():
    first = refs.edit_reference(CONTENT, 'add', REFERENCE, '2026-10-30')
    assert first.endswith(b'## Progresso atual do ticket\n- [x] Immutable\n')
    assert first.startswith(b'---\nid: ALPHA-001\nupdated_at: 2026-10-30\nstatus: open\n---\n\n# Ticket\n\n')
    other = {**REFERENCE, 'environmentId': 'env-2', 'link': 't3-thread://v2/env-2/thread-1'}
    second = refs.edit_reference(first, 'add', other, '2026-10-30')
    removed = refs.edit_reference(second, 'remove', REFERENCE, '2026-10-30')
    assert b'](t3-thread://v2/env-1/thread-1)' not in removed
    assert b'](t3-thread://v2/env-2/thread-1)' in removed
    assert refs.edit_reference(removed, 'add', other, '2026-10-31') == removed
    assert refs.edit_reference(removed, 'remove', REFERENCE, '2026-10-31') == removed
    _, entries = refs.parse_section(removed.decode().split('---\n', 2)[2])
    assert [key for key, _ in entries] == [('env-2', 'thread-1')]


@pytest.mark.parametrize('newline', ['\n', '\r\n'])
def test_examples_in_fences_and_special_identity_do_not_change_unrelated_bytes(newline):
    example = newline.join(['```markdown', refs.START, 'example only', refs.END, '```', ''])
    content = CONTENT.decode().replace('\n', newline).replace('# Ticket' + newline, '# Ticket' + newline + example)
    reference = {**REFERENCE, 'threadId': 'a[]--><b'}
    result = refs.edit_reference(content.encode(), 'add', reference, '2026-10-30').decode()
    assert example in result
    assert result.endswith('## Progresso atual do ticket' + newline + '- [x] Immutable' + newline)
    _, entries = refs.parse_section(result.split('---' + newline, 2)[2])
    assert entries[0][0] == ('env-1', 'a[]--><b')


@pytest.mark.parametrize('bad', [refs.START, refs.END, refs.START.replace('v1', 'v2') + '\n' + refs.END,
                                  refs.START + '\n## Threads T3\n\nUnknown data\n' + refs.END])
def test_malformed_sections_are_rejected_without_deleting_text(bad):
    with pytest.raises(ValueError):
        refs.edit_reference(CONTENT + bad.encode() + b'\n', 'add', REFERENCE, '2026-10-30')


def setup_workspace(ws):
    ws.install()
    ws.install(board='beta')
    assert ws.create().returncode == 0
    git(ws.vault, 'init', '-b', 'main')
    git(ws.vault, 'remote', 'add', 'origin', 'git@example.invalid:org/vault.git')


def call(ws, request):
    result = subprocess.run([sys.executable, str(Path(refs.__file__)), '--repo', str(ws.repo), '--vault', str(ws.vault)],
                            input=json.dumps({'protocolVersion': 1, **request}), text=True,
                            capture_output=True, env=ws.env)
    return result, json.loads(result.stdout)


def apply_request(ws, reference=REFERENCE):
    result, search = call(ws, {'operation': 'search', 'search': 'ALPHA-001'})
    assert result.returncode == 0, search
    key = search['items'][0]['key']
    return {'operation': 'apply', 'operationId': 'operation', 'vaultId': key['vaultId'],
            'steps': [{'boardId': 'alpha', 'ticketId': 'ALPHA-001', 'action': 'add', 'reference': reference,
                       'expectedSha256': hashlib.sha256(ws.ticket.read_bytes()).hexdigest()}]}


def test_repository_scope_conflicting_hash_and_duplicate_ids_do_not_write(ws):
    setup_workspace(ws)
    request = apply_request(ws)
    before = ws.ticket.read_bytes()
    request['steps'][0]['expectedSha256'] = '0' * 64
    result, response = call(ws, request)
    assert result.returncode != 0 and response['status'] == 'failed'
    assert ws.ticket.read_bytes() == before
    request['steps'][0]['boardId'] = 'notes'
    result, response = call(ws, request)
    assert result.returncode != 0 and 'repository' in response['error']
    duplicate = ws.ticket.with_name('Duplicate.md')
    duplicate.write_bytes(before)
    result, response = call(ws, {'operation': 'search', 'search': 'ALPHA'})
    assert result.returncode != 0 and 'Duplicate' in response['error']
    assert ws.ticket.read_bytes() == before


def test_concurrent_writers_preserve_both_threads_after_explicit_reinspection(ws):
    setup_workspace(ws)
    a = apply_request(ws)
    b = apply_request(ws, {**REFERENCE, 'threadId': 'thread-2', 'link': 't3-thread://v2/env-1/thread-2'})
    with ThreadPoolExecutor() as pool:
        responses = list(pool.map(lambda request: call(ws, request), [a, b]))
    assert sorted(result.returncode for result, _ in responses) == [0, 1]
    loser = [a, b][next(i for i, (result, _) in enumerate(responses) if result.returncode)]
    loser['steps'][0]['expectedSha256'] = hashlib.sha256(ws.ticket.read_bytes()).hexdigest()
    result, response = call(ws, loser)
    assert result.returncode == 0 and response['status'] == 'committed'
    text = ws.ticket.read_text()
    assert '](t3-thread://v2/env-1/thread-1)' in text
    assert '](t3-thread://v2/env-1/thread-2)' in text
    assert ws.call('validate', '--id', 'ALPHA-001').returncode == 0


def test_failure_between_files_reports_partial_evidence_without_rollback(ws, monkeypatch):
    setup_workspace(ws)
    assert ws.create(board='beta').returncode == 0
    request = apply_request(ws)
    beta = ws.vault / 'beta/tasks/Recover failed requests.md'
    request['steps'].append({**request['steps'][0], 'boardId': 'beta', 'ticketId': 'BETA-001',
                             'expectedSha256': hashlib.sha256(beta.read_bytes()).hexdigest()})
    before_beta = beta.read_bytes()
    original = refs.tickets.atomic_update
    def failing(path, content, expected):
        if path == beta:
            raise OSError('Simulated replace failure')
        return original(path, content, expected)
    monkeypatch.setattr(refs.tickets, 'atomic_update', failing)
    vault = refs.tickets.open_vault(str(ws.vault))
    response = refs.execute({'protocolVersion': 1, **request}, vault, str(ws.repo))
    assert response['status'] == 'recovery-required'
    assert [step['status'] for step in response['steps']] == ['applied', 'indeterminate']
    assert '](t3-thread://v2/env-1/thread-1)' in ws.ticket.read_text()
    assert beta.read_bytes() == before_beta


def test_search_orders_by_creation_before_pagination_across_boards(ws, monkeypatch):
    setup_workspace(ws)
    from datetime import date
    rows = {
        'alpha': [(Path(f'Older {i}.md'), {'id': f'ALPHA-{i:03}', 'created_at': date(2026, 1, 1), 'updated_at': date(2026, 12, 1)}) for i in range(1, 52)],
        'beta': [(Path('Newest.md'), {'id': 'BETA-001', 'created_at': date(2026, 11, 1)})],
    }
    monkeypatch.setattr(refs.tickets, 'rows', lambda folder: rows[folder.parent.name])
    vault = refs.tickets.open_vault(str(ws.vault))
    request = {'protocolVersion': 1, 'operation': 'search', 'search': '', 'sort': 'created_desc'}
    first = refs.execute(request, vault, str(ws.repo))
    second = refs.execute({**request, 'cursor': first['nextCursor']}, vault, str(ws.repo))
    ids = [item['key']['ticketId'] for item in first['items'] + second['items']]
    assert ids == ['BETA-001'] + [f'ALPHA-{i:03}' for i in range(51, 0, -1)]
    assert len(first['items']) == 50 and second['nextCursor'] is None
    filtered = refs.execute({**request, 'search': 'Newest'}, vault, str(ws.repo))
    assert [item['key']['ticketId'] for item in filtered['items']] == ['BETA-001']
