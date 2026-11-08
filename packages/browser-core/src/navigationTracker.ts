import type {
  PageNavigationChange,
  PageNetworkSettlingResult,
  PageReadinessSample,
} from './pageObserver.js';

export interface NavigationSettlementTrackerOptions {
  urlBefore: string;
  trackNetwork?: boolean;
  networkAvailable?: boolean;
  networkIdleMs?: number;
  contentReadyAfterMs?: number;
  sampleContent?: () => Promise<PageReadinessSample | undefined>;
}

export interface NavigationSettlementTracker {
  hasStarted(): boolean;
  hasNetworkActivity(): boolean;
  updatePage(url?: string, title?: string): void;
  markStarted(url?: string, title?: string): void;
  markDocumentComplete(url?: string, title?: string): void;
  requestStarted(requestId: string): void;
  requestFinished(requestId: string): void;
  setNetworkAvailable(available: boolean): void;
  waitForStart(timeoutMs: number): Promise<boolean>;
  waitForNetworkIdle(timeoutMs: number): Promise<PageNetworkSettlingResult>;
  waitForResult(timeoutMs: number): Promise<PageNavigationChange>;
  dispose(): void;
}

export function createNavigationSettlementTracker(
  options: NavigationSettlementTrackerOptions,
): NavigationSettlementTracker {
  const startedAt = performance.now();
  const trackNetwork = options.trackNetwork === true;
  const networkIdleMs = Math.min(Math.max(options.networkIdleMs ?? 500, 100), 3000);
  const contentReadyAfterMs = Math.min(Math.max(options.contentReadyAfterMs ?? 5000, 0), 20000);
  let networkAvailable = trackNetwork && options.networkAvailable !== false;
  let started = false;
  let documentComplete = false;
  let documentCompletedAt = 0;
  let disposed = false;
  let completed: PageNavigationChange | undefined;
  let latestUrl = options.urlBefore;
  let latestTitle = '';
  let lastNetworkActivity = 0;
  let networkActivityObserved = false;
  let networkIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let contentTimer: ReturnType<typeof setTimeout> | undefined;
  let contentPollInFlight = false;
  let latestContentSample: PageReadinessSample | undefined;
  const pendingRequests = new Set<string>();
  const startWaiters = new Set<(value: boolean) => void>();
  const resultWaiters = new Set<(value: PageNavigationChange) => void>();
  const pollTimers = new Set<ReturnType<typeof setTimeout>>();

  const updatePage = (url?: string, title?: string) => {
    if (url) latestUrl = url;
    if (title) latestTitle = title;
  };
  const notifyStarted = () => {
    if (started) return;
    started = true;
    for (const waiter of startWaiters) waiter(true);
    startWaiters.clear();
  };
  const finish = (
    loaded: boolean,
    ready: boolean,
    settledBy: PageNavigationChange['settledBy'],
  ) => {
    if (completed || disposed) return;
    if (networkIdleTimer) clearTimeout(networkIdleTimer);
    if (contentTimer) clearTimeout(contentTimer);
    completed = {
      mode: 'navigation',
      urlBefore: options.urlBefore,
      urlAfter: latestUrl,
      title: latestTitle,
      elapsed: Math.round((performance.now() - startedAt) * 1000) / 1000,
      loaded,
      ready,
      settledBy,
      pendingRequests: pendingRequests.size,
      ...(latestContentSample ? { content: latestContentSample } : {}),
      fullSnapshotRecommended: true,
      snapshotReasons: ['navigation'],
    };
    for (const waiter of resultWaiters) waiter(completed);
    resultWaiters.clear();
  };
  const scheduleReadinessCheck = (delayMs: number, mode: 'network-idle' | 'content-stable') => {
    if (
      completed ||
      disposed ||
      !started ||
      !documentComplete ||
      !trackNetwork ||
      !networkAvailable ||
      !options.sampleContent
    ) {
      return;
    }
    if (contentTimer) clearTimeout(contentTimer);
    contentTimer = setTimeout(
      async () => {
        contentTimer = undefined;
        if (completed || disposed || contentPollInFlight) return;
        if (mode === 'content-stable' && pendingRequests.size === 0) {
          scheduleNetworkCompletion();
          return;
        }
        if (mode === 'network-idle' && pendingRequests.size > 0) {
          scheduleContentCompletion();
          return;
        }
        const elapsed = performance.now() - startedAt;
        if (mode === 'content-stable' && elapsed < contentReadyAfterMs) {
          scheduleReadinessCheck(contentReadyAfterMs - elapsed, mode);
          return;
        }
        contentPollInFlight = true;
        try {
          latestContentSample = await options.sampleContent?.();
          if (latestContentSample?.ready) {
            finish(true, true, pendingRequests.size > 0 ? 'content-stable' : 'network-idle');
            return;
          }
        } catch {
          latestContentSample = undefined;
        } finally {
          contentPollInFlight = false;
        }
        if (
          pendingRequests.size === 0 &&
          (!latestContentSample ||
            (!latestContentSample.meaningful && !latestContentSample.skeletonVisible))
        ) {
          finish(true, true, 'network-idle');
          return;
        }
        scheduleReadinessCheck(200, pendingRequests.size > 0 ? 'content-stable' : 'network-idle');
      },
      Math.max(0, delayMs),
    );
  };
  const scheduleNetworkCompletion = () => {
    if (completed || disposed || !started || !documentComplete) return;
    if (!trackNetwork || !networkAvailable) {
      finish(true, true, 'load');
      return;
    }
    if (networkIdleTimer) clearTimeout(networkIdleTimer);
    networkIdleTimer = undefined;
    if (pendingRequests.size > 0) return;
    const quietSince = Math.max(documentCompletedAt, lastNetworkActivity);
    const remaining = networkIdleMs - (performance.now() - quietSince);
    if (remaining <= 0) {
      if (options.sampleContent) scheduleReadinessCheck(0, 'network-idle');
      else finish(true, true, 'network-idle');
      return;
    }
    networkIdleTimer = setTimeout(scheduleNetworkCompletion, remaining);
  };
  const scheduleContentCompletion = (delayMs = 0) => {
    if (
      completed ||
      disposed ||
      !started ||
      !documentComplete ||
      !trackNetwork ||
      !networkAvailable ||
      !options.sampleContent ||
      pendingRequests.size === 0
    ) {
      return;
    }
    scheduleReadinessCheck(delayMs, 'content-stable');
  };
  const markStarted = (url?: string, title?: string) => {
    updatePage(url, title);
    notifyStarted();
  };
  const markDocumentComplete = (url?: string, title?: string) => {
    updatePage(url, title);
    notifyStarted();
    documentComplete = true;
    documentCompletedAt = performance.now();
    scheduleNetworkCompletion();
    scheduleContentCompletion();
  };
  const requestStarted = (requestId: string) => {
    if (!trackNetwork || disposed) return;
    pendingRequests.add(requestId);
    networkActivityObserved = true;
    lastNetworkActivity = performance.now();
    if (networkIdleTimer) clearTimeout(networkIdleTimer);
    networkIdleTimer = undefined;
    scheduleContentCompletion();
  };
  const requestFinished = (requestId: string) => {
    if (!pendingRequests.delete(requestId)) return;
    lastNetworkActivity = performance.now();
    scheduleNetworkCompletion();
    scheduleContentCompletion();
  };
  const setNetworkAvailable = (available: boolean) => {
    networkAvailable = trackNetwork && available;
    if (!networkAvailable) {
      pendingRequests.clear();
      lastNetworkActivity = 0;
      scheduleNetworkCompletion();
    }
  };
  const waitForStart = (timeoutMs: number): Promise<boolean> => {
    if (started) return Promise.resolve(true);
    if (timeoutMs <= 0 || disposed) return Promise.resolve(false);
    return new Promise(resolve => {
      const initialDeadline = performance.now() + timeoutMs;
      const hardDeadline = initialDeadline + 4000;
      let timer: ReturnType<typeof setTimeout>;
      const waiter = (didStart: boolean) => {
        clearTimeout(timer);
        startWaiters.delete(waiter);
        resolve(didStart);
      };
      const check = () => {
        if (started) {
          waiter(true);
          return;
        }
        const now = performance.now();
        const networkBusy =
          networkAvailable &&
          (pendingRequests.size > 0 ||
            (networkActivityObserved && now - lastNetworkActivity < 750));
        if (disposed || now >= hardDeadline || (now >= initialDeadline && !networkBusy)) {
          waiter(false);
          return;
        }
        timer = setTimeout(check, 50);
      };
      startWaiters.add(waiter);
      check();
    });
  };
  const waitForResult = (timeoutMs: number): Promise<PageNavigationChange> => {
    if (completed) return Promise.resolve(completed);
    return new Promise(resolve => {
      const waiter = (result: PageNavigationChange) => {
        clearTimeout(timer);
        resultWaiters.delete(waiter);
        resolve(result);
      };
      const timer = setTimeout(() => {
        resultWaiters.delete(waiter);
        finish(documentComplete, false, 'timeout');
        if (completed) resolve(completed);
      }, timeoutMs);
      resultWaiters.add(waiter);
    });
  };
  const waitForNetworkIdle = (timeoutMs: number): Promise<PageNetworkSettlingResult> => {
    const waitStartedAt = performance.now();
    return new Promise(resolve => {
      const finishWait = (ready: boolean, settledBy: PageNetworkSettlingResult['settledBy']) => {
        resolve({
          ready,
          settledBy,
          pendingRequests: pendingRequests.size,
          elapsed: Math.round((performance.now() - waitStartedAt) * 1000) / 1000,
        });
      };
      const check = () => {
        if (disposed || !networkAvailable) {
          finishWait(false, 'unavailable');
          return;
        }
        const now = performance.now();
        if (
          pendingRequests.size === 0 &&
          networkActivityObserved &&
          now - lastNetworkActivity >= networkIdleMs
        ) {
          finishWait(true, 'network-idle');
          return;
        }
        if (now - waitStartedAt >= timeoutMs) {
          finishWait(false, 'timeout');
          return;
        }
        const timer = setTimeout(() => {
          pollTimers.delete(timer);
          check();
        }, 50);
        pollTimers.add(timer);
      };
      check();
    });
  };
  const dispose = () => {
    disposed = true;
    if (networkIdleTimer) clearTimeout(networkIdleTimer);
    if (contentTimer) clearTimeout(contentTimer);
    for (const timer of pollTimers) clearTimeout(timer);
    pollTimers.clear();
    for (const waiter of startWaiters) waiter(false);
    startWaiters.clear();
  };

  return {
    hasStarted: () => started,
    hasNetworkActivity: () => networkActivityObserved,
    updatePage,
    markStarted,
    markDocumentComplete,
    requestStarted,
    requestFinished,
    setNetworkAvailable,
    waitForStart,
    waitForNetworkIdle,
    waitForResult,
    dispose,
  };
}
