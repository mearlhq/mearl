export type PluginModelMode = 'generate' | 'agent';
export interface PluginModelRequest {
  provider: string;
  mode: PluginModelMode;
  prompt: string;
  instructions?: string;
  model?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  outputSchema?: Record<string, unknown>;
  /** Opt-in conversation scoped to the bound document or calling command execution. */
  conversation?: string;
  /** Required for an agent task; never inferred from a pure-generation request. */
  permissions?: 'read-only';
}
export interface PluginModelCapability {
  provider: string;
  modes: PluginModelMode[];
  permissions: Array<'read-only'>;
  structuredOutput: boolean;
  streaming: boolean;
  cancellation: boolean;
}
export interface PluginModelOption {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  reasoningEfforts?: NonNullable<PluginModelRequest['reasoningEffort']>[];
  defaultReasoningEffort?: PluginModelRequest['reasoningEffort'];
}
export interface PluginModelList {
  provider: string;
  models: PluginModelOption[];
}
export interface PluginModelResult {
  text: string;
  output?: unknown;
  provider: string;
  mode: PluginModelMode;
  model?: string;
}

/** Execution observations contain no prompts, account identities or credential values. */
export interface PluginModelDiagnostic {
  requestedModel?: string;
  selectedModel?: string;
  activeModel?: string;
  runtime?: {
    executable?: string;
    version?: string;
    selection: 'explicit' | 'automatic';
    started?: boolean;
  };
  configuration?: {
    source: 'default' | 'environment';
    home?: string;
    filePresent: boolean;
    baseProvider?: string;
    credentialStore?: 'file' | 'keyring' | 'auto' | 'ephemeral' | 'unknown';
  };
  authentication?: 'apikey' | 'chatgpt' | 'chatgptAuthTokens' | 'unknown';
  threadRestrictionsAccepted?: boolean;
  turnRestrictionsAccepted?: boolean;
  retryCount?: number;
}
