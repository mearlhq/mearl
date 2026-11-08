import { BROWSER_CONTROL_GET_ACTION, BROWSER_CONTROL_SET_ACTION, BROWSER_CONTROL_CLEAR_ACTION } from '../../shared/browserControl';
import { isExtensionUiSender } from './extensionMessageTrust';
import { selectedNetworkControl } from './envSwitchRules';
import { getNetworkControlState, setNetworkControlForTab, clearNetworkControlForTab } from './networkControlRules';

export async function handleBrowserControl(input: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
  if (!isExtensionUiSender(sender, chrome.runtime.id)) return { success: false, error: 'Extension UI required' };
  try {
    const tabId = input.tabId;
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab ID');
    if (input.action === BROWSER_CONTROL_CLEAR_ACTION) {
      await clearNetworkControlForTab(tabId);
      return { success: true };
    }
    const selected = await selectedNetworkControl();
    if (input.action === BROWSER_CONTROL_SET_ACTION) {
      if (!selected || input.controlId !== selected.definition.id || input.bundleId !== selected.bundleId || input.revision !== selected.revision) throw new Error('Browser control selection changed');
      const option = selected.definition.options.find(option => option.value === input.value);
      if (!option) throw new Error('Unknown browser control option');
      await setNetworkControlForTab(tabId, selected, option.value, async () => {
        const current = await selectedNetworkControl();
        if (current?.bundleId !== selected.bundleId || current.revision !== selected.revision || current.definition.id !== selected.definition.id) throw new Error('Browser control selection changed');
      });
    } else if (input.action !== BROWSER_CONTROL_GET_ACTION) throw new Error('Unknown browser control operation');
    const accepted = await getNetworkControlState(tabId);
    const value = accepted?.value ?? selected?.definition.defaultValue;
    return { success: true, value };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}
