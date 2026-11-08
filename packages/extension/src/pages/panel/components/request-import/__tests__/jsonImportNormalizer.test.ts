import { expect, it, vi } from 'vitest';
import { normalizeImportItem, normalizeInstalledImportItem } from '../jsonImportNormalizer';
it('preserves arbitrary server payloads without adding a protocol envelope', () => {
  const item = { model: { total: 3 }, headers: {}, httpStatusCode: 200 };
  expect(normalizeImportItem(item, 'orders.list')).toEqual({ ok: true, entry: { apiName: 'orders.list', responseData: item } });
  expect(normalizeImportItem({ api: 'selected', data: 1 }, 'other')).toMatchObject({ ok: true, entry: { apiName: 'selected', responseData: { api: 'selected', data: 1 } } });
  expect(normalizeImportItem({}, '')).toEqual({ ok: false, reason: 'missingApi' });
  expect(normalizeImportItem(null, 'api')).toEqual({ ok: false, reason: 'notObject' });
});
it('resolves JSON references before handing the payload to a protocol', async () => {
  const send = vi.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue({ success: true, data: null });
  const item = { api: 'sample', original: { value: 1 }, copy: { $ref: '$.original' } };
  expect(normalizeImportItem(item, '')).toMatchObject({ ok: true, entry: { responseData: { copy: { value: 1 } } } });
  await normalizeInstalledImportItem(item, '');
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ input: { item: { api: 'sample', original: { value: 1 }, copy: { value: 1 } }, fallbackApi: '' } }) }));
  send.mockRestore();
});
it('accepts installed transformations and never hides a plugin failure', async () => {
  const send = vi.spyOn(chrome.runtime, 'sendMessage');
  send.mockResolvedValue({ success: true, data: { ok: true, entry: { apiName: 'sample', responseData: { envelope: true } } } });
  expect(await normalizeInstalledImportItem({}, 'sample')).toMatchObject({ ok: true, entry: { responseData: { envelope: true } } });
  send.mockResolvedValue({ success: false, error: 'plugin failed' });
  await expect(normalizeInstalledImportItem({}, 'sample')).rejects.toThrow('plugin failed');
  send.mockResolvedValue({ success: true, data: { ok: true, entry: {} } });
  await expect(normalizeInstalledImportItem({}, 'sample')).rejects.toThrow('Invalid import');
  send.mockRestore();
});
