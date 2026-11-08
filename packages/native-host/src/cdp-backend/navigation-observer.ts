import {
  createNavigationSettlementTracker,
  disposePageReadinessObserverInPage,
  isPotentialNavigationRequest,
  samplePageReadinessInPage,
  type PageActNavigationObserver,
  type PageOpenedTab,
  type PageReadinessSample,
} from '@mearl/browser-core';
import type { CdpSession, PageSession } from './cdp-session.js';
import { waitForPageLoad } from './cdp-utils.js';
import {
  resolveCdpDeviceShellPageEndpoint,
  sendCdpDeviceShellPageCommand,
} from './device-shell.js';
import { ensureCdpDomain } from './domain-manager.js';

const SAMPLE_PAGE_READINESS_SRC = samplePageReadinessInPage.toString();
const DISPOSE_PAGE_READINESS_SRC = disposePageReadinessObserverInPage.toString();

export async function startCdpNavigationObserver(
  cdpSession: CdpSession,
  pageSession: PageSession,
  urlBefore: string,
  options: {
    trackNetwork?: boolean;
    networkIdleMs?: number;
    contentReadyAfterMs?: number;
    trackOpenedTabs?: boolean;
    sourceTabId?: number;
  } = {},
): Promise<PageActNavigationObserver> {
  const pageEndpoint = await resolveCdpDeviceShellPageEndpoint(pageSession);
  const pageClient = pageEndpoint.client;
  await ensureCdpDomain(pageClient, 'Page');
  await ensureCdpDomain(pageClient, 'Runtime');
  if (options.trackNetwork) await ensureCdpDomain(pageClient, 'Network');
  let browserClient: Awaited<ReturnType<CdpSession['getBrowserClient']>> | null = null;
  const baselineTargetIds = new Set<string>();
  if (options.trackOpenedTabs) {
    try {
      browserClient = await cdpSession.getBrowserClient();
      const targets = await browserClient.sendCommand('Target.getTargets');
      for (const target of targets.targetInfos ?? []) baselineTargetIds.add(target.targetId);
    } catch {
      browserClient = null;
    }
  }
  const frameTree = await pageClient.sendCommand('Page.getFrameTree');
  const observedFrameId =
    pageEndpoint.frameId ?? (frameTree.frameTree?.frame?.id as string | undefined);
  const observesParentTargetSubframe =
    pageClient === pageSession.client && pageEndpoint.frameId !== undefined;
  const tracker = createNavigationSettlementTracker({
    urlBefore,
    trackNetwork: options.trackNetwork,
    networkAvailable: options.trackNetwork === true,
    networkIdleMs: options.networkIdleMs,
    contentReadyAfterMs: options.contentReadyAfterMs,
    sampleContent: async () => {
      const evaluation = await sendCdpDeviceShellPageCommand(pageSession, 'Runtime.evaluate', {
        expression: `(${SAMPLE_PAGE_READINESS_SRC})(${options.networkIdleMs ?? 500})`,
        returnByValue: true,
      });
      return evaluation.result?.value as PageReadinessSample | undefined;
    },
  });

  const removeFrameNavigated = pageClient.on('Page.frameNavigated', (params: any) => {
    if (observedFrameId && params.frame?.id !== observedFrameId) return;
    tracker.markStarted(params.frame?.url);
  });
  const removeWithinDocument = pageClient.on('Page.navigatedWithinDocument', (params: any) => {
    if (observedFrameId && params.frameId !== observedFrameId) return;
    tracker.markStarted(params.url);
    tracker.markDocumentComplete(params.url);
  });
  const removeLoad = pageClient.on('Page.loadEventFired', () => {
    if (observesParentTargetSubframe) return;
    if (tracker.hasStarted()) tracker.markDocumentComplete();
  });
  const removeFrameStoppedLoading = pageClient.on('Page.frameStoppedLoading', (params: any) => {
    if (observedFrameId && params.frameId !== observedFrameId) return;
    if (tracker.hasStarted()) tracker.markDocumentComplete();
  });
  const removeRequestStarted = options.trackNetwork
    ? pageClient.on('Network.requestWillBeSent', (params: any) => {
        if (!isPotentialNavigationRequest(params.type ?? '', params.request?.url ?? '')) return;
        tracker.requestStarted(params.requestId);
      })
    : () => {};
  const onRequestFinished = (params: any) => tracker.requestFinished(params.requestId);
  const removeRequestFinished = options.trackNetwork
    ? pageClient.on('Network.loadingFinished', onRequestFinished)
    : () => {};
  const removeRequestFailed = options.trackNetwork
    ? pageClient.on('Network.loadingFailed', onRequestFinished)
    : () => {};

  return {
    hasStarted: tracker.hasStarted,
    hasNetworkActivity: tracker.hasNetworkActivity,
    waitForStart: tracker.waitForStart,
    waitForNetworkIdle: tracker.waitForNetworkIdle,
    waitForResult: async (timeoutMs: number) => {
      const result = await tracker.waitForResult(timeoutMs);
      try {
        const pageState = await sendCdpDeviceShellPageCommand(pageSession, 'Runtime.evaluate', {
          expression: '({ title: document.title, url: location.href })',
          returnByValue: true,
        });
        return {
          ...result,
          title: pageState.result?.value?.title ?? result.title,
          urlAfter: pageState.result?.value?.url ?? result.urlAfter,
        };
      } catch {
        return result;
      }
    },
    getOpenedTabs: async timeoutMs => {
      if (!browserClient || options.sourceTabId === undefined) return [];
      const targets = await browserClient.sendCommand('Target.getTargets');
      const candidates = (targets.targetInfos ?? []).filter(
        (target: any) =>
          target.type === 'page' &&
          target.openerId === pageSession.targetId &&
          !baselineTargetIds.has(target.targetId),
      );
      const openedTabs = await Promise.all(
        candidates.map(async (candidate: any): Promise<PageOpenedTab | null> => {
          const tabId = await cdpSession.ensureTargetRegistered(candidate.targetId);
          let ready = false;
          try {
            const openedPageSession = await cdpSession.getPageSession(tabId);
            await ensureCdpDomain(openedPageSession.client, 'Page');
            await waitForPageLoad(openedPageSession, timeoutMs);
            ready = true;
          } catch {
            // The tab is still returned with ready=false so callers can decide whether to wait.
          }
          const targetInfo = await browserClient
            .sendCommand('Target.getTargetInfo', { targetId: candidate.targetId })
            .then(result => result.targetInfo)
            .catch(() => null);
          if (!targetInfo) return null;
          return {
            tabId,
            openerTabId: options.sourceTabId as number,
            url: targetInfo.url ?? candidate.url ?? '',
            title: targetInfo.title ?? candidate.title ?? '',
            ready,
            settledBy: ready ? 'load' : 'timeout',
          };
        }),
      );
      return openedTabs.filter((tab): tab is PageOpenedTab => tab !== null);
    },
    dispose: async () => {
      removeFrameNavigated();
      removeWithinDocument();
      removeLoad();
      removeFrameStoppedLoading();
      removeRequestStarted();
      removeRequestFinished();
      removeRequestFailed();
      tracker.dispose();
      await sendCdpDeviceShellPageCommand(pageSession, 'Runtime.evaluate', {
        expression: `(${DISPOSE_PAGE_READINESS_SRC})()`,
        returnByValue: false,
      }).catch(() => {});
    },
  };
}
