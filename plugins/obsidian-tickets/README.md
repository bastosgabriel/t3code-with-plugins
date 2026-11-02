# Ticket thread references

The plugin embeds `python/thread_references.py` in its JavaScript bundle and runs it with Python
with one JSON request on stdin and reads one JSON response on stdout. Protocol
version 1 supports `capabilities`, `search`, `read`, `inspect` and `apply`.
The writer resolves machine paths from the installed workflow's `local.json` and
`boards.json`; callers retain the returned vault, board and ticket identity rather
than storing an absolute ticket path as identity.

`apply` accepts at most two ordered reference steps, each with the ticket key,
action, expected SHA-256 and canonical environment/thread reference. It uses the
same ticket locks and atomic writer as the ticket workflow, verifies the result,
and reports completed steps if a later step fails. It never retries, rolls back,
commits or pushes. The plugin owns durable intent, binding revision and recovery;
the writer owns ticket-file validation and reference edits.

Only the `t3-ticket-threads:v1` section and the ticket's `updated_at` value may
change. Existing progress and other bytes are preserved. Malformed sections,
duplicate identities, stale hashes and ambiguous tickets are errors, not invitations
to rebuild the section. Do not hand-edit this section to repair a plugin binding:
use the plugin's explicit recovery operation after inspecting both references.

## Development

Run `vp run test` for the plugin and `vp run test:writer` for the Python adapter.
The latter needs pytest, PyYAML, and the installed vault workflow; set
`T3_OBSIDIAN_WORKFLOW_DIR` to test against another workflow checkout. Fixtures use
disposable repositories and vaults, never the configured user vault.
