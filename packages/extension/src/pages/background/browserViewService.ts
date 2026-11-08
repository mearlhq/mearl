import {
  BundleError,
  browserTransportUrl,
  browserTransportPolicies,
} from '@mearl/preset/bundles';
import { clonePresetDefaults } from '@mearl/preset';
import type { JsonObject } from '@mearl/preset';
import { getAgentAllowAllDomains, getAgentAllowedOrigins } from '../../shared/proxyPermissions';
import { runAcceptedBrowserCapability, authorizeBrowserCapabilityUrl } from './browserCapabilities';
import {
  openBrowserViewInstance,
  readBrowserViewInstance,
  closeBrowserViewInstance,
} from './browserViewInstances';
import { closeBrowserRequestLogin, openBrowserRequestLogin } from './browserRequestLogin';
import { isExternalServiceEnabled } from './externalServices';
import { isExtensionUiSender } from './extensionMessageTrust';
import { browserViewPreferenceKey } from '../../shared/browserViewPreferences';

export async function handleBrowserView(input: unknown, sender: chrome.runtime.MessageSender) {
  if (!isExtensionUiSender(sender, chrome.runtime.id))
    return { success: false, error: 'Extension UI required' };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected a browser view operation');
    const value = input as Record<string, unknown>;
    if (
      value.slot === 'captureController' &&
      (value.operation === 'open' || value.operation === 'close')
    )
      throw new Error('Browser controllers require their resident lifecycle');
    if (value.operation === 'loginClose') {
      if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id))
        throw new Error('Expected a login lease');
      await closeBrowserRequestLogin(value.id, sender);
      return { success: true };
    }
    if (value.operation === 'open') {
      await openBrowserViewInstance(value, sender);
      return { success: true };
    }
    if (value.operation === 'close') {
      await closeBrowserViewInstance(value, sender);
      return { success: true };
    }
    const instance = await readBrowserViewInstance(value, sender);
    const selected = { ...instance.selected, html: '' };
    if (value.operation === 'transport') {
      if (
        typeof value.name !== 'string' ||
        !Object.hasOwn(selected.definition.transports ?? {}, value.name)
      )
        throw new Error('Unknown browser view transport');
      const transport = selected.definition.transports![value.name];
      if (!(await isExternalServiceEnabled(transport.setting)))
        throw new Error('Browser view transport service is disabled');
      const target = browserTransportUrl(value.url, transport.kind);
      await authorizeBrowserCapabilityUrl(target.permissionUrl);
      const [domains, allowAll, permissions] = await Promise.all([
        getAgentAllowedOrigins(),
        getAgentAllowAllDomains(),
        chrome.permissions.getAll(),
      ]);
      return {
        success: true,
        data: {
          url: target.url,
          kind: transport.kind,
          policies: browserTransportPolicies(
            domains,
            permissions.origins ?? [],
            allowAll,
            transport.kind,
          ),
        },
      };
    }
    if (value.operation === 'invoke') {
      if (
        typeof value.action !== 'string' ||
        !Object.hasOwn(selected.definition.actions, value.action)
      )
        throw new Error('Unknown browser view action');
      const action = selected.definition.actions[value.action];
      if (action.setting && !(await isExternalServiceEnabled(action.setting)))
        return { success: true, data: action.disabledResult };
      if (!instance.runtime || !Object.hasOwn(instance.handlers, value.action))
        throw new BundleError('BUNDLE_INVALID', 'Browser view action is unavailable');
      const result = await runAcceptedBrowserCapability({
        ...instance.runtime,
        code: new TextEncoder().encode(instance.runtime.code),
        handler: instance.handlers[value.action],
        input: value.input,
      });
      return { success: true, data: result };
    }
    if (value.operation === 'preferences') {
      const declarations = selected.definition.preferences ?? {};
      const keys = Object.keys(declarations).filter(key => declarations[key].area !== 'session');
      const keyFor = (key: string) => browserViewPreferenceKey(selected, key);
      if (value.key !== undefined) {
        if (
          typeof value.key !== 'string' ||
          !Object.hasOwn(declarations, value.key) ||
          declarations[value.key].area === 'session'
        )
          throw new Error('Unknown browser view preference');
        const accepted = clonePresetDefaults({ value: value.value });
        await chrome.storage.local.set({ [keyFor(value.key)]: accepted.value });
        return { success: true };
      }
      const stored = await chrome.storage.local.get(keys.map(keyFor));
      const result: JsonObject = {};
      for (const key of keys) {
        const source = keyFor(key);
        if (Object.hasOwn(stored, source)) result[key] = stored[source];
      }
      return { success: true, data: result };
    }
    if (value.operation === 'loginOpen') {
      if (
        typeof value.login !== 'string' ||
        !Object.hasOwn(selected.definition.logins ?? {}, value.login) ||
        typeof value.id !== 'string'
      )
        throw new Error('Unknown browser view login');
      const definition = selected.definition.logins![value.login];
      const id = await openBrowserRequestLogin(definition.url, sender, value.id);
      return { success: true, data: { id, definition } };
    }
    throw new Error('Unknown browser view operation');
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
