import type { PluginModelCapability } from '@mearl/browser-core/pluginModels';

export const CODEX_MODEL_CAPABILITY: PluginModelCapability = {
  provider: 'codex',
  modes: ['agent'],
  permissions: ['read-only'],
  structuredOutput: true,
  streaming: true,
  cancellation: true,
};
