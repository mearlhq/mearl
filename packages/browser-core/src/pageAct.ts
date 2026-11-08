import {
  resolveNavigationWaitOptions,
  shouldWaitForPotentialNavigation,
  type PageChangeSet,
  type PageNavigationChange,
  type PageNetworkSettlingResult,
  type PageOpenedTab,
  type PageObservationCheckpoint,
  type PageSnapshotReason,
} from './pageObserver.js';
import {
  PAGE_ACT_ACTIONS,
  type PageActAction,
  type PageDiagnosticsOptions,
  type PageDiagnosticsSetting,
  type PageObservationWaitOptions,
} from './browserActionProtocol.js';

const DEFAULT_PAGE_DIAGNOSTICS: PageDiagnosticsOptions = {
  logs: true,
  requests: true,
};

export type PageActionFailureStage = 'precondition' | 'dispatch-uncertain';
export type PageActionAttempt = Record<string, unknown>;

/**
 * Identifies failures found before an action emits input or mutates the page.
 * The string marker keeps the classification intact across package bundles.
 */
export class PageActionPreconditionError extends Error {
  readonly pageActionFailureStage = 'precondition' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PageActionPreconditionError';
  }
}

/**
 * Identifies an input command whose acknowledgement failed after the browser may
 * already have received it. Callers must verify the observation before retrying.
 */
export class PageActionDispatchUncertainError extends Error {
  readonly pageActionFailureStage = 'dispatch-uncertain' as const;
  readonly pageActionAttempt?: PageActionAttempt;

  constructor(message: string, options?: ErrorOptions & { attempt?: PageActionAttempt }) {
    super(message, options);
    this.name = 'PageActionDispatchUncertainError';
    this.pageActionAttempt = options?.attempt;
  }
}

export function isPageActionPreconditionError(
  error: unknown,
): error is PageActionPreconditionError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { pageActionFailureStage?: unknown }).pageActionFailureStage === 'precondition'
  );
}

export function isPageActionDispatchUncertainError(
  error: unknown,
): error is PageActionDispatchUncertainError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { pageActionFailureStage?: unknown }).pageActionFailureStage === 'dispatch-uncertain'
  );
}

/** Preserve serializable dispatch evidence while an uncertain failure crosses handler layers. */
export function withPageActionDispatchAttempt(error: unknown, attempt: PageActionAttempt): unknown {
  if (!isPageActionDispatchUncertainError(error)) return error;
  return new PageActionDispatchUncertainError(error.message, {
    cause: error,
    attempt: { ...(error.pageActionAttempt ?? {}), ...attempt },
  });
}

/** Dispatch a press/release pair in order without letting a stalled press strand the pointer. */
export async function dispatchPairedPageInputCommands(
  sendPress: () => Promise<void>,
  sendRelease: () => Promise<void>,
): Promise<void> {
  const settle = async (send: () => Promise<void>): Promise<PromiseSettledResult<void>> => {
    try {
      await send();
      return { status: 'fulfilled', value: undefined };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  };

  const pressResultPromise = settle(sendPress);
  // chrome.debugger can stall both acknowledgements when paired input commands are submitted in
  // the same task. A task boundary keeps their order while still releasing a delivered press.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const releaseResultPromise = settle(sendRelease);
  const [pressResult, releaseResult] = await Promise.all([
    pressResultPromise,
    releaseResultPromise,
  ]);
  const failure =
    pressResult.status === 'rejected'
      ? pressResult.reason
      : releaseResult.status === 'rejected'
        ? releaseResult.reason
        : undefined;
  if (failure === undefined) return;

  const describeStatus = (result: PromiseSettledResult<void>): string =>
    result.status === 'fulfilled'
      ? 'acknowledged'
      : isPageActionDispatchUncertainError(result.reason)
        ? 'uncertain'
        : 'failed';
  throw withPageActionDispatchAttempt(failure, {
    inputSequence: {
      press: describeStatus(pressResult),
      release: describeStatus(releaseResult),
    },
  });
}

export function asPageActionPreconditionError(error: unknown): PageActionPreconditionError {
  if (isPageActionPreconditionError(error)) return error;
  return new PageActionPreconditionError(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

export function checkPageActionPrecondition<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw asPageActionPreconditionError(error);
  }
}

export function describePageActionFailure(error: unknown): {
  error: string;
  stage?: PageActionFailureStage;
  attempt?: PageActionAttempt;
} {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(isPageActionPreconditionError(error) || isPageActionDispatchUncertainError(error)
      ? { stage: error.pageActionFailureStage }
      : {}),
    ...(isPageActionDispatchUncertainError(error) && error.pageActionAttempt
      ? { attempt: error.pageActionAttempt }
      : {}),
  };
}

