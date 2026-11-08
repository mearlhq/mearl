import {
  createNavigationSettlementTracker,
  disposePageReadinessObserverInPage,
  isPotentialNavigationRequest,
  samplePageReadinessInPage,
  type PageActNavigationObserver,
  type PageOpenedTab,
  type PageReadinessSample,
} from '@mearl/browser-core';
import { acquireDebuggerLease, type DebuggerLease } from '../debuggerSessionManager';
import { groupAgentNavigationTarget } from './agentTabGroups';

const PAGE_READINESS_CLEANUP_DEADLINE_MS = 1000;

async function settleBestEffortWithin(
  promise: Promise<unknown>,
  deadlineMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => {}),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, deadlineMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

interface OpenedTabCandidate {
  tabId: number;
  initialUrl: string;
  grouped: Promise<void>;
}

async function resolveOpenedTab(
  candidate: OpenedTabCandidate,
  openerTabId: number,
  timeoutMs: number,
): Promise<PageOpenedTab | null> {
  let tab = await chrome.tabs.get(candidate.tabId).catch(() => null);
  if (!tab) return null;

  if (tab.status !== 'complete') {
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (tabId === candidate.tabId && changeInfo.status === 'complete') finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      void chrome.tabs
        .get(candidate.tabId)
        .then(current => {
          if (current.status === 'complete') finish();
        })
        .catch(finish);
    });
    tab = await chrome.tabs.get(candidate.tabId).catch(() => null);
    if (!tab) return null;
  }

  const ready = tab.status === 'complete';
  return {
    tabId: candidate.tabId,
    openerTabId,
    url: tab.url ?? tab.pendingUrl ?? candidate.initialUrl,
    title: tab.title ?? '',
    active: tab.active,
    ready,
    settledBy: ready ? 'load' : 'timeout',
  };
}

export async function startExtensionNavigationObserver(
  tabId: number,
  urlBefore: string,
  options: {
    trackNetwork?: boolean;
    networkIdleMs?: number;
    contentReadyAfterMs?: number;
    trackOpenedTabs?: boolean;
    sourceTabId?: number;
  } = {},
): Promise<PageActNavigationObserver> {
  let debuggerLease: DebuggerLease | undefined;
  const openerTabId = options.sourceTabId ?? tabId;
  const openedTabCandidates = new Map<number, OpenedTabCandidate>();
  const rememberOpenedTab = (openedTabId: number, initialUrl = '') => {
    if (!options.trackOpenedTabs || openedTabId === openerTabId) return;
    const existing = openedTabCandidates.get(openedTabId);
    openedTabCandidates.set(openedTabId, {
      tabId: openedTabId,
      initialUrl: existing?.initialUrl || initialUrl,
      grouped:
        existing?.grouped ??
        groupAgentNavigationTarget({ sourceTabId: openerTabId, tabId: openedTabId }, true),
    });
  };
  const tracker = createNavigationSettlementTracker({
    urlBefore,
    trackNetwork: options.trackNetwork,
    networkAvailable: false,
    networkIdleMs: options.networkIdleMs,
    contentReadyAfterMs: options.contentReadyAfterMs,
    sampleContent: async () => {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId },
        func: samplePageReadinessInPage,
        args: [options.networkIdleMs ?? 500],
      });
      return execution?.result as PageReadinessSample | undefined;
    },
  });

  const tabListener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
    if (id !== tabId) return;
    const url = info.url ?? tab.url;
    tracker.updatePage(url, tab.title);
    if (info.status === 'loading' || info.url !== undefined) tracker.markStarted(url, tab.title);
    if (info.status === 'complete' || (info.url !== undefined && tab.status === 'complete')) {
      tracker.markDocumentComplete(url, tab.title);
    }
  };
  const debuggerListener = (
    source: chrome.debugger.Debuggee,
    method: string,
    params: any,
  ): void => {
    if (source.tabId !== tabId) return;
    if (
      method === 'Network.requestWillBeSent' &&
      isPotentialNavigationRequest(params.type ?? '', params.request?.url ?? '')
    ) {
      tracker.requestStarted(params.requestId);
      return;
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      tracker.requestFinished(params.requestId);
    }
  };
  const createdTabListener = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId !== openerTabId || tab.id === undefined) return;
    rememberOpenedTab(tab.id, tab.pendingUrl ?? tab.url ?? '');
  };
  const createdNavigationTargetListener = (
    details: chrome.webNavigation.WebNavigationSourceCallbackDetails,
  ) => {
    if (details.sourceTabId !== openerTabId) return;
    rememberOpenedTab(details.tabId, details.url);
  };

  chrome.tabs.onUpdated.addListener(tabListener);
  if (options.trackOpenedTabs) {
    chrome.tabs.onCreated.addListener(createdTabListener);
    chrome.webNavigation?.onCreatedNavigationTarget?.addListener(createdNavigationTargetListener);
  }
  if (options.trackNetwork) {
    chrome.debugger.onEvent.addListener(debuggerListener);
    try {
      debuggerLease = await acquireDebuggerLease(tabId, {
        consumer: 'page-act-navigation',
        domains: ['Network'],
        onInvalidated: () => tracker.setNetworkAvailable(false),
      });
      tracker.setNetworkAvailable(true);
    } catch {
      tracker.setNetworkAvailable(false);
    }
  }

  return {
    hasStarted: tracker.hasStarted,
    hasNetworkActivity: tracker.hasNetworkActivity,
    waitForStart: tracker.waitForStart,
    waitForNetworkIdle: tracker.waitForNetworkIdle,
    waitForResult: tracker.waitForResult,
    getOpenedTabs: async timeoutMs => {
      const tabs = await Promise.all(
        Array.from(openedTabCandidates.values()).map(async candidate => {
          await candidate.grouped;
          return resolveOpenedTab(candidate, openerTabId, timeoutMs);
        }),
      );
      return tabs.filter((tab): tab is PageOpenedTab => tab !== null);
    },
    dispose: async () => {
      chrome.tabs.onUpdated.removeListener(tabListener);
      if (options.trackOpenedTabs) {
        chrome.tabs.onCreated.removeListener(createdTabListener);
        chrome.webNavigation?.onCreatedNavigationTarget?.removeListener(
          createdNavigationTargetListener,
        );
      }
      if (options.trackNetwork) chrome.debugger.onEvent.removeListener(debuggerListener);
      tracker.dispose();
      await debuggerLease?.release();
      if (options.trackNetwork) {
        await settleBestEffortWithin(
          chrome.scripting.executeScript({
            target: { tabId },
            func: disposePageReadinessObserverInPage,
          }),
          PAGE_READINESS_CLEANUP_DEADLINE_MS,
        );
      }
    },
  };
}
