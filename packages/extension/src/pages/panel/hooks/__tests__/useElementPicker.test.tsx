import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ElementPickerTabContext, useElementPicker } from '../useElementPicker';
import { sendMessageSafely } from '../../utils/safeChrome';

vi.mock('../../utils/safeChrome', () => ({ sendMessageSafely: vi.fn().mockResolvedValue({ success: true }) }));

it('picks and receives results for the preview tab without a DevTools window', async () => {
  const onPicked = vi.fn();
  const listeners = vi.spyOn(chrome.runtime.onMessage, 'addListener');
  const { result } = renderHook(() => useElementPicker({ onPicked }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ElementPickerTabContext.Provider value={42}>{children}</ElementPickerTabContext.Provider>
    ),
  });

  await act(async () => { result.current.start(); });
  expect(sendMessageSafely).toHaveBeenCalledWith({ action: 'startElementPicker', tabId: 42 });
  const receive = listeners.mock.lastCall![0];
  const picked = { source: 'mearl-content-script', type: 'ELEMENT_PICKED', text: '业务元素' };
  act(() => { receive(picked, { tab: { id: 7 } } as chrome.runtime.MessageSender, vi.fn()); });
  expect(onPicked).not.toHaveBeenCalled();
  act(() => { receive(picked, { tab: { id: 42 } } as chrome.runtime.MessageSender, vi.fn()); });
  expect(onPicked).toHaveBeenCalledWith('业务元素', expect.objectContaining({ text: '业务元素' }));
  expect(result.current.isPicking).toBe(false);
});
