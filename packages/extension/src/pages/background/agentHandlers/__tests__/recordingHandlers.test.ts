import { DomainPermissionError } from '@mearl/browser-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePageRecording, hasPageRecording } from '../recordingHandlers';

const { release } = vi.hoisted(() => ({ release: vi.fn(async () => {}) }));
vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease: async () => ({ release }),
}));

function fixture() {
  const listeners = new Set<(event: { tabId: number; frameId: number; url: string }) => void>();
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
    method === 'IO.close' ? undefined : { stream: 'stream-1' },
  );
  vi.stubGlobal('chrome', {
    debugger: {
      sendCommand: (_target: unknown, method: string, params?: Record<string, unknown>) =>
        send(method, params),
    },
    tabs: { get: async () => ({ url: 'https://example.com/' }) },
    webNavigation: {
      onCommitted: {
        addListener: (listener: (event: { tabId: number; frameId: number; url: string }) => void) =>
          listeners.add(listener),
        removeListener: (
          listener: (event: { tabId: number; frameId: number; url: string }) => void,
        ) => listeners.delete(listener),
      },
    },
  });
  return { listeners, send };
}

const start = (deadline: number) => ({
  operation: 'start' as const,
  tabId: 42,
  recordingId: 'recording',
  deadline,
  options: { maxWidth: 1280, maxHeight: 720, frameRate: 30, audio: false },
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('extension recording', () => {
  it('closes a stream that opens after the Native Host deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { listeners, send } = fixture();
    const deadline = Date.now() + 100;
    send.mockImplementationOnce(async () => {
      vi.setSystemTime(deadline);
      return { stream: 'stream-1' };
    });
    await expect(handlePageRecording(start(deadline), async () => {})).rejects.toThrow('timed out');
    expect(send).toHaveBeenCalledWith('Page.stopScreenRecording', undefined);
    expect(send).toHaveBeenCalledWith('IO.close', { handle: 'stream-1' });
    expect(release).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it('reports that a recording containing an unauthorized page must be restarted', async () => {
    const { listeners, send } = fixture();
    const authorize = async (urls: Iterable<string>) => {
      if ([...urls].includes('https://denied.example/'))
        throw new DomainPermissionError('page_record', 'denied.example');
    };
    await handlePageRecording(start(Date.now() + 1000), authorize);
    try {
      expect(hasPageRecording('recording')).toBe(true);
      expect(send).not.toHaveBeenCalledWith('Page.stopScreenRecording', undefined);
      for (const listener of listeners)
        listener({ tabId: 42, frameId: 0, url: 'https://denied.example/' });
      await expect(
        handlePageRecording({ operation: 'stop', recordingId: 'recording' }, authorize),
      ).rejects.toMatchObject({
        code: 'DOMAIN_PERMISSION_REQUIRED',
        message: expect.stringContaining('start a new recording'),
      });
    } finally {
      await handlePageRecording({ operation: 'close', recordingId: 'recording' }, authorize);
    }
    expect(send).toHaveBeenCalledWith('IO.close', { handle: 'stream-1' });
    expect(send).not.toHaveBeenCalledWith('IO.read', expect.anything());
    expect(hasPageRecording('recording')).toBe(false);
    expect(listeners.size).toBe(0);
  });
});
