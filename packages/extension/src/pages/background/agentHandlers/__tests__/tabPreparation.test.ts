import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ collect: vi.fn(), mark: vi.fn() }));
vi.mock('../../backgroundRequestCollector', () => ({ startRequestCollection: mocks.collect }));
vi.mock('../controlledTabs', () => ({ markTabControlled: mocks.mark }));
import { prepareTabForAgent, prepareTabForCapture } from '../tabPreparation';

afterEach(() => vi.clearAllMocks());

describe('page preparation ownership', () => {
  it('arms collection without claiming automation ownership', async () => {
    await prepareTabForCapture(7);
    expect(mocks.collect).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it('keeps ordinary automation ownership before collection', async () => {
    await prepareTabForAgent(7, 'remote');
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith(7, 'remote');
    expect(mocks.collect).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.mark.mock.invocationCallOrder[0]).toBeLessThan(mocks.collect.mock.invocationCallOrder[0]!);
  });

  it.each([undefined, null, -1, NaN, Infinity, 1.5])('ignores invalid target %s', async tabId => {
    await prepareTabForCapture(tabId);
    await prepareTabForAgent(tabId);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
  });
});
