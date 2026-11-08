import { beforeEach, expect, it, vi } from 'vitest';
import { resolveAplusSpm } from '../aplusSpm';
beforeEach(() => { chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ success: true, data: { mainSpm: '1.2.card.button', highlightSpm: '1.2.card.button' } }); });
it('uses the installed point decoder without interpreting business fields in the UI', async () => {
  const raw = { arbitrary: ['preserved'] };
  expect(await resolveAplusSpm('custom', raw)).toEqual({ mainSpm: '1.2.card.button', highlightSpm: '1.2.card.button' });
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'browserTracking', data: { operation: 'spm', input: { eventType: 'custom', raw } } });
});
it('reports missing or failed point decoding without a private fallback', async () => {
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: false, error: 'TRACKING_CAPABILITY_NOT_INSTALLED' });
  await expect(resolveAplusSpm('CLK', {})).rejects.toThrow('NOT_INSTALLED');
});
