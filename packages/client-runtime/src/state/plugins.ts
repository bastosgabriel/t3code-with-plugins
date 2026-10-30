import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const observe = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "plugins:observe",
    tag: WS_METHODS.pluginsObserve,
    idleTtlMs: 0,
  });
  const observeCatalog = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "plugins:catalog-observe",
    tag: WS_METHODS.pluginsCatalogObserve,
    idleTtlMs: 0,
  });
  return {
    catalog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "plugins:catalog",
      tag: WS_METHODS.pluginsCatalog,
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshTrigger: observeCatalog,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "plugins:list",
      tag: WS_METHODS.pluginsList,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    query: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "plugins:query",
      tag: WS_METHODS.pluginsQuery,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    liveQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "plugins:live-query",
      tag: WS_METHODS.pluginsQuery,
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshTrigger: observe,
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "plugins:command",
      tag: WS_METHODS.pluginsCommand,
    }),
    manage: createEnvironmentRpcCommand(runtime, {
      label: "plugins:manage",
      tag: WS_METHODS.pluginsManage,
    }),
  };
}
