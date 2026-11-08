import { describe, it, expect } from 'vitest';
import {
  attachOverrideFromMap,
  clearResponseOverrideOnRequest,
  applyOverrideToRequestById,
} from '../utils/mockOverride';
import { CapturedRequest, ResponseOverride } from '../../panel/types';

const baseReq = (id: number, apiName: string): CapturedRequest =>
  ({
    id,
    apiName,
    url: `https://example.com/${apiName}`,
    responseBody: { ok: true },
    duration: 100,
  }) as CapturedRequest;

describe('mockOverride helpers', () => {
  it('clearResponseOverrideOnRequest 仅清除指定 id', () => {
    const override = { apiName: 'a', modifiedData: {} } as ResponseOverride;
    const requests = [
      { ...baseReq(1, 'a'), responseOverride: override },
      { ...baseReq(2, 'a'), responseOverride: override },
    ];
    const next = clearResponseOverrideOnRequest(requests, 1);
    expect(next[0].responseOverride).toBeUndefined();
    expect(next[1].responseOverride).toBe(override);
  });

  it('clearResponseOverrideOnRequest 用 override.duration 兜底 duration', () => {
    const requests = [
      {
        ...baseReq(1, 'a'),
        duration: 100,
        responseOverride: { apiName: 'a', modifiedData: {}, duration: 500 } as ResponseOverride,
      },
    ];
    const next = clearResponseOverrideOnRequest(requests, 1);
    expect(next[0].duration).toBe(500);
  });

  it('attachOverrideFromMap 无 map 项时不改动已有 override', () => {
    const override = { apiName: 'a', modifiedData: { x: 1 } } as ResponseOverride;
    const req = { ...baseReq(1, 'a'), responseOverride: override };
    const next = attachOverrideFromMap(req, new Map(), true);
    expect(next.responseOverride).toBe(override);
  });

  it('applyOverrideToRequestById 仅更新指定 id', () => {
    const override = { apiName: 'a', modifiedData: { n: 1 } } as ResponseOverride;
    const requests = [baseReq(1, 'a'), baseReq(2, 'a')];
    const next = applyOverrideToRequestById(requests, 2, override);
    expect(next[0].responseOverride).toBeUndefined();
    expect(next[1].responseOverride).toBe(override);
  });
});
