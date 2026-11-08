import { CODEX_MODEL_CAPABILITY } from '@mearl/agent-runtime/capabilities';
import type {
  PluginModelCapability,
  PluginModelRequest,
  PluginModelResult,
} from '@mearl/browser-core';

export function pluginModelCapabilities(): { providers: PluginModelCapability[] } {
  return { providers: [CODEX_MODEL_CAPABILITY] };
}
export function normalizePluginModel(value: unknown): PluginModelRequest {
  const request = value as PluginModelRequest;
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    typeof request.prompt !== 'string' ||
    !request.prompt.trim() ||
    Buffer.byteLength(JSON.stringify(request)) > 256 * 1024 ||
    (request.instructions !== undefined && typeof request.instructions !== 'string') ||
    (request.conversation !== undefined &&
      (typeof request.conversation !== 'string' ||
        !/^[a-zA-Z0-9:_-]{1,80}$/.test(request.conversation))) ||
    (request.model !== undefined &&
      (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 256)) ||
    (request.reasoningEffort !== undefined &&
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
        request.reasoningEffort,
      )) ||
    Object.keys(request).some(
      key =>
        ![
          'provider',
          'mode',
          'prompt',
          'instructions',
          'model',
          'reasoningEffort',
          'outputSchema',
          'permissions',
          'conversation',
        ].includes(key),
    )
  )
    throw new Error('Invalid model execution request');
  const capability = pluginModelCapabilities().providers.find(
    item => item.provider === request.provider,
  );
  if (
    !capability?.modes.includes(request.mode) ||
    (request.mode === 'agent' && !capability.permissions.includes(request.permissions!)) ||
    (request.mode === 'generate' && request.permissions !== undefined)
  )
    throw Object.assign(
      new Error(
        'Requested model mode or permissions are unsupported; choose an advertised capability explicitly',
      ),
      { code: 'PLUGIN_MODEL_CAPABILITY_UNSUPPORTED' },
    );
  if (request.outputSchema !== undefined) {
    if (
      !capability.structuredOutput ||
      !request.outputSchema ||
      typeof request.outputSchema !== 'object' ||
      Array.isArray(request.outputSchema) ||
      request.outputSchema.$async ||
      Buffer.byteLength(JSON.stringify(request.outputSchema)) > 64 * 1024
    )
      throw new Error('Invalid model output schema');
  }
  return JSON.parse(JSON.stringify(request));
}
export function validatePluginModelResult(
  request: PluginModelRequest,
  value: unknown,
): PluginModelResult {
  const result = value as PluginModelResult;
  if (
    !result ||
    typeof result.text !== 'string' ||
    result.provider !== request.provider ||
    result.mode !== request.mode
  )
    throw new Error('Invalid model execution result');
  if (request.outputSchema) {
    let output: unknown;
    try {
      output = JSON.parse(result.text);
    } catch {
      throw Object.assign(new Error('Model returned invalid JSON'), {
        code: 'PLUGIN_MODEL_SCHEMA_INVALID',
      });
    }
    return { ...result, output };
  }
  return result;
}
