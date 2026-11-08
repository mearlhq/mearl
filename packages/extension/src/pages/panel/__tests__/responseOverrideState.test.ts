import { describe, expect, it } from 'vitest';
import { CapturedRequest, ResponseOverride } from '../types';
import { clearRemovedResponseOverride } from '../utils/responseOverrideState';

const request = (id: number, apiName: string, responseOverride?: ResponseOverride): CapturedRequest =>
  ({
    id,
    apiName,
    duration: 100,
    responseOverride,
  }) as CapturedRequest;

describe('clearRemovedResponseOverride', () => {
  it('应清理刷新前后共享同一 override 的请求', () => {
    const removed = {
      id: 'override-1',
      apiName: 'mtop.test',
      modifiedData: { value: 2 },
      duration: 500,
    } as ResponseOverride;
    const other = {
      id: 'override-2',
      apiName: 'mtop.test',
      modifiedData: { value: 3 },
    } as ResponseOverride;

    const next = clearRemovedResponseOverride(
      [
        request(1, 'mtop.test', removed),
        request(2, 'mtop.test', { ...removed }),
        request(3, 'mtop.test', other),
      ],
      'mtop.test',
      removed,
    );

    expect(next[0].responseOverride).toBeUndefined();
    expect(next[1].responseOverride).toBeUndefined();
    expect(next[0].duration).toBe(500);
    expect(next[1].duration).toBe(500);
    expect(next[2].responseOverride).toBe(other);
  });

  it('无 id 时应清理该 API 的全部关联状态', () => {
    const removed = {
      apiName: 'mtop.test',
      modifiedData: { value: 2 },
    } as ResponseOverride;
    const next = clearRemovedResponseOverride(
      [request(1, 'mtop.test', removed), request(2, 'mtop.other', removed)],
      'mtop.test',
      removed,
    );

    expect(next[0].responseOverride).toBeUndefined();
    expect(next[1].responseOverride).toBe(removed);
  });
});
