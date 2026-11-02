#!/usr/bin/env python3
"""Versioned ticket read/reference protocol for trusted local T3 plugins."""
from contextlib import ExitStack
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

WORKFLOW_DIRECTORY = Path(os.environ.get(
    'T3_OBSIDIAN_WORKFLOW_DIR', Path.home() / '.codex/skills/vault-manage-ticket',
)).expanduser().resolve()
sys.path.insert(0, str(WORKFLOW_DIRECTORY / 'scripts'))

import tickets
from vault import matching_projects, git, remote_key

PROTOCOL_VERSION = 1
START = '<!-- t3-ticket-threads:v1:start -->'
END = '<!-- t3-ticket-threads:v1:end -->'
PROGRESS = '## Progresso atual do ticket'
ENTRY = re.compile(r'<!-- t3-thread-ref (.+) -->\r?\n(- \[[^\r\n]+\]\([^\r\n]+\)\r?\n)')


def digest(content):
    return hashlib.sha256(content).hexdigest()


def active_lines(text):
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.rstrip('\r\n')
        match = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', stripped)
        if fence:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = None
        elif match:
            fence = match[1]
        else:
            yield offset, offset + len(line), stripped
        offset += len(line)


def reference_key(reference):
    if not isinstance(reference, dict) or set(reference) != {'environmentId', 'threadId', 'link'}:
        raise ValueError('Invalid thread reference fields.')
    for field in ('environmentId', 'threadId'):
        value = reference[field]
        if not isinstance(value, str) or not 1 <= len(value) <= 200 or any(ord(c) < 32 for c in value):
            raise ValueError('Invalid thread identity.')
    link = reference['link']
    if not isinstance(link, str) or len(link) > 2048 or any(c.isspace() or c in '<>()' for c in link):
        raise ValueError('Invalid thread link.')
    if urlsplit(link).scheme != 't3-thread':
        raise ValueError('Only canonical T3 thread links are supported.')
    return reference['environmentId'], reference['threadId']


def parse_section(body):
    markers = [(a, b, line) for a, b, line in active_lines(body) if line.startswith('<!-- t3-ticket-threads:')]
    if not markers:
        return None, []
    if len(markers) != 2 or markers[0][2] != START or markers[1][2] != END:
        raise ValueError('Malformed, duplicate or unsupported thread-reference section.')
    first, last = markers
    inner = body[first[1]:last[0]]
    heading = re.match(r'## Threads T3\r?\n\r?\n', inner)
    if not heading:
        raise ValueError('Invalid thread-reference heading.')
    remaining = inner[heading.end():]
    if remaining.strip() == 'Nenhuma thread vinculada.':
        remaining = ''
    entries, seen = [], set()
    while remaining:
        match = ENTRY.match(remaining)
        if not match:
            if remaining.strip():
                raise ValueError('Unreadable content in thread-reference section.')
            break
        identity = json.loads(match[1])
        if not isinstance(identity, dict) or set(identity) != {'environmentId', 'threadId'}:
            raise ValueError('Invalid reference identity.')
        link = re.search(r'\]\(([^\r\n]+)\)', match[2])[1]
        key = reference_key({**identity, 'link': link})
        if key in seen:
            raise ValueError('Duplicate thread identity.')
        seen.add(key)
        entries.append((key, match[0]))
        remaining = remaining[match.end():]
    return (first[0], last[1]), entries


def edit_reference(content, action, reference, today):
    key = reference_key(reference)
    text = content.decode('utf-8')
    front = re.match(r'\A---\r?\n[\s\S]*?\r?\n---\r?\n', text)
    if not front:
        raise ValueError('Missing or unterminated frontmatter.')
    header, body = text[:front.end()], text[front.end():]
    newline = '\r\n' if '\r\n' in header else '\n'
    bounds, entries = parse_section(body)
    existing = next((entry for identity, entry in entries if identity == key), None)
    if action == 'remove':
        if existing is None:
            return content
        entries = [(identity, entry) for identity, entry in entries if identity != key]
    elif action == 'add':
        if existing is not None:
            if f']({reference["link"]})' not in existing:
                raise ValueError('Existing reference differs; explicit recovery is required.')
            return content
        identity = json.dumps({'environmentId': key[0], 'threadId': key[1]}, ensure_ascii=True, separators=(',', ':'))
        identity = identity.replace('-', '\\u002d').replace('<', '\\u003c').replace('>', '\\u003e')
        label = f'Thread {key[1]} · ambiente {key[0]}'
        label = re.sub(r'([\\`*{}\[\]<>])', r'\\\1', label)
        entries.append((key, f'<!-- t3-thread-ref {identity} -->{newline}- [{label}]({reference["link"]}){newline}'))
    else:
        raise ValueError('Unknown reference action.')
    block = START + newline + '## Threads T3' + newline * 2
    block += ''.join(entry for _, entry in entries) if entries else 'Nenhuma thread vinculada.' + newline
    block += END + newline
    if bounds:
        body = body[:bounds[0]] + block + body[bounds[1]:]
    else:
        progress = next((a for a, _, line in active_lines(body) if line == PROGRESS), len(body))
        prefix = '' if not body[:progress] or body[:progress].endswith(newline * 2) else newline
        body = body[:progress] + prefix + block + newline + body[progress:]
    header, count = re.subn(r'(?m)^updated_at:[^\r\n]*', 'updated_at: ' + today, header)
    if count != 1:
        raise ValueError('updated_at must have one unambiguous scalar line.')
    return (header + body).encode('utf-8')


