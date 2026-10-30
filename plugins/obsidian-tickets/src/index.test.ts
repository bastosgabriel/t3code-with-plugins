import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { it, expect } from "vite-plus/test";

import type { PluginOperation, PluginResult, ThreadContext, Json } from "@t3tools/plugin-api";
import { activate } from "./index.ts";

const ticket = (id: string) => ({ vaultId: "vault", boardId: "board", ticketId: id });
const value = (result: PluginResult): Record<string, Json> => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value as Record<string, Json>;
};
const error = (result: PluginResult) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  return result.error.code;
};
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ticket-plugin-"));
  const storage = {
    configDirectory: NodePath.join(root, "config"),
    durableDirectory: NodePath.join(root, "data"),
  };
  await NodeFSP.mkdir(storage.configDirectory);
  await NodeFSP.mkdir(storage.durableDirectory);
  await NodeFSP.writeFile(
    NodePath.join(storage.configDirectory, "settings.json"),
    JSON.stringify({
      writerPath: NodeURL.fileURLToPath(new URL("../test/fixtures/writer.mjs", import.meta.url)),
      python: process.execPath,
      revision: 0,
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "documents.json"),
    JSON.stringify({
      calls: 0,
      interrupt: false,
      docs: Object.fromEntries(
        ["T-1", "T-2"].map((id) => [
          id,
          { title: id, markdown: "Body", properties: {}, references: [] },
        ]),
      ),
    }),
  );
  const context: ThreadContext = {
    scope: "thread",
    environmentId: "env",
    threadId: "thread",
    projectId: "project",
    projectDirectory: root,
    threadLink: "t3-thread://v1/thread",
    activationGeneration: "one",
    signal: new AbortController().signal,
  };
  let operations = new Map<string, PluginOperation>();
  const start = async () => {
    operations = new Map();
    const noop = () => {};
    await activate({
      version: 1,
      storage,
      log: noop,
      changed: noop,
      resources: { add: () => noop },
      contributions: { documentPanel: () => noop, threadItem: () => noop, settings: () => noop },
      operations: {
        register: (operation) => {
          operations.set(operation.id, operation);
          return noop;
        },
      },
    });
  };
  const query = async (id: string, input: Json = {}) => {
    const operation = operations.get(id);
    if (!operation || operation.scope !== "thread" || operation.kind !== "query")
      throw new Error(id);
    return operation.run(context, input);
  };
  const command = async (id: string, operationId: string, input: Json) => {
    const operation = operations.get(id);
    if (!operation || operation.scope !== "thread" || operation.kind !== "command")
      throw new Error(id);
    return operation.run(context, { operationId, input });
  };
  const bind = (id: string, revision: number, operationId: string) =>
    command("binding.set", operationId, {
      key: JSON.stringify({ ticket: ticket(id), expectedBindingRevision: revision }),
    });
  const documents = async () =>
    JSON.parse(await NodeFSP.readFile(NodePath.join(root, "documents.json"), "utf8")) as {
      calls: number;
      interrupt: boolean;
      docs: Record<string, { title: string; references: unknown[] }>;
    };
  const interrupt = async () => {
    const data = await documents();
    data.interrupt = true;
    await NodeFSP.writeFile(NodePath.join(root, "documents.json"), JSON.stringify(data));
  };
  try {
    await start();
  } catch (cause) {
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw cause;
  }
  return {
    root,
    storage,
    context,
    start,
    query,
    command,
    bind,
    documents,
    interrupt,
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

it("persists bindings, rejects stale revisions and replays operation receipts without rewriting tickets", async () => {
  await using f = await fixture();
  const first = await f.bind("T-1", 0, "first");
  expect(value(first).revision).toBe(1);
  expect(await f.bind("T-1", 0, "first")).toEqual(first);
  expect((await f.documents()).calls).toBe(1);
  expect(error(await f.bind("T-2", 1, "first"))).toBe("invalid_input");
  expect(error(await f.bind("T-2", 0, "stale"))).toBe("binding_conflict");
  await f.start();
  expect(value(await f.query("binding.get")).ticket).toEqual(ticket("T-1"));
  expect(value(await f.bind("T-2", 1, "switch")).revision).toBe(2);
  const docs = await f.documents();
  expect(docs.docs["T-1"]!.references).toEqual([]);
  expect(docs.docs["T-2"]!.references).toHaveLength(1);
  expect(
    value(await f.command("binding.clear", "clear", { expectedBindingRevision: 2 })).ticket,
  ).toBeNull();
  expect((await f.documents()).docs["T-2"]!.references).toEqual([]);
});

it("recovers an interrupted repair using the complete original ticket set after restarting", async () => {
  await using f = await fixture();
  await f.bind("T-1", 0, "first");
  await f.interrupt();
  expect(error(await f.bind("T-2", 1, "switch"))).toBe("recovery_required");
  expect(error(await f.bind("T-2", 1, "retry"))).toBe("recovery_required");
  expect((await f.documents()).calls).toBe(2);
  expect(value(await f.query("binding.get")).ticket).toEqual(ticket("T-1"));
  const choices = value(await f.query("recovery.choices", { search: "" })).items as {
    key: string;
  }[];
  await f.interrupt();
  expect(error(await f.command("recovery.apply", "repair", { key: choices[1]!.key }))).toBe(
    "recovery_required",
  );
  await f.start();
  const next = value(await f.query("recovery.choices", { search: "" })).items as { key: string }[];
  expect(next).toHaveLength(2);
  const snapshot = value(await f.query("recovery.inspect", { recoveryId: "repair" }));
  expect(snapshot.documents as Json[]).toHaveLength(2);
  const done = await f.command("recovery.apply", "finish-repair", { key: next[1]!.key });
  expect(value(done).ticket).toEqual(ticket("T-1"));
  expect(value(await f.query("binding.get")).recoveries).toEqual([]);
  const docs = await f.documents();
  expect(docs.docs["T-1"]!.references).toHaveLength(1);
  expect(docs.docs["T-2"]!.references).toEqual([]);
  expect(await f.command("recovery.apply", "finish-repair", { key: next[1]!.key })).toEqual(done);
  expect((await f.documents()).calls).toBe(4);
});

it("preserves unsupported durable state and refuses activation", async () => {
  await using f = await fixture();
  const file = NodePath.join(f.storage.durableDirectory, "state.json");
  const original = '{"version":99,"important":"preserve"}';
  await NodeFSP.writeFile(file, original);
  await expect(f.start()).rejects.toThrow("Unsupported ticket-plugin data version");
  expect(await NodeFSP.readFile(file, "utf8")).toBe(original);
});
