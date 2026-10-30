# Local plugins

In **Settings → Plugins**, install a plugin from its package directory on the
computer running your environment, then enable it. Packages run with the server's
permissions, so install only packages you trust. This first version targets local
desktop use; mobile and remote use have not been verified.

Installing another version stages an update. It takes effect when you manually
restart the environment. **Stage rollback** selects the preceding version for the
next restart. Disabling a plugin stops its active views and observers. Removing
one keeps its durable data; you can choose whether to delete its settings.

## Obsidian tickets

The ticket plugin needs the installed vault workflow with its thread-reference
writer. Configure the writer path and Python executable in the plugin's settings.
The workflow's existing machine configuration locates the vault and project boards.

Open **Ticket** from a thread's details and select a ticket. Search results identify
their board when several boards share the project. The panel shows the ticket's
title, properties and Markdown, and follows external edits while open. A thread
can have one ticket; the same ticket can have several threads.

Selecting another ticket moves this thread's reference. Unlinking removes the
reference. Settling or deleting the thread keeps the ticket reference and binding.
Ticket text is read-only here; edit business fields and content in the vault.

If an operation is interrupted, inspect its receipt and affected references through
the agent's plugin queries. Use **Repair references** to explicitly choose whether
to complete the intended change or restore the previous binding. Failed writes
are not retried automatically.
