import {
  installPageObserverInPage,
  disposePageObserverInPage,
  resolvePageObservationWaitOptions,
  type PageChangeSet,
  type PageNavigationChange,
  type PageObservationCheckpoint,
  type PageObservationWaitOptions,
} from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import {
  resolveCdpDeviceShellPageEndpoint,
  sendCdpDeviceShellPageCommand,
  type CdpDeviceShellCommandClient,
} from './device-shell.js';

const INSTALL_PAGE_OBSERVER_SRC = installPageObserverInPage.toString();
const DISPOSE_PAGE_OBSERVER_SRC = disposePageObserverInPage.toString();
const PAGE_OBSERVER_GLOBAL = '__MEARL_PAGE_OBSERVER__';
const observationTargets = new WeakMap<
  PageObservationCheckpoint,
  {
    client: CdpDeviceShellCommandClient;
    frameId?: string;
    url?: string;
    startedAt: number;
  }
>();

function evaluationError(result: any): string | null {
  if (!result.exceptionDetails) return null;
  return (
    result.exceptionDetails.exception?.description ??
    result.exceptionDetails.text ??
    'Page observation evaluation failed'
  );
}

export async function startPageObservation(
  session: PageSession,
): Promise<PageObservationCheckpoint> {
  const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `(${INSTALL_PAGE_OBSERVER_SRC})()`,
    returnByValue: true,
  });
  const error = evaluationError(result);
  if (error) throw new Error(error);
  const checkpoint = result.result?.value as PageObservationCheckpoint | undefined;
  if (!checkpoint || typeof checkpoint.version !== 'number') {
    throw new Error('Page observer did not return a checkpoint');
  }
  const endpoint = await resolveCdpDeviceShellPageEndpoint(session);
  observationTargets.set(checkpoint, { ...endpoint, startedAt: Date.now() });
  return checkpoint;
}

export async function finishPageObservation(
  session: PageSession,
  checkpoint: PageObservationCheckpoint,
  options: PageObservationWaitOptions = {},
): Promise<PageChangeSet | PageNavigationChange> {
  const startedTarget = observationTargets.get(checkpoint);
  const currentTarget = await resolveCdpDeviceShellPageEndpoint(session);
  if (
    startedTarget &&
    currentTarget.url &&
    (currentTarget.client !== startedTarget.client ||
      currentTarget.frameId !== startedTarget.frameId ||
      currentTarget.url !== (startedTarget.url ?? checkpoint.url))
  ) {
    const title = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    })
      .then(result => (typeof result.result?.value === 'string' ? result.result.value : ''))
      .catch(() => '');
    return {
      mode: 'navigation',
      urlBefore: checkpoint.url,
      urlAfter: currentTarget.url,
      title,
      elapsed: Date.now() - startedTarget.startedAt,
      loaded: true,
      ready: true,
      settledBy: 'load',
      pendingRequests: 0,
      fullSnapshotRecommended: true,
      snapshotReasons: ['navigation'],
    };
  }
  const { quietMs, firstChangeTimeoutMs, timeoutMs } = resolvePageObservationWaitOptions(options);
  const expression = `(() => {
    const state = globalThis[${JSON.stringify(PAGE_OBSERVER_GLOBAL)}];
    if (!state || typeof state.waitSince !== 'function') {
      throw new Error('Page observer is unavailable after the action');
    }
    return state.waitSince(
      ${checkpoint.version},
      ${JSON.stringify(checkpoint.focus)},
      ${quietMs},
      ${firstChangeTimeoutMs},
      ${timeoutMs}
    );
  })()`;
  const result = await sendCdpDeviceShellPageCommand(
    session,
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    timeoutMs + 2000,
  );
  const error = evaluationError(result);
  if (error) throw new Error(error);
  const changeSet = result.result?.value as PageChangeSet | undefined;
  if (!changeSet || changeSet.mode !== 'delta') {
    throw new Error('Page observer did not return a change set');
  }
  return changeSet;
}

export async function disposePageObservation(session: PageSession): Promise<void> {
  await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `(${DISPOSE_PAGE_OBSERVER_SRC})()`,
    returnByValue: false,
  }).catch(() => {});
}
