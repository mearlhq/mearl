import { setBackgroundPageActivity } from '../backgroundPageActivity';
import { cleanupBrowserEnhancements } from '../browserEnhancements';
import { runSerializedQuickSimulationUpdate } from '../quickSimulationUpdateQueue';
/**
 * Agent handler: browser_release
 *
 * 释放当前浏览器内由 Mearl 持有的临时控制状态，保留浏览器与全部标签页。
 */

import {
  cleanupCollector,
  listCollectingTabIds,
  stopRequestCollection,
} from '../backgroundRequestCollector';
import { listDebuggerControlTabIds, releaseDebuggerControlForTab } from '../debuggerManager';
import { listActiveDebuggerTabIds } from '../debuggerSessionManager';
import { notifyPanelOverrideChanged } from '../overrideNotifier';
import { listControlledTabIds, releaseControlledTab } from './controlledTabs';
import { disposePageRefs } from './pageRefs';
import { disposeExtensionWebMcp, listWebMcpTabIds } from './webMcpHandlers';
import { listCollectingMarkerTabIds, removeCollectingTab } from './tabHandlers';
import { clearAppProfileForTab, listAppProfileTabIds } from '../utils/appProfileRules';
import { clearDeviceShellForTab, listDeviceShellTabIds } from '../deviceShellRules';
import {
  disableQuickDeviceSimulationState,
  listActiveQuickDeviceSimulationTabIds,
} from '../quickDeviceSimulationState';

export interface BrowserReleaseFailure {
  tabId: number;
  stage:
    | 'activity'
    | 'request_collection'
    | 'collection_marker'
    | 'app_profile'
    | 'device_shell'
    | 'quick_device'
    | 'debugger'
    | 'reload'
    | 'indicator';
  error: string;
}

export interface BrowserReleaseResult {
  released: boolean;
  hadActiveControl: boolean;
  affectedTabIds: number[];
  failures?: BrowserReleaseFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleBrowserRelease(scope?: {
  tabIds: number[];
  preserveEnvironment?: boolean;
}): Promise<BrowserReleaseResult> {
  const tabIds = scope
    ? scope.tabIds
    : Array.from(
        new Set([
          ...(await listControlledTabIds()),
          ...listCollectingTabIds(),
          ...listCollectingMarkerTabIds(),
          ...listDebuggerControlTabIds(),
          ...listActiveDebuggerTabIds(),
          ...listWebMcpTabIds(),
          ...(await listAppProfileTabIds()),
          ...(await listDeviceShellTabIds()),
          ...(await listActiveQuickDeviceSimulationTabIds()),
        ]),
      ).sort((a, b) => a - b);
  const failures: BrowserReleaseFailure[] = [];

  const runStep = async (
    tabId: number,
    stage: BrowserReleaseFailure['stage'],
    operation: () => void | Promise<void> | Promise<boolean>,
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push({ tabId, stage, error: errorMessage(error) });
    }
  };

  for (const tabId of tabIds) {
    await runSerializedQuickSimulationUpdate(tabId, async () => {
      disposeExtensionWebMcp(tabId);
      await runStep(tabId, 'activity', () => setBackgroundPageActivity(tabId, false));
      if (scope?.preserveEnvironment) {
        disposePageRefs(tabId);
        await runStep(tabId, 'indicator', () => releaseControlledTab(tabId));
        return;
      }
      let reloadWithoutDeviceShell = false;
      await runStep(tabId, 'request_collection', () => stopRequestCollection(tabId));
      cleanupCollector(tabId);
      // DNR session rule 由所有 tab 共享，串行更新可避免并发删改把旧 tabIds 写回。
      await runStep(tabId, 'collection_marker', () => removeCollectingTab(tabId));
      await runStep(tabId, 'app_profile', () => clearAppProfileForTab(tabId));
      await runStep(tabId, 'device_shell', async () => {
        reloadWithoutDeviceShell = await clearDeviceShellForTab(tabId);
      });
      await runStep(tabId, 'quick_device', async () => {
        await disableQuickDeviceSimulationState(tabId);
      });
      await runStep(tabId, 'debugger', () => releaseDebuggerControlForTab(tabId));
      disposePageRefs(tabId);
      notifyPanelOverrideChanged(tabId);
      await runStep(tabId, 'indicator', () => releaseControlledTab(tabId));
      if (reloadWithoutDeviceShell) {
        await runStep(tabId, 'reload', () => chrome.tabs.reload(tabId));
      }
      if (!failures.some(failure => failure.tabId === tabId)) {
        await runStep(tabId, 'debugger', () => cleanupBrowserEnhancements(tabId));
      }
    });
  }

  return {
    released: failures.length === 0,
    hadActiveControl: tabIds.length > 0,
    affectedTabIds: tabIds,
    ...(failures.length > 0 && { failures }),
  };
}
