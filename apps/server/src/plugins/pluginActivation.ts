import type {
  Dispose,
  DocumentPanelContribution,
  Json,
  PluginAccess,
  PluginApi,
  PluginContext,
  PluginModule,
  PluginOperation,
  PluginResult,
  SettingsContribution,
  ThreadItemContribution,
} from "@t3tools/plugin-api";
import { compilePluginSchema } from "./pluginSchema.ts";

export class PluginActivationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Plugin operation failed: ${code}.`);
    this.code = code;
  }
}

type RegisteredOperation = {
  definition: PluginOperation;
  decodeInput: (input: unknown) => Json;
  decodeOutput: (output: unknown) => Json;
};

const assertIdentifier = (id: string) => {
  if (!/^[a-z][a-z0-9.-]{0,79}$/.test(id)) throw new PluginActivationError("invalid_identifier");
};

export async function activatePlugin(
  module: PluginModule,
  options: {
    generation: string;
    storage: PluginApi["storage"];
    changed: PluginApi["changed"];
    log: PluginApi["log"];
  },
) {
  let state: "activating" | "active" | "stopping" | "inactive" = "activating";
  const operations = new Map<string, RegisteredOperation>();
  const threadItems = new Map<string, ThreadItemContribution>();
  const panels = new Map<string, DocumentPanelContribution>();
  const settings = new Map<string, SettingsContribution>();
  const resources = new Set<Dispose>();
  const commands = new Set<Promise<PluginResult>>();
  const queries = new Set<AbortController>();
  let stopPromise: Promise<void> | undefined;

  function assertRegistering() {
    if (state !== "activating") throw new PluginActivationError("registration_closed");
  }

  function own(dispose: Dispose): () => Promise<void> {
    if (state === "inactive" || state === "stopping") throw new PluginActivationError("inactive");
    let disposed: Promise<void> | undefined;
    const once = () => {
      if (!disposed) {
        resources.delete(once);
        disposed = Promise.resolve().then(dispose);
      }
      return disposed;
    };
    resources.add(once);
    return once;
  }

  function register<T extends { readonly id: string }>(map: Map<string, T>, value: T): Dispose {
    assertRegistering();
    assertIdentifier(value.id);
    if (map.has(value.id)) throw new PluginActivationError("duplicate_registration");
    map.set(value.id, structuredClone(value));
    return own(() => {
      map.delete(value.id);
    });
  }

  const stop = () => {
    if (stopPromise) return stopPromise;
    state = "stopping";
    for (const controller of queries) controller.abort();
    stopPromise = (async () => {
      await Promise.allSettled(commands);
      const failures: unknown[] = [];
      for (const dispose of [...resources].reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      operations.clear();
      threadItems.clear();
      panels.clear();
      settings.clear();
      state = "inactive";
      if (failures.length) throw new PluginActivationError("cleanup_failed");
    })();
    return stopPromise;
  };

  const api: PluginApi = {
    version: 1,
    operations: {
      register(definition) {
        assertRegistering();
        assertIdentifier(definition.id);
        if (operations.has(definition.id))
          throw new PluginActivationError("duplicate_registration");
        const registration = {
          definition: { ...definition, requiredAccess: [...definition.requiredAccess] },
          decodeInput: compilePluginSchema(definition.inputSchema),
          decodeOutput: compilePluginSchema(definition.outputSchema),
        };
        operations.set(definition.id, registration);
        return own(() => {
          operations.delete(definition.id);
        });
      },
    },
    contributions: {
      threadItem: (value) => register(threadItems, value),
      documentPanel: (value) => register(panels, value),
      settings: (value) => register(settings, value),
    },
    resources: { add: own },
    storage: Object.freeze({ ...options.storage }),
    changed(target) {
      if (state !== "active") return;
      const scope = settings.has(target.viewId) ? "environment" : "thread";
      if (
        !settings.has(target.viewId) &&
        !panels.has(target.viewId) &&
        !threadItems.has(target.viewId)
      ) {
        throw new PluginActivationError("unknown_contribution");
      }
      if ((scope === "thread") !== (target.threadId !== undefined)) {
        throw new PluginActivationError("invalid_scope");
      }
      options.changed(target);
    },
    log: options.log,
  };

  function requireOperation(
    id: string,
    kind: "query" | "command",
    scope: "thread" | "environment",
  ) {
    const entry = operations.get(id);
    if (!entry || entry.definition.kind !== kind || entry.definition.scope !== scope) {
      throw new PluginActivationError("invalid_contribution_operation");
    }
  }

  try {
    await module.activate(api);
    for (const item of threadItems.values()) {
      requireOperation(item.queryId, "query", "thread");
      if (!panels.has(item.panelId)) throw new PluginActivationError("unknown_panel");
    }
    for (const panel of panels.values()) {
      requireOperation(panel.queryId, "query", "thread");
      for (const action of panel.actions) {
        if (action.kind === "panel") {
          if (!panels.has(action.panelId)) throw new PluginActivationError("unknown_panel");
        } else {
          requireOperation(action.commandId, "command", "thread");
          if (action.kind === "picker") requireOperation(action.queryId, "query", "thread");
        }
      }
    }
    for (const entry of settings.values()) {
      requireOperation(entry.queryId, "query", "environment");
      requireOperation(entry.commandId, "command", "environment");
    }
    state = "active";
  } catch (error) {
    await stop().catch(() => options.log("error", "Plugin activation cleanup failed."));
    throw error;
  }

  function authorize(input: {
    id: string;
    kind: "query" | "command";
    context: PluginContext;
    access: readonly PluginAccess[];
    agent: boolean;
  }) {
    if (state !== "active") throw new PluginActivationError("inactive");
    if (input.context.activationGeneration !== options.generation) {
      throw new PluginActivationError("stale_generation");
    }
    const entry = operations.get(input.id);
    if (!entry || entry.definition.kind !== input.kind)
      throw new PluginActivationError("unknown_operation");
    const operation = entry.definition;
    if (operation.scope !== input.context.scope) throw new PluginActivationError("invalid_scope");
    const required = new Set<PluginAccess>(["thread.read", ...operation.requiredAccess]);
    if (input.kind === "command") required.add("thread.operate");
    if (
      [...required].some((access) => !input.access.includes(access)) ||
      (input.agent && !operation.agent)
    ) {
      throw new PluginActivationError("access_denied");
    }
    return entry;
  }

  function run(input: {
    id: string;
    kind: "query" | "command";
    context: PluginContext;
    access: readonly PluginAccess[];
    agent: boolean;
    input: unknown;
    operationId?: string;
  }): Promise<PluginResult> {
    const entry = authorize(input);
    const payload = entry.decodeInput(input.input);
    const controller = new AbortController();
    if (input.kind === "query") queries.add(controller);
    const context = {
      ...input.context,
      signal:
        input.kind === "query"
          ? AbortSignal.any([controller.signal, input.context.signal])
          : controller.signal,
    };
    const operation = entry.definition;
    const execute = async () => {
      let result: PluginResult;
      if (operation.kind === "command") {
        if (!input.operationId || input.operationId.length > 160)
          throw new PluginActivationError("invalid_operation_id");
        const request = { operationId: input.operationId, input: payload };
        if (operation.scope === "thread" && context.scope === "thread")
          result = await operation.run(context, request);
        else if (operation.scope === "environment" && context.scope === "environment")
          result = await operation.run(context, request);
        else throw new PluginActivationError("invalid_scope");
      } else {
        if (operation.scope === "thread" && context.scope === "thread")
          result = await operation.run(context, payload);
        else if (operation.scope === "environment" && context.scope === "environment")
          result = await operation.run(context, payload);
        else throw new PluginActivationError("invalid_scope");
        if (context.signal.aborted || state !== "active")
          throw new PluginActivationError("inactive");
      }
      return result.ok ? { ok: true as const, value: entry.decodeOutput(result.value) } : result;
    };
    // Keep mutations owned until their actual Promise settles, even if the caller disconnects.
    const promise = execute().finally(() => {
      commands.delete(promise);
      queries.delete(controller);
    });
    if (input.kind === "command") commands.add(promise);
    return promise;
  }

  async function observe(
    input: {
      id: string;
      context: PluginContext;
      access: readonly PluginAccess[];
      agent: boolean;
      input: unknown;
    },
    invalidate: () => void,
  ): Promise<Dispose> {
    const entry = authorize({ ...input, kind: "query" });
    const payload = entry.decodeInput(input.input);
    const operation = entry.definition;
    if (operation.kind !== "query" || !operation.observe) return () => {};
    const controller = new AbortController();
    const context = {
      ...input.context,
      signal: AbortSignal.any([controller.signal, input.context.signal]),
    };
    context.signal.throwIfAborted();
    let closed = false;
    const notify = () => {
      if (!closed && !context.signal.aborted && state === "active") invalidate();
    };
    const acquisition = Promise.resolve().then(() => {
      if (operation.scope === "thread" && context.scope === "thread")
        return operation.observe!(context, payload, notify);
      if (operation.scope === "environment" && context.scope === "environment")
        return operation.observe!(context, payload, notify);
      throw new PluginActivationError("invalid_scope");
    });
    const close = own(async () => {
      closed = true;
      input.context.signal.removeEventListener("abort", onAbort);
      controller.abort();
      const dispose = await acquisition;
      await dispose();
    });
    const onAbort = () => {
      void close().catch(() => options.log("error", "Plugin observer cleanup failed."));
    };
    input.context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await acquisition;
      if (closed || state !== "active" || context.signal.aborted) await close();
      return close;
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }

  return {
    run,
    observe,
    stop,
    generation: options.generation,
    catalog: () => ({
      threadItems: [...threadItems.values()],
      documentPanels: [...panels.values()],
      settings: [...settings.values()],
      operations: [...operations.values()].map(({ definition: { run: _run, ...definition } }) => {
        const { observe: _observe, ...metadata } = { observe: undefined, ...definition };
        return metadata;
      }),
    }),
  };
}