/**
 * Page actions supported by the shared wrapper. Interaction actions observe
 * by default. Diagnostics and page_eval observation are opt-in.
 */
export function isPageActAction(action: string): action is PageActAction {
  return PAGE_ACT_ACTIONS.includes(action as PageActAction);
}

/** Whether one public action call should enter the shared observation wrapper. */
export function shouldObservePageAction(
  action: string,
  data: Record<string, any> | undefined | null,
): action is PageActAction {
  if (!isPageActAction(action)) return false;
  const diagnosticsSetting = data?.diagnostics;
  const diagnosticsEnabled =
    diagnosticsSetting === true ||
    (diagnosticsSetting !== null &&
      typeof diagnosticsSetting === 'object' &&
      !Array.isArray(diagnosticsSetting));
  if (action === 'page_eval') {
    return Boolean(
      diagnosticsEnabled ||
      (data?.observe && typeof data.observe === 'object' && !Array.isArray(data.observe)),
    );
  }
  return data?.observe !== false || diagnosticsEnabled;
}

/**
 * Splits a flat observed-action payload into raw action, observation, and
 * diagnostic settings. Interaction observation defaults on; diagnostics are
 * collected only when explicitly requested.
 */
export function splitObservedActionPayload(
  action: PageActAction,
  data: Record<string, any> | undefined | null,
): {
  actionData: Record<string, any>;
  observe: PageObservationWaitOptions | false;
  diagnostics?: PageDiagnosticsOptions;
} {
  const { observe, diagnostics, ...actionData } = data ?? {};
  const setting = diagnostics as PageDiagnosticsSetting | undefined;
  const resolvedDiagnostics =
    setting === false
      ? undefined
      : setting === true
        ? DEFAULT_PAGE_DIAGNOSTICS
        : setting && typeof setting === 'object' && !Array.isArray(setting)
          ? setting
          : undefined;
  if (observe === false) return { actionData, observe: false, diagnostics: resolvedDiagnostics };
  if (action === 'page_eval' && (!observe || typeof observe !== 'object')) {
    return { actionData, observe: false, diagnostics: resolvedDiagnostics };
  }
  return {
    actionData,
    observe: observe && typeof observe === 'object' && !Array.isArray(observe) ? observe : {},
    diagnostics: resolvedDiagnostics,
  };
}

export interface PageActNavigationObserver {
  hasStarted(): boolean;
  hasNetworkActivity(): boolean;
  waitForStart(timeoutMs: number): Promise<boolean>;
  waitForNetworkIdle(timeoutMs: number): Promise<PageNetworkSettlingResult>;
  waitForResult(timeoutMs: number): Promise<PageNavigationChange>;
  getOpenedTabs(timeoutMs: number): Promise<PageOpenedTab[]>;
  dispose(): void | Promise<void>;
}

export interface PageActDependencies {
  dialogs?: import('./pageDialog.js').PageDialogState;
  startObservation(): Promise<PageObservationCheckpoint>;
  finishObservation(
    checkpoint: PageObservationCheckpoint,
    options: PageObservationWaitOptions,
  ): Promise<PageActObservation>;
  startNavigationObserver(options: {
    urlBefore: string;
    trackNetwork: boolean;
    networkIdleMs: number;
    contentReadyAfterMs: number;
    trackOpenedTabs: boolean;
    sourceTabId?: number;
  }): Promise<PageActNavigationObserver>;
  detectNavigation?(
    checkpoint: PageObservationCheckpoint,
    timeoutMs: number,
  ): Promise<PageNavigationChange | null>;
  executeAction(action: PageActAction, actionData: Record<string, any>): Promise<any>;
  finalizeObservation?(observation: PageActObservation): Promise<PageActObservation>;
  disposeObservation?(): void | Promise<void>;
}

interface PageActUnavailableObservation {
  mode: 'unavailable';
  checkpoint: number;
  urlBefore: string;
  error: string;
  fullSnapshotRecommended: true;
  snapshotReasons: ['observer-unavailable'];
  network?: PageNetworkSettlingResult;
  openedTabs?: PageOpenedTab[];
}

export type PageActObservation =
  | PageChangeSet
  | PageNavigationChange
  | PageActUnavailableObservation;

