/**
 * Agent handlers: set_mock, get_mocks
 */

import type { GetMocksParams, SetMockParams } from '@mearl/browser-core';
import { setValueByPath } from '../requestBuffer';
import { ResponseOverride } from '../../../shared/types';
import { splitMockConditions } from '../../../shared/mockConditions';
import { setResponseOverride, getOverrides, removeResponseOverride } from '../debuggerManager';
import { notifyPanelOverrideChanged } from '../overrideNotifier';
import type { AgentHandlerContext } from './types';

// 判断两个生效条件是否等价（均空 / 同键同值），用于复用已有 override
function sameConditions(a?: Record<string, any>, b?: Record<string, any>): boolean {
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length === 0 || bKeys.length === 0) return aKeys.length === 0 && bKeys.length === 0;
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => JSON.stringify(a![k]) === JSON.stringify(b![k]));
}

// ─── set_mock ─────────────────────────────────────────────────────────────────

export async function handleSetMock(
  data: SetMockParams,
  ctx: AgentHandlerContext,
): Promise<{ success: boolean; affectedCount: number; message: string }> {
  const { apiName, mockData, fields, enabled, duration, conditions } = data;

  if (!apiName || typeof apiName !== 'string' || apiName.trim() === '') {
    throw new Error('Invalid apiName: apiName must be a non-empty string');
  }

  const tabId = data.tabId;

  // enabled 省略时默认启用；仅显式 false 才禁用（与文档 / MCP 层默认一致）
  if (enabled === false) {
    removeResponseOverride(tabId, apiName);
    notifyPanelOverrideChanged(tabId);
    return { success: true, affectedCount: 1, message: `Mock disabled for ${apiName}` };
  }

  if (mockData === undefined && (!fields || fields.length === 0)) {
    throw new Error('Either mockData or fields must be provided');
  }

  if (fields && fields.length > 100) {
    throw new Error('Too many fields: maximum 100 fields allowed');
  }

  let finalMockData = mockData;

  if (fields && fields.length > 0) {
    try {
      const bodyResult = await ctx.queryPanel(tabId, { type: 'getRequestBody', apiName });
      if (bodyResult?.responseBody) {
        finalMockData = JSON.parse(JSON.stringify(bodyResult.responseBody));
      } else {
        finalMockData = {};
      }
    } catch {
      finalMockData = {};
    }

    for (const field of fields) {
      setValueByPath(finalMockData, field.path, field.value);
    }
  }

  // 生效条件：空对象视为「无条件」（始终生效）
  const normConditions = conditions && Object.keys(conditions).length > 0 ? conditions : undefined;
  const { sequenceIndex } = splitMockConditions(normConditions);
  if (sequenceIndex !== undefined && (!Number.isInteger(sequenceIndex) || sequenceIndex < 0)) {
    throw new Error('$index must be a non-negative integer');
  }
  // 复用同 API + 同条件的已有 override id，命中则原地替换，避免重复堆积；
  // 无匹配时不带 id，由 setResponseOverride 兜底（无条件项替换 / 有条件项追加）
  const existingId = getOverrides(tabId).find(
    o =>
      o.apiName.toLowerCase() === apiName.toLowerCase() &&
      sameConditions(o.conditions, normConditions),
  )?.id;

  const override: ResponseOverride = {
    id: existingId,
    apiName,
    url: '',
    originalData: null,
    modifiedData: finalMockData,
    responseData: finalMockData,
    duration,
    conditions: normConditions,
    disabled: false,
  };

  try {
    await setResponseOverride(tabId, override);
    notifyPanelOverrideChanged(tabId);
  } catch (error) {
    throw new Error(
      `Failed to set override: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return { success: true, affectedCount: 1, message: `Mock enabled for ${apiName}` };
}

// ─── get_mocks ────────────────────────────────────────────────────────────────

export async function handleGetMocks(
  data: GetMocksParams,
  _ctx: AgentHandlerContext,
): Promise<{
  mocks: Array<{
    apiName: string;
    disabled: boolean;
    duration?: number;
    conditions?: Record<string, any>;
    mockData: any;
  }>;
}> {
  const tabId = data.tabId;

  let overrides = getOverrides(tabId);

  if (data.apiName) {
    const pattern = new RegExp(data.apiName, 'i');
    overrides = overrides.filter(o => pattern.test(o.apiName));
  }

  const mocks = overrides.map(o => ({
    apiName: o.apiName,
    disabled: o.disabled ?? false,
    duration: o.duration,
    conditions: o.conditions,
    mockData: o.modifiedData ?? o.responseData,
  }));

  return { mocks };
}
