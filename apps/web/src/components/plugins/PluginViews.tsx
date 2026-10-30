import { useServerConfigs } from "../../state/entities";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import {
  PluginDocument,
  PluginPickerPage,
  PluginThreadItemState,
  type PluginAction,
  type PluginCatalog,
  type PluginCallInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { PuzzleIcon } from "lucide-react";
import { pluginEnvironment } from "../../state/plugins";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";
import ChatMarkdown from "../ChatMarkdown";

type Plugin = PluginCatalog["plugins"][number];
const decodeDocument = Schema.decodeUnknownOption(PluginDocument);
const decodePicker = Schema.decodeUnknownOption(PluginPickerPage);
const decodeLabel = Schema.decodeUnknownOption(PluginThreadItemState);
const record = (value: Schema.Json): { readonly [key: string]: Schema.Json } =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { readonly [key: string]: Schema.Json })
    : {};
function usePluginCatalog(threadRef: ScopedThreadRef | null) {
  const configs = useServerConfigs();
  const supported =
    threadRef &&
    configs.get(threadRef.environmentId)?.environment.capabilities?.pluginApiV1 === true;
  return useEnvironmentQuery(
    supported && threadRef
      ? pluginEnvironment.catalog({
          environmentId: threadRef.environmentId,
          input: { ...threadRef, uiVersion: 1 },
        })
      : null,
  );
}
const call = (
  threadRef: ScopedThreadRef,
  plugin: Plugin,
  operation: string,
  input: Schema.Json = {},
): PluginCallInput => ({
  ...threadRef,
  uiVersion: 1,
  pluginId: plugin.pluginId,
  generation: plugin.generation,
  operation,
  input,
});

export function usePluginSurfaceActions(threadRef: ScopedThreadRef | null) {
  const catalog = usePluginCatalog(threadRef);
  const [selection, setSelection] = useState<{
    threadRef: ScopedThreadRef;
    plugin: Plugin;
    item: Plugin["contributions"]["threadItems"][number];
  } | null>(null);
  const sameThread =
    selection?.threadRef.environmentId === threadRef?.environmentId &&
    selection?.threadRef.threadId === threadRef?.threadId;
  if (selection && !sameThread) setSelection(null);
  const activePlugin = catalog.data?.plugins.find(
    (plugin) =>
      plugin.pluginId === selection?.plugin.pluginId &&
      plugin.generation === selection.plugin.generation,
  );
  const dialog =
    selection && sameThread ? (
      <PluginSurfaceSelection
        key={`${selection.threadRef.environmentId}:${selection.threadRef.threadId}:${selection.plugin.generation}:${selection.item.id}`}
        threadRef={selection.threadRef}
        plugin={activePlugin ?? null}
        item={selection.item}
        unavailable={catalog.error !== null || !activePlugin}
        onClose={() => setSelection(null)}
      />
    ) : null;
  if (!threadRef) return { actions: [], dialog: null };
  const actions =
    catalog.data?.plugins.flatMap((plugin) =>
      plugin.contributions.threadItems.map((item) => ({
        label: item.label,
        icon: PuzzleIcon,
        shortcut: "",
        available:
          !catalog.error &&
          plugin.contributions.documentPanels.some((panel) => panel.id === item.panelId),
        disabledReason: "This plugin panel is unavailable. Check Plugins in Settings.",
        onClick: () => setSelection({ threadRef, plugin, item }),
      })),
    ) ?? [];
  return {
    dialog,
    actions:
      actions.length > 0
        ? actions
        : [
            {
              label: catalog.isPending ? "Loading plugins…" : "Plugins unavailable",
              icon: PuzzleIcon,
              shortcut: "",
              available: false,
              disabledReason:
                catalog.error ?? "Check Plugins in Settings and your environment permissions.",
              onClick: () => {},
            },
          ],
  };
}

