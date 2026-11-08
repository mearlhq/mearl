import type { ControlSource } from '@mearl/browser-core';
import { startRequestCollection } from '../backgroundRequestCollector';
import { markTabControlled } from './controlledTabs';

/** Collection alone does not grant input ownership or make the page a closeExisting candidate. */
export async function prepareTabForCapture(tabId: number | null | undefined): Promise<void> {
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return;
  await startRequestCollection(tabId);
}

/** The ordinary automation entry keeps both its visual ownership and pre-action collection. */
export async function prepareTabForAgent(
  tabId: number | null | undefined,
  controlSource: ControlSource = 'local',
): Promise<void> {
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return;
  await markTabControlled(tabId, controlSource);
  await prepareTabForCapture(tabId);
}
