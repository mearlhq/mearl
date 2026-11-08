import type {
  AppProfileDefinition,
  AppProfileOptions,
  InjectedAppProfileConfig,
} from '@mearl/browser-core';
import { appProfileRevision } from '@mearl/browser-core';
import { mergeAppBridgeConfigs, resolveAppProfile } from './profiles.js';

const OPTION_KEYS = [
  'os',
  'appVersion',
  'language',
  'deviceModel',
  'devicePreset',
  'orientation',
  'lockDefinition',
] as const;

/** Definition lookup must not keep a navigation paused when the host or a plugin is unavailable. */
export async function findAppProfileDefinitionUpdate(
  current: InjectedAppProfileConfig,
  load: () => Promise<AppProfileDefinition>,
  timeoutMs = 1500,
): Promise<AppProfileDefinition | undefined> {
  if (!current.binding || current.binding.options.lockDefinition) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const definition = await Promise.race([
      load(),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    // Removing a code provider does not replace a pinned full environment with a UA-only fallback.
    if (current.binding.definition.pageRuntime && definition && !definition.pageRuntime) return undefined;
    return definition &&
      definition.name === current.profile &&
      appProfileRevision(definition) !== current.binding.revision
      ? definition
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Host command envelopes never become part of a serialized profile binding. */
export function mergeAppProfileOptions(
  ...sources: Array<AppProfileOptions | undefined>
): AppProfileOptions {
  const result: AppProfileOptions = {};
  for (const source of sources) {
    if (!source) continue;
    for (const key of OPTION_KEYS) {
      if (source[key] !== undefined) Object.assign(result, { [key]: source[key] });
    }
    if (source.bridgeConfig !== undefined)
      result.bridgeConfig = mergeAppBridgeConfigs(result.bridgeConfig, source.bridgeConfig);
  }
  return result;
}

export function getAppProfileExplicitOptions(config: InjectedAppProfileConfig): AppProfileOptions {
  return mergeAppProfileOptions(config.binding?.explicitOptions, {
    bridgeConfig: config.binding?.options.bridgeConfig,
  });
}

/** Both hosts use the same precedence for saved choices, active choices and command overrides. */
export function resolveAppProfileUpdate(
  name: string,
  {
    current,
    definition,
    defaults,
    options,
    deviceOptions,
  }: {
    current?: InjectedAppProfileConfig;
    definition?: AppProfileDefinition;
    defaults?: AppProfileOptions;
    options?: AppProfileOptions;
    deviceOptions?: AppProfileOptions;
  } = {},
) {
  const active = current?.profile === name ? current : undefined;
  const explicit = mergeAppProfileOptions(
    defaults,
    active ? getAppProfileExplicitOptions(active) : undefined,
    options,
  );
  const previousDevice = active?.binding?.options;
  const effective = mergeAppProfileOptions(
    previousDevice && {
      os: previousDevice.os,
      deviceModel: previousDevice.deviceModel,
      devicePreset: previousDevice.devicePreset,
      orientation: previousDevice.orientation,
    },
    explicit,
    deviceOptions,
  );
  const resolved = resolveAppProfile(name, effective, definition ?? active?.binding?.definition);
  resolved.injected.binding!.explicitOptions = Object.fromEntries(
    Object.entries(explicit).filter(([key]) => key !== 'bridgeConfig'),
  );
  if (active?.hostCapabilities && (definition === undefined || definition === active.binding?.definition)) resolved.injected.hostCapabilities = structuredClone(active.hostCapabilities);
  return resolved;
}

/** Recompile profile-owned fields while retaining the independently managed device layout. */
export function rebuildAppProfileConfig(
  current: InjectedAppProfileConfig,
  options: AppProfileOptions = {},
  definition = current.binding?.definition,
): InjectedAppProfileConfig {
  const next = resolveAppProfileUpdate(current.profile, { current, definition, options }).injected;
  return {
    ...next,
    animationMs: current.animationMs,
    statusBarHeight: current.statusBarHeight,
    safeAreaInsets: current.safeAreaInsets,
    deviceAppearance: current.deviceAppearance,
    simulateSystemBars: current.simulateSystemBars,
    externalDeviceChrome: current.externalDeviceChrome,
    rootContainer: {
      ...next.rootContainer,
      ...(next.rootContainer?.initialCookies && {
        initialCookies: next.rootContainer.initialCookies.map(cookie => ({
          ...cookie,
          value: String(current.statusBarHeight),
        })),
      }),
      enabled: current.rootContainer?.enabled ?? false,
      ...(current.rootContainer?.splitScreen !== undefined && {
        splitScreen: current.rootContainer.splitScreen,
      }),
    },
  };
}
