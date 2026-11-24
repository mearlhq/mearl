import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ElementPickerTabContext, useElementPicker } from '../useElementPicker';
import { sendMessageSafely } from '../../utils/safeChrome';

vi.mock('../../utils/safeChrome', () => ({
  sendMessageSafely: vi.fn().mockResolvedValue({ success: true }),
}));

it('picks and receives results for the preview tab without a DevTools window', async () => {
  const onPicked = vi.fn();
  const listeners = vi.spyOn(chrome.runtime.onMessage, 'addListener');
  const { result } = renderHook(() => useElementPicker({ onPicked }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ElementPickerTabContext.Provider value={42}>{children}</ElementPickerTabContext.Provider>
    ),
  });

  await act(async () => {
    result.current.start();
  });
  expect(sendMessageSafely).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'startElementPicker',
      tabId: 42,
      pickerSessionId: expect.any(String),
    }),
  );
  const pickerSessionId = (vi.mocked(sendMessageSafely).mock.lastCall?.[0] as any).pickerSessionId;
  const receive = listeners.mock.lastCall![0];
  const picked = {
    source: 'mearl-content-script',
    type: 'ELEMENT_PICKED',
    pickerSessionId,
    frameToken: 'frame-1',
    text: '业务元素',
  };
  act(() => {
    receive(picked, { tab: { id: 7 } } as chrome.runtime.MessageSender, vi.fn());
  });
  expect(onPicked).not.toHaveBeenCalled();
  act(() => {
    receive(picked, { tab: { id: 42 } } as chrome.runtime.MessageSender, vi.fn());
  });
  expect(onPicked).toHaveBeenCalledWith('业务元素', expect.objectContaining({ text: '业务元素' }));
  expect(result.current.isPicking).toBe(false);
});

it('starts the shared picker in SPM-only mode', async () => {
  const { result } = renderHook(() => useElementPicker({ onPicked: vi.fn(), tabId: 42 }));

  await act(async () => {
    result.current.start({ spmMode: true });
  });

  expect(sendMessageSafely).toHaveBeenCalledWith({
    action: 'startElementPicker',
    tabId: 42,
    pickerSessionId: expect.any(String),
    spmMode: true,
  });
});

it('keeps a continuous SPM picker active after repeated selections', async () => {
  const onPicked = vi.fn();
  const onPreview = vi.fn();
  const listeners = vi.spyOn(chrome.runtime.onMessage, 'addListener');
  const { result } = renderHook(() => useElementPicker({ onPicked, onPreview, tabId: 42 }));

  await act(async () => {
    result.current.start({ spmMode: true, continuousSpmMode: true });
  });
  expect(sendMessageSafely).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: 'startElementPicker',
      continuousSpmMode: true,
    }),
  );

  const pickerSessionId = (vi.mocked(sendMessageSafely).mock.lastCall?.[0] as any).pickerSessionId;
  const receive = listeners.mock.lastCall![0];
  const sender = { tab: { id: 42 } } as chrome.runtime.MessageSender;
  act(() => {
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICK_PREVIEW',
        pickerSessionId,
        frameToken: 'frame-1',
        text: 'Preview before selection',
        spm: 'module.preview',
      },
      sender,
      vi.fn(),
    );
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICKED',
        pickerSessionId,
        frameToken: 'frame-1',
        text: 'First',
        spm: 'module.first',
      },
      sender,
      vi.fn(),
    );
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICK_PREVIEW',
        pickerSessionId,
        frameToken: 'frame-1',
        text: 'Hover after selection',
        spm: 'module.hovered',
      },
      sender,
      vi.fn(),
    );
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICKED',
        pickerSessionId,
        frameToken: 'frame-1',
        text: 'Second',
        spm: 'module.second',
      },
      sender,
      vi.fn(),
    );
  });

  expect(onPicked).toHaveBeenCalledTimes(2);
  expect(onPreview).toHaveBeenCalledExactlyOnceWith(
    'Preview before selection',
    expect.objectContaining({ spm: 'module.preview' }),
  );
  expect(result.current.isPicking).toBe(true);
});

