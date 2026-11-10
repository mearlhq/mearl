import type { ProviderAction } from './actions.js';
import type {
  BrowserCapabilities,
  BrowserControlSessionMode,
  ProviderEnhancementTarget,
  BrowserProviderOperation,
  BrowserControlParams,
  ExternalBrowserControlResult,
} from '@mearl/browser-core';

export { MEARL_PROVIDER_PROTOCOL_VERSION } from './protocol.js';

export type { ProviderAction } from './actions.js';
export type {
  BrowserEnhancementInvocation,
  ProviderEnhancementBinding,
  ProviderEnhancementTarget,
} from '@mearl/browser-core';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ProviderScreenshotKind = 'native' | 'reconstructed' | 'none';

export interface ProviderCapabilities extends BrowserCapabilities {}

/** Completed download staged on the local Provider process host for Mearl transfer. */
export interface ProviderDownloadResult {
  filename: string;
  filePath: string;
  action: JsonValue;
  /** Allows Mearl to remove the staged file after importing it. */
  owned?: boolean;
}

export interface ProviderPairingInfo {
  kind: 'qr';
  url: string;
  code?: string;
  label?: string;
}

export interface ProviderDescriptor {
  providerId: string;
  name: string;
  version: string;
  protocolVersion?: number;
  builtin?: boolean;
}

export type ProviderInputComponent = 'cookie-sync' | 'switch';

export interface ProviderInputVisibility {
  field: string;
  empty: boolean;
}

interface ProviderSchemaBase {
  title?: string;
  description?: string;
  default?: JsonValue;
  /** Optional Mearl form component used to edit this schema value. */
  component?: ProviderInputComponent;
  /** Presentation-only default used by Mearl forms without changing runtime semantics. */
  formDefault?: JsonValue;
  /** Excludes an advanced runtime option from generated Mearl forms. */
  formHidden?: boolean;
  /** Places compact fields side by side in generated Mearl forms. */
  formWidth?: 'half' | 'full';
  /** Hides the optional badge without changing schema validation. */
  formHideOptional?: boolean;
  /** Conditionally displays and submits this field based on another form value. */
  formVisibleWhen?: ProviderInputVisibility;
}

export interface ProviderStringSchema extends ProviderSchemaBase {
  type: 'string';
  secret?: boolean;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  options?: readonly ProviderInputOption[];
}

export interface ProviderInputOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ProviderLaunchFormRequest {
  variant?: string;
  values: JsonObject;
}

export interface ProviderLaunchFormVariant {
  id: string;
  title: string;
  description?: string;
  inputSchema?: ProviderObjectSchema;
  values?: JsonObject;
  refreshOn?: readonly string[];
  dynamicFields?: readonly string[];
}

/** Read-only presentation data; values are fixed launch parameters, never credentials. */
export interface ProviderLaunchForm {
  inputSchema: ProviderObjectSchema;
  variants?: readonly ProviderLaunchFormVariant[];
  variant?: string;
  values?: JsonObject;
  refreshOn?: readonly string[];
  dynamicFields?: readonly string[];
  message?: string;
  blocked?: boolean;
}

