import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const elementPicker = vi.hoisted(() => ({
  startElementPicker: vi.fn(),
  pauseElementPicker: vi.fn(),
  resumeElementPicker: vi.fn(),
  setPickerFrameActive: vi.fn(),
  stopElementPicker: vi.fn(),
  editElementComment: vi.fn(),
  removeElementComment: vi.fn(),
  clearElementComments: vi.fn(),
}));

vi.mock('../elementPicker', () => ({
  createElementPicker: vi.fn(() => elementPicker),
}));

import { installElementPickerRuntime } from '../elementPickerRuntime';

describe('elementPickerRuntime', () => {
  beforeEach(() => {
    delete (window as typeof window & Record<string, unknown>).__mearlElementPickerRuntime;
    vi.clearAllMocks();
    (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue(undefined);
  });

  it('installs once, announces frame readiness, and acknowledges picker startup', () => {
    const listeners: Array<
      (
        message: any,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => void
    > = [];
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(listener => {
      listeners.push(listener as (typeof listeners)[number]);
    });

    installElementPickerRuntime();
    installElementPickerRuntime();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      source: 'mearl-content-script',
      type: 'ELEMENT_PICKER_FRAME_READY',
    });
    const sendResponse = vi.fn();
    listeners[0]?.({ action: 'pingElementPickerRuntime' }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      frameToken: expect.stringMatching(/^picker-frame-/),
      page: {
        url: window.location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      },
    });

    sendResponse.mockClear();
    listeners[0]?.(
      {
        action: 'startElementPicker',
        traceMode: true,
        commentMode: false,
        topPage: { url: 'https://example.test/', title: 'Example' },
      },
      {},
      sendResponse,
    );

    expect(elementPicker.startElementPicker).toHaveBeenCalledWith({
      traceMode: true,
      commentMode: false,
    });
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('forwards main-world trace results in the top frame as part of the shared runtime', async () => {
    installElementPickerRuntime();
    vi.mocked(chrome.runtime.sendMessage).mockClear();

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'mearl-injected',
          type: 'TRACE_RESULT',
          tagId: 'trace-1',
          payload: { ok: true },
        },
      }),
    );

    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        source: 'mearl-content-script',
        type: 'TRACE_RESULT',
        tagId: 'trace-1',
        payload: { ok: true },
      }),
    );
  });
});
