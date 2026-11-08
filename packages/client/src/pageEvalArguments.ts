import { randomUUID } from 'node:crypto';
import {
  validatePageUserScriptParams,
  resolvePageEvalExpression,
  type PageEvalParams,
} from '@mearl/browser-core';

const CHUNK_CHARACTERS = 48 * 1024;

/** Serialize page_eval arguments within transport limits while retaining the caller's execution world. */
export async function invokePageEvalWithArgs(
  invoke: (payload: Record<string, unknown>, transfer?: boolean) => Promise<any>,
  params: PageEvalParams,
): Promise<any> {
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0)
    throw new Error('Invalid target tab');
  resolvePageEvalExpression({ expression: params.expression, args: [] });
  if (!Array.isArray(params.args)) throw new Error('page_eval args must be an array');
  if (params.executionWorld !== undefined && !['main', 'isolated'].includes(params.executionWorld))
    throw new Error('Invalid page executionWorld');
  if (params.executionWorld === 'isolated')
    validatePageUserScriptParams({
      tabId: params.tabId,
      worldId: params.worldId ?? '',
      code: params.expression,
    });
  const args = JSON.stringify(params.args);
  if (args.length > 64 * 1024 * 1024)
    throw new Error('Page script arguments must fit within 64 MiB characters');
  const { args: _args, ...request } = params;
  const evaluate = async (expression: string, transfer = false) => {
    const payload = {
      ...request,
      ...(transfer ? { observe: false, diagnostics: false } : {}),
      expression,
    };
    const result = await (transfer ? invoke(payload, true) : invoke(payload));
    if (transfer && result?.action?.success === false)
      throw new Error(result.action.error || 'page_eval failed');
    return result;
  };
  if (args.length + params.expression.length <= CHUNK_CHARACTERS) {
    return evaluate(resolvePageEvalExpression(params));
  }
  const key = JSON.stringify('__mearlPageScriptTransfer_' + randomUUID());
  try {
    for (let offset = 0; offset < args.length; offset += CHUNK_CHARACTERS) {
      await evaluate(
        `void (window[${key}] = (window[${key}] || '') + ${JSON.stringify(args.slice(offset, offset + CHUNK_CHARACTERS))})`,
        true,
      );
    }
    return await evaluate(
      `(() => { const args = JSON.parse(window[${key}]); delete window[${key}]; return (${params.expression})(...args); })()`,
    );
  } finally {
    await evaluate(`delete window[${key}]`, true).catch(() => {});
  }
}