export interface ProviderNumberSchema extends ProviderSchemaBase {
  type: 'number';
  integer?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface ProviderBooleanSchema extends ProviderSchemaBase {
  type: 'boolean';
}

export interface ProviderArraySchema extends ProviderSchemaBase {
  type: 'array';
  items: ProviderInputSchema;
  minItems?: number;
  maxItems?: number;
}

export interface ProviderObjectSchema extends ProviderSchemaBase {
  type: 'object';
  properties: Record<string, ProviderInputSchema>;
  required?: readonly string[];
  oneOf?: readonly ProviderObjectSchema[];
  not?: ProviderObjectSchema;
  additionalProperties?: boolean;
}

export type ProviderInputSchema =
  | ProviderStringSchema
  | ProviderNumberSchema
  | ProviderBooleanSchema
  | ProviderArraySchema
  | ProviderObjectSchema;

export interface ProviderConfigurationDefinition {
  inputSchema: ProviderObjectSchema;
}

export interface ProviderBrowserType {
  name: string;
  /** Host must support every listed mode before launch. Omitted means Mearl only. */
  controlSessionModes?: readonly BrowserControlSessionMode[];
  documentationUrl?: string;
  /** Provider-owned usage guidance rendered by `mearl <providerId>`. */
  help?: readonly string[];
  inputSchema: ProviderObjectSchema;
  configuration?: ProviderConfigurationDefinition;
  dynamicLaunchForm?: boolean;
  launchForm?: ProviderLaunchForm;
}

export type ProviderBrowserStatus = 'connected' | 'pairing' | 'running_disconnected' | 'stopped';
export type ProviderOwnership = 'owned' | 'attached';
export type ProviderPersistence = 'ephemeral' | 'persistent';
export type ProviderBrowserOperation = BrowserProviderOperation;

export type ProviderBrowserControl =
  | {
      kind: 'provider';
      capabilities: ProviderCapabilities;
    }
  | {
      kind: 'host';
      transport: 'extension' | 'cdp';
      browserId: string;
      capabilities?: ProviderCapabilities;
    }
  | { kind: 'none' };

/** Common safe metadata; additional Provider-specific keys must also be non-secret JSON. */
export type ProviderBrowserDetails = JsonObject & {
  headless?: boolean;
  createdAt?: string;
  cdpPort?: number;
  copiedCookies?: { domains: string[]; count: number };
};

export interface ProviderBrowserReference {
  kind: string;
  id: string;
  label?: string;
}

export interface ProviderBrowser {
  /** Stable within this provider. Mearl adds the Provider namespace globally. */
  browserId: string;
  name: string;
  status: ProviderBrowserStatus;
  control: ProviderBrowserControl;
  ownership?: ProviderOwnership;
  persistence: ProviderPersistence;
  operations: ProviderBrowserOperation[];
  lastFocusedAt?: number;
  pairing?: ProviderPairingInfo;
  references?: ProviderBrowserReference[];
  /** Safe, non-secret metadata suitable for browser_list and remote connectors. */
  details?: ProviderBrowserDetails;
}

export interface InstalledProviderManifest extends ProviderDescriptor {
  /** Default extension Agent access off in these natively identified browser apps. */
  extensionAgentDefault?: { macBundleIds: string[] };
  protocolVersion: number;
  browserType: ProviderBrowserType;
  packageName: string;
  packageRoot: string;
  entryPath: string;
}

export interface ProviderPackageMetadata {
  extensionAgentDefault?: { macBundleIds: string[] };
  providerId: string;
  name: string;
  protocolVersion: number;
  entry: string;
  browserType: ProviderBrowserType;
}

export interface ProviderActionRequest {
  id: string;
  action: string;
  data?: JsonObject;
  /** Provider-local browser id selected by the Mearl client. */
  browserId?: string;
  version?: string;
  protocolVersion: number;
  /** Absolute caller deadline, outside Provider business options. */
  deadline?: number;
  controlSource?: string;
  host?: ProviderHostContextData;
}

export interface ProviderActionContext {
  browserId: string;
  action: ProviderAction;
  data: JsonObject;
  controlSource?: string;
  deadline?: number;
}

export interface ProviderHostServices {
  request<T = JsonValue>(method: string, data?: JsonObject): Promise<T>;
}

/** Host-derived launch data carried over the local Provider protocol. */
export interface ProviderHostContextData {
  cookies?: JsonObject[];
  userAgent?: string;
}

export interface ProviderContext {
  host?: ProviderHostServices;
  controlSource?: string;
  deadline?: number;
}

export interface ProviderInstanceRequest {
  browserId: string;
}

export interface ProviderCloseRequest extends ProviderInstanceRequest {
  deleteData?: boolean;
}

export interface ProviderSyncCookiesRequest extends ProviderInstanceRequest {
  scope: JsonObject;
}

export interface ProviderAccess {
  kind: string;
  url: string;
  sensitive: true;
}

export interface BrowserProviderDefinition {
  descriptor: ProviderDescriptor;
  browserType: ProviderBrowserType;
  listBrowsers?: (context: ProviderContext) => ProviderBrowser[] | Promise<ProviderBrowser[]>;
  launch: (options: JsonObject, context: ProviderContext) => Promise<ProviderBrowser>;
  start?: (request: ProviderInstanceRequest, context: ProviderContext) => Promise<ProviderBrowser>;
  close: (request: ProviderCloseRequest, context: ProviderContext) => Promise<unknown>;
  /** Explicit lifecycle control for external task owners; never creates a Mearl session. */
  control?: (
    request: ProviderInstanceRequest & BrowserControlParams,
    context: ProviderContext,
  ) => Promise<ExternalBrowserControlResult>;
  detach?: (request: ProviderInstanceRequest, context: ProviderContext) => Promise<unknown>;
  syncCookies?: (request: ProviderSyncCookiesRequest, context: ProviderContext) => Promise<unknown>;
  getAccess?: (
    request: ProviderInstanceRequest,
    context: ProviderContext,
  ) => Promise<ProviderAccess>;
  configure?: (options: JsonObject, context: ProviderContext) => Promise<unknown>;
  getLaunchForm?: (
    request: ProviderLaunchFormRequest,
    context: ProviderContext,
  ) => Promise<ProviderLaunchForm>;
  /** Reentrant read-only preflight: must reflect current control and identity without claiming a page. */
  getEnhancementTarget?: (
    request: ProviderInstanceRequest & { tabId: number },
    context: ProviderContext,
  ) => Promise<ProviderEnhancementTarget>;
  handleAction?: (context: ProviderActionContext) => Promise<unknown>;
}

export interface ProviderRuntime {
  readonly definition: BrowserProviderDefinition;
  listBrowsers(context?: ProviderContext): Promise<ProviderBrowser[]>;
  updateBrowsers(browsers: ProviderBrowser[]): void;
  launch(options: JsonObject, context?: ProviderContext): Promise<ProviderBrowser>;
  start(request: ProviderInstanceRequest, context?: ProviderContext): Promise<ProviderBrowser>;
  close(request: ProviderCloseRequest, context?: ProviderContext): Promise<unknown>;
  control(
    request: ProviderInstanceRequest & BrowserControlParams,
    context?: ProviderContext,
  ): Promise<ExternalBrowserControlResult>;
  detach(request: ProviderInstanceRequest, context?: ProviderContext): Promise<unknown>;
  syncCookies(request: ProviderSyncCookiesRequest, context?: ProviderContext): Promise<unknown>;
  getAccess(request: ProviderInstanceRequest, context?: ProviderContext): Promise<ProviderAccess>;
  configure(options: JsonObject, context?: ProviderContext): Promise<unknown>;
  getLaunchForm(
    request: ProviderLaunchFormRequest,
    context?: ProviderContext,
  ): Promise<ProviderLaunchForm>;
  invokeAction(context: ProviderActionContext): Promise<unknown>;
  getEnhancementTarget?(
    request: ProviderInstanceRequest & { tabId: number },
    context?: ProviderContext,
  ): Promise<ProviderEnhancementTarget>;
}

export interface ProviderServerOptions {
  definition: BrowserProviderDefinition;
  socketPath?: string;
}

export interface ProviderServer {
  readonly socketPath: string;
  readonly runtime: ProviderRuntime;
  start(): Promise<void>;
  updateBrowsers(browsers: ProviderBrowser[]): void;
  touchBrowser(browserId: string): void;
  stop(): Promise<void>;
}
