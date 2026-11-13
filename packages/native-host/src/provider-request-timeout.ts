import { resolveActionTimeoutSec } from '@mearl/client/action-timeouts';

/** A caller deadline covers queueing and all steps; legacy callers use action-derived bounds. */
export function providerRequestTimeoutMs(
  action: string,
  data: Record<string, any>,
  deadline?: number,
): number {
  if (deadline !== undefined) {
    if (!Number.isSafeInteger(deadline) || deadline <= 0)
      throw new Error('Invalid Provider request deadline');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Provider request deadline exceeded');
    if (remaining > 2_147_483_647)
      throw new Error('Provider request deadline exceeds the supported range');
    return remaining;
  }
  if (action === 'browser_close')
    return resolveActionTimeoutSec('browser_manage', { operation: 'close' }, 120) * 1000;
  return resolveActionTimeoutSec(action, data, 120) * 1000;
}
