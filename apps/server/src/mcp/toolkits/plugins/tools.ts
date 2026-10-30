import {
  PluginCallInput,
  PluginCommandInput,
  PluginCatalog,
  PluginResult,
  ThreadId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as PluginHost from "../../../plugins/PluginHost.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const target = {
  scope: Schema.Literals(["thread", "environment"]),
  threadId: Schema.optionalKey(ThreadId),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    PluginHost.PluginHost,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
export const PluginToolkit = Toolkit.make(
  Tool.make("plugin_catalog", {
    ...shared,
    description:
      "Discover active plugin operations and their input schemas in this environment. Use scope thread for the current thread; environment for environment-wide operations. Thread-bound agents may only target their own thread. Read this catalog before calling plugin_query or plugin_command; use the returned activation generation.",
    parameters: Schema.Struct(target),
    success: PluginCatalog,
  }).annotate(Tool.Readonly, true),
  Tool.make("plugin_query", {
    ...shared,
    description:
      "Read plugin data with an operation whose catalog kind is query. Use this tool for status and recovery inspection. Take the operation and generation from plugin_catalog; input must match its schema. Queries cannot dispatch commands. If generation is stale, read the catalog again.",
    parameters: Schema.Struct({
      ...target,
      pluginId: PluginCallInput.fields.pluginId,
      generation: PluginCallInput.fields.generation,
      operation: PluginCallInput.fields.operation,
      input: PluginCallInput.fields.input,
    }),
    success: PluginResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("plugin_command", {
    ...shared,
    description:
      "Change plugin state with an operation whose catalog kind is command, only for an authorized change. Never use this tool for a query; use plugin_query for status and recovery inspection. Read the command schema and required revisions first. Supply a unique operationId and keep it for the same intent. After a timeout or recovery_required, inspect the receipt and current state with plugin_query; never retry a write automatically. Repair requires an explicit choice. Commands use the same handlers and permissions as the UI.",
    parameters: Schema.Struct({
      ...target,
      pluginId: PluginCallInput.fields.pluginId,
      generation: PluginCallInput.fields.generation,
      operation: PluginCallInput.fields.operation,
      input: PluginCallInput.fields.input,
      operationId: PluginCommandInput.fields.operationId,
    }),
    success: PluginResult,
  }).annotate(Tool.Destructive, true),
);
