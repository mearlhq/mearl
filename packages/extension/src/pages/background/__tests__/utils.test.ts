import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendTabMessageSafe } from '../utils';

describe('sendTabMessageSafe', () => {
  const sendMessage = vi.fn();

  beforeEach(() => {
    sendMessage.mockReset().mockResolvedValue({ ok: true });
    chrome.tabs = { sendMessage } as unknown as typeof chrome.tabs;
  });

  it('broadcasts messages when no frame is specified', async () => {
    await expect(sendTabMessageSafe(11, { action: 'stopElementPicker' })).resolves.toEqual({
      ok: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(11, { action: 'stopElementPicker' });
  });

  it('targets a selected iframe when frameId is specified', async () => {
    await sendTabMessageSafe(
      11,
      { action: 'traceHighlightField', value: 'Submit order' },
      { frameId: 7 },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      11,
      { action: 'traceHighlightField', value: 'Submit order' },
      { frameId: 7 },
    );
  });
});
