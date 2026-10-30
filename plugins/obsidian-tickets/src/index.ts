import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type {
  Json,
  JsonSchema,
  PluginApi,
  PluginResult,
  PluginThreadItemState,
  ThreadContext,
} from "@t3tools/plugin-api";

type TicketKey = { vaultId: string; boardId: string; ticketId: string };
type Binding = { revision: number; ticket: TicketKey | null };
type Receipt = {
  fingerprint: string;
  status: "prepared" | "committed" | "failed" | "recovery-required";
  previous: Binding;
  target: TicketKey | null;
  result?: PluginResult;
  recoveryOf?: string;
};
type State = { version: 1; bindings: Record<string, Binding>; operations: Record<string, Receipt> };
type Configuration = { writerPath: string; python: string; revision: number };

const empty = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;
const object = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", maxLength: 4096 } as const;
const revisionSchema = { type: "number", minimum: 0 } as const;
const selectTicket = {
  kind: "picker",
  label: "Select ticket",
  queryId: "ticket.search",
  commandId: "binding.set",
  input: {},
} as const;
const success = (value: Json): PluginResult => ({ ok: true, value });
const failure = (code: string, message: string, recoveryId?: string): PluginResult => ({
  ok: false,
  error: { code, message, ...(recoveryId ? { recoveryId } : {}) },
});
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as Record<string, unknown>;
};
const text = (value: unknown) => {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string.");
  return value;
};
const revision = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid revision.");
  return value;
};
const ticketKey = (value: unknown): TicketKey => {
  const key = record(value);
  return { vaultId: text(key.vaultId), boardId: text(key.boardId), ticketId: text(key.ticketId) };
};
const binding = (value: unknown): Binding => {
  const item = record(value);
  return {
    revision: revision(item.revision),
    ticket: item.ticket === null ? null : ticketKey(item.ticket),
  };
};
const threadKey = (context: ThreadContext) =>
  JSON.stringify([context.environmentId, context.threadId]);
const operationKey = (context: ThreadContext, id: string) =>
  JSON.stringify([context.environmentId, context.threadId, id]);
const sameTicket = (a: TicketKey | null, b: TicketKey | null) =>
  JSON.stringify(a) === JSON.stringify(b);
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

async function atomicJson(file: string, value: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const handle = await NodeFSP.open(file + ".tmp", "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(file + ".tmp", file);
  const directory = await NodeFSP.open(NodePath.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function decodeState(value: unknown): State {
  if (value === undefined) return { version: 1, bindings: {}, operations: {} };
  const state = record(value);
  if (state.version !== 1)
    throw new Error("Unsupported ticket-plugin data version; data was preserved.");
  const bindings = Object.fromEntries(
    Object.entries(record(state.bindings)).map(([key, value]) => [key, binding(value)]),
  );
  const operations = Object.fromEntries(
    Object.entries(record(state.operations)).map(([key, value]) => {
      const receipt = record(value);
      if (
        !["prepared", "committed", "failed", "recovery-required"].includes(String(receipt.status))
      )
        throw new Error("Invalid operation receipt.");
      const result = receipt.result as PluginResult | undefined;
      if (
        result !== undefined &&
        (typeof result.ok !== "boolean" || (!result.ok && typeof result.error?.code !== "string"))
      )
        throw new Error("Invalid operation result.");
      return [
        key,
        {
          fingerprint: text(receipt.fingerprint),
          status: receipt.status === "prepared" ? "recovery-required" : receipt.status,
          ...(receipt.recoveryOf === undefined ? {} : { recoveryOf: text(receipt.recoveryOf) }),
          previous: binding(receipt.previous),
          target: receipt.target === null ? null : ticketKey(receipt.target),
          ...(result === undefined ? {} : { result }),
        } as Receipt,
      ];
    }),
  );
  return { version: 1, bindings, operations };
}

function workflow(
  config: Configuration,
  repo: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(config.python, [config.writerPath, "--repo", repo], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length <= 2 * 1024 * 1024) chunks.push(chunk);
      else overflow = true;
    });
    child.stderr.resume();
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", () => {
      try {
        if (overflow) throw new Error("Workflow response exceeds the supported size.");
        resolve(record(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ protocolVersion: 1, ...request }));
  });
}

