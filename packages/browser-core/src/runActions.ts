import {
  isExtensionBrowserAction,
  validateRequiredActionTabId,
  type RunActionsParams,
} from './browserActionProtocol.js';
import { describePageActionFailure } from './pageAct.js';

export interface BatchStepOutcome {
  success: boolean;
  data?: any;
  error?: string;
  stage?: string;
  attempt?: Record<string, unknown>;
}

export interface BatchStepResult extends BatchStepOutcome {
  step: number;
  action: string;
}

export function validateActionBatch(data: RunActionsParams): void {
  if (!Array.isArray(data.actions) || !data.actions.length)
    throw new Error('actions must be a non-empty array');
  if (data.actions.length > 50) throw new Error('actions array exceeds maximum of 50 steps');
}

/** Backends supply lightweight dispatch; validation and failure reporting stay consistent. */
export async function runActionBatch(
  data: RunActionsParams,
  execute: (action: string, payload: Record<string, any>) => Promise<BatchStepOutcome>,
  options: { beforeStep?: () => void } = {},
) {
  validateActionBatch(data);
  const results: BatchStepResult[] = [];
  for (let index = 0; index < data.actions.length; index++) {
    const step = data.actions[index]!;
    const action = String(step?.action ?? '');
    let validationError: string | undefined;
    if (!action) validationError = 'action must be a non-empty string';
    else if (action.startsWith('__'))
      validationError = `internal action "${action}" is not available to agents`;
    else if (!isExtensionBrowserAction(action)) validationError = `unsupported action "${action}"`;
    else if (action === 'run_actions')
      validationError = `composite action "${action}" is not allowed in run_actions`;
    else if (action === 'browser_release' || action === 'get_capabilities')
      validationError = `browser-level action "${action}" is not allowed in run_actions`;
    if (validationError)
      return {
        results,
        completedSteps: index,
        totalSteps: data.actions.length,
        failedStep: index,
        error: `Step ${index}: ${validationError}`,
      };
    const payload = { ...step.data };
    if (payload.tabId === undefined && data.tabId !== undefined) payload.tabId = data.tabId;
    let outcome: BatchStepOutcome;
    try {
      options.beforeStep?.();
      validateRequiredActionTabId(action, payload);
      outcome = await execute(action, payload);
    } catch (error) {
      outcome = { success: false, ...describePageActionFailure(error) };
    }
    results.push({ ...outcome, step: index, action });
    if (!outcome.success) {
      const { error, stage, attempt } = outcome;
      return {
        results,
        completedSteps: index,
        totalSteps: data.actions.length,
        failedStep: index,
        error,
        ...(stage ? { stage } : {}),
        ...(attempt ? { attempt } : {}),
      };
    }
  }
  return { results, completedSteps: results.length, totalSteps: data.actions.length };
}
