import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDebuggerLease,
  cleanupDebuggerSession,
  getDebuggerFrameExecutionContextId,
  getDebuggerSessionDebugState,
  handleDebuggerSessionDetach,
  handleDebuggerSessionEvent,
  listActiveDebuggerTabIds,
  refreshDebuggerExecutionContexts,
  releaseDebuggerSession,
  resolveDebuggerFrameExecutionContextId,
} from '../debuggerSessionManager';

describe('debugger session manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.debugger.attach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.detach = vi.fn().mockResolvedValue(undefined);
    chrome.debugger.sendCommand = vi.fn().mockResolvedValue({});
  });

  it('shares one attachment and reference-counts domains across consumers', async () => {
    const first = await acquireDebuggerLease(2101, {
      consumer: 'navigation',
      domains: ['Network'],
    });
    const second = await acquireDebuggerLease(2101, {
      consumer: 'request-collector',
      domains: ['Network'],
    });

    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    // 域只 enable 一次（引用计数）
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 2101 }, 'Network.enable', {});
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(call => call[1] === 'Network.enable'),
    ).toHaveLength(1);
    expect(getDebuggerSessionDebugState(2101)).toEqual({
      attached: true,
      generation: first.generation,
      consumers: ['navigation', 'request-collector'],
      domainRefs: { Network: 2 },
    });

    await first.release();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(chrome.debugger.sendCommand)
        .mock.calls.filter(call => call[1] === 'Network.disable'),
    ).toHaveLength(0);

    await second.release();
    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 2101 },
      'Network.disable',
      {},
    );
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2101 });
    cleanupDebuggerSession(2101);
  });

  it('caches MAIN world execution contexts for frame-targeted evaluation', async () => {
    const lease = await acquireDebuggerLease(2108, {
      consumer: 'page-eval',
      domains: ['Runtime'],
    });

    handleDebuggerSessionEvent(2108, 'Runtime.executionContextCreated', {
      context: { id: 31, auxData: { frameId: 'root-frame', isDefault: true } },
    });
    handleDebuggerSessionEvent(2108, 'Runtime.executionContextCreated', {
      context: { id: 32, auxData: { frameId: 'root-frame', isDefault: false } },
    });
    expect(getDebuggerFrameExecutionContextId(2108, 'root-frame')).toBe(31);

    handleDebuggerSessionEvent(2108, 'Runtime.executionContextDestroyed', {
      executionContextId: 31,
    });
    expect(getDebuggerFrameExecutionContextId(2108, 'root-frame')).toBeUndefined();

    handleDebuggerSessionEvent(2108, 'Runtime.executionContextCreated', {
      context: { id: 33, auxData: { frameId: 'root-frame', isDefault: true } },
    });
    handleDebuggerSessionEvent(2108, 'Runtime.executionContextsCleared', {});
    expect(getDebuggerFrameExecutionContextId(2108, 'root-frame')).toBeUndefined();

    await lease.release();
    cleanupDebuggerSession(2108);
  });

  it('只在当前调用方独占 Runtime domain 时重新枚举上下文', async () => {
    const first = await acquireDebuggerLease(2109, {
      consumer: 'page-eval',
      domains: ['Runtime'],
    });

    expect(await refreshDebuggerExecutionContexts(2109)).toBe(true);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 2109 },
      'Runtime.disable',
      {},
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 2109 }, 'Runtime.enable', {});

    const second = await acquireDebuggerLease(2109, {
      consumer: 'page-observer',
      domains: ['Runtime'],
    });
    vi.mocked(chrome.debugger.sendCommand).mockClear();
    expect(await refreshDebuggerExecutionContexts(2109)).toBe(false);
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();

    await second.release();
    await first.release();
    cleanupDebuggerSession(2109);
  });

  it('resolves and refreshes a frame execution context through the shared session', async () => {
    let eventListener:
      | ((source: chrome.debugger.Debuggee, method: string, params: any) => void)
      | undefined;
    chrome.debugger.onEvent = {
      addListener: vi.fn(listener => {
        eventListener = listener as typeof eventListener;
      }),
      removeListener: vi.fn(),
    } as any;
    let nextContextId = 41;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === 'Runtime.enable' && eventListener) {
        const contextId = nextContextId;
        queueMicrotask(() =>
          eventListener?.({ tabId: 2110 }, 'Runtime.executionContextCreated', {
            context: {
              id: contextId,
              auxData: { frameId: 'business-frame', isDefault: true },
            },
          }),
        );
      }
      return {};
    });
    const lease = await acquireDebuggerLease(2110, {
      consumer: 'page-eval',
      domains: ['Runtime'],
    });

    await expect(resolveDebuggerFrameExecutionContextId(2110, 'business-frame')).resolves.toBe(41);
    nextContextId = 42;
    await expect(
      resolveDebuggerFrameExecutionContextId(2110, 'business-frame', true),
    ).resolves.toBe(42);

    expect(chrome.debugger.onEvent.removeListener).toHaveBeenCalledTimes(2);
    await lease.release();
    cleanupDebuggerSession(2110);
  });

  it('serializes concurrent acquisition for the same tab', async () => {
    const [first, second] = await Promise.all([
      acquireDebuggerLease(2102, { consumer: 'first' }),
      acquireDebuggerLease(2102, { consumer: 'second' }),
    ]);

    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    await Promise.all([first.release(), second.release()]);
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
    cleanupDebuggerSession(2102);
  });

  it('adopts a session that is still owned by the extension after state restoration', async () => {
    vi.mocked(chrome.debugger.attach).mockRejectedValueOnce(new Error('Another debugger attached'));
    vi.mocked(chrome.debugger.sendCommand).mockResolvedValueOnce(undefined);

    const lease = await acquireDebuggerLease(2105, { consumer: 'restored-consumer' });

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 2105 }, 'Runtime.evaluate', {
      expression: 'void 0',
    });
    await lease.release();
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2105 });
    cleanupDebuggerSession(2105);
  });

  it('invalidates all consumers when Chrome detaches the session', async () => {
    const firstInvalidated = vi.fn();
    const secondInvalidated = vi.fn();
    const first = await acquireDebuggerLease(2103, {
      consumer: 'navigation',
      domains: ['Network'],
      onInvalidated: firstInvalidated,
    });
    const second = await acquireDebuggerLease(2103, {
      consumer: 'emulation',
      onInvalidated: secondInvalidated,
    });

    handleDebuggerSessionDetach(2103, 'canceled_by_user');

    expect(firstInvalidated).toHaveBeenCalledWith('canceled_by_user');
    expect(secondInvalidated).toHaveBeenCalledWith('canceled_by_user');
    expect(getDebuggerSessionDebugState(2103)).toEqual({
      attached: false,
      generation: first.generation + 1,
      consumers: [],
      domainRefs: {},
    });

    await Promise.all([first.release(), second.release()]);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    cleanupDebuggerSession(2103);
  });

  it('does not resurrect a session invalidated while attach is pending', async () => {
    let finishAttach!: () => void;
    vi.mocked(chrome.debugger.attach).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishAttach = resolve;
        }),
    );

    const acquiring = acquireDebuggerLease(2106, { consumer: 'pending-consumer' });
    await Promise.resolve();
    handleDebuggerSessionDetach(2106, 'target_closed');
    finishAttach();

    await expect(acquiring).rejects.toThrow('became unavailable while attaching');
    expect(getDebuggerSessionDebugState(2106)?.consumers).toEqual([]);
    cleanupDebuggerSession(2106);
  });

  it('keeps a reconnected session when an older command reports failure late', async () => {
    const old = await acquireDebuggerLease(2110, { consumer: 'old-command' });
    handleDebuggerSessionDetach(2110, 'command_failed', old.generation);
    const invalidated = vi.fn();
    const current = await acquireDebuggerLease(2110, {
      consumer: 'reconnected-page',
      domains: ['Page'],
      onInvalidated: invalidated,
    });

    handleDebuggerSessionDetach(2110, 'command_failed', old.generation);
    await old.release();

    expect(invalidated).not.toHaveBeenCalled();
    expect(getDebuggerSessionDebugState(2110)).toEqual({
      attached: true,
      generation: current.generation,
      consumers: ['reconnected-page'],
      domainRefs: { Page: 1 },
    });
    await current.release();
    cleanupDebuggerSession(2110);
  });

  it('does not reuse lease generations after releasing and rebuilding a tab session', async () => {
    const old = await acquireDebuggerLease(2111, { consumer: 'pending-command' });
    await releaseDebuggerSession(2111);
    const invalidated = vi.fn();
    const current = await acquireDebuggerLease(2111, {
      consumer: 'reopened-page',
      domains: ['Page'],
      onInvalidated: invalidated,
    });

    expect(current.generation).toBeGreaterThan(old.generation);
    handleDebuggerSessionDetach(2111, 'command_failed', old.generation);
    await old.release();

    expect(invalidated).not.toHaveBeenCalled();
    expect(getDebuggerSessionDebugState(2111)?.consumers).toEqual(['reopened-page']);
    expect(getDebuggerSessionDebugState(2111)?.domainRefs).toEqual({ Page: 1 });
    await current.release();
    cleanupDebuggerSession(2111);
  });

  it('rolls back and detaches when a domain cannot be enabled', async () => {
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(new Error('Network failed'));

    await expect(
      acquireDebuggerLease(2104, { consumer: 'navigation', domains: ['Network'] }),
    ).rejects.toThrow('Network failed');

    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2104 });
    expect(getDebuggerSessionDebugState(2104)?.consumers).toEqual([]);
    cleanupDebuggerSession(2104);
  });

  it('force releases every consumer while preserving the tab target', async () => {
    const firstInvalidated = vi.fn();
    const secondInvalidated = vi.fn();
    await acquireDebuggerLease(2107, {
      consumer: 'request-collector',
      domains: ['Network'],
      onInvalidated: firstInvalidated,
    });
    await acquireDebuggerLease(2107, {
      consumer: 'device-emulation',
      onInvalidated: secondInvalidated,
    });

    expect(listActiveDebuggerTabIds()).toContain(2107);
    await expect(releaseDebuggerSession(2107)).resolves.toBe(true);

    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2107 });
    expect(firstInvalidated).toHaveBeenCalledWith('browser_release');
    expect(secondInvalidated).toHaveBeenCalledWith('browser_release');
    expect(listActiveDebuggerTabIds()).not.toContain(2107);
    expect(getDebuggerSessionDebugState(2107)).toBeNull();
  });
});
