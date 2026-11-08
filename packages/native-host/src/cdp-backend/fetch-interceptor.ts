/** Shared CDP Fetch-domain dispatcher for features that pause network requests. */

import type { PageSession } from './cdp-session.js';

export interface CdpFetchHeader {
  name: string;
  value: string;
}

export interface CdpFetchPauseContext {
  session: PageSession;
  params: any;
  isResponseStage: boolean;
}

export interface CdpFetchPattern {
  urlPattern: string;
  requestStage: 'Request' | 'Response';
  resourceType?: string;
}

export type CdpFetchPauseHandler = (context: CdpFetchPauseContext) => Promise<boolean> | boolean;

interface RegisteredHandler {
  priority: number;
  handler: CdpFetchPauseHandler;
  patterns?: CdpFetchPattern[];
}

interface FetchInterceptionState {
  handlers: Map<string, RegisteredHandler>;
  setupPromise: Promise<void>;
  disposeListener: () => void;
  patternKey: string;
}

let interceptionStates = new WeakMap<PageSession, FetchInterceptionState>();

function continuePausedRequest(
  session: PageSession,
  params: any,
  isResponseStage: boolean,
  headers?: Record<string, string>,
) {
  return session.client
    .sendCommand(isResponseStage ? 'Fetch.continueResponse' : 'Fetch.continueRequest', {
      requestId: params.requestId,
      ...(!isResponseStage &&
        headers && { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) }),
    })
    .catch(() => {});
}

function createInterceptionState(session: PageSession): FetchInterceptionState {
  const handlers = new Map<string, RegisteredHandler>();
  const disposeListener = session.client.on('Fetch.requestPaused', async (params: any) => {
    const originalHeaders = params.request?.headers;
    const isResponseStage = params.responseStatusCode != null || params.responseErrorReason != null;
    const orderedHandlers = [...handlers.values()].sort((a, b) => b.priority - a.priority);
    const context: CdpFetchPauseContext = { session, params, isResponseStage };

    for (const { handler } of orderedHandlers) {
      try {
        if (await handler(context)) return;
      } catch {
        // 单个功能失败时继续交给下一处理器，最终保证请求被恢复。
      }
    }

    // 处理器可替换 request.headers 并返回 false，让后续规则继续组合这些头部。
    await continuePausedRequest(
      session,
      params,
      isResponseStage,
      params.request?.headers !== originalHeaders ? params.request?.headers : undefined,
    );
  });
  const state: FetchInterceptionState = {
    handlers,
    setupPromise: Promise.resolve(),
    disposeListener,
    patternKey: '',
  };
  return state;
}

function synchronizePatterns(session: PageSession, state: FetchInterceptionState): Promise<void> {
  const operation = state.setupPromise
    .catch(() => {})
    .then(async () => {
      const entries = [...state.handlers.values()];
      const patterns = entries.some(entry => !entry.patterns)
        ? [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ]
        : [
            ...new Map(
              entries
                .flatMap(entry => entry.patterns ?? [])
                .map(pattern => [JSON.stringify(pattern), pattern]),
            ).values(),
          ];
      const key = JSON.stringify(patterns);
      if (!patterns.length || key === state.patternKey) return;
      await session.client.sendCommand('Fetch.enable', { patterns });
      state.patternKey = key;
    });
  state.setupPromise = operation;
  return operation;
}

/** 注册一个有序 Fetch 处理器；同一 page session 只启用一个 CDP Fetch 监听器。 */
export async function registerCdpFetchPauseHandler(
  session: PageSession,
  key: string,
  priority: number,
  handler: CdpFetchPauseHandler,
  patterns?: CdpFetchPattern[],
): Promise<void> {
  let state = interceptionStates.get(session);
  if (!state) {
    state = createInterceptionState(session);
    interceptionStates.set(session, state);
  }
  state.handlers.set(key, { priority, handler, patterns });
  try {
    await synchronizePatterns(session, state);
  } catch (error) {
    state.handlers.delete(key);
    if (!state.handlers.size) {
      state.disposeListener();
      interceptionStates.delete(session);
    }
    throw error;
  }
}

/** 移除一个处理器；没有其它功能依赖 Fetch 时恢复 CDP 默认网络行为。 */
export async function unregisterCdpFetchPauseHandler(
  session: PageSession,
  key: string,
): Promise<void> {
  const state = interceptionStates.get(session);
  if (!state) return;
  state.handlers.delete(key);
  if (state.handlers.size > 0) {
    await synchronizePatterns(session, state);
    return;
  }

  await state.setupPromise.catch(() => {});
  if (interceptionStates.get(session) !== state || state.handlers.size > 0) return;
  interceptionStates.delete(session);
  state.disposeListener();
  await session.client.sendCommand('Fetch.disable', {}).catch(() => {});
}

/** browser_release 使用：丢弃指定会话注册表；底层 CDP 连接随后关闭并恢复默认网络行为。 */
export function clearCdpFetchInterceptionState(sessions?: Iterable<PageSession>): void {
  if (!sessions) {
    interceptionStates = new WeakMap();
    return;
  }
  for (const session of sessions) {
    const state = interceptionStates.get(session);
    state?.disposeListener();
    interceptionStates.delete(session);
  }
}

export function ensureCorsHeaders(
  headers: CdpFetchHeader[],
  request: { headers?: Record<string, string> },
): CdpFetchHeader[] {
  const origin = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'origin',
  )?.[1];
  if (!origin) return headers;

  const result = [...headers];
  const setHeader = (name: string, value: string) => {
    const existing = result.find(header => header.name.toLowerCase() === name);
    if (existing) existing.value = value;
    else result.push({ name, value });
  };
  setHeader('access-control-allow-origin', origin);
  setHeader('access-control-allow-credentials', 'true');
  return result;
}
