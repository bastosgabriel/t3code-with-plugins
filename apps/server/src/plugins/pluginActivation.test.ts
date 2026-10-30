import { describe, expect, it, vi } from "vite-plus/test";
import type { PluginApi, PluginCommand, PluginQuery, ThreadContext } from "@t3tools/plugin-api";
import { activatePlugin } from "./pluginActivation.ts";

const schema = { type: "string" } as const;
const context = (): ThreadContext => ({
  scope: "thread",
  environmentId: "environment",
  threadId: "thread",
  projectId: "project",
  projectDirectory: "/project",
  threadLink: "t3-thread://v1/thread",
  activationGeneration: "generation",
  signal: new AbortController().signal,
});
const options = () => ({
  generation: "generation",
  storage: { configDirectory: "/config", durableDirectory: "/data" },
  changed: vi.fn(),
  log: vi.fn(),
});
const query = (run: PluginQuery<"thread">["run"]): PluginQuery<"thread"> => ({
  id: "read",
  kind: "query",
  scope: "thread",
  summary: "Read a document.",
  requiredAccess: ["filesystem.read"],
  agent: true,
  inputSchema: schema,
  outputSchema: schema,
  run,
});
const command = (run: PluginCommand<"thread">["run"]): PluginCommand<"thread"> => ({
  ...query(async () => ({ ok: true, value: "unused" })),
  kind: "command",
  id: "write",
  requiredAccess: ["filesystem.write"],
  run,
});

describe("plugin activation", () => {
  it("disposes an observer acquired after cancellation and suppresses its late notifications", async () => {
    const acquired = Promise.withResolvers<() => void>();
    const entered = Promise.withResolvers<void>();
    const cleanup = vi.fn();
    const invalidate = vi.fn();
    const abort = new AbortController();
    let notify = () => {};
    const plugin = await activatePlugin(
      {
        activate: async (api) => {
          api.operations.register({
            ...query(async () => ({ ok: true, value: "document" })),
            observe: async (_context, _input, changed) => {
              notify = changed;
              entered.resolve();
              return acquired.promise;
            },
          } satisfies PluginQuery<"thread">);
        },
      },
      options(),
    );
    const observing = plugin.observe(
      {
        id: "read",
        context: { ...context(), signal: abort.signal },
        access: ["thread.read", "filesystem.read"],
        agent: false,
        input: "input",
      },
      invalidate,
    );
    await entered.promise;
    notify();
    abort.abort();
    acquired.resolve(cleanup);
    const dispose = await observing;
    notify();
    await dispose();
    await plugin.stop();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("checks generation, scope, access, operation kind and payload before dispatch", async () => {
    const handler = vi.fn(async () => ({ ok: true as const, value: "document" }));
    const plugin = await activatePlugin(
      {
        activate: async (api) => {
          api.operations.register(query(handler));
        },
      },
      options(),
    );
    const request = {
      id: "read",
      kind: "query" as const,
      context: context(),
      access: ["thread.read", "filesystem.read"] as const,
      agent: true,
      input: "input",
    };
    expect(() => plugin.run({ ...request, access: ["thread.read"] })).toThrow("access_denied");
    expect(() => plugin.run({ ...request, kind: "command" })).toThrow("unknown_operation");
    expect(() =>
      plugin.run({ ...request, context: { ...context(), activationGeneration: "old" } }),
    ).toThrow("stale_generation");
    expect(() =>
      plugin.run({ ...request, context: { ...context(), scope: "environment" } }),
    ).toThrow("invalid_scope");
    expect(() => plugin.run({ ...request, input: 42 })).toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(await plugin.run(request)).toEqual({ ok: true, value: "document" });
    await plugin.stop();
    expect(() => plugin.run(request)).toThrow("inactive");
    expect(plugin.catalog().operations).toEqual([]);
  });

  it("cleans every resource after partial activation and duplicate registration", async () => {
    const cleanup = vi.fn();
    const failedCleanup = vi.fn(() => {
      throw new Error("cleanup failure");
    });
    const activation = activatePlugin(
      {
        activate: async (api) => {
          api.resources.add(cleanup);
          api.resources.add(failedCleanup);
          api.operations.register(query(async () => ({ ok: true, value: "one" })));
          api.operations.register(query(async () => ({ ok: true, value: "two" })));
        },
      },
      options(),
    );
    await expect(activation).rejects.toThrow("duplicate_registration");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(failedCleanup).toHaveBeenCalledOnce();
  });

  it("drains an actual mutation before cleanup and rejects late query results", async () => {
    const write = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const cleanup = vi.fn();
    const plugin = await activatePlugin(
      {
        activate: async (api) => {
          api.resources.add(cleanup);
          api.operations.register(
            command(async () => {
              await write.promise;
              return { ok: true, value: "committed" };
            }),
          );
          api.operations.register(
            query(async () => {
              await read.promise;
              return { ok: true, value: "stale" };
            }),
          );
        },
      },
      options(),
    );
    const request = {
      context: context(),
      access: ["thread.read", "thread.operate", "filesystem.read", "filesystem.write"] as const,
      agent: true,
      input: "input",
    };
    const writing = plugin.run({
      ...request,
      id: "write",
      kind: "command",
      operationId: "operation",
    });
    const reading = plugin.run({ ...request, id: "read", kind: "query" });
    const stopped = plugin.stop();
    expect(plugin.stop()).toBe(stopped);
    expect(cleanup).not.toHaveBeenCalled();
    read.resolve();
    await expect(reading).rejects.toThrow("inactive");
    write.resolve();
    expect(await writing).toEqual({ ok: true, value: "committed" });
    await stopped;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects broken contribution references and ignores invalidations after stop", async () => {
    await expect(
      activatePlugin(
        {
          activate: async (api) => {
            api.contributions.documentPanel({ id: "document", queryId: "missing", actions: [] });
          },
        },
        options(),
      ),
    ).rejects.toThrow("invalid_contribution_operation");
    const opts = options();
    let retained: PluginApi | undefined;
    const plugin = await activatePlugin(
      {
        activate: async (api) => {
          retained = api;
          api.operations.register(query(async () => ({ ok: true, value: "read" })));
          api.contributions.documentPanel({ id: "document", queryId: "read", actions: [] });
        },
      },
      opts,
    );
    expect(() => retained?.changed({ viewId: "document" })).toThrow("invalid_scope");
    retained?.changed({ viewId: "document", threadId: "thread" });
    await plugin.stop();
    retained?.changed({ viewId: "document", threadId: "thread" });
    expect(opts.changed).toHaveBeenCalledOnce();
  });
});
