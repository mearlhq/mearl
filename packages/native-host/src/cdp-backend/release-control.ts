/**
 * Browser-level CDP control release.
 *
 * Closes Mearl's browser/page WebSocket sessions while keeping Chrome and all
 * targets alive. A later browser action may create a fresh CdpSession.
 */

import type { CdpSession } from './cdp-session.js';
import { releaseControlledIndicator } from './controlled-indicator.js';
import { clearCdpMockState } from './mock-handlers.js';
import { clearCdpAppProfile } from './app-profile-handlers.js';
import { clearCdpDeviceShell } from './device-shell.js';
import { clearCdpFetchInterceptionState } from './fetch-interceptor.js';
import { clearCdpNetworkControlState } from './network-control.js';
import { clearCdpRuleState } from './rule-handlers.js';

export interface CdpReleaseResult {
  released: boolean;
  hadActiveControl: boolean;
  affectedTabIds: number[];
}

export async function releaseCdpControl(session: CdpSession): Promise<CdpReleaseResult> {
  const pageSessions = session.listOpenPageSessions();
  const targetIds = new Set(pageSessions.map(pageSession => pageSession.targetId));
  const affectedTabIds = session.listRegisteredTabIds(targetIds).sort((a, b) => a - b);
  const hadActiveControl = session.hasActiveConnections();

  await Promise.allSettled(
    pageSessions.map(async pageSession => {
      const [, deviceShell] = await Promise.allSettled([
        clearCdpAppProfile(pageSession, false),
        clearCdpDeviceShell(pageSession),
        releaseControlledIndicator(pageSession),
      ]);
      if (deviceShell.status === 'fulfilled' && deviceShell.value) {
        await pageSession.client.sendCommand('Page.reload', {}).catch(() => {});
      }
    }),
  );
  clearCdpMockState();
  clearCdpNetworkControlState(pageSessions);
  clearCdpRuleState(session);
  clearCdpFetchInterceptionState(pageSessions);
  session.close();

  return {
    released: true,
    hadActiveControl,
    affectedTabIds,
  };
}