function PluginSurfaceSelection({
  threadRef,
  plugin,
  item,
  unavailable,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  plugin: Plugin | null;
  item: Plugin["contributions"]["threadItems"][number];
  unavailable: boolean;
  onClose: () => void;
}) {
  const [resolved, setResolved] = useState<PluginThreadItemState | null>(null);
  const query = useEnvironmentQuery(
    plugin && !unavailable && !resolved
      ? pluginEnvironment.query({
          environmentId: threadRef.environmentId,
          input: call(threadRef, plugin, item.queryId),
        })
      : null,
  );
  const state = unavailable
    ? null
    : (resolved ??
      (!query.isPending && !query.error && query.data?.ok
        ? Option.getOrNull(decodeLabel(query.data.value))
        : null));
  if (state && !resolved) setResolved(state);
  const action =
    state?.action ??
    (state ? { kind: "panel" as const, panelId: item.panelId, label: item.label } : null);
  const panel =
    action?.kind === "panel" &&
    plugin?.contributions.documentPanels.some((candidate) => candidate.id === action.panelId)
      ? action
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves the requested plugin navigation into the external right-panel store
  useEffect(() => {
    if (!panel || !plugin) return;
    useRightPanelStore.getState().openPlugin(threadRef, {
      pluginId: plugin.pluginId,
      panelId: panel.panelId,
      title: item.label,
    });
    onClose();
  }, [panel, plugin, threadRef, item.label, onClose]);
  if (panel) return null;
  if (action?.kind === "picker" && plugin)
    return (
      <PluginActionControl
        threadRef={threadRef}
        plugin={plugin}
        action={action}
        input={action.input}
        initialOpen
        onClose={onClose}
        onError={() => {}}
        onComplete={() => {
          useRightPanelStore.getState().openPlugin(threadRef, {
            pluginId: plugin.pluginId,
            panelId: item.panelId,
            title: item.label,
          });
          onClose();
        }}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{item.label}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p role="status">
            {unavailable
              ? "This plugin is unavailable."
              : (query.error ??
                (query.data?.ok === false
                  ? query.data.error.message
                  : query.isPending
                    ? "Loading…"
                    : "The plugin returned an invalid navigation action."))}
          </p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function PluginThreadItems({ threadRef }: { threadRef: ScopedThreadRef }) {
  const catalog = usePluginCatalog(threadRef);
  return (
    <ThreadDetailsSection headingId="plugin-thread-items" title="Plugins" showHeading={false}>
      <div>
        {catalog.data?.plugins.flatMap((plugin) =>
          plugin.contributions.threadItems.map((item) => (
            <PluginThreadItem
              key={`${threadRef.environmentId}:${threadRef.threadId}:${plugin.pluginId}:${plugin.generation}:${item.id}`}
              threadRef={threadRef}
              plugin={plugin}
              item={item}
            />
          )),
        )}
        {(catalog.error ||
          !catalog.data?.plugins.some((plugin) => plugin.contributions.threadItems.length > 0)) && (
          <p role="status" className="px-2.5 text-xs text-muted-foreground">
            {catalog.isPending
              ? "Loading plugins…"
              : "Plugins unavailable. Check Plugins in Settings and your environment permissions."}
          </p>
        )}
      </div>
    </ThreadDetailsSection>
  );
}
function PluginThreadItem({
  threadRef,
  plugin,
  item,
}: {
  threadRef: ScopedThreadRef;
  plugin: Plugin;
  item: Plugin["contributions"]["threadItems"][number];
}) {
  const query = useEnvironmentQuery(
    pluginEnvironment.liveQuery({
      environmentId: threadRef.environmentId,
      input: call(threadRef, plugin, item.queryId),
    }),
  );
  const label =
    !query.error && query.data?.ok ? Option.getOrNull(decodeLabel(query.data.value))?.label : null;
  const [open, setOpen] = useState(false);
  return (
    <>
      <ThreadDetailsControl part="select" multiline onClick={() => setOpen(true)}>
        <PuzzleIcon className="size-4 shrink-0" />
        <span className="min-w-0 text-left">
          <span className="block">{item.label}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {label ?? (query.isPending ? "Loading…" : "Unavailable")}
          </span>
        </span>
      </ThreadDetailsControl>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{item.label}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                useRightPanelStore.getState().openPlugin(threadRef, {
                  pluginId: plugin.pluginId,
                  panelId: item.panelId,
                  title: item.label,
                });
              }}
            >
              Open in side panel
            </Button>
            {open && (
              <PluginDocumentPanel
                threadRef={threadRef}
                pluginId={plugin.pluginId}
                panelId={item.panelId}
              />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function PluginDocumentPanel({
  threadRef,
  pluginId,
  panelId,
}: {
  threadRef: ScopedThreadRef;
  pluginId: string;
  panelId: string;
}) {
  const catalog = usePluginCatalog(threadRef);
  const plugin = catalog.data?.plugins.find((candidate) => candidate.pluginId === pluginId);
  const panel = plugin?.contributions.documentPanels.find((candidate) => candidate.id === panelId);
  if (catalog.error || !plugin || !panel)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {catalog.isPending
          ? "Loading plugin…"
          : "This plugin panel is unavailable. Check Plugins in Settings."}
      </div>
    );
  return (
    <DocumentContent
      key={`${threadRef.environmentId}:${threadRef.threadId}:${plugin.pluginId}:${plugin.generation}:${panel.id}`}
      threadRef={threadRef}
      plugin={plugin}
      panel={panel}
    />
  );
}
function DocumentContent({
  threadRef,
  plugin,
  panel,
}: {
  threadRef: ScopedThreadRef;
  plugin: Plugin;
  panel: Plugin["contributions"]["documentPanels"][number];
}) {
  const query = useEnvironmentQuery(
    pluginEnvironment.liveQuery({
      environmentId: threadRef.environmentId,
      input: call(threadRef, plugin, panel.queryId),
    }),
  );
  const document =
    !query.error && query.data?.ok ? Option.getOrNull(decodeDocument(query.data.value)) : null;
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {panel.actions.map((action) => (
          <PluginActionControl
            key={`${action.kind}:${action.label}`}
            threadRef={threadRef}
            plugin={plugin}
            action={action}
            input={
              action.kind === "command"
                ? (document?.actionInputs?.[action.commandId] ?? action.input)
                : {}
            }
            onError={setActionError}
            onComplete={() => {
              setActionError(null);
              query.refresh();
            }}
          />
        ))}
      </div>
      {actionError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {actionError}
        </p>
      )}
      {document ? (
        <>
          <h2 className="mb-3 text-lg font-semibold">{document.title}</h2>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {Object.entries(document.properties).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="break-words">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
          <ChatMarkdown
            text={document.markdown}
            cwd={undefined}
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            parseRawHtml={false}
          />
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {query.error ??
            (query.data?.ok === false
              ? query.data.error.message
              : query.isPending
                ? "Loading document…"
                : "The plugin returned an invalid document.")}
        </p>
      )}
    </div>
  );
}
function PluginActionControl({
  threadRef,
  plugin,
  action,
  input,
  onComplete,
  onError,
  initialOpen = false,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  plugin: Plugin;
  action: PluginAction;
  input: Schema.Json;
  onComplete: () => void;
  onError: (message: string | null) => void;
  initialOpen?: boolean;
  onClose?: () => void;
}) {
  const canOperate = useAtomValue(
    pluginEnvironment.command.permissionAtom(threadRef.environmentId),
  );
  const command = useAtomCommand(pluginEnvironment.command);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(initialOpen);
  const active = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ignores asynchronous command completion after the initiating thread or plugin view unmounts
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const available =
    action.kind === "panel" ||
    plugin.contributions.operations.some(
      (operation) => operation.id === action.commandId && operation.kind === "command",
    );
  const execute = async (value: Schema.Json) => {
    if (action.kind === "panel" || busy || !available || !canOperate) return;
    setBusy(true);
    onError(null);
    setError(null);
    const result = await command({
      environmentId: threadRef.environmentId,
      input: { ...call(threadRef, plugin, action.commandId, value), operationId: randomUUID() },
    });
    if (!active.current) return;
    setBusy(false);
    const failure =
      result._tag === "Failure"
        ? String(squashAtomCommandFailure(result))
        : result.value.ok
          ? null
          : result.value.error.message;
    if (failure) {
      setError(failure);
      onError(failure);
    } else {
      setOpen(false);
      onComplete();
    }
  };
  return (
    <div>
      {!initialOpen && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !available || (action.kind !== "panel" && !canOperate)}
          onClick={() => {
            if (action.kind === "panel")
              useRightPanelStore.getState().openPlugin(threadRef, {
                pluginId: plugin.pluginId,
                panelId: action.panelId,
                title: action.label,
              });
            else if (action.kind === "picker") setOpen(true);
            else void execute(input);
          }}
        >
          {action.label}
        </Button>
      )}
      {action.kind === "picker" && (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) onClose?.();
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{action.label}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {(!canOperate || !available) && (
                <p role="status">
                  {!canOperate
                    ? "You do not have permission to perform this action in this environment."
                    : "This plugin action is unavailable."}
                </p>
              )}
              {error && (
                <p role="alert" className="mb-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              {open && (
                <PluginPicker
                  threadRef={threadRef}
                  plugin={plugin}
                  action={action}
                  busy={busy || !canOperate || !available}
                  onSelect={(key) => {
                    void execute({ ...record(action.input), key });
                  }}
                />
              )}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
function PluginPicker({
  threadRef,
  plugin,
  action,
  busy,
  onSelect,
}: {
  threadRef: ScopedThreadRef;
  plugin: Plugin;
  action: Extract<PluginAction, { kind: "picker" }>;
  busy: boolean;
  onSelect: (key: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const query = useEnvironmentQuery(
    pluginEnvironment.query({
      environmentId: threadRef.environmentId,
      input: call(threadRef, plugin, action.queryId, {
        ...record(action.input),
        search,
        ...(cursor === null ? {} : { cursor }),
      }),
    }),
  );
  const page =
    !query.error && !query.isPending && query.data?.ok
      ? Option.getOrNull(decodePicker(query.data.value))
      : null;
  return (
    <div className="space-y-3">
      <Input
        aria-label="Search"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setCursor(null);
        }}
      />
      <div className="max-h-80 space-y-1 overflow-auto">
        {page?.items.map((item) => (
          <div key={item.key} className="grid min-w-0">
            <Button
              variant="ghost"
              size="sm-multiline"
              disabled={busy || query.isPending}
              onClick={() => onSelect(item.key)}
            >
              <span className="min-w-0 text-left">
                <span className="block break-words">{item.label}</span>
                <span className="block break-all text-muted-foreground">{item.detail}</span>
              </span>
            </Button>
          </div>
        ))}
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {query.error ??
          (query.data?.ok === false
            ? query.data.error.message
            : query.isPending
              ? "Searching…"
              : page?.items.length === 0
                ? "No results."
                : "")}
      </p>
      {page?.nextCursor && (
        <Button variant="outline" onClick={() => setCursor(page.nextCursor)}>
          Next page
        </Button>
      )}
    </div>
  );
}