def checked_ticket(vault, repo, board, ticket_id):
    candidates, _ = matching_projects(vault, repo)
    if board not in candidates:
        raise ValueError('Board does not belong to this repository.')
    tickets.preflight(vault, board, repo)
    folder = vault.tickets(board).resolve()
    path = tickets.find_ticket(folder, ticket_id).resolve()
    if not path.is_relative_to(folder):
        raise ValueError('Ticket escapes its board through a symlink.')
    content = path.read_bytes()
    meta, body = tickets.load_note(path)
    if path.read_bytes() != content:
        raise ValueError('Ticket changed while reading.')
    tickets.VAULT = vault
    tickets.check(meta, board)
    tickets.check_body(body, done=meta['status'] == 'done')
    return path, meta, body, content


def execute(request, vault, repo):
    if request.get('protocolVersion') != PROTOCOL_VERSION:
        raise ValueError('Unsupported protocol version.')
    operation = request.get('operation')
    if operation == 'capabilities':
        return {'protocolVersion': PROTOCOL_VERSION}
    boards, _ = matching_projects(vault, repo)
    remote = git(vault.path, 'remote', 'get-url', 'origin')
    if not remote:
        raise ValueError('The vault needs an origin remote for stable cross-machine identity.')
    vault_id = digest(remote_key(remote).encode())
    if operation == 'search':
        search = str(request.get('search', '')).casefold()
        offset = int(request.get('cursor') or 0)
        if offset < 0:
            raise ValueError('Invalid cursor.')
        found = []
        for board in boards:
            tickets.preflight(vault, board, repo)
            seen = set()
            for path, meta in tickets.rows(vault.tickets(board)):
                ticket_id = meta.get('id')
                if ticket_id is None or ticket_id == '':
                    continue
                if ticket_id in seen:
                    raise ValueError(f'Duplicate ticket ID {ticket_id} in board {board}.')
                seen.add(ticket_id)
                if search in (str(ticket_id) + ' ' + path.stem).casefold():
                    found.append({'key': {'vaultId': vault_id, 'boardId': board, 'ticketId': ticket_id}, 'title': path.stem, '_created_at': tickets.date_text(meta.get('created_at')) or ''})
        found.sort(key=lambda item: (item['key']['boardId'], item['key']['ticketId']))
        if request.get('sort') == 'created_desc':
            found.sort(key=lambda item: (item['_created_at'], item['key']['boardId'], item['key']['ticketId']), reverse=True)
        page = found[offset:offset + 50]
        for item in page:
            item.pop('_created_at')
        return {'items': page, 'nextCursor': str(offset + 50) if len(found) > offset + 50 else None}
    if operation in ('read', 'inspect'):
        if request.get('vaultId') != vault_id:
            raise ValueError('Vault identity changed.')
        path, meta, body, content = checked_ticket(vault, repo, request['boardId'], request['ticketId'])
        _, entries = parse_section(body)
        return {'title': path.stem, 'properties': meta, 'markdown': body, 'sha256': digest(content), 'path': str(path),
                'references': [{'environmentId': key[0], 'threadId': key[1]} for key, _ in entries]}
    if operation != 'apply' or request.get('vaultId') != vault_id:
        raise ValueError('Unknown operation or vault identity.')
    steps = request.get('steps')
    if not isinstance(steps, list) or not 1 <= len(steps) <= 2:
        raise ValueError('A reference mutation requires one or two ticket steps.')
    if not isinstance(request.get('operationId'), str) or not request['operationId']:
        raise ValueError('Missing operation identity.')
    folders = []
    for step in steps:
        if step['boardId'] not in boards:
            raise ValueError('Board does not belong to this repository.')
        folders.append(vault.tickets(step['boardId']).resolve())
    results = []
    with ExitStack() as locks:
        for folder in sorted(set(folders)):
            locks.enter_context(tickets.board_lock(folder))
        prepared = []
        today = datetime.now(ZoneInfo(vault.registry.get('timezone', 'UTC'))).date().isoformat()
        for step in steps:
            path, _, _, before = checked_ticket(vault, repo, step['boardId'], step['ticketId'])
            if any(other == path for other, *_ in prepared):
                raise ValueError('Duplicate ticket step.')
            if digest(before) != step['expectedSha256']:
                raise ValueError('Ticket changed since inspection.')
            after = edit_reference(before, step['action'], step['reference'], today)
            prepared.append((path, before, after, step))
        for path, before, after, step in prepared:
            result = {'boardId': step['boardId'], 'ticketId': step['ticketId'], 'beforeSha256': digest(before), 'afterSha256': digest(after)}
            try:
                if after != before:
                    tickets.atomic_update(path, after.decode('utf-8'), digest(before))
                if path.read_bytes() != after:
                    raise ValueError('Reference read-back differs after writing.')
                results.append({**result, 'status': 'applied'})
            except (OSError, ValueError) as error:
                results.append({**result, 'status': 'indeterminate', 'error': str(error)})
                return {'status': 'recovery-required', 'operationId': request['operationId'], 'steps': results}
    return {'status': 'committed', 'operationId': request['operationId'], 'steps': results}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--vault')
    args = parser.parse_args()
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('Request exceeds the protocol limit.')
    print(json.dumps(execute(json.loads(raw), tickets.open_vault(args.vault), args.repo), default=str))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        sys.exit(1)