export type PageActObservationResponse =
  | (Omit<PageChangeSet, 'url' | 'title'> & Partial<Pick<PageChangeSet, 'url' | 'title'>>)
  | PageNavigationChange
  | PageActUnavailableObservation;

export interface PageActResult {
  dialog?: import('./pageDialog.js').PageDialogInfo;
  action: {
    name: string;
    success: boolean;
    data?: any;
    error?: string;
    stage?: PageActionFailureStage;
    attempt?: PageActionAttempt;
  };
  observation?: PageActObservationResponse;
}

function unavailableObservation(
  checkpoint: PageObservationCheckpoint,
  error: unknown,
): PageActUnavailableObservation {
  return {
    mode: 'unavailable',
    checkpoint: checkpoint.version,
    urlBefore: checkpoint.url,
    error: error instanceof Error ? error.message : String(error),
    fullSnapshotRecommended: true,
    snapshotReasons: ['observer-unavailable'],
  };
}

function addSnapshotReason(
  observation: PageActObservation,
  reason: PageSnapshotReason,
): PageActObservation {
  if (observation.mode === 'navigation') return observation;
  const reasons = new Set<PageSnapshotReason>([...(observation.snapshotReasons ?? []), reason]);
  return {
    ...observation,
    fullSnapshotRecommended: true,
    snapshotReasons: Array.from(reasons),
  } as PageActObservation;
}

/**
 * CDP may lose the action's execution context after input has already caused a
 * navigation. The failure is recoverable only when the navigation observer
 * independently confirms that a transition started.
 */
function isNavigationInterruptedActionFailure(
  failure: ReturnType<typeof describePageActionFailure> | undefined,
): boolean {
  if (!failure || failure.stage === 'precondition') return false;
  return /Detached while handling command|Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/i.test(
    failure.error,
  );
}

function compactObservationResponse(
  observation: PageActObservation,
  checkpoint: PageObservationCheckpoint,
): PageActObservationResponse {
  if (observation.mode !== 'delta') return observation;
  const { url, title, ...compact } = observation;
  return {
    ...compact,
    ...(url !== checkpoint.url ? { url } : {}),
    ...(title !== checkpoint.title ? { title } : {}),
  };
}

