import { resolveAppProfileDefinition, type ResolveAppProfileOptions } from '@mearl/app-profiles';
import { APP_PROFILES } from '../../../../app-profiles/src/__tests__/fixtures';

/** Explicit contributed settings keep persistence tests independent of UA-only defaults. */
export function resolveSettingsProfile(name: 'wallet' | 'reader', options: ResolveAppProfileOptions = {}) {
  const definition = structuredClone(APP_PROFILES[name]);
  if (name === 'wallet') {
    definition.policies = { languages: ['zh-CN', 'en-US'], defaultLanguage: 'zh-CN' };
    definition.settings = [{ id: 'language', label: 'Language', type: 'select', target: { option: 'language' }, choices: [{ label: 'Chinese', value: 'zh-CN' }, { label: 'English', value: 'en-US' }] }];
  } else {
    definition.actions.responses = { getNotifications: { enabled: false }, getFeatureFlags: { enhancedRendering: true } };
    definition.settings = [{ id: 'enhancedRendering', label: 'Version', type: 'boolean', target: { method: 'getFeatureFlags', field: 'enhancedRendering' } }];
  }
  return resolveAppProfileDefinition(definition, options);
}


export const MAP_PROFILE_FIXTURE = {
  ...APP_PROFILES.shop,
  name: 'maps/sample',
  label: 'Maps fixture',
  appName: 'Maps',
  defaultAppVersion: '1.0.0',
  uaTokens: ['FixtureMaps/{v}'],
  globals: { __FIXTURE_MAPS__: '1' },
};
