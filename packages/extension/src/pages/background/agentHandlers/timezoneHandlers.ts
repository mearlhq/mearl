/** Agent handler: set_timezone */

import type { SetTimezoneParams, SetTimezoneResult } from '@mearl/browser-core';
import { disableTimezoneForTab, enableTimezoneForTab } from '../debuggerManager';

export async function handleSetTimezone(
  data: SetTimezoneParams,
  getActiveTabId: () => number | null,
): Promise<SetTimezoneResult> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }
  if (typeof data.timezone !== 'string') {
    throw new Error(
      'set_timezone: "timezone" is required (IANA timezone or empty string to clear)',
    );
  }

  const timezone = data.timezone.trim();
  if (!timezone) {
    await disableTimezoneForTab(tabId);
    return { enabled: false, timezone: null };
  }

  await enableTimezoneForTab(tabId, timezone);
  return { enabled: true, timezone };
}
