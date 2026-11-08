import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDebuggerSession, getDebuggerSessionDebugState } from '../debuggerSessionManager';
import { extensionPageDialogShortcut, getExtensionPageDialogs, sendPageCommand, withExtensionPageDialogs } from '../pageDialogs';

const listeners = new Set<(source: any, method: string, params?: any) => void>();
const emit = (method: string, params?: any, sessionId?: string) => {
  for (const listener of [...listeners]) listener({ tabId: 701, ...(sessionId ? { sessionId } : {}) }, method, params);
};
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal('chrome', {
    debugger: {
      attach: vi.fn(async () => {}), detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
    },
    tabs: { get: vi.fn(async () => ({ url: 'https://example.test', title: 'Fixture' })) },
  });
});
afterEach(async () => {
  cleanupDebuggerSession(701);
  await tick();
  listeners.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('extension native dialogs', () => {
  it('bounds monitoring waits and releases the old lease after manual closure unblocks Page.enable', async () => {
    vi.useFakeTimers();
    let enable!: () => void;
    let first = true;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === 'Page.enable' && first) {
        first = false;
        return new Promise<void>(resolve => { enable = resolve; });
      }
      return {};
    });
    const prepare = vi.fn(async () => 1);
    const operation = withExtensionPageDialogs(701, prepare);
    const failure = expect(operation).rejects.toThrow('close it manually');
    await tick();
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(prepare).not.toHaveBeenCalled();
    enable(); // Simulates Chrome resuming the pending enable after manual dialog closure.
    await tick();
    await expect(withExtensionPageDialogs(701, async () => 2)).resolves.toBe(2);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('releases the handling lock after a bounded uncertain acknowledgement failure', async () => {
    vi.useFakeTimers();
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Runtime.evaluate' ? new Promise(() => {}) : {});
    const operation = withExtensionPageDialogs(701, () => sendPageCommand({ tabId: 701 }, 'Runtime.evaluate', {}));
    const failure = expect(operation).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
    await tick();
    emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
    await failure;
    await tick();
    const dialogId = getExtensionPageDialogs(701)!.info()!.id;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async () => new Promise(() => {}));
    const handling = extensionPageDialogShortcut('page_press', { tabId: 701, dialogId, key: 'Enter' });
    const uncertain = expect(handling).rejects.toMatchObject({ pageActionFailureStage: 'dispatch-uncertain' });
    await vi.advanceTimersByTimeAsync(5000);
    await uncertain;
    expect(getExtensionPageDialogs(701)!.busy).toBe(false);
    expect(getExtensionPageDialogs(701)!.info()!.id).toBe(dialogId);
  });
  it('keeps invalidated work guarded until a caught error and fallback have fully unwound', async () => {
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Runtime.evaluate' ? new Promise(() => {}) : {});
    const operation = withExtensionPageDialogs(701, async () => {
      try { await sendPageCommand({ tabId: 701 }, 'Runtime.evaluate', {}); }
      catch { await sendPageCommand({ tabId: 701 }, 'Input.dispatchMouseEvent', { type: 'mousePressed' }); }
    });
    const failure = expect(operation).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
    await tick();
    cleanupDebuggerSession(701);
    await failure;
    await tick();
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(expect.anything(), 'Input.dispatchMouseEvent', expect.anything());
  });
  it('interrupts an endless eval, retains its lease through close-before-ack, then permits new reads', async () => {
    const continued = vi.fn();
    const send = vi.mocked(chrome.debugger.sendCommand);
    send.mockImplementation(async (_target, method) => method === 'Runtime.evaluate' ? new Promise(() => {}) : {});
    const operation = withExtensionPageDialogs(701, async () => {
      await sendPageCommand({ tabId: 701 }, 'Runtime.evaluate', { expression: 'confirm("Continue?"); await never' });
      continued();
    });
    const failure = expect(operation).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
    await tick();
    emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
    await failure;
    await tick();
    const snapshot = await extensionPageDialogShortcut('page_snapshot', { tabId: 701 });
    const id = snapshot!.data.dialog.id;
    expect(getDebuggerSessionDebugState(701)?.consumers).toContain('page-dialog');
    let acknowledge!: () => void;
    send.mockImplementation(async (_target, method) => {
      if (method === 'Page.handleJavaScriptDialog') {
        emit('Page.javascriptDialogClosed');
        return new Promise<void>(resolve => { acknowledge = resolve; });
      }
      return { result: { value: 2 } };
    });
    const handling = extensionPageDialogShortcut('page_press', { tabId: 701, key: 'Escape', dialogId: id });
    await tick();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    acknowledge();
    expect((await handling)!.data.dispatchMode).toBe('native-dialog');
    await tick();
    await expect(extensionPageDialogShortcut('page_press', { tabId: 701, key: 'Enter', dialogId: id })).rejects.toThrow('stale');
    expect(await withExtensionPageDialogs(701, () => sendPageCommand({ tabId: 701 }, 'Runtime.evaluate', {}))).toEqual({ result: { value: 2 } });
    expect(continued).not.toHaveBeenCalled();
  });

  it('discovers a pre-existing modal before page preparation and preserves its actual child owner', async () => {
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === 'Page.enable') emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', defaultPrompt: 'Guest' }, 'child');
      return {};
    });
    const prepare = vi.fn(async () => 1);
    await expect(withExtensionPageDialogs(701, prepare)).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
    expect(prepare).not.toHaveBeenCalled();
    const id = getExtensionPageDialogs(701)!.info()!.id;
    emit('Page.javascriptDialogClosed'); // An unrelated root event cannot close the child dialog.
    expect(getExtensionPageDialogs(701)!.pending).toBe(true);
    await extensionPageDialogShortcut('page_press', { tabId: 701, dialogId: id, key: 'Enter', promptText: 'Alice' });
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 701, sessionId: 'child' }, 'Page.handleJavaScriptDialog', { accept: true, promptText: 'Alice' });
  });
});
