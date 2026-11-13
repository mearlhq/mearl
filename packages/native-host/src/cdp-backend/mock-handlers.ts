/**
 * CDP mock interception handlers.
 */

import {
  prepareMockResponseHeaders,
  serializeMockResponse,
  setValueByPath,
  type GetMocksParams,
  type SetMockParams,
} from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { registerActions } from './action-registry.js';
import { fulfillCdpDeviceShellDocument } from './device-shell.js';
import {
  ensureCorsHeaders,
  registerCdpFetchPauseHandler,
  type CdpFetchHeader,
  type CdpFetchPauseContext,
} from './fetch-interceptor.js';

// ─── State ────────────────────────────────────────────────────────────────────

interface MockEntry {
  apiName: string;
  responseData: any;
  /** 完整响应时长（毫秒）：mock 的总耗时，绕过真实服务器精确控制 */
  duration?: number;
  /** 生效条件：请求 query / body 字段子集匹配，命中才生效；为空则始终生效 */
  conditions?: Record<string, any>;
  enabled: boolean;
}

// 每个 apiName 一个列表，支持同接口按不同 conditions 配置多条 mock
let mockStores = new WeakMap<PageSession, Map<string, MockEntry[]>>();
function pageMocks(session: PageSession): Map<string, MockEntry[]> {
  let store = mockStores.get(session);
  if (!store) {
    store = new Map();
    mockStores.set(session, store);
  }
  return store;
}
export function clearCdpPageMocks(session: PageSession): void {
  mockStores.delete(session);
}

/** 释放浏览器控制 使用：丢弃所有依赖当前 CDP 会话的 mock 状态。 */
export function clearCdpMockState(): void {
  mockStores = new WeakMap();
}

// ─── Conditions matching（与扩展 shared/isSubset + matchesConditions 行为一致） ──

function tryParseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isSubset(subset: any, superset: any): boolean {
  if (subset === superset) return true;
  if (subset == null || superset == null) return subset === superset;
  if (typeof subset !== 'object' || typeof superset !== 'object') {
    return String(subset) === String(superset);
  }
  if (Array.isArray(subset)) {
    return Array.isArray(superset) && JSON.stringify(subset) === JSON.stringify(superset);
  }
  return Object.entries(subset).every(([key, value]) => {
    if (!(key in superset)) return false;
    return isSubset(value, (superset as Record<string, any>)[key]);
  });
}

function matchesConditions(mock: MockEntry, request: { url?: string; postData?: string }): boolean {
  if (!mock.conditions || Object.keys(mock.conditions).length === 0) return true;

  const requestData: Record<string, any> = {};
  try {
    const url = new URL(request.url ?? '');
    url.searchParams.forEach((value, key) => {
      requestData[key] = tryParseJson(value);
    });
  } catch {
    /* ignore */
  }
  if (request.postData) {
    try {
      const json = JSON.parse(request.postData);
      if (typeof json === 'object' && json !== null) {
        Object.assign(requestData, json);
      }
    } catch {
      try {
        new URLSearchParams(request.postData).forEach((value, key) => {
          requestData[key] = tryParseJson(value);
        });
      } catch {
        /* ignore */
      }
    }
  }

  if (isSubset(mock.conditions, requestData)) return true;
  // 兼容简写：条件直接写 data 内层字段时，也尝试匹配 requestData.data
  if (requestData.data && typeof requestData.data === 'object') {
    return isSubset(mock.conditions, requestData.data);
  }
  return false;
}

// 找到该请求命中的 mock（按 apiName 子串匹配 + conditions，取插入顺序首个）
function findMatchedMock(session: PageSession, url: string, postData?: string): MockEntry | null {
  for (const list of pageMocks(session).values()) {
    for (const mock of list) {
      if (
        mock.enabled &&
        (url.includes(`/${mock.apiName}/`) || url.includes(mock.apiName)) &&
        matchesConditions(mock, { url, postData })
      ) {
        return mock;
      }
    }
  }
  return null;
}

// 生效条件是否等价（均空 / 同键同值），用于去重复用
function sameConditions(a?: Record<string, any>, b?: Record<string, any>): boolean {
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length === 0 || bKeys.length === 0) return aKeys.length === 0 && bKeys.length === 0;
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => JSON.stringify(a![k]) === JSON.stringify(b![k]));
}

// ─── Interception setup ───────────────────────────────────────────────────────

