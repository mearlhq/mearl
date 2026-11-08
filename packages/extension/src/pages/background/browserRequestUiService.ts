import { BundleError, validateBrowserRequestDetail } from '@mearl/preset/bundles';
import { isExtensionUiSender } from './extensionMessageTrust';
import { browserRequestUiSelection, browserRequestUiState } from './browserRequestUiState';
import { updateBrowserServicePreferences, isExternalServiceEnabled } from './externalServices';
import { invokeBrowserCapability } from './browserCapabilities';
import { closeBrowserRequestLogin, openBrowserRequestLogin } from './browserRequestLogin';

export async function handleBrowserRequestUi(input: unknown, sender: chrome.runtime.MessageSender) {
  if (!isExtensionUiSender(sender, chrome.runtime.id))
    return { success: false, error: 'Extension UI required' };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected a request UI operation');
    const value = input as Record<string, unknown>;
    if (value.operation === 'loginClose') {
      if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id))
        throw new Error('Expected a login lease');
      await closeBrowserRequestLogin(value.id, sender);
      return { success: true };
    }
    const state = await browserRequestUiState();
    if (value.operation === 'state') return { success: true, data: state };
    if (!state.selected || !state.definition) throw new Error('CAPABILITY_NOT_INSTALLED');
    if (value.revision !== (state.selected?.revision ?? null))
      throw new BundleError('BUNDLE_CONFLICT', 'The request UI provider changed');
    if (value.operation === 'save') {
      const declaration = state.definition.save;
      if (!state.selected || !declaration)
        throw new Error('The selected request save handler is unavailable');
      if (!(await isExternalServiceEnabled(declaration.setting)))
        throw new Error(`${declaration.setting.replace(/Enabled$/, '').toUpperCase()}_DISABLED`);
      const result = await invokeBrowserCapability(declaration.hook, value.input, {
        bundleId: state.selected.bundleId,
        revision: state.selected.revision,
      });
      if (!result.available)
        throw new BundleError('BUNDLE_INVALID', 'The selected request save handler is unavailable');
      return { success: true, data: result.value };
    }
    if (value.operation === 'loginOpen') {
      if (typeof value.id !== 'string') throw new Error('Expected a login lease');
      const id = await openBrowserRequestLogin(state.definition.login.url, sender, value.id);
      return { success: true, data: { id, definition: state.definition } };
    }
    if (value.operation === 'preference') {
      if (typeof value.enabled !== 'boolean') throw new Error('Expected a service preference');
      await updateBrowserServicePreferences({ [state.definition.setting.key]: value.enabled }, async () => {
        const current = await browserRequestUiSelection();
        if (current.selected?.bundleId !== state.selected?.bundleId || current.selected?.revision !== state.selected?.revision || current.definition?.setting.key !== state.definition?.setting.key) throw new BundleError('BUNDLE_CONFLICT', 'The request UI provider changed');
      });
      return { success: true };
    }
    if (
      value.operation !== 'details' ||
      typeof value.api !== 'string' ||
      !value.api.trim() ||
      (value.version !== undefined && typeof value.version !== 'string')
    )
      throw new Error('Expected an API and version');
    if (!(await isExternalServiceEnabled(state.definition.setting.key)))
      throw new Error(`${state.definition.service.toUpperCase().replaceAll('-', '_')}_DISABLED`);
    const request = {
      api: value.api,
      version: typeof value.version === 'string' ? value.version : '1.0',
    };
    const result = await invokeBrowserCapability(state.definition.details.hook, request, {
      bundleId: state.selected.bundleId,
      revision: state.selected.revision,
    });
    if (!result.available)
      throw new BundleError('BUNDLE_INVALID', 'The selected request detail handler is unavailable');
    return {
      success: true,
      data: result.value === null ? null : validateBrowserRequestDetail(result.value),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
