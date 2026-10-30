import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]{0,79}$/));
export const PluginManifest = Schema.Struct({
  id: Identifier,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)),
  apiVersion: Schema.Literal(1),
  uiVersion: Schema.Literal(1),
  entry: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+\.mjs$/)),
});
export type PluginManifest = typeof PluginManifest.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  code: Schema.String,
  pluginId: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    return `Plugin operation failed: ${this.code}.`;
  }
}

export const PluginTarget = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: Schema.optionalKey(ThreadId),
  uiVersion: Schema.Literal(1),
});
export const PluginCallInput = Schema.Struct({
  ...PluginTarget.fields,
  pluginId: Identifier,
  generation: Schema.String,
  operation: Identifier,
  input: Schema.Json,
});
export type PluginCallInput = typeof PluginCallInput.Type;
export const PluginCommandInput = Schema.Struct({
  ...PluginCallInput.fields,
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
});
export type PluginCommandInput = typeof PluginCommandInput.Type;

export const PluginResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String.check(Schema.isMaxLength(80)),
      message: Schema.String.check(Schema.isMaxLength(2000)),
      operationId: Schema.optionalKey(Schema.String),
      recoveryId: Schema.optionalKey(Schema.String),
    }),
  }),
]);
export const PluginAdminInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("install"), directory: Schema.String }),
  Schema.Struct({
    action: Schema.Literals(["enable", "disable", "rollback"]),
    pluginId: Identifier,
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    pluginId: Identifier,
    clearConfiguration: Schema.Boolean,
  }),
]);
export type PluginAdminInput = typeof PluginAdminInput.Type;
export const PluginInstalled = Schema.Struct({
  manifest: PluginManifest,
  enabled: Schema.Boolean,
  active: Schema.Boolean,
  pendingVersion: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type PluginInstalled = typeof PluginInstalled.Type;

export const PluginAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("panel"), label: Schema.String, panelId: Identifier }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    label: Schema.String,
    commandId: Identifier,
    input: Schema.Json,
  }),
  Schema.Struct({
    kind: Schema.Literal("picker"),
    label: Schema.String,
    queryId: Identifier,
    commandId: Identifier,
    input: Schema.Json,
  }),
]);
export type PluginAction = typeof PluginAction.Type;
export const PluginContributions = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      id: Identifier,
      kind: Schema.Literals(["query", "command"]),
      scope: Schema.Literals(["environment", "thread"]),
      summary: Schema.String,
      inputSchema: Schema.Json,
      outputSchema: Schema.Json,
      requiredAccess: Schema.Array(Schema.String),
      agent: Schema.Boolean,
    }),
  ),
  threadItems: Schema.Array(
    Schema.Struct({
      id: Identifier,
      label: Schema.String,
      queryId: Identifier,
      panelId: Identifier,
    }),
  ),
  documentPanels: Schema.Array(
    Schema.Struct({ id: Identifier, queryId: Identifier, actions: Schema.Array(PluginAction) }),
  ),
  settings: Schema.Array(
    Schema.Struct({
      id: Identifier,
      label: Schema.String,
      queryId: Identifier,
      commandId: Identifier,
      fields: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          label: Schema.String,
          help: Schema.optionalKey(Schema.String),
          type: Schema.Literals(["text", "boolean", "enum"]),
          options: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});
export const PluginDocument = Schema.Struct({
  title: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Json),
  markdown: Schema.String,
  revision: Schema.String,
  actionInputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export const PluginPickerPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ key: Schema.String, label: Schema.String, detail: Schema.String }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export const PluginCatalog = Schema.Struct({
  plugins: Schema.Array(
    Schema.Struct({
      pluginId: Identifier,
      generation: Schema.String,
      contributions: PluginContributions,
    }),
  ),
});
export type PluginCatalog = typeof PluginCatalog.Type;
