import { beforeEach, expect, it, vi } from 'vitest';
import { isBrowserDocumentAlive, resolveBrowserDocumentSender } from '../browserDocuments';

const token = '75ece965-9526-42c5-8d74-c931779c3090';
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const url = `chrome-extension://${extensionId}/src/pages/panel/index.html`;
const sender = { id: extensionId, url };
beforeEach(() => {
  vi.clearAllMocks();
  chrome.runtime.id = extensionId;
  chrome.runtime.getURL = path => `chrome-extension://${extensionId}/${path}`;
  chrome.runtime.getContexts = vi.fn(async () => []) as any;
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ url });
});
it('binds a DevTools sender without documentId to a live, source-matched document nonce', async () => {
  const owner = await resolveBrowserDocumentSender(sender, token);
  expect(owner.documentId).toBe('mearl-document:' + token);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'mearl-browser-document-probe', token });
  expect(await isBrowserDocumentAlive(owner.documentId!)).toBe(true);
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  expect(await isBrowserDocumentAlive(owner.documentId!)).toBe(false);
});
it('rejects missing proof, stale proof, another document URL and content-script senders', async () => {
  await expect(resolveBrowserDocumentSender(sender, undefined)).rejects.toThrow('live extension document');
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  await expect(resolveBrowserDocumentSender(sender, token)).rejects.toThrow('live extension document');
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ url: url + '?other=1' });
  await expect(resolveBrowserDocumentSender(sender, token)).rejects.toThrow('live extension document');
  await expect(resolveBrowserDocumentSender({ ...sender, url: 'https://example.com' }, token)).rejects.toThrow('Extension UI required');
});
it('preserves Chrome document identities and verifies the exact context ID', async () => {
  const native = { ...sender, documentId: 'native' };
  expect(await resolveBrowserDocumentSender(native, undefined)).toEqual(native);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  chrome.runtime.getContexts = vi.fn(async () => [{ documentId: 'native' }]) as any;
  expect(await isBrowserDocumentAlive('native')).toBe(true);
  expect(await isBrowserDocumentAlive('closed')).toBe(false);
});
