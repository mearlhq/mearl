import { afterEach, expect, it, vi } from 'vitest';
import { sendTabMessageSafe } from '../index';
afterEach(() => vi.unstubAllGlobals());
it('targets the originating document so late events cannot reach a replacement frame', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { tabs: { sendMessage: send } });
  await sendTabMessageSafe(
    7,
    { action: 'appBridgeProtocolStreamEvent', requestId: 1 },
    { frameId: 0, documentId: 'original-document' },
  );
  expect(send).toHaveBeenCalledWith(7, expect.any(Object), { documentId: 'original-document' });
});
it('does not fall back to a replacement document when the original document is gone', async () => {
  const send = vi.fn().mockRejectedValue(new Error('Document is gone'));
  vi.stubGlobal('chrome', { tabs: { sendMessage: send } });
  await expect(sendTabMessageSafe(7, {}, { documentId: 'old-document' })).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});
