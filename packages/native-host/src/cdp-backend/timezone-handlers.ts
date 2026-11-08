/** CDP timezone override handler. */

import type { SetTimezoneParams } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { registerActions } from './action-registry.js';

export async function cdpSetTimezone(session: PageSession, data: SetTimezoneParams): Promise<any> {
  if (typeof data?.timezone !== 'string') {
    throw new Error(
      'set_timezone: "timezone" is required (IANA timezone or empty string to clear)',
    );
  }

  const timezone = data.timezone.trim();
  await session.client.sendCommand('Emulation.setTimezoneOverride', { timezoneId: timezone });
  return { enabled: timezone.length > 0, timezone: timezone || null };
}

registerActions([{ name: 'set_timezone', session: 'page', handler: cdpSetTimezone }]);
