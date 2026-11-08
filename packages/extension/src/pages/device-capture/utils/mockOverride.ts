import { CapturedRequest, ResponseOverride } from '../../panel/types';

/** 构建真机抓包 / 代理抓包 mock 使用的 ResponseOverride（与 Panel 字段对齐） */
export function buildMockResponseOverride(
  request: CapturedRequest,
  modifiedData: unknown,
): ResponseOverride {
  return {
    apiName: request.apiName,
    originalData: request.responseOverride?.originalData || request.responseBody,
    modifiedData,
    duration: request.responseOverride?.duration,
    sceneComment: request.responseOverride?.sceneComment,
    mockConfig: request.responseOverride?.mockConfig,
  };
}

/**
 * 新请求入队时：若 map 中有该 api 的 override 则贴上。
 * 无 override 时保留该条已有展示状态，不批量清除。
 */
export function attachOverrideFromMap(
  req: CapturedRequest,
  apiOverrides: Map<string, ResponseOverride> | undefined,
  modificationEnabled: boolean,
): CapturedRequest {
  if (!modificationEnabled) {
    return req.responseOverride ? { ...req, responseOverride: undefined } : req;
  }
  const override = apiOverrides?.get(req.apiName);
  return override ? { ...req, responseOverride: override } : req;
}

/** 重置响应：仅清除指定请求的 override（与 Panel removeResponseOverride 一致） */
export function clearResponseOverrideOnRequest(
  requests: CapturedRequest[],
  requestId: number,
): CapturedRequest[] {
  return requests.map(req => {
    if (req.id !== requestId) return req;
    const preservedDuration = req.responseOverride?.duration ?? req.duration;
    return { ...req, responseOverride: undefined, duration: preservedDuration };
  });
}

/** 关闭「修改」时清除列表中全部 mock 展示层 */
export function clearAllRequestOverrides(requests: CapturedRequest[]): CapturedRequest[] {
  if (!requests.some(r => r.responseOverride)) return requests;
  return requests.map(req =>
    req.responseOverride ? { ...req, responseOverride: undefined } : req,
  );
}

/** 保存 mock 后仅更新当前条展示（与 Panel setResponseOverride 一致） */
export function applyOverrideToRequestById(
  requests: CapturedRequest[],
  requestId: number,
  override: ResponseOverride,
): CapturedRequest[] {
  return requests.map(req => (req.id === requestId ? { ...req, responseOverride: override } : req));
}
