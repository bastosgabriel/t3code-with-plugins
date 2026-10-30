import {
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  OrchestratorMcpFailure,
  type PluginError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PluginHost from "../../../plugins/PluginHost.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { PluginToolkit } from "./tools.ts";

const target = Effect.fn("mcp.pluginTarget")(function* (input: {
  scope: "thread" | "environment";
  threadId?: ThreadId;
}) {
  const caller = yield* readCaller();
  const threadId =
    input.scope === "thread" ? (input.threadId ?? caller.scope.thread?.threadId) : undefined;
  if (
    (input.scope === "thread" && threadId === undefined) ||
    (input.scope === "environment" && input.threadId !== undefined)
  )
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "A thread target is required for thread operations; environment operations cannot name a thread.",
    });
  const writable =
    caller.limits.runtimeMode === "full-access" &&
    caller.limits.interactionMode === "default" &&
    caller.scope.client?.access !== "read-only";
  return {
    host: yield* PluginHost.PluginHost,
    input: {
      environmentId: caller.scope.environmentId,
      uiVersion: 1 as const,
      ...(threadId === undefined ? {} : { threadId }),
    },
    principal: {
      scopes: [
        AuthOrchestrationReadScope,
        AuthFilesystemReadScope,
        ...(writable
          ? [AuthOrchestrationOperateScope, AuthFilesystemWriteScope, AuthEnvironmentMaintainScope]
          : []),
      ],
      agent: true,
      ...(caller.scope.thread === undefined ? {} : { threadId: caller.scope.thread.threadId }),
    },
  };
});
const failure = (error: PluginError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
export const layer = McpToolAccess.toLayer(PluginToolkit, {
  plugin_catalog: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const ctx = yield* target(input);
      return yield* ctx.host.catalog(ctx.input, ctx.principal).pipe(Effect.mapError(failure));
    }),
  ),
  plugin_query: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const ctx = yield* target(input);
      return yield* ctx.host
        .query(
          {
            ...ctx.input,
            pluginId: input.pluginId,
            generation: input.generation,
            operation: input.operation,
            input: input.input,
          },
          ctx.principal,
        )
        .pipe(Effect.mapError(failure));
    }),
  ),
  plugin_command: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const execute = Effect.gen(function* () {
        yield* check;
        const ctx = yield* target(input);
        return yield* ctx.host
          .command(
            {
              ...ctx.input,
              pluginId: input.pluginId,
              generation: input.generation,
              operation: input.operation,
              input: input.input,
              operationId: input.operationId,
            },
            ctx.principal,
          )
          .pipe(Effect.mapError(failure));
      });
      return yield* scope.thread ? executor.withLock(scope.thread.threadId, execute) : execute;
    }),
  ),
});
