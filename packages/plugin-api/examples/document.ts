import type { PluginApi, PluginDocument } from "@t3tools/plugin-api";

export async function activate(api: PluginApi): Promise<void> {
  const emptyInput = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  } as const;

  api.operations.register({
    id: "document.read",
    scope: "thread",
    summary: "Read the example document for this thread.",
    kind: "query",
    inputSchema: emptyInput,
    outputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        properties: emptyInput,
        markdown: { type: "string" },
        revision: { type: "string" },
      },
      required: ["title", "properties", "markdown", "revision"],
      additionalProperties: false,
    },
    requiredAccess: ["thread.read"],
    agent: true,
    run: async (context) => {
      const document: PluginDocument = {
        title: "Plugin example",
        properties: {},
        markdown: `A document supplied through API v${api.version}. Thread: ${context.threadId}`,
        revision: "1",
      };
      return { ok: true, value: document };
    },
  });
  api.contributions.documentPanel({ id: "document", queryId: "document.read", actions: [] });
  api.contributions.threadItem({
    id: "example",
    label: "Plugin example",
    queryId: "document.read",
    panelId: "document",
  });
}