export async function activate(api: PluginApi): Promise<void> {
  const configFile = NodePath.join(api.storage.configDirectory, "settings.json");
  const stateFile = NodePath.join(api.storage.durableDirectory, "state.json");
  const savedConfig = await readJson(configFile);
  const source = savedConfig === undefined ? {} : record(savedConfig);
  let config: Configuration = {
    writerPath:
      source.writerPath === undefined
        ? NodePath.join(
            NodeOS.homedir(),
            ".codex/skills/vault-manage-ticket/scripts/thread_references.py",
          )
        : text(source.writerPath),
    python: source.python === undefined ? "python3" : text(source.python),
    revision: source.revision === undefined ? 0 : revision(source.revision),
  };
  const capability = await workflow(config, api.storage.configDirectory, {
    operation: "capabilities",
  });
  if (capability.protocolVersion !== 1)
    throw new Error("Install a compatible vault workflow before activating Obsidian tickets.");
  let state = decodeState(await readJson(stateFile));
  let tail = Promise.resolve();
  const locked = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const save = async (next: State) => {
    await atomicJson(stateFile, next);
    state = next;
  };
  const current = (context: ThreadContext): Binding =>
    state.bindings[threadKey(context)] ?? { revision: 0, ticket: null };
  const changed = (context: ThreadContext) => {
    api.changed({ viewId: "ticket", threadId: context.threadId });
    api.changed({ viewId: "ticket-item", threadId: context.threadId });
  };
  const inspect = async (context: ThreadContext, ticket: TicketKey) => {
    const result = await workflow(config, context.projectDirectory, {
      operation: "read",
      ...ticket,
    });
    if (result.status === "failed") throw new Error(String(result.error));
    text(result.sha256);
    return result;
  };
  const recoveries = (context: ThreadContext) =>
    Object.entries(state.operations).filter(([key, receipt]) => {
      const identity: unknown = JSON.parse(key);
      return (
        Array.isArray(identity) &&
        identity[0] === context.environmentId &&
        identity[1] === context.threadId &&
        (receipt.status === "prepared" || receipt.status === "recovery-required")
      );
    });

  const mutate = async (
    context: ThreadContext,
    operationId: string,
    target: TicketKey | null,
    expected: number,
  ): Promise<PluginResult> =>
    locked(async () => {
      const key = operationKey(context, operationId);
      const fingerprint = sha256(JSON.stringify([threadKey(context), target, expected]));
      const existing = state.operations[key];
      if (existing)
        return existing.fingerprint === fingerprint
          ? (existing.result ??
              failure(
                "recovery_required",
                "Inspect the interrupted operation before repairing references.",
                operationId,
              ))
          : failure("invalid_input", "This operation ID was already used with different input.");
      if (recoveries(context).length)
        return failure("recovery_required", "Repair the existing interrupted operation first.");
      const previous = current(context);
      if (previous.revision !== expected)
        return failure(
          "binding_conflict",
          "The binding changed. Read it again before changing it.",
        );
      const reference = {
        environmentId: context.environmentId,
        threadId: context.threadId,
        link: context.threadLink,
      };
      const steps: Record<string, unknown>[] = [];
      try {
        if (sameTicket(previous.ticket, target)) {
          if (target) {
            const doc = await inspect(context, target);
            const references = doc.references;
            if (
              !Array.isArray(references) ||
              !references.some((value) => {
                const item = record(value);
                return (
                  item.environmentId === context.environmentId && item.threadId === context.threadId
                );
              })
            ) {
              const outcome = failure(
                "recovery_required",
                "The ticket reference differs from the confirmed binding.",
                operationId,
              );
              await save({
                ...state,
                operations: {
                  ...state.operations,
                  [key]: {
                    fingerprint,
                    status: "recovery-required",
                    previous,
                    target,
                    result: outcome,
                  },
                },
              });
              return outcome;
            }
          }
          const outcome = success(previous);
          await save({
            ...state,
            operations: {
              ...state.operations,
              [key]: { fingerprint, status: "committed", previous, target, result: outcome },
            },
          });
          return outcome;
        }
        for (const [ticket, action] of [
          [previous.ticket, "remove"],
          [target, "add"],
        ] as const) {
          if (!ticket) continue;
          const document = await inspect(context, ticket);
          steps.push({
            boardId: ticket.boardId,
            ticketId: ticket.ticketId,
            action,
            expectedSha256: document.sha256,
            reference,
          });
        }
      } catch {
        return failure(
          "ticket_unavailable",
          "The ticket could not be inspected. No reference was written.",
        );
      }
      const receipt: Receipt = { fingerprint, status: "prepared", previous, target };
      await save({ ...state, operations: { ...state.operations, [key]: receipt } });
      let result: Record<string, unknown>;
      try {
        result = await workflow(config, context.projectDirectory, {
          operation: "apply",
          operationId,
          vaultId: (target ?? previous.ticket)!.vaultId,
          steps,
        });
      } catch {
        result = { status: "recovery-required" };
      }
      if (result.status !== "committed") {
        const status = result.status === "failed" ? "failed" : "recovery-required";
        const outcome = failure(
          status === "failed" ? "reference_write_failed" : "recovery_required",
          status === "failed"
            ? "Reference validation failed; no binding change was confirmed."
            : "Reference writing was interrupted. Inspect this operation before repairing it.",
          status === "failed" ? undefined : operationId,
        );
        await save({
          ...state,
          operations: { ...state.operations, [key]: { ...receipt, status, result: outcome } },
        });
        changed(context);
        return outcome;
      }
      const confirmed = { revision: previous.revision + 1, ticket: target };
      const outcome = success(confirmed);
      try {
        await save({
          ...state,
          bindings: { ...state.bindings, [threadKey(context)]: confirmed },
          operations: {
            ...state.operations,
            [key]: { ...receipt, status: "committed", result: outcome },
          },
        });
      } catch {
        return failure(
          "recovery_required",
          "References were written, but the binding could not be confirmed. Inspect the operation.",
          operationId,
        );
      }
      changed(context);
      return outcome;
    });

  const observeTicket = async (context: ThreadContext, invalidate: () => void) => {
    let closed = false;
    let busy = false;
    let watched = "";
    let signature = "";
    let watcher: ReturnType<typeof NodeFS.watch> | undefined;
    const refresh = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const selected = current(context);
        const doc = selected.ticket ? await inspect(context, selected.ticket) : null;
        if (closed) return;
        const next = JSON.stringify([selected, doc?.sha256 ?? null]);
        if (next !== signature) {
          signature = next;
          invalidate();
        }
        const file = doc ? text(doc.path) : "";
        if (file !== watched) {
          watcher?.close();
          watched = file;
          watcher = file
            ? NodeFS.watch(NodePath.dirname(file), () => {
                void refresh();
              })
            : undefined;
          watcher?.on("error", () => {
            watcher?.close();
            watched = "";
          });
        }
      } catch {
        if (!closed && signature !== "unavailable") {
          signature = "unavailable";
          invalidate();
        }
      } finally {
        busy = false;
      }
    };
    await refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    timer.unref();
    return () => {
      closed = true;
      clearInterval(timer);
      watcher?.close();
    };
  };

  const observations = new Map<
    string,
    { listeners: Set<() => void>; acquired: Promise<() => void> }
  >();
  const observe = async (context: ThreadContext, _input: Json, invalidate: () => void) => {
    const key = threadKey(context);
    let observation = observations.get(key);
    if (!observation) {
      const listeners = new Set<() => void>();
      observation = {
        listeners,
        acquired: observeTicket(context, () => {
          for (const listener of listeners) listener();
        }),
      };
      observations.set(key, observation);
    }
    const owned = observation;
    owned.listeners.add(invalidate);
    const dispose = await owned.acquired;
    return () => {
      owned.listeners.delete(invalidate);
      if (!owned.listeners.size) {
        dispose();
        observations.delete(key);
      }
    };
  };

  const registerQuery = (
    id: string,
    inputSchema: JsonSchema,
    run: (context: ThreadContext, input: Json) => Promise<PluginResult>,
    observing = false,
  ) =>
    api.operations.register({
      id,
      kind: "query",
      scope: "thread",
      summary: `Obsidian tickets: ${id}.`,
      inputSchema,
      outputSchema: {},
      requiredAccess: ["thread.read", "filesystem.read"],
      agent: true,
      run,
      ...(observing ? { observe } : {}),
    });
  registerQuery(
    "binding.get",
    empty,
    async (context) => {
      const selected = current(context);
      let label = "No ticket linked";
      if (selected.ticket) {
        try {
          label = `${selected.ticket.ticketId} · ${text((await inspect(context, selected.ticket)).title)}`;
        } catch {
          label = `${selected.ticket.ticketId} · unavailable`;
        }
      }
      return success({
        ...selected,
        ...({
          label,
          action: selected.ticket
            ? { kind: "panel", label: "Ticket", panelId: "ticket" }
            : selectTicket,
        } satisfies PluginThreadItemState),
        recoveries: recoveries(context).map(([key]) => JSON.parse(key)[2]),
      });
    },
    true,
  );
  registerQuery(
    "ticket.search",
    object({ search: string, cursor: {} }, ["search"]),
    async (context, input) => {
      const args = record(input);
      const result = await workflow(config, context.projectDirectory, {
        operation: "search",
        search: args.search,
        cursor: args.cursor,
      });
      if (!Array.isArray(result.items))
        return failure("search_failed", "The project boards could not be searched.");
      return success({
        items: result.items.map((value) => {
          const item = record(value),
            key = ticketKey(item.key);
          return {
            key: JSON.stringify({
              ticket: key,
              expectedBindingRevision: current(context).revision,
            }),
            label: `${key.ticketId} · ${text(item.title)}`,
            detail: key.boardId,
          };
        }),
        nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
      });
    },
  );
  registerQuery(
    "ticket.read",
    empty,
    async (context) => {
      const selected = current(context);
      const actionInputs = { "binding.clear": { expectedBindingRevision: selected.revision } };
      if (!selected.ticket)
        return success({
          title: "Ticket",
          properties: {},
          markdown: "No ticket linked.",
          revision: String(selected.revision),
          actionInputs,
        });
      try {
        const document = await inspect(context, selected.ticket);
        return success({
          title: `${selected.ticket.ticketId} · ${text(document.title)}`,
          properties: document.properties as Json,
          markdown: text(document.markdown),
          revision: `${selected.revision}:${text(document.sha256)}`,
          actionInputs,
        });
      } catch {
        return failure(
          "ticket_unavailable",
          "The linked ticket is missing, unreadable or ambiguous. Its binding is preserved.",
        );
      }
    },
    true,
  );
  registerQuery("operation.get", object({ operationId: string }), async (context, input) => {
    const id = text(record(input).operationId);
    return success(state.operations[operationKey(context, id)] ?? { status: "not-found" });
  });
  registerQuery("recovery.inspect", object({ recoveryId: string }), async (context, input) => {
    const id = text(record(input).recoveryId),
      receipt = state.operations[operationKey(context, id)];
    if (!receipt || !["prepared", "recovery-required"].includes(receipt.status))
      return failure("not_found", "No interrupted operation matches this thread.");
    const snapshot = await recoverySnapshot(context, receipt);
    return success({
      recoveryId: id,
      confirmed: current(context),
      intent: receipt.target,
      documents: snapshot.documents as Json,
      recoveryRevision: snapshot.revision,
    });
  });
  const recoverySnapshot = async (context: ThreadContext, receipt: Receipt) => {
    const unique = new Map<string, TicketKey>();
    const visited = new Set<Receipt>();
    let currentReceipt: Receipt | undefined = receipt;
    while (currentReceipt) {
      if (visited.has(currentReceipt)) throw new Error("Invalid recovery chain.");
      visited.add(currentReceipt);
      for (const ticket of [currentReceipt.previous.ticket, currentReceipt.target])
        if (ticket) unique.set(JSON.stringify(ticket), ticket);
      currentReceipt = currentReceipt.recoveryOf
        ? state.operations[operationKey(context, currentReceipt.recoveryOf)]
        : undefined;
    }
    if (!unique.size) throw new Error("No ticket reference to repair.");
    const documents = [];
    for (const ticket of unique.values())
      documents.push({ ticket, document: await inspect(context, ticket) });
    return { documents, revision: sha256(JSON.stringify([current(context), documents])) };
  };
  registerQuery(
    "recovery.choices",
    object({ search: string, cursor: {} }, ["search"]),
    async (context) => {
      const items = [];
      const pending = recoveries(context);
      const superseded = new Set(pending.map(([, receipt]) => receipt.recoveryOf));
      for (const [key, receipt] of pending) {
        if (superseded.has(text(JSON.parse(key)[2]))) continue;
        const id = text(JSON.parse(key)[2]);
        const snapshot = await recoverySnapshot(context, receipt);
        for (const mode of ["complete", "restore"] as const)
          items.push({
            key: JSON.stringify({
              recoveryId: id,
              mode,
              expectedRecoveryRevision: snapshot.revision,
            }),
            label:
              mode === "complete"
                ? "Complete the requested binding"
                : "Restore references to the confirmed binding",
            detail: id,
          });
      }
      return success({ items, nextCursor: null });
    },
  );
  api.operations.register({
    id: "recovery.apply",
    kind: "command",
    scope: "thread",
    summary:
      "Repair an interrupted operation using an explicitly selected recovery. Inspect recovery.choices first; no automatic retries.",
    inputSchema: object({ key: string }),
    outputSchema: {},
    requiredAccess: ["thread.operate", "filesystem.read", "filesystem.write"],
    agent: true,
    run: (context, request) =>
      locked(async () => {
        const selected = record(JSON.parse(text(record(request.input).key)));
        const recoveryId = text(selected.recoveryId),
          mode = text(selected.mode);
        if (mode !== "complete" && mode !== "restore")
          return failure("invalid_input", "Unknown recovery mode.");
        const expected = text(selected.expectedRecoveryRevision);
        const oldKey = operationKey(context, recoveryId),
          key = operationKey(context, request.operationId);
        const fingerprint = sha256(JSON.stringify([oldKey, mode, expected]));
        const existing = state.operations[key];
        if (existing)
          return existing.fingerprint === fingerprint
            ? (existing.result ??
                failure(
                  "recovery_required",
                  "Inspect the interrupted repair.",
                  request.operationId,
                ))
            : failure("invalid_input", "This operation ID already belongs to another request.");
        const old = state.operations[oldKey];
        if (!old || !["prepared", "recovery-required"].includes(old.status))
          return failure("not_found", "The operation no longer needs recovery.");
        const snapshot = await recoverySnapshot(context, old);
        if (snapshot.revision !== expected)
          return failure(
            "recovery_conflict",
            "References or the binding changed; inspect recovery again.",
          );
        const previous = current(context);
        const target = mode === "complete" ? old.target : previous.ticket;
        const receipt: Receipt = {
          fingerprint,
          previous,
          target,
          status: "prepared",
          recoveryOf: recoveryId,
        };
        const reference = {
          environmentId: context.environmentId,
          threadId: context.threadId,
          link: context.threadLink,
        };
        const steps = snapshot.documents.map(({ ticket, document }) => ({
          boardId: ticket.boardId,
          ticketId: ticket.ticketId,
          action: sameTicket(ticket, target) ? "add" : "remove",
          reference,
          expectedSha256: document.sha256,
        }));
        await save({ ...state, operations: { ...state.operations, [key]: receipt } });
        let result: Record<string, unknown>;
        try {
          result = await workflow(config, context.projectDirectory, {
            operation: "apply",
            operationId: request.operationId,
            vaultId: snapshot.documents[0]!.ticket.vaultId,
            steps,
          });
        } catch {
          result = { status: "recovery-required" };
        }
        if (result.status !== "committed") {
          const outcome = failure(
            "recovery_required",
            "Repair did not complete; inspect current files before another repair.",
            request.operationId,
          );
          await save({
            ...state,
            operations: {
              ...state.operations,
              [key]: { ...receipt, status: "recovery-required", result: outcome },
            },
          });
          return outcome;
        }
        const confirmed = { revision: previous.revision + 1, ticket: target };
        const outcome = success(confirmed);
        const resolved = Object.fromEntries(
          recoveries(context).map(([receiptKey, pending]) => [
            receiptKey,
            { ...pending, status: "committed" as const, result: outcome },
          ]),
        );
        try {
          await save({
            ...state,
            bindings: { ...state.bindings, [threadKey(context)]: confirmed },
            operations: {
              ...state.operations,
              ...resolved,
              [key]: { ...receipt, status: "committed", result: outcome },
            },
          });
        } catch {
          return failure(
            "recovery_required",
            "Repair references were written but could not be confirmed.",
            request.operationId,
          );
        }
        changed(context);
        return outcome;
      }),
  });
  api.operations.register({
    id: "binding.set",
    kind: "command",
    scope: "thread",
    summary:
      "Link a selected ticket to this thread after an explicit user request. Read binding.get and ticket.search first.",
    inputSchema: object({ key: string }),
    outputSchema: {},
    requiredAccess: ["thread.operate", "filesystem.read", "filesystem.write"],
    agent: true,
    run: async (context, request) => {
      const selected = record(JSON.parse(text(record(request.input).key)));
      return mutate(
        context,
        request.operationId,
        ticketKey(selected.ticket),
        revision(selected.expectedBindingRevision),
      );
    },
  });
  api.operations.register({
    id: "binding.clear",
    kind: "command",
    scope: "thread",
    summary:
      "Unlink the current ticket on explicit request. Read binding.get before supplying its revision.",
    inputSchema: object({ expectedBindingRevision: revisionSchema }),
    outputSchema: {},
    requiredAccess: ["thread.operate", "filesystem.read", "filesystem.write"],
    agent: true,
    run: (context, request) =>
      mutate(
        context,
        request.operationId,
        null,
        revision(record(request.input).expectedBindingRevision),
      ),
  });
  api.operations.register({
    id: "configuration.get",
    kind: "query",
    scope: "environment",
    summary: "Read this plugin's workflow configuration.",
    inputSchema: empty,
    outputSchema: {},
    requiredAccess: ["filesystem.read"],
    agent: true,
    run: async () => success(config),
  });
  api.operations.register({
    id: "configuration.set",
    kind: "command",
    scope: "environment",
    summary: "Save plugin-owned settings after checking workflow compatibility.",
    inputSchema: object({ writerPath: string, python: string, revision: revisionSchema }),
    outputSchema: {},
    requiredAccess: ["environment.manage"],
    agent: false,
    run: async (_context, request) =>
      locked(async () => {
        const args = record(request.input);
        if (revision(args.revision) !== config.revision)
          return failure("configuration_conflict", "Settings changed; read them again.");
        const next = {
          writerPath: text(args.writerPath),
          python: text(args.python),
          revision: config.revision + 1,
        };
        const result = await workflow(next, api.storage.configDirectory, {
          operation: "capabilities",
        });
        if (result.protocolVersion !== 1)
          return failure(
            "incompatible_workflow",
            "The configured workflow does not support protocol v1.",
          );
        await atomicJson(configFile, next);
        config = next;
        return success(config);
      }),
  });
  api.contributions.documentPanel({
    id: "ticket",
    queryId: "ticket.read",
    actions: [
      selectTicket,
      { kind: "command", label: "Unlink", commandId: "binding.clear", input: {} },
      {
        kind: "picker",
        label: "Repair references",
        queryId: "recovery.choices",
        commandId: "recovery.apply",
        input: {},
      },
    ],
  });
  api.contributions.threadItem({
    id: "ticket-item",
    label: "Ticket",
    queryId: "binding.get",
    panelId: "ticket",
  });
  api.contributions.settings({
    id: "settings",
    label: "Obsidian tickets",
    queryId: "configuration.get",
    commandId: "configuration.set",
    fields: [
      { key: "writerPath", type: "text", label: "Installed workflow writer" },
      { key: "python", type: "text", label: "Python command" },
    ],
  });
}
