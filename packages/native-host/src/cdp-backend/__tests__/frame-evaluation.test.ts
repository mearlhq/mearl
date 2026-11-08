import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdpPageEval } from '../interaction-handlers.js';
import type { PageSession } from '../cdp-session.js';

function fixture(frameId = 'business', outOfProcess = false) {
  const listeners = new Map<string, Set<(params: any) => void>>();
  const emit = (method: string, params: any) => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };
  const child = {
    on: vi.fn((method: string, callback: (params: any) => void) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(callback);
      return () => listeners.get(method)!.delete(callback);
    }),
    sendCommand: vi.fn(async (method: string, params?: Record<string, any>): Promise<any> => {
      if (method === 'Runtime.enable') {
        emit('Runtime.executionContextCreated', {
          context: { id: 11, auxData: { frameId, isDefault: false } },
        });
        emit('Runtime.executionContextCreated', {
          context: { id: 22, auxData: { frameId: 'unrelated', isDefault: true } },
        });
        emit('Runtime.executionContextCreated', {
          context: { id: 33, auxData: { frameId, isDefault: true } },
        });
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: params?.contextId === 33 ? 'page-global' : 'wrong-world' } };
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'business' } } };
      return {};
    }),
  };
  const client = {
    sendCommand: vi.fn(async (method: string) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'main' },
            childFrames: outOfProcess ? [] : [{ frame: { id: 'business' } }],
          },
        };
      }
      if (method === 'Target.getTargets') {
        return {
          targetInfos: outOfProcess
            ? [
                {
                  type: 'iframe',
                  targetId: 'business',
                  parentId: 'page-target',
                  parentFrameId: 'main',
                },
              ]
            : [],
        };
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'temporary' };
      return {};
    }),
    createChildSession: vi.fn(() => child),
  };
  const session = { client, targetId: 'page-target' } as unknown as PageSession;
  return { session, client, child, listeners, emit };
}

afterEach(() => vi.useRealTimers());

describe('CDP page_eval frame routing', () => {
  it.each([
    ['main', false, 'page-target'],
    ['business', false, 'page-target'],
    ['business', true, 'business'],
  ] as const)('reads the main world of %s (OOPIF=%s)', async (frameId, oopif, targetId) => {
    const f = fixture(frameId, oopif);

    await expect(
      cdpPageEval(f.session, { tabId: 1, frameId, expression: 'window.appState' }),
    ).resolves.toEqual({ result: 'page-global' });
    expect(f.client.sendCommand).toHaveBeenCalledWith('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    expect(f.child.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'window.appState',
      contextId: 33,
      awaitPromise: true,
      returnByValue: true,
    });
    expect(
      f.client.sendCommand.mock.calls.some(
        ([method]) => method === 'Runtime.evaluate' || method === 'Runtime.disable',
      ),
    ).toBe(false);
    expect(f.client.sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', {
      sessionId: 'temporary',
    });
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
  });

  it.each(['missing', '', null, 123])(
    'rejects invalid or missing frame %s before executing',
    async frameId => {
      const f = fixture();
      await expect(
        cdpPageEval(f.session, { expression: 'submit()', frameId } as any),
      ).rejects.toMatchObject({ pageActionFailureStage: 'precondition' });
      expect(f.client.createChildSession).not.toHaveBeenCalled();
      expect(f.child.sendCommand).not.toHaveBeenCalled();
    },
  );

  it('waits for delayed context events and preserves awaitPromise=false', async () => {
    const f = fixture();
    f.child.sendCommand.mockImplementation(async method => {
      if (method === 'Runtime.enable') {
        setTimeout(
          () =>
            f.emit('Runtime.executionContextCreated', {
              context: { id: 44, auxData: { frameId: 'business', isDefault: true } },
            }),
          0,
        );
      }
      return { result: { value: 'done' } };
    });
    await expect(
      cdpPageEval(f.session, {
        expression: 'Promise.resolve()',
        frameId: 'business',
        awaitPromise: false,
      } as any),
    ).resolves.toEqual({ result: 'done' });
    expect(f.child.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 44, awaitPromise: false }),
    );
  });

  it('reports unavailable contexts without evaluating in the outer document', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.child.sendCommand.mockResolvedValue({});
    const pending = cdpPageEval(f.session, { expression: 'submit()', frameId: 'business' } as any);
    const rejection = expect(pending).rejects.toMatchObject({
      pageActionFailureStage: 'precondition',
    });
    await vi.advanceTimersByTimeAsync(3000);
    await rejection;
    expect(f.child.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(
      false,
    );
    expect(f.client.sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', {
      sessionId: 'temporary',
    });
  });

  it('cleans up after uncertain evaluation failures without re-executing the expression', async () => {
    const f = fixture();
    const original = f.child.sendCommand.getMockImplementation()!;
    f.child.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.evaluate') throw new Error('CDP command timeout: Runtime.evaluate');
      return original(method, params);
    });
    await expect(
      cdpPageEval(f.session, { expression: 'submit()', frameId: 'business' } as any),
    ).rejects.toThrow('timeout');
    expect(
      f.child.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.evaluate'),
    ).toHaveLength(1);
    expect(f.client.sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', {
      sessionId: 'temporary',
    });
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
  });

  it('releases the session when the expression throws in the target frame', async () => {
    const f = fixture();
    const original = f.child.sendCommand.getMockImplementation()!;
    f.child.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.evaluate') return { exceptionDetails: { text: 'page failure' } };
      return original(method, params);
    });
    await expect(
      cdpPageEval(f.session, { expression: 'throw Error()', frameId: 'business' } as any),
    ).rejects.toThrow('page failure');
    expect(f.client.sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', {
      sessionId: 'temporary',
    });
  });
});