export async function runPageAct(
  input: {
    action: string;
    actionData?: Record<string, any>;
    observe?: PageObservationWaitOptions;
  },
  dependencies: PageActDependencies,
): Promise<PageActResult> {
  const { action, actionData = {}, observe = {} } = input;
  if (!PAGE_ACT_ACTIONS.includes(action as PageActAction)) {
    throw new Error(`observed page action must be one of: ${PAGE_ACT_ACTIONS.join(', ')}`);
  }
  if (!actionData || typeof actionData !== 'object' || Array.isArray(actionData)) {
    throw new Error('actionData must be an object');
  }

  const typedAction = action as PageActAction;
  const dialogs = dependencies.dialogs;
  const guarded = <T>(work: () => Promise<T>): Promise<T> => dialogs ? dialogs.command(work) : work();
  const dialogResult = (failure?: ReturnType<typeof describePageActionFailure>, data?: any): PageActResult => ({
    action: { name: typedAction, success: !failure, ...(data !== undefined ? { data } : {}), ...failure },
    ...(dialogs?.info() ? { dialog: dialogs.info() } : {}),
  });
  let checkpoint: PageObservationCheckpoint;
  try { checkpoint = await guarded(() => dependencies.startObservation()); }
  catch (error) {
    if (!dialogs?.pending) throw error;
    return dialogResult({ ...describePageActionFailure(error), stage: 'precondition' });
  }
  const navigationOptions = resolveNavigationWaitOptions(observe);
  const sourceTabId =
    typeof actionData.tabId === 'number' && Number.isInteger(actionData.tabId)
      ? actionData.tabId
      : undefined;
  const navigationObserver = await dependencies
    .startNavigationObserver({
      urlBefore: checkpoint.url,
      trackNetwork: true,
      networkIdleMs: navigationOptions.networkIdleMs,
      contentReadyAfterMs: navigationOptions.contentReadyAfterMs,
      trackOpenedTabs:
        typedAction === 'page_click' || typedAction === 'page_press' || typedAction === 'page_eval',
      sourceTabId,
    })
    .catch(() => null);

  let actionResult: any;
  let actionFailure: ReturnType<typeof describePageActionFailure> | undefined;
  try {
    actionResult = await dependencies.executeAction(typedAction, actionData);
  } catch (error) {
    actionFailure = describePageActionFailure(error);
  }

  const dispose = () => Promise.allSettled([
    Promise.resolve().then(() => navigationObserver?.dispose()),
    Promise.resolve().then(() => dependencies.disposeObservation?.()),
  ]);
  if (dialogs?.pending) {
    await dispose();
    return dialogResult(actionFailure, actionResult);
  }

  if (actionFailure?.stage === 'precondition') {
    await Promise.allSettled([
      Promise.resolve().then(() => navigationObserver?.dispose()),
      Promise.resolve().then(() => dependencies.disposeObservation?.()),
    ]);
    return {
      action: {
        name: typedAction,
        success: false,
        error: actionFailure.error,
        stage: actionFailure.stage,
      },
    };
  }

  let observation: PageActObservation;
  try {
    observation = await guarded(() => dependencies.finishObservation(checkpoint, observe));
  } catch (error) {
    observation = unavailableObservation(checkpoint, error);
  }
  if (dialogs?.pending) {
    await dispose();
    return dialogResult(actionFailure, actionResult);
  }
  const navigationInterruptedAction = isNavigationInterruptedActionFailure(actionFailure);
  if (navigationInterruptedAction && observation.mode === 'navigation') {
    actionFailure = undefined;
  }

  try {
    if (
      dependencies.detectNavigation &&
      observation.mode !== 'navigation' &&
      (actionFailure === undefined || navigationInterruptedAction) &&
      shouldWaitForPotentialNavigation(typedAction, observation)
    ) {
      const detectedNavigation = await dependencies
        .detectNavigation(checkpoint, navigationOptions.graceMs)
        .catch(() => null);
      if (detectedNavigation) {
        observation = detectedNavigation;
        if (navigationInterruptedAction) actionFailure = undefined;
      }
    }

    if (
      navigationObserver &&
      observation.mode !== 'navigation' &&
      (actionFailure === undefined || navigationInterruptedAction) &&
      (navigationObserver.hasStarted() ||
        shouldWaitForPotentialNavigation(typedAction, observation))
    ) {
      const didNavigate =
        navigationObserver.hasStarted() ||
        (await guarded(() => navigationObserver.waitForStart(navigationOptions.graceMs)));
      if (didNavigate) {
        observation = await guarded(() => navigationObserver.waitForResult(navigationOptions.timeoutMs));
      }
    }

    if (
      navigationObserver &&
      (actionFailure === undefined || navigationInterruptedAction) &&
      observation.mode !== 'navigation' &&
      navigationObserver.hasNetworkActivity()
    ) {
      const network = await guarded(() => navigationObserver.waitForNetworkIdle(navigationOptions.timeoutMs));
      if (navigationObserver.hasStarted()) {
        observation = await guarded(() => navigationObserver.waitForResult(navigationOptions.timeoutMs));
      } else {
        try {
          observation = await guarded(() => dependencies.finishObservation(checkpoint, observe));
        } catch (error) {
          observation = unavailableObservation(checkpoint, error);
        }
        if (observation.mode !== 'navigation') {
          observation.network = network;
          if (!network.ready) observation = addSnapshotReason(observation, 'network-pending');
        }
      }
    }
    if (navigationInterruptedAction && observation.mode === 'navigation') {
      actionFailure = undefined;
    }

    if (dependencies.finalizeObservation) {
      try {
        observation = await guarded(() => dependencies.finalizeObservation!(observation));
      } catch {
        // Ref enrichment and other response finalizers are best-effort and must
        // never turn a successful page action into a failed action.
      }
    }

    if (navigationObserver) {
      const openedTabs = await guarded(() => navigationObserver.getOpenedTabs(navigationOptions.timeoutMs))
        .catch(() => []);
      if (openedTabs.length > 0) observation = { ...observation, openedTabs };
    }
  } catch (error) {
    if (!dialogs?.pending) throw error;
    return dialogResult(actionFailure, actionResult);
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => navigationObserver?.dispose()),
      Promise.resolve().then(() => dependencies.disposeObservation?.()),
    ]);
  }

  if (dialogs?.pending) return dialogResult(actionFailure, actionResult);

  return {
    action: {
      name: typedAction,
      success: actionFailure === undefined,
      ...(actionResult !== undefined ? { data: actionResult } : {}),
      ...(actionFailure ? actionFailure : {}),
    },
    observation: compactObservationResponse(observation, checkpoint),
  };
}
