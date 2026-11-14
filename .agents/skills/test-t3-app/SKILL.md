---
name: test-t3-app
description: Test T3 Code's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Use T3's built-in Browser panel for verification. Follow the recovery steps
below before declaring it unavailable. Do not install or switch to another
automation system. For native mobile testing, use
[test-t3-mobile](../test-t3-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `python3 scripts/local-validation.py -- vp run dev` from the
repository root and retain its terminal session. Follow the local validation
resource policy in `AGENTS.md`. Exit 75 means the shared slot is occupied; defer
validation rather than starting another server. Reuse only a server owned by this
task and already running under the wrapper; stop an owned unguarded server before
restarting it through the wrapper. Use the worktree's ignored
`.t3` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Drive agent turns for free

Do not spend a paid model to see a turn render. `vp run dev` registers the
`Replay (dev)` provider, which replays recorded turns with simulated streaming
through the real adapter and orchestration. Its models are scenarios:
`showcase` covers thinking, a plan, tool calls, an approval, and markdown.
Press `Ctrl+Alt+Shift+R` for a picker (GNOME takes that key for screen
recording), call `window.t3dev.replay("showcase")`
with `preview_evaluate`, or run
`node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase <project> "go"`.
When the test needs real provider behavior, use that provider's cheapest
model, such as Haiku for Claude or Luna for Codex.

## Use the Browser panel

Call `preview_status`. If no tab can be automated, call `preview_open`, including
when status reports `available: false` or `tabId: null`. Status can report
unavailable simply because no tab exists yet; opening a tab needs no user action.
Stop verification and explain the blocker only if the tools are absent or
`preview_open` reports unavailable or fails.

Navigate to the complete startup pairing URL once with
`preview_navigate`, then use `preview_snapshot` and T3's interaction tools.
If the token was consumed or expired, run `node apps/server/src/bin.ts pair`
for a fresh one. Keep using the same tab.

## Verify and clean up

Exercise the affected flow and save screenshots and logs outside disposable
fixtures. Close this task's Browser tab and stop the retained wrapper session
immediately after validation, including failures or cancellations. Verify that
its scope stopped before starting another heavy check or handing off the slot.
The wrapper cleans its own scope; Browser tabs in the installed app are outside
it and must be closed separately. Never close the user's main window.

Keep a running environment only when Gabriel explicitly requests inspection;
record its owner and end condition, and keep the wrapper and lock alive for that
period. Retaining evidence or fixtures does not require a running server. Record
cleanup and any retained resources in the ticket or final response.

When sharing is requested, start with `python3 scripts/local-validation.py -- vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
