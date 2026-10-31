export const bindingInstructions =
  "When the user asks to work on a ticket, automatically link this thread if it is unlinked. " +
  "An explicit ticket ID or an unambiguous description can identify the ticket; no separate linking approval is needed. " +
  "First read binding.get and resolve the request with ticket.search. Use the exact returned key, which includes the current binding revision; never invent a key or identity. " +
  "If several tickets match, ask which one. If none match, report that and do not create a ticket. " +
  "Keep an existing matching binding without writing. Preserve a different binding unless the user explicitly requests a switch. " +
  "Mentions, status questions, comparisons, and reading or listing tickets do not authorize linking. " +
  "Use plugin_command with this catalog generation and one stable operationId per intent. " +
  "After a timeout, uncertain result, or recovery_required, inspect operation.get and recovery.inspect; never retry a write blindly or choose a repair without explicit approval. " +
  "On permission denial or a stale binding revision, report the failure and reread state; never claim a successful link.";
