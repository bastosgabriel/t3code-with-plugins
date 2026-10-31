export const PLUGIN_API_VERSION = 1;
export const PLUGIN_UI_VERSION = 1;

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export type JsonSchema =
  | { readonly type?: never }
  | { readonly type: "null" | "boolean" }
  | { readonly type: "string"; readonly enum?: readonly string[]; readonly maxLength?: number }
  | { readonly type: "number"; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "array"; readonly items: JsonSchema; readonly maxItems?: number }
  | {
      readonly type: "object";
      readonly properties: Readonly<Record<string, JsonSchema>>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
    };

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly uiVersion: 1;
  readonly entry: string;
}

export type PluginResult<T extends Json = Json> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly operationId?: string;
        readonly recoveryId?: string;
      };
    };

export type Dispose = () => void | Promise<void>;
export type PluginAccess =
  | "filesystem.read"
  | "filesystem.write"
  | "thread.read"
  | "thread.operate"
  | "environment.manage";
export type PluginScope = "environment" | "thread";

export interface EnvironmentContext {
  readonly scope: "environment";
  readonly environmentId: string;
  readonly activationGeneration: string;
  readonly signal: AbortSignal;
}

export interface ThreadContext extends Omit<EnvironmentContext, "scope"> {
  readonly scope: "thread";
  readonly projectId: string;
  readonly threadId: string;
  readonly projectDirectory: string;
  readonly worktreeDirectory?: string;
  readonly threadLink: string;
}

export type PluginContext<S extends PluginScope = PluginScope> = S extends "thread"
  ? ThreadContext
  : EnvironmentContext;

interface OperationDefinition<S extends PluginScope> {
  readonly id: string;
  readonly scope: S;
  readonly summary: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly requiredAccess: readonly PluginAccess[];
  readonly agent: boolean;
}

export interface PluginQuery<S extends PluginScope = PluginScope> extends OperationDefinition<S> {
  readonly kind: "query";
  readonly run: (context: PluginContext<S>, input: Json) => Promise<PluginResult>;
  readonly observe?: (
    context: PluginContext<S>,
    input: Json,
    invalidate: () => void,
  ) => Promise<Dispose>;
}

export interface PluginCommand<S extends PluginScope = PluginScope> extends OperationDefinition<S> {
  readonly kind: "command";
  readonly run: (
    context: PluginContext<S>,
    request: { readonly operationId: string; readonly input: Json },
  ) => Promise<PluginResult>;
}

export type PluginOperation =
  | PluginQuery<"environment">
  | PluginQuery<"thread">
  | PluginCommand<"environment">
  | PluginCommand<"thread">;

export type PluginAction =
  | { readonly kind: "panel"; readonly label: string; readonly panelId: string }
  | {
      readonly kind: "command";
      readonly label: string;
      readonly commandId: string;
      readonly input: Json;
    }
  | {
      readonly kind: "picker";
      readonly label: string;
      readonly queryId: string;
      readonly commandId: string;
      readonly input: Json;
    };

export interface ThreadItemContribution {
  readonly id: string;
  readonly label: string;
  readonly queryId: string;
  readonly panelId: string;
}

export type PluginThreadItemState = {
  label: string;
  action?: PluginAction;
  actions?: readonly PluginAction[];
};

export interface DocumentPanelContribution {
  readonly id: string;
  readonly queryId: string;
  readonly actions: readonly PluginAction[];
}

export type SettingField = {
  readonly key: string;
  readonly label: string;
  readonly help?: string;
} & (
  | { readonly type: "text" | "boolean" }
  | { readonly type: "enum"; readonly options: readonly string[] }
);

export interface SettingsContribution {
  readonly id: string;
  readonly label: string;
  readonly queryId: string;
  readonly commandId: string;
  readonly fields: readonly SettingField[];
}

export type PluginDocument = {
  title: string;
  properties: { [key: string]: Json };
  markdown: string;
  revision: string;
  actionInputs?: { [commandId: string]: Json };
};

export type PluginPickerPage = {
  items: { key: string; label: string; detail: string }[];
  nextCursor: string | null;
};

export interface PluginApi {
  readonly version: 1;
  readonly operations: { readonly register: (operation: PluginOperation) => Dispose };
  readonly contributions: {
    readonly threadItem: (contribution: ThreadItemContribution) => Dispose;
    readonly documentPanel: (contribution: DocumentPanelContribution) => Dispose;
    readonly settings: (contribution: SettingsContribution) => Dispose;
  };
  readonly resources: { readonly add: (dispose: Dispose) => Dispose };
  readonly storage: { readonly configDirectory: string; readonly durableDirectory: string };
  readonly changed: (target: { readonly viewId: string; readonly threadId?: string }) => void;
  readonly log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface PluginModule {
  readonly activate: (api: PluginApi) => Promise<void>;
}
