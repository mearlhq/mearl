import { isDeviceEnvironmentObservation, observeDeviceEnvironment, type DeviceEnvironmentObservation } from '@mearl/browser-core';
import { acquireDebuggerLease } from './debuggerSessionManager';

export async function readPhysicalDeviceEnvironment(tabId: number): Promise<DeviceEnvironmentObservation> {
  const lease = await acquireDebuggerLease(tabId, { consumer: 'environment-observation', domains: ['Page', 'Runtime'] });
  try {
    const before = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree') as any)?.frameTree?.frame;
    if (!before?.id || !before.loaderId) throw new Error('ENVIRONMENT_OBSERVATION_UNAVAILABLE');
    const world = await chrome.debugger.sendCommand({ tabId }, 'Page.createIsolatedWorld', {
      frameId: before.id, worldName: '__mearl_environment_observation__',
    }) as { executionContextId?: number };
    if (!Number.isSafeInteger(world.executionContextId)) throw new Error('ENVIRONMENT_OBSERVATION_UNAVAILABLE');
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(${observeDeviceEnvironment.toString()})()`, contextId: world.executionContextId,
      returnByValue: true, awaitPromise: true,
    }) as any;
    const after = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree') as any)?.frameTree?.frame;
    if (after?.id !== before.id || after?.loaderId !== before.loaderId || result?.exceptionDetails || !isDeviceEnvironmentObservation(result?.result?.value))
      throw new Error('ENVIRONMENT_OBSERVATION_UNAVAILABLE');
    return result.result.value;
  } finally { await lease.release(); }
}
