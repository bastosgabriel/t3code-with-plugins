import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { Atom } from "effect/reactivity";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ command: vi.fn(), query: vi.fn(), allowed: true }));
vi.mock(import("../../state/entities"), () => ({
  useServerConfigs: (() =>
    new Map([["env", { environment: { capabilities: { pluginApiV1: true } } }]])) as never,
}));
vi.mock(import("../../state/query"), () => ({ useEnvironmentQuery: state.query }));
vi.mock(
  import("../../state/plugins"),
  () =>
    ({
      pluginEnvironment: {
        catalog: () => "catalog",
        query: (args: unknown) => args,
        liveQuery: (args: unknown) => args,
        command: { permissionAtom: () => Atom.make(state.allowed) },
      },
    }) as never,
);
vi.mock(import("../../state/use-atom-command"), () => ({ useAtomCommand: () => state.command }));
vi.mock(import("../ChatMarkdown"), () => ({ default: (() => null) as never }));
import { PluginThreadItems } from "./PluginViews";

function setup() {
  state.allowed = true;
  state.command.mockReset();
  state.query.mockReset();
}

it("opens the primary picker directly and keeps options and linked-ticket details separate", async () => {
  setup();
  state.command.mockResolvedValue({
    _tag: "Success",
    value: {
      ok: false,
      error: { code: "binding_conflict", message: "Binding changed; select again." },
    },
  });
  let catalogError: string | null = null;
  const action = {
    kind: "picker",
    label: "Select ticket",
    queryId: "ticket.search",
    commandId: "binding.set",
    input: {},
  };
  let linked = false;
  state.query.mockImplementation((request: unknown) => ({
    isPending: false,
    error: request === "catalog" ? catalogError : null,
    refresh: () => {},
    data:
      request === "catalog"
        ? {
            plugins: [
              {
                pluginId: "tickets",
                generation: "one",
                contributions: {
                  operations: [{ id: "binding.set", kind: "command" }],
                  settings: [],
                  threadItems: [
                    { id: "ticket", label: "Ticket", queryId: "binding.get", panelId: "ticket" },
                  ],
                  documentPanels: [{ id: "ticket", queryId: "ticket.read", actions: [] }],
                },
              },
            ],
          }
        : {
            ok: true,
            value:
              (request as { input?: { operation?: string } })?.input?.operation === "ticket.search"
                ? {
                    items: [{ key: "verified-key", label: "T-1 · Fixture", detail: "board" }],
                    nextCursor: null,
                  }
                : {
                    label: linked ? "T-1 · Fixture" : "No ticket linked",
                    action: linked ? { kind: "panel", label: "Ticket", panelId: "ticket" } : action,
                    actions: [action],
                  },
          },
  }));
  await using screen = await render(
    <PluginThreadItems
      threadRef={{ environmentId: "env", threadId: "thread" } as ScopedThreadRef}
    />,
  );
  await screen.getByRole("button", { name: "Ticket", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Select ticket", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: /T-1/ })).toBeVisible();
  expect(state.command).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  const arrow =
    screen.container.querySelector("[data-slot=select-icon]") ??
    screen.getByRole("button", { name: "Ticket options" }).element();
  await userEvent.click(arrow);
  await expect.element(page.getByRole("menu")).toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.command).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Ticket options" }).click();
  await page.getByRole("menuitem", { name: "Select ticket" }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Select ticket", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("dialog", { name: "Ticket", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: /T-1/ }).click();
  await expect
    .element(page.getByRole("dialog").getByRole("alert"))
    .toHaveTextContent("Binding changed; select again.");
  expect(state.command).toHaveBeenCalledTimes(1);
  expect(state.command.mock.calls[0]?.[0].input).toMatchObject({
    threadId: "thread",
    operation: "binding.set",
    input: { key: "verified-key" },
  });
  linked = true;
  state.allowed = false;
  await screen.rerender(
    <PluginThreadItems
      threadRef={{ environmentId: "env", threadId: "other" } as ScopedThreadRef}
    />,
  );
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Ticket options" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Select ticket" }))
    .toHaveAttribute("aria-disabled", "true");
  expect(state.command).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await screen.getByRole("button", { name: "Ticket", exact: true }).click();
  await expect.element(page.getByRole("dialog", { name: "Ticket", exact: true })).toBeVisible();
  catalogError = "Plugin catalog unavailable";
  await screen.rerender(
    <PluginThreadItems
      threadRef={{ environmentId: "env", threadId: "other" } as ScopedThreadRef}
    />,
  );
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Ticket options" }))
    .not.toBeInTheDocument();
});
