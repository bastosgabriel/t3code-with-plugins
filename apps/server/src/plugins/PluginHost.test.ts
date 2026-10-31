import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  AuthStandardClientScopes,
  AuthEnvironmentMaintainScope,
  ThreadId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { liveThreadShell, idleThreadProjection } from "../mcp/McpToolAccess.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PluginHost from "./PluginHost.ts";

const environmentId = EnvironmentId.make("plugin-test-environment");
const principal = {
  scopes: [...AuthStandardClientScopes, AuthEnvironmentMaintainScope],
  agent: false,
};
const layerTest = () =>
  PluginHost.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (projectId) =>
            Effect.succeedSome({
              projectId,
              title: "Fixture",
              workspaceRoot: process.cwd(),
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              pinnedAt: null,
              archivedAt: null,
              deletedAt: null,
              createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
              updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: (id) => Effect.succeed(idleThreadProjection(liveThreadShell(id)).thread),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-host-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const manifest = {
  id: "fixture",
  name: "Fixture",
  version: "1.0.0",
  apiVersion: 1,
  uiVersion: 1,
  entry: "plugin.mjs",
};
const bundle = `import { writeFile } from 'node:fs/promises';
export async function activate(api) {
  await writeFile(api.storage.durableDirectory + '/binding.json', 'retained');
  await writeFile(api.storage.configDirectory + '/settings.json', 'configured');
  api.resources.add(() => writeFile(api.storage.durableDirectory + '/stopped', 'yes'));
  api.operations.register({ id: 'read', kind: 'query', scope: 'environment', summary: 'Read fixture',
    inputSchema: {type: 'string'}, outputSchema: {type: 'string'}, requiredAccess: [], agent: true,
    run: async () => ({ok: true, value: 'version-one'}) });
  api.operations.register({ id: 'thread-link', kind: 'query', scope: 'thread', summary: 'Read link',
    inputSchema: {type: 'string'}, outputSchema: {type: 'string'}, requiredAccess: [], agent: true,
    run: async (context) => ({ok: true, value: context.threadLink}) });
}`;

it.effect(
  "validates packages and target permissions, stages updates and preserves durable data on removal",
  () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.PluginHost;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-source-" });
      yield* fs.writeFileString(path.join(source, "manifest.json"), JSON.stringify(manifest));
      yield* fs.writeFileString(path.join(source, "plugin.mjs"), bundle);
      const denied = yield* host
        .manage({ action: "install", directory: source }, { scopes: [], agent: false })
        .pipe(Effect.flip);
      assert.equal(denied.code, "access_denied");
      assert.deepEqual(yield* host.list(principal), []);
      yield* fs.writeFileString(
        path.join(source, "manifest.json"),
        JSON.stringify({ ...manifest, apiVersion: 2 }),
      );
      const invalid = yield* host
        .manage({ action: "install", directory: source }, principal)
        .pipe(Effect.flip);
      assert.equal(invalid.code, "management_failed");
      assert.deepEqual(yield* host.list(principal), []);
      yield* fs.writeFileString(path.join(source, "manifest.json"), JSON.stringify(manifest));
      yield* host.manage({ action: "install", directory: source }, principal);
      yield* host.manage({ action: "enable", pluginId: "fixture" }, principal);
      const catalog = yield* host.catalog({ environmentId, uiVersion: 1 }, principal);
      assert.equal(catalog.plugins.length, 1);
      const generation = catalog.plugins[0]!.generation;
      const request = {
        environmentId,
        uiVersion: 1 as const,
        pluginId: "fixture",
        generation,
        operation: "read",
        input: "",
      };
      assert.deepEqual(yield* host.query(request, principal), { ok: true, value: "version-one" });
      assert.deepEqual(
        yield* host.query(
          {
            ...request,
            threadId: ThreadId.make("mcp:fixture"),
            operation: "thread-link",
          },
          principal,
        ),
        { ok: true, value: "t3-thread://v2/plugin-test-environment/mcp:fixture" },
      );
      const wrongEnvironment = yield* host
        .query({ ...request, environmentId: EnvironmentId.make("another") }, principal)
        .pipe(Effect.flip);
      assert.equal(wrongEnvironment.code, "invalid_target");
      yield* fs.writeFileString(
        path.join(source, "manifest.json"),
        JSON.stringify({ ...manifest, version: "2.0.0" }),
      );
      yield* fs.writeFileString(
        path.join(source, "plugin.mjs"),
        bundle.replace("version-one", "version-two"),
      );
      yield* host.manage({ action: "install", directory: source }, principal);
      assert.equal((yield* host.list(principal))[0]?.pendingVersion, "2.0.0");
      assert.deepEqual(yield* host.query(request, principal), { ok: true, value: "version-one" });
      yield* host.manage({ action: "disable", pluginId: "fixture" }, principal);
      assert.equal(
        yield* fs.readFileString(path.join(config.stateDir, "plugins/data/fixture/stopped")),
        "yes",
      );
      yield* host.manage({ action: "enable", pluginId: "fixture" }, principal);
      const stale = yield* host.query(request, principal).pipe(Effect.flip);
      assert.equal(stale.code, "stale_generation");
      yield* host.manage(
        { action: "remove", pluginId: "fixture", clearConfiguration: true },
        principal,
      );
      assert.deepEqual(yield* host.list(principal), []);
      assert.equal(
        yield* fs.readFileString(path.join(config.stateDir, "plugins/data/fixture/binding.json")),
        "retained",
      );
      assert.isFalse(yield* fs.exists(path.join(config.stateDir, "plugins/config/fixture")));
    }).pipe(Effect.provide(layerTest())),
);

it.effect(
  "promotes an immutable staged bundle on restart and can roll back without replacing durable data",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-upgrade-" });
      yield* fs.writeFileString(path.join(source, "manifest.json"), JSON.stringify(manifest));
      yield* fs.writeFileString(path.join(source, "plugin.mjs"), bundle);
      const query = Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const catalog = yield* host.catalog({ environmentId, uiVersion: 1 }, principal);
        return yield* host.query(
          {
            environmentId,
            uiVersion: 1,
            pluginId: "fixture",
            generation: catalog.plugins[0]!.generation,
            operation: "read",
            input: "",
          },
          principal,
        );
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* host.manage({ action: "install", directory: source }, principal);
        yield* host.manage({ action: "enable", pluginId: "fixture" }, principal);
        yield* fs.writeFileString(
          path.join(source, "manifest.json"),
          JSON.stringify({ ...manifest, version: "2.0.0" }),
        );
        yield* fs.writeFileString(
          path.join(source, "plugin.mjs"),
          bundle.replace("version-one", "version-two"),
        );
        yield* host.manage({ action: "install", directory: source }, principal);
        assert.deepEqual(yield* query, { ok: true, value: "version-one" });
      }).pipe(Effect.provide(PluginHost.layer));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual(yield* query, { ok: true, value: "version-two" });
        assert.isNull((yield* host.list(principal))[0]!.pendingVersion);
        yield* host.manage({ action: "rollback", pluginId: "fixture" }, principal);
        assert.deepEqual(yield* query, { ok: true, value: "version-two" });
      }).pipe(Effect.provide(PluginHost.layer));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        assert.deepEqual(yield* query, { ok: true, value: "version-one" });
        assert.equal((yield* host.list(principal))[0]!.manifest.version, "1.0.0");
      }).pipe(Effect.provide(PluginHost.layer));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectStore.ProjectStoreV2)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-restart-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
