import * as NodeURL from "node:url";
import {
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PluginError,
  PluginManifest,
  PluginContributions,
  PluginResult,
  type AuthEnvironmentScope,
  type PluginAdminInput,
  type PluginCallInput,
  type PluginCommandInput,
  type PluginCatalog,
  type PluginInstalled,
  type ThreadId,
} from "@t3tools/contracts";
import type { PluginAccess, PluginContext, PluginModule } from "@t3tools/plugin-api";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { activatePlugin, PluginActivationError } from "./pluginActivation.ts";

type Principal = { scopes: readonly AuthEnvironmentScope[]; agent: boolean; threadId?: ThreadId };
type Activation = Awaited<ReturnType<typeof activatePlugin>>;
const BundleFile = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]+\.mjs$/));
const InstalledRecord = Schema.Struct({
  currentFile: BundleFile,
  pendingFile: Schema.NullOr(BundleFile),
  previousFile: Schema.NullOr(BundleFile),
  manifest: PluginManifest,
  enabled: Schema.Boolean,
  pending: Schema.NullOr(PluginManifest),
  previous: Schema.NullOr(PluginManifest),
});
type InstalledRecord = typeof InstalledRecord.Type;
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstalledRecord));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest), {
  onExcessProperty: "error",
});
const decodeResult = Schema.decodeUnknownEffect(PluginResult, { onExcessProperty: "error" });
const decodeContributions = Schema.decodeUnknownSync(PluginContributions);

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly list: (principal: Principal) => Effect.Effect<readonly PluginInstalled[], PluginError>;
    readonly manage: (
      input: PluginAdminInput,
      principal: Principal,
    ) => Effect.Effect<void, PluginError>;
    readonly catalog: (
      input: Pick<PluginCallInput, "environmentId" | "threadId" | "uiVersion">,
      principal: Principal,
    ) => Effect.Effect<PluginCatalog, PluginError>;
    readonly query: (
      input: PluginCallInput,
      principal: Principal,
    ) => Effect.Effect<typeof PluginResult.Type, PluginError>;
    readonly command: (
      input: PluginCommandInput,
      principal: Principal,
    ) => Effect.Effect<typeof PluginResult.Type, PluginError>;
    readonly observeCatalog: (
      input: Pick<PluginCallInput, "environmentId" | "threadId" | "uiVersion">,
      principal: Principal,
    ) => Stream.Stream<number, PluginError>;
    readonly observe: (
      input: PluginCallInput,
      principal: Principal,
    ) => Stream.Stream<number, PluginError>;
  }
>()("t3/plugins/PluginHost") {}

const accessFor = (principal: Principal): PluginAccess[] => {
  const map: [AuthEnvironmentScope, PluginAccess][] = [
    [AuthFilesystemReadScope, "filesystem.read"],
    [AuthFilesystemWriteScope, "filesystem.write"],
    [AuthOrchestrationReadScope, "thread.read"],
    [AuthOrchestrationOperateScope, "thread.operate"],
    [AuthEnvironmentMaintainScope, "environment.manage"],
  ];
  return map.filter(([scope]) => principal.scopes.includes(scope)).map(([, access]) => access);
};

