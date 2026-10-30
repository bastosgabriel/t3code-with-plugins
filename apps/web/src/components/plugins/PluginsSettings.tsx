import { useServerConfigs } from "../../state/entities";
import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type PluginAdminInput, type PluginCatalog } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type * as Schema from "effect/Schema";
import { useState } from "react";
import { pluginEnvironment } from "../../state/plugins";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { useSettingsScope } from "../settings/SettingsScopeContext";

type Plugin = PluginCatalog["plugins"][number];
export function PluginsSettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const selected =
    environment ?? (connectedEnvironments.length === 1 ? connectedEnvironments[0] : undefined);
  const configs = useServerConfigs();
  const supported =
    selected && configs.get(selected.environmentId)?.environment.capabilities?.pluginApiV1 === true;
  return (
    <SettingsPageContainer>
      {selected && supported ? (
        <PluginManagement key={selected.environmentId} environmentId={selected.environmentId} />
      ) : (
        <p>
          {selected
            ? "This environment does not support plugin API v1. Update its server to use plugins."
            : "Choose a connected environment to manage its plugins."}
        </p>
      )}
    </SettingsPageContainer>
  );
}
function PluginManagement({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(pluginEnvironment.list({ environmentId, input: {} }));
  const catalog = useEnvironmentQuery(
    pluginEnvironment.catalog({ environmentId, input: { environmentId, uiVersion: 1 } }),
  );
  const allowed = useAtomValue(pluginEnvironment.manage.permissionAtom(environmentId));
  const manage = useAtomCommand(pluginEnvironment.manage);
  const [directory, setDirectory] = useState("");
  const [clearConfiguration, setClearConfiguration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execute = async (input: PluginAdminInput) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await manage({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    query.refresh();
    catalog.refresh();
  };
  return (
    <>
      <SettingsSection title="Plugins" id="plugins">
        <p className="text-sm text-muted-foreground">
          Install a local plugin folder on this environment. Plugins run with the server's
          filesystem access; install only code you trust. Updates and rollbacks take effect after
          you restart the server.
        </p>
        <div className="mt-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
              aria-label="Plugin folder"
              placeholder="Plugin folder on the server"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
            />
          </div>
          <Button
            disabled={!allowed || busy || !directory.trim()}
            onClick={() => {
              void execute({ action: "install", directory: directory.trim() });
            }}
          >
            Install
          </Button>
        </div>
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error ?? query.error}
        </p>
        {(query.data ?? []).map((installed) => (
          <div key={installed.manifest.id} className="mt-4 space-y-2 rounded-md border p-3">
            <h3 className="font-medium">
              {installed.manifest.name}{" "}
              <span className="text-muted-foreground">{installed.manifest.version}</span>
            </h3>
            <p className="text-sm text-muted-foreground">
              {installed.active ? "Active" : installed.enabled ? "Activation failed" : "Disabled"}
              {installed.pendingVersion ? ` · ${installed.pendingVersion} pending restart` : ""}
              {installed.error ? ` · ${installed.error}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!allowed || busy}
                onClick={() => {
                  void execute({
                    action: installed.enabled ? "disable" : "enable",
                    pluginId: installed.manifest.id,
                  });
                }}
              >
                {installed.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!allowed || busy}
                onClick={() => {
                  void execute({ action: "rollback", pluginId: installed.manifest.id });
                }}
              >
                Stage rollback
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!allowed || busy}
                onClick={() => {
                  void execute({
                    action: "remove",
                    pluginId: installed.manifest.id,
                    clearConfiguration,
                  });
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        <label className="mt-4 flex items-center gap-2 text-sm">
          <Switch checked={clearConfiguration} onCheckedChange={setClearConfiguration} />
          Also delete plugin settings when removing. Plugin data is always kept.
        </label>
      </SettingsSection>
      {catalog.data?.plugins.flatMap((plugin) =>
        plugin.contributions.settings.map((settings) => (
          <PluginSettingsForm
            key={`${plugin.pluginId}:${plugin.generation}:${settings.id}`}
            environmentId={environmentId}
            plugin={plugin}
            settings={settings}
          />
        )),
      )}
    </>
  );
}
function PluginSettingsForm({
  environmentId,
  plugin,
  settings,
}: {
  environmentId: EnvironmentId;
  plugin: Plugin;
  settings: Plugin["contributions"]["settings"][number];
}) {
  const query = useEnvironmentQuery(
    pluginEnvironment.query({
      environmentId,
      input: {
        environmentId,
        uiVersion: 1,
        pluginId: plugin.pluginId,
        generation: plugin.generation,
        operation: settings.queryId,
        input: {},
      },
    }),
  );
  const value = query.data?.ok ? query.data.value : null;
  const data =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { readonly [key: string]: Schema.Json })
      : null;
  return (
    <SettingsSection title={settings.label}>
      {data ? (
        <SettingsEditor
          key={JSON.stringify(data)}
          environmentId={environmentId}
          plugin={plugin}
          settings={settings}
          data={data}
          onSave={query.refresh}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {query.error ??
            (query.data?.ok === false ? query.data.error.message : "Loading settings…")}
        </p>
      )}
    </SettingsSection>
  );
}
function SettingsEditor({
  environmentId,
  plugin,
  settings,
  data,
  onSave,
}: {
  environmentId: EnvironmentId;
  plugin: Plugin;
  settings: Plugin["contributions"]["settings"][number];
  data: { readonly [key: string]: Schema.Json };
  onSave: () => void;
}) {
  const [draft, setDraft] = useState(data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useAtomValue(pluginEnvironment.command.permissionAtom(environmentId));
  const command = useAtomCommand(pluginEnvironment.command);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await command({
      environmentId,
      input: {
        environmentId,
        uiVersion: 1,
        pluginId: plugin.pluginId,
        generation: plugin.generation,
        operation: settings.commandId,
        operationId: randomUUID(),
        input: draft,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else if (!result.value.ok) setError(result.value.error.message);
    else onSave();
  };
  return (
    <div className="space-y-3">
      {settings.fields.map((field) => (
        <label key={field.key} className="block space-y-1 text-sm">
          <span>{field.label}</span>
          {field.type === "boolean" ? (
            <Switch
              checked={draft[field.key] === true}
              onCheckedChange={(checked) => setDraft({ ...draft, [field.key]: checked })}
            />
          ) : field.type === "enum" ? (
            <div className="flex flex-wrap gap-2">
              {field.options?.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={draft[field.key] === option ? "default" : "outline"}
                  onClick={() => setDraft({ ...draft, [field.key]: option })}
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : (
            <Input
              value={typeof draft[field.key] === "string" ? String(draft[field.key]) : ""}
              onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
            />
          )}
          {field.help && <span className="text-muted-foreground">{field.help}</span>}
        </label>
      ))}
      <Button
        disabled={
          !allowed ||
          busy ||
          !plugin.contributions.operations.some((operation) => operation.id === settings.commandId)
        }
        onClick={() => {
          void save();
        }}
      >
        Save settings
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
