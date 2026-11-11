/**
 * CDP composite action handlers.
 *
 * Provides `run_actions` — sequential batch execution of multiple actions
 * within a single request, sharing the same CDP session — and the observed
 * page-action wrapper that gives page interaction actions their default
 * built-in observation.
 */

import type { CdpSession } from './cdp-session.js';
import {
  captureCheckpoint,
  describePageActionFailure,
  runPageAct,
  splitObservedActionPayload,
  runActionBatch,
  type ControlSource,
  type PageActAction,
  type RunActionsParams,
} from '@mearl/browser-core';
import { dispatchCdpAction } from './action-registry.js';
import { registerActions } from './action-registry.js';
import { ensureControlledIndicator } from './controlled-indicator.js';
import { startCdpNavigationObserver } from './navigation-observer.js';
import {
  disposePageObservation,
  finishPageObservation,
  startPageObservation,
} from './page-observer.js';
import { enrichCdpPageChangeSetWithRefs } from './page-refs.js';
import { collectCdpPageDiagnostics } from './request-handlers.js';
import { getCdpPageDialogs } from './page-dialogs.js';

export async function cdpRunActions(
  session: CdpSession,
  data: RunActionsParams,
  controlSource: ControlSource = 'local',
  deadline?: number,
): Promise<any> {
  return runActionBatch(data, async (action, payload) => ({
    success: true,
    data: await dispatchCdpAction(session, action, payload, controlSource, deadline),
  }));
}

/**
 * Runs a page interaction action with built-in observation. Diagnostics are
 * collected only when the caller requests them.
 * `run_actions` stays lightweight and never enters this wrapper.
 */
export async function cdpObservedPageAction(
  session: CdpSession,
  action: PageActAction,
  data: any,
  controlSource: ControlSource = 'local',
  deadline?: number,
): Promise<any> {
  const { actionData, observe, diagnostics } = splitObservedActionPayload(action, data);
  const { tabId } = actionData;
  const pageSession = await session.getPageSession(tabId);
  const dialogs = getCdpPageDialogs(pageSession);
  if (action === 'page_press' && actionData.dialogId !== undefined) {
    return dispatchCdpAction(session, action, actionData, controlSource, deadline);
  }
  // Keep the controlled favicon installation outside the action's diagnostic boundary.
  await dialogs.command(() => ensureControlledIndicator(pageSession, controlSource));
  if (observe === false) {
    if (!diagnostics)
      return dispatchCdpAction(session, action, actionData, controlSource, deadline);
    const cursor = captureCheckpoint(pageSession.buffers.capture);
    let actionResult: any;
    let actionFailure: ReturnType<typeof describePageActionFailure> | undefined;
    try {
      actionResult = await dispatchCdpAction(session, action, actionData, controlSource, deadline);
    } catch (error) {
      actionFailure = describePageActionFailure(error);
    }
    const result = {
      action: {
        name: action,
        success: actionFailure === undefined,
        ...(actionResult !== undefined ? { data: actionResult } : {}),
        ...(actionFailure ? actionFailure : {}),
      },
    };
    if (actionFailure?.stage === 'precondition') return result;
    return {
      ...result,
      diagnostics: await collectCdpPageDiagnostics(pageSession, cursor, diagnostics),
    };
  }
  let diagnosticsCursor: string | undefined;
  const result = await runPageAct(
    { action, actionData, observe },
    {
      dialogs,
      startObservation: () => startPageObservation(pageSession),
      finishObservation: (checkpoint, options) =>
        finishPageObservation(pageSession, checkpoint, options),
      startNavigationObserver: options =>
        startCdpNavigationObserver(session, pageSession, options.urlBefore, options),
      executeAction: (name, params) => {
        if (diagnostics) diagnosticsCursor = captureCheckpoint(pageSession.buffers.capture);
        return dispatchCdpAction(session, name, { ...params, tabId }, controlSource, deadline);
      },
      finalizeObservation: observation => {
        if (observation.mode === 'delta') {
          return enrichCdpPageChangeSetWithRefs(pageSession, observation);
        }
        return Promise.resolve(observation);
      },
      disposeObservation: () => disposePageObservation(pageSession),
    },
  );
  if (!diagnostics || !diagnosticsCursor || result.action.stage === 'precondition') return result;
  return {
    ...result,
    diagnostics: await collectCdpPageDiagnostics(pageSession, diagnosticsCursor, diagnostics),
  };
}

registerActions([{ name: 'run_actions', session: 'browser', handler: cdpRunActions }]);
