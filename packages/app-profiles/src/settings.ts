import type {
  AppProfileOptions,
  AppProfileSetting,
  InjectedAppProfileConfig,
} from '@mearl/browser-core';
import { rebuildAppProfileConfig } from './updates.js';

export function readAppProfileSetting(
  config: InjectedAppProfileConfig,
  setting: AppProfileSetting,
): unknown {
  if ('option' in setting.target) return config.language;
  const response = config.actions.responses?.[setting.target.method];
  if (setting.target.field) {
    return response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>)[setting.target.field]
      : undefined;
  }
  return response;
}

/** Settings write canonical options or method overrides; presentation state is derived. */
export function updateAppProfileSetting(
  config: InjectedAppProfileConfig,
  id: string,
  value: unknown,
): {
  config: InjectedAppProfileConfig;
  options: AppProfileOptions;
  responses?: Record<string, unknown>;
  reload: boolean;
} {
  const binding = config.binding;
  const setting = binding?.definition.settings?.find(item => item.id === id);
  if (!binding || !setting) throw new Error('App profile setting is unavailable');
  if (
    (setting.type === 'boolean' && typeof value !== 'boolean') ||
    (setting.type === 'number' &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (setting.minimum !== undefined && value < setting.minimum) ||
        (setting.maximum !== undefined && value > setting.maximum))) ||
    (['text', 'select'].includes(setting.type) && typeof value !== 'string') ||
    (setting.type === 'select' && !setting.choices?.some(choice => choice.value === value))
  ) {
    throw new Error('Invalid app profile setting value');
  }
  if (JSON.stringify(value)?.length > 16_384 || value === undefined)
    throw new Error('Invalid app profile setting value');
  if ('option' in setting.target) {
    const next = rebuildAppProfileConfig(config, { language: String(value) });
    return { config: next, options: next.binding!.options, reload: true };
  }
  const { method, field } = setting.target;
  const old = config.actions.responses?.[method];
  const response = field
    ? { ...(old && typeof old === 'object' && !Array.isArray(old) ? old : {}), [field]: value }
    : value;
  const patch = {
    methods: { [method]: { response, silent: config.actions.silent?.includes(method) === true } },
  };
  const next = rebuildAppProfileConfig(config, { bridgeConfig: patch });
  return {
    config: next,
    options: next.binding!.options,
    responses: { [method]: response },
    reload: false,
  };
}