const isPluginError = Schema.is(PluginError);
const pluginFailure = (code: string, pluginId?: string) => (cause: unknown) =>
  isPluginError(cause)
    ? cause
    : new PluginError({
        code: cause instanceof PluginActivationError ? cause.code : code,
        ...(pluginId === undefined ? {} : { pluginId }),
        cause,
      });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "plugins");
  const records = new Map<string, InstalledRecord>();
  const active = new Map<string, Activation>();
  const errors = new Map<string, string>();
  const loaded = new Set<string>();
  const logs = yield* Queue.dropping<{
    pluginId: string;
    level: "info" | "warn" | "error";
    message: string;
  }>(64);
  yield* Queue.take(logs).pipe(
    Effect.flatMap(({ pluginId, level, message }) =>
      (level === "error" ? Effect.logError : level === "warn" ? Effect.logWarning : Effect.logInfo)(
        message,
      ).pipe(Effect.annotateLogs({ pluginId })),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  const catalogListeners = new Set<() => void>();
  const listeners = new Set<(pluginId: string, threadId?: string) => void>();
  const directory = (id: string) => path.join(root, "packages", id);

  const guard = (principal: Principal, scope: AuthEnvironmentScope) =>
    principal.scopes.includes(scope)
      ? Effect.void
      : Effect.fail(new PluginError({ code: "access_denied" }));

  const save = Effect.fn("PluginHost.save")(function* (id: string, record: InstalledRecord) {
    const text = yield* encodeRecord(record);
    const file = path.join(directory(id), "state.json");
    yield* fs.writeFileString(file + ".tmp", text);
    yield* fs.rename(file + ".tmp", file);
    records.set(id, record);
  });

  const disable = Effect.fn("PluginHost.disable")(function* (id: string) {
    const activation = active.get(id);
    active.delete(id);
    for (const listener of catalogListeners) listener();
    for (const listener of listeners) listener(id);
    if (activation)
      yield* Effect.tryPromise({
        try: () => activation.stop(),
        catch: pluginFailure("cleanup_failed", id),
      });
  });

  const enable = Effect.fn("PluginHost.enable")(function* (id: string) {
    if (active.has(id)) return;
    const record = records.get(id);
    if (!record) return yield* new PluginError({ code: "not_installed", pluginId: id });
    const configDirectory = path.join(root, "config", id);
    const durableDirectory = path.join(root, "data", id);
    yield* fs.makeDirectory(configDirectory, { recursive: true });
    yield* fs.makeDirectory(durableDirectory, { recursive: true });
    const url = NodeURL.pathToFileURL(path.join(directory(id), record.currentFile)).href;
    const module = yield* Effect.tryPromise({
      try: async () => {
        const loaded: unknown = await import(/* @vite-ignore */ url);
        if (
          !loaded ||
          typeof loaded !== "object" ||
          !("activate" in loaded) ||
          typeof loaded.activate !== "function"
        ) {
          throw new PluginActivationError("invalid_module");
        }
        return loaded as PluginModule;
      },
      catch: pluginFailure("load_failed", id),
    });
    loaded.add(id);
    const generation = yield* random.uuidV4();
    const activation = yield* Effect.tryPromise({
      try: () =>
        activatePlugin(module, {
          generation,
          storage: { configDirectory, durableDirectory },
          changed: ({ threadId }) => {
            for (const listener of listeners) listener(id, threadId);
          },
          log: (level, message) => {
            Queue.offerUnsafe(logs, { pluginId: id, level, message: message.slice(0, 4096) });
          },
        }),
      catch: pluginFailure("activation_failed", id),
    });
    active.set(id, activation);
    errors.delete(id);
    for (const listener of catalogListeners) listener();
    for (const listener of listeners) listener(id);
  });

  const contextFor = Effect.fn("PluginHost.contextFor")(function* (
    input: Pick<PluginCallInput, "environmentId" | "threadId" | "uiVersion">,
    principal: Principal,
    generation: string,
    signal: AbortSignal,
  ): Effect.fn.Return<PluginContext, PluginError> {
    yield* guard(principal, AuthOrchestrationReadScope);
    const environmentId = yield* environment.getEnvironmentId;
    if (
      input.environmentId !== environmentId ||
      input.uiVersion !== 1 ||
      (principal.threadId && input.threadId !== undefined && principal.threadId !== input.threadId)
    ) {
      return yield* new PluginError({ code: "invalid_target" });
    }
    if (!input.threadId)
      return { scope: "environment", environmentId, activationGeneration: generation, signal };
    const thread = yield* projections
      .getThread(input.threadId)
      .pipe(Effect.mapError(pluginFailure("thread_unavailable")));
    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.mapError(pluginFailure("project_unavailable")));
    if (Option.isNone(project)) return yield* new PluginError({ code: "project_unavailable" });
    return {
      scope: "thread",
      environmentId,
      activationGeneration: generation,
      signal,
      threadId: thread.id,
      projectId: thread.projectId,
      projectDirectory: project.value.workspaceRoot,
      ...(thread.worktreePath ? { worktreeDirectory: thread.worktreePath } : {}),
      // Plugin consumers need the URI, without the formatter's Markdown autolink delimiters.
      threadLink: formatThreadLink({ environmentId, threadId: thread.id }).slice(1, -1),
    };
  });

  const list = Effect.fn("PluginHost.list")(function* (principal: Principal) {
    yield* guard(principal, AuthOrchestrationReadScope);
    return [...records].map(([id, record]) => ({
      manifest: record.manifest,
      enabled: record.enabled,
      active: active.has(id),
      pendingVersion: record.pending?.version ?? null,
      error: errors.get(id) ?? null,
    }));
  });

  const manage = Effect.fn("PluginHost.manage")(
    function* (input: PluginAdminInput, principal: Principal) {
      yield* guard(principal, AuthEnvironmentMaintainScope);
      if (input.action === "install") {
        const manifest = yield* fs
          .readFileString(path.join(input.directory, "manifest.json"))
          .pipe(Effect.flatMap(decodeManifest));
        const sourceRoot = yield* fs.realPath(input.directory);
        const source = yield* fs.realPath(path.join(sourceRoot, manifest.entry));
        if (path.dirname(source) !== sourceRoot)
          return yield* new PluginError({ code: "invalid_entry", pluginId: manifest.id });
        const stat = yield* fs.stat(source);
        if (stat.size > 10 * 1024 * 1024)
          return yield* new PluginError({ code: "package_too_large", pluginId: manifest.id });
        yield* fs.makeDirectory(directory(manifest.id), { recursive: true });
        const record = records.get(manifest.id);
        if (!record && loaded.has(manifest.id))
          return yield* new PluginError({ code: "restart_required", pluginId: manifest.id });
        const bundleFile = `${yield* random.uuidV4()}.mjs`;
        const target = path.join(directory(manifest.id), bundleFile);
        yield* fs.copyFile(source, target + ".tmp");
        yield* fs.rename(target + ".tmp", target);
        yield* save(
          manifest.id,
          record
            ? { ...record, pending: manifest, pendingFile: bundleFile }
            : {
                manifest,
                enabled: false,
                pending: null,
                previous: null,
                currentFile: bundleFile,
                pendingFile: null,
                previousFile: null,
              },
        );
        return;
      }
      const id = input.pluginId;
      const record = records.get(id);
      if (!record) return yield* new PluginError({ code: "not_installed", pluginId: id });
      if (input.action === "enable") {
        yield* enable(id);
        yield* save(id, { ...record, enabled: true });
      } else if (input.action === "disable") {
        yield* disable(id);
        yield* save(id, { ...record, enabled: false });
      } else if (input.action === "remove") {
        yield* disable(id);
        yield* fs.remove(directory(id), { recursive: true });
        if (input.clearConfiguration)
          yield* fs.remove(path.join(root, "config", id), { recursive: true, force: true });
        records.delete(id);
        errors.delete(id);
      } else {
        if (!record.previous || !record.previousFile)
          return yield* new PluginError({ code: "no_previous_package", pluginId: id });
        yield* save(id, { ...record, pending: record.previous, pendingFile: record.previousFile });
      }
    },
    lock.withPermits(1),
    Effect.uninterruptible,
    Effect.mapError(pluginFailure("management_failed")),
  );

  const invoke = Effect.fn("PluginHost.invoke")(function* (
    input: PluginCallInput | PluginCommandInput,
    principal: Principal,
    kind: "query" | "command",
  ) {
    const activation = active.get(input.pluginId);
    if (!activation) return yield* new PluginError({ code: "inactive", pluginId: input.pluginId });
    const context = yield* contextFor(
      input,
      principal,
      input.generation,
      yield* Effect.abortSignal,
    );
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        activation.run({
          id: input.operation,
          kind,
          context: { ...context, signal },
          access: accessFor(principal),
          agent: principal.agent,
          input: input.input,
          ...("operationId" in input ? { operationId: input.operationId } : {}),
        }),
      catch: pluginFailure("execution_failed", input.pluginId),
    });
    return yield* decodeResult(result).pipe(
      Effect.mapError(pluginFailure("invalid_result", input.pluginId)),
    );
  });
  const query = Effect.fn("PluginHost.query")((input: PluginCallInput, principal: Principal) =>
    invoke(input, principal, "query").pipe(Effect.scoped),
  );
  const command = Effect.fn("PluginHost.command")(
    (input: PluginCommandInput, principal: Principal) => invoke(input, principal, "command"),
    Effect.scoped,
    Effect.uninterruptible,
  );

  const catalog = Effect.fn("PluginHost.catalog")(
    function* (
      input: Pick<PluginCallInput, "environmentId" | "threadId" | "uiVersion">,
      principal: Principal,
    ) {
      yield* contextFor(input, principal, "catalog", yield* Effect.abortSignal);
      const access = accessFor(principal);
      return {
        plugins: [...active].map(([pluginId, activation]) => {
          const catalog = activation.catalog();
          const operations = catalog.operations.filter(
            (operation) =>
              (!principal.agent || operation.agent) &&
              operation.requiredAccess.every((scope) => access.includes(scope)) &&
              (operation.kind !== "command" || access.includes("thread.operate")),
          );
          const readable = new Set(
            operations
              .filter((operation) => operation.kind === "query")
              .map((operation) => operation.id),
          );
          return {
            pluginId,
            generation: activation.generation,
            contributions: decodeContributions({
              ...catalog,
              operations,
              threadItems: catalog.threadItems.filter((item) => readable.has(item.queryId)),
              documentPanels: catalog.documentPanels.filter((item) => readable.has(item.queryId)),
              settings: catalog.settings.filter((item) => readable.has(item.queryId)),
            }),
          };
        }),
      };
    },
    Effect.scoped,
    Effect.mapError(pluginFailure("catalog_failed")),
  );

  const observeCatalog = (
    input: Pick<PluginCallInput, "environmentId" | "threadId" | "uiVersion">,
    principal: Principal,
  ) =>
    Stream.callback<number, PluginError>((queue) =>
      Effect.gen(function* () {
        yield* contextFor(input, principal, "catalog", yield* Effect.abortSignal);
        let revision = 0;
        const invalidate = () => {
          Queue.offerUnsafe(queue, ++revision);
        };
        catalogListeners.add(invalidate);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            catalogListeners.delete(invalidate);
          }),
        );
        invalidate();
      }),
    );

  const observe = (input: PluginCallInput, principal: Principal) =>
    Stream.callback<number, PluginError>((queue) =>
      Effect.gen(function* () {
        const activation = active.get(input.pluginId);
        if (!activation)
          return yield* new PluginError({ code: "inactive", pluginId: input.pluginId });
        const signal = yield* Effect.abortSignal;
        const context = yield* contextFor(input, principal, input.generation, signal);
        let revision = 0;
        const invalidate = () => {
          Queue.offerUnsafe(queue, ++revision);
        };
        const listener = (pluginId: string, threadId?: string) => {
          if (
            pluginId === input.pluginId &&
            (threadId === undefined || threadId === input.threadId)
          )
            invalidate();
        };
        listeners.add(listener);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
        );
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              activation.observe(
                {
                  id: input.operation,
                  context,
                  access: accessFor(principal),
                  agent: principal.agent,
                  input: input.input,
                },
                invalidate,
              ),
            catch: pluginFailure("observation_failed", input.pluginId),
          }),
          (dispose) =>
            Effect.promise(async () => {
              await dispose();
            }).pipe(Effect.ignore),
        );
        invalidate();
      }),
    );

  yield* fs.makeDirectory(path.join(root, "packages"), { recursive: true });
  for (const id of yield* fs.readDirectory(path.join(root, "packages"))) {
    if (!/^[a-z][a-z0-9.-]{0,79}$/.test(id)) continue;
    yield* Effect.gen(function* () {
      let record = yield* fs
        .readFileString(path.join(directory(id), "state.json"))
        .pipe(Effect.flatMap(decodeRecord));
      if (record.manifest.id !== id)
        return yield* new PluginError({ code: "invalid_package_identity", pluginId: id });
      records.set(id, record);
      if (record.pending) {
        if (!record.pendingFile)
          return yield* new PluginError({ code: "invalid_package_state", pluginId: id });
        record = {
          ...record,
          manifest: record.pending,
          previous: record.manifest,
          pending: null,
          currentFile: record.pendingFile,
          previousFile: record.currentFile,
          pendingFile: null,
        };
        yield* save(id, record);
      }
      if (record.enabled) yield* enable(id);
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          errors.set(id, pluginFailure("startup_failed", id)(cause).code);
        }),
      ),
    );
  }
  yield* Effect.addFinalizer(() => Effect.forEach([...active.keys()], disable).pipe(Effect.ignore));
  return PluginHost.of({ list, manage, catalog, query, command, observe, observeCatalog });
});

export const layer = Layer.effect(PluginHost, make);
