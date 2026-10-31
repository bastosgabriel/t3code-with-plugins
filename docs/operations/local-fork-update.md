# Update the installed Linux fork

For the existing T3 Code with Plugins installation on this workstation, keep the
app open and run from the repository:

```sh
python3 scripts/update-local-desktop.py
```

The command requires local `main` to match `origin/main` and rejects uncommitted
application sources. It selects an installed NVM Node 24+ and puts rustup's
`~/.cargo/bin` on PATH. Rust 1.95+, the Linux AppImage prerequisites in
[development](development.md#linux-appimage-prerequisites), and installed workspace
dependencies must already be available.

The command holds the shared local validation lock, builds a fresh AppImage and
Obsidian tickets plugin, verifies copied files, stages the plugin through the
running server's authenticated installation operation, and updates the existing
fork launcher. It preserves the previous release, launcher backup, plugin settings
and bindings. A delivery record with commit and checksums lives beside the installed
release. This command targets the existing fork launcher at
`~/.local/state/t3p-006/launch.py` and T3 home `~/.t3code-with-plugins`; it is not a
new-machine installer. Use `--port` if the fork server does not listen on 3773.

After success, close and reopen **T3 Code with Plugins** when active turns finish.
The command does not stop or restart the app. An update staged in Plugins settings
is activated on that restart. A connection failure after sending installation may
leave a staged plugin: inspect Plugins settings before retrying. A failure before
updating the launcher leaves its existing target intact.

Do not wrap this command in `local-validation.py` again: it acquires that lock itself.