it('forwards an SPM-only selection even when it has no text or element snapshot', async () => {
  const onPicked = vi.fn();
  const listeners = vi.spyOn(chrome.runtime.onMessage, 'addListener');
  const { result } = renderHook(() => useElementPicker({ onPicked, tabId: 42 }));

  await act(async () => {
    result.current.start({ spmMode: true });
  });

  const receive = listeners.mock.lastCall![0];
  const pickerSessionId = (vi.mocked(sendMessageSafely).mock.lastCall?.[0] as any).pickerSessionId;
  act(() => {
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICKED',
        pickerSessionId,
        frameToken: 'frame-1',
        text: '',
        element: null,
        spm: 'card.book',
      },
      { tab: { id: 42 } } as chrome.runtime.MessageSender,
      vi.fn(),
    );
  });

  expect(onPicked).toHaveBeenCalledWith(
    '',
    expect.objectContaining({ spm: 'card.book', element: null }),
  );
  expect(result.current.isPicking).toBe(false);
});

it('previews an SPM selection while keeping the picker active', async () => {
  const onPreview = vi.fn();
  const listeners = vi.spyOn(chrome.runtime.onMessage, 'addListener');
  const { result } = renderHook(() =>
    useElementPicker({ onPicked: vi.fn(), onPreview, tabId: 42 }),
  );

  await act(async () => {
    result.current.start({ spmMode: true });
  });

  const receive = listeners.mock.lastCall![0];
  const pickerSessionId = (vi.mocked(sendMessageSafely).mock.lastCall?.[0] as any).pickerSessionId;
  act(() => {
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICKER_FRAME_ACTIVE',
        pickerSessionId,
        frameToken: 'frame-1',
      },
      { tab: { id: 42 } } as chrome.runtime.MessageSender,
      vi.fn(),
    );
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICK_PREVIEW',
        pickerSessionId,
        frameToken: 'frame-1',
        text: 'Rate comment',
        spm: 'comment.comment_rate',
        element: { tagName: 'button' },
      },
      { tab: { id: 42 } } as chrome.runtime.MessageSender,
      vi.fn(),
    );
  });

  expect(onPreview).toHaveBeenCalledWith(
    'Rate comment',
    expect.objectContaining({ spm: 'comment.comment_rate' }),
  );
  expect(result.current.isPicking).toBe(true);
});

it('rejects a preview delivered from an older session or inactive frame', async () => {
  const onPreview = vi.fn();
  const listeners = vi.spyOn(chrome.runtime.onMessage, 'addListener');
  const { result } = renderHook(() =>
    useElementPicker({ onPicked: vi.fn(), onPreview, tabId: 42 }),
  );

  await act(async () => result.current.start({ spmMode: true }));
  const oldSessionId = (vi.mocked(sendMessageSafely).mock.lastCall?.[0] as any).pickerSessionId;
  await act(async () => result.current.start({ spmMode: true }));
  const currentSessionId = (vi.mocked(sendMessageSafely).mock.lastCall?.[0] as any).pickerSessionId;
  const receive = listeners.mock.lastCall![0];
  const sender = { tab: { id: 42 } } as chrome.runtime.MessageSender;

  act(() => {
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICKER_FRAME_ACTIVE',
        pickerSessionId: currentSessionId,
        frameToken: 'current-frame',
      },
      sender,
      vi.fn(),
    );
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICK_PREVIEW',
        pickerSessionId: oldSessionId,
        frameToken: 'old-frame',
        text: 'Old session',
        spm: 'old.point',
      },
      sender,
      vi.fn(),
    );
    receive(
      {
        source: 'mearl-content-script',
        type: 'ELEMENT_PICK_PREVIEW',
        pickerSessionId: currentSessionId,
        frameToken: 'inactive-frame',
        text: 'Inactive frame',
        spm: 'inactive.point',
      },
      sender,
      vi.fn(),
    );
  });

  expect(onPreview).not.toHaveBeenCalled();
});