async function handleMockRequest({
  session,
  params,
  isResponseStage,
}: CdpFetchPauseContext): Promise<boolean> {
  const url: string = params.request?.url ?? '';

  // 预检请求与业务请求可能使用完全相同的 URL。替换 OPTIONS 会丢失服务端 CORS
  // 响应头，使真正的业务请求在发送前就被浏览器拦截。
  if (params.request?.method === 'OPTIONS') {
    return false;
  }

  const matchedMock = findMatchedMock(session, url, params.request?.postData);

  const fulfillMock = async (
    mock: MockEntry,
    responseCode: number,
    responseHeaders: CdpFetchHeader[],
  ) => {
    const { body: responseBody } = serializeMockResponse(url, mock.responseData);
    const base64Body = Buffer.from(responseBody, 'utf-8').toString('base64');
    if (
      await fulfillCdpDeviceShellDocument(session, params, {
        responseCode,
        responseHeaders,
        body: base64Body,
      })
    )
      return;
    await session.client.sendCommand('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode,
      responseHeaders,
      body: base64Body,
    });
  };

  if (!matchedMock) {
    return false;
  }

  try {
    if (!isResponseStage) {
      // 请求阶段：配置了 duration 则 sleep 后直接 fulfill，绕过真实服务器（总耗时 == duration）
      if (matchedMock.duration !== undefined) {
        if (matchedMock.duration > 0) {
          await new Promise(r => setTimeout(r, matchedMock!.duration));
        }
        const { isJsonp } = serializeMockResponse(url, matchedMock.responseData);
        const responseHeaders = prepareMockResponseHeaders(
          [
            { name: 'content-type', value: 'application/json; charset=utf-8' },
            { name: 'x-mock-by', value: 'mearl-cdp' },
          ],
          isJsonp,
        );
        await fulfillMock(matchedMock, 200, ensureCorsHeaders(responseHeaders, params.request));
      } else {
        // 未配置 duration：交还调度器放行到服务器，响应阶段再替换 mock 内容
        return false;
      }
      return true;
    }
    if (matchedMock.duration !== undefined) return false;
    const { isJsonp } = serializeMockResponse(url, matchedMock.responseData);
    await fulfillMock(
      matchedMock,
      params.responseStatusCode ?? 200,
      ensureCorsHeaders(
        prepareMockResponseHeaders(params.responseHeaders, isJsonp),
        params.request,
      ),
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureMockInterception(session: PageSession): Promise<void> {
  await registerCdpFetchPauseHandler(session, 'mock', 100, handleMockRequest);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function cdpSetMock(session: PageSession, data: SetMockParams): Promise<any> {
  const { apiName, mockData, fields, enabled, duration, conditions } = data;
  const mockStore = pageMocks(session);

  if (!apiName || typeof apiName !== 'string' || apiName.trim() === '') {
    throw new Error('Invalid apiName');
  }

  // enabled 省略时默认启用；仅显式 false 才禁用（清除该接口全部 mock）
  if (enabled === false) {
    mockStore.delete(apiName);
    return { success: true, affectedCount: 1, message: `Mock disabled for ${apiName}` };
  }

  if (mockData === undefined && (!fields || fields.length === 0)) {
    throw new Error('Either mockData or fields must be provided');
  }

  if (fields && fields.length > 100) {
    throw new Error('Too many fields: maximum 100 fields allowed');
  }

  const normConditions = conditions && Object.keys(conditions).length > 0 ? conditions : undefined;
  let finalMockData = mockData;

  if (fields && fields.length > 0) {
    const conditionMatcher: MockEntry = {
      apiName,
      responseData: null,
      conditions: normConditions,
      enabled: true,
    };
    const baseRequest = [...session.buffers.requests].reverse().find(
      request =>
        request.method !== 'OPTIONS' &&
        request.responseBody !== null &&
        request.responseBody !== undefined &&
        (request.apiName?.includes(apiName) || request.url?.includes(apiName)) &&
        matchesConditions(conditionMatcher, {
          url: request.url,
          postData: typeof request.postData === 'string' ? request.postData : undefined,
        }),
    );

    finalMockData = baseRequest?.responseBody
      ? JSON.parse(JSON.stringify(baseRequest.responseBody))
      : {};

    for (const field of fields) {
      setValueByPath(finalMockData, field.path, field.value);
    }
  }

  const entry: MockEntry = {
    apiName,
    responseData: finalMockData,
    duration,
    conditions: normConditions,
    enabled: true,
  };

  // 同接口下按 conditions 去重：命中同条件则替换，否则追加（支持多条不同条件的 mock）
  const list = mockStore.get(apiName) ?? [];
  const idx = list.findIndex(m => sameConditions(m.conditions, normConditions));
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }
  mockStore.set(apiName, list);

  await ensureMockInterception(session);

  return {
    success: true,
    affectedCount: 1,
    message: `Mock set for ${apiName}`,
  };
}

export function cdpGetMocks(session: PageSession, data: GetMocksParams): any {
  const mockStore = pageMocks(session);
  const matcher = data?.apiName ? new RegExp(data.apiName, 'i') : null;
  const mocks = [...mockStore.values()]
    .flat()
    .filter(m => !matcher || matcher.test(m.apiName))
    .map(m => ({
      apiName: m.apiName,
      responseData: m.responseData,
      duration: m.duration ?? 0,
      conditions: m.conditions,
      disabled: !m.enabled,
    }));
  return { mocks, count: mocks.length };
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerActions([
  { name: 'set_mock', session: 'page', handler: cdpSetMock },
  { name: 'get_mocks', session: 'page', handler: async (s, d) => cdpGetMocks(s, d) },
]);
