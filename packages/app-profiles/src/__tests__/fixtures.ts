import type { BuiltinAppProfileName } from '@mearl/browser-core';
import { resolveAppProfile as compile, type AppProfile, type ResolveAppProfileOptions } from '../profiles.js';

const BUILTIN_APP_PROFILE_LABELS: Record<string, string> = { reader: '阅读器', shop: '手机商城', chat: '聊天', wallet: '钱包' };
const emptyActions = () => ({ open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [], navigationBar: [], statusBar: [], kvGet: [], kvSet: [], kvDelete: [], pageContext: [], responses: {}, behaviors: {}, silent: [] });
function basicProfile(name: BuiltinAppProfileName, appName: string, defaultAppVersion: string, uaTokens: string[], uaFamily?: AppProfile['uaFamily']): AppProfile {
  return { name, label: BUILTIN_APP_PROFILE_LABELS[name], appName, defaultAppVersion, uaTokens,
    ...(uaFamily && { uaFamily }), uaTemplate: { ios: 'Sample/{v} iOS {language}', android: 'Sample/{v} {deviceModel}' }, globals: {}, bridges: [], activeEvents: [], actions: emptyActions(), schemes: [] };
}

export const APP_PROFILES: Record<BuiltinAppProfileName, AppProfile> = {
  reader: basicProfile('reader', 'Reader', '10.0.9', ['FixtureReader/{v}', 'FixtureBridge/8.7.0']),
  shop: basicProfile('shop', 'Shop', '10.65.0', ['FixtureBridge/8.7.0']),
  chat: basicProfile('chat', 'Chat', '8.0.58', [], 'chatMiniProgram'),
  wallet: { authorization: { hook: 'sample.authorization', method: 'getAuthCode' }, ...basicProfile('wallet', 'Wallet', '10.8.0', ['WalletClient/{v}']), policies: { navigatorLanguage: true, defaultLanguage: 'zh-CN' } },
};


export function resolveAppProfile(name: string, options: ResolveAppProfileOptions = {}, definition?: AppProfile) {
  return compile(name, options, definition ?? APP_PROFILES[name as BuiltinAppProfileName]);
}
export function listBuiltinAppProfiles() { return ['reader', 'shop', 'wallet', 'chat'].map(name => APP_PROFILES[name as BuiltinAppProfileName]).map(definition => ({ id: definition.name, label: definition.label, source: 'plugin' as const, available: true, definition })); }
