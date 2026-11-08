import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestNativeHostOnce, startNativeHostRequestSession } from '../nativeHostRequest';

function nativePort() {
  const messageListeners: Array<(message: any) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    disconnect: vi.fn(),
    onDisconnect: {
      addListener: vi.fn(listener => disconnectListeners.push(listener)),
    },
    onMessage: {
      addListener: vi.fn(listener => messageListeners.push(listener)),
    },
    postMessage: vi.fn(),
    emitDisconnect: () => disconnectListeners.forEach(listener => listener()),
    emitMessage: (message: any) => messageListeners.forEach(listener => listener(message)),
  };
}

describe('requestNativeHostOnce', () => {
  beforeEach(() => {
    chrome.runtime.lastError = undefined;
  });

  it('returns the matching response and disconnects the temporary port', async () => {
    const port = nativePort();
    chrome.runtime.connectNative = vi.fn(() => port as unknown as chrome.runtime.Port);

    const pending = requestNativeHostOnce('update_setup_extension', { version: '2.8.0' });
    const request = port.postMessage.mock.calls[0]![0];
    port.emitMessage({ id: request.id, success: true, data: { updated: true } });

    await expect(pending).resolves.toEqual({ updated: true });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('forwards progress without closing the native host request', async () => {
    const port = nativePort();
    chrome.runtime.connectNative = vi.fn(() => port as unknown as chrome.runtime.Port);
    const onProgress = vi.fn();
    const pending = requestNativeHostOnce('wallet_auth_code_wait', {}, 10_000, onProgress);
    const request = port.postMessage.mock.calls[0]![0];
    port.emitMessage({ id: request.id, type: 'progress', data: { phase: 'connected' } });
    expect(onProgress).toHaveBeenCalledWith({ phase: 'connected' });
    expect(port.disconnect).not.toHaveBeenCalled();
    port.emitMessage({ id: request.id, success: true, data: { authcode: 'code' } });
    await expect(pending).resolves.toEqual({ authcode: 'code' });
  });

  it('tries the alternate registered host only after a connection failure', async () => {
    const missing = nativePort();
    const available = nativePort();
    chrome.runtime.connectNative = vi
      .fn()
      .mockReturnValueOnce(missing as unknown as chrome.runtime.Port)
      .mockReturnValueOnce(available as unknown as chrome.runtime.Port);

    const pending = requestNativeHostOnce('update_setup_extension');
    missing.emitDisconnect();
    await vi.waitFor(() => expect(available.postMessage).toHaveBeenCalledOnce());
    const request = available.postMessage.mock.calls[0]![0];
    available.emitMessage({ id: request.id, success: true, data: { updated: false } });

    await expect(pending).resolves.toEqual({ updated: false });
    expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.connectNative).toHaveBeenNthCalledWith(1, 'ai.mearl.skills');
    expect(chrome.runtime.connectNative).toHaveBeenNthCalledWith(2, 'ai.mearl.mcp');
  });

  it('does not retry an update error returned by a connected host', async () => {
    const port = nativePort();
    chrome.runtime.connectNative = vi.fn(() => port as unknown as chrome.runtime.Port);

    const pending = requestNativeHostOnce('update_setup_extension');
    const request = port.postMessage.mock.calls[0]![0];
    port.emitMessage({ id: request.id, success: false, error: 'checksum mismatch' });

    await expect(pending).rejects.toThrow('checksum mismatch');
    expect(chrome.runtime.connectNative).toHaveBeenCalledOnce();
  });
});


it('keeps start, wait and close in one Native process until the operation is finished', async () => {
  const port = nativePort();
  const nativeState = new Map<string, string>();
  chrome.runtime.connectNative = vi.fn(() => port as unknown as chrome.runtime.Port);
  port.postMessage.mockImplementation(request => {
    if (request.action === 'authorization_start') { nativeState.set('session', 'accepted-controller'); port.emitMessage({ id: request.id, success: true, data: { id: 'session' } }); }
    if (request.action === 'authorization_wait') port.emitMessage({ id: request.id, success: nativeState.has('session'), data: nativeState.get('session') });
    if (request.action === 'authorization_close') { nativeState.delete('session'); port.emitMessage({ id: request.id, success: true, data: {} }); }
  });
  const accepted = await startNativeHostRequestSession('authorization_start', {}, 1000);
  await expect(accepted.session.request('authorization_wait', {}, 1000)).resolves.toBe('accepted-controller');
  await accepted.session.request('authorization_close', {}, 1000);
  expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(1);
  expect(port.disconnect).not.toHaveBeenCalled();
  accepted.session.close();
  expect(port.disconnect).toHaveBeenCalledTimes(1);
});
it('never replays a timed-out start in a second process', async () => {
  vi.useFakeTimers();
  try {
    const port = nativePort(); chrome.runtime.connectNative = vi.fn(() => port as unknown as chrome.runtime.Port);
    const accepted = startNativeHostRequestSession('authorization_start', {}, 10);
    const result = expect(accepted).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10); await result;
    expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
