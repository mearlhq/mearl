import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let ports: Array<{ ready(): void; closed(): void; disconnect: ReturnType<typeof vi.fn> }>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); ports = [];
  chrome.runtime.connect = vi.fn(() => {
    let onMessage!: (input: any) => void, onDisconnect!: () => void;
    const disconnect = vi.fn(() => onDisconnect());
    const port = { onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } }, onDisconnect: { addListener: (listener: typeof onDisconnect) => { onDisconnect = listener; } }, disconnect };
    ports.push({ ready: () => onMessage({ ready: true }), closed: () => onDisconnect(), disconnect }); return port as any;
  });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => ({ success: true, data: { id: message.data.id, definition: { url: 'https://accepted.example.test/', title: { en: 'Account' } } } }));
});
afterEach(() => vi.useRealTimers());
it('retains the accepted login across a worker restart without choosing a new URL', async () => {
  const { createBrowserUiLoginLease } = await import('../browserUiLogin');
  const { browserDocumentToken } = await import('../../../../shared/browserDocument');
  const opening = createBrowserUiLoginLease('account'); ports[0].ready();
  const lease = await opening;
  expect(lease.definition.url).toBe('https://accepted.example.test/');
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  ports[0].closed(); await vi.advanceTimersByTimeAsync(1000); ports[1].ready(); await vi.advanceTimersByTimeAsync(0);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(chrome.runtime.connect).toHaveBeenNthCalledWith(2, { name: 'browser-request-login:' + lease.id + ':' + browserDocumentToken });
  await lease.close(); await vi.advanceTimersByTimeAsync(10000);
  expect(ports).toHaveLength(2);
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'browserUiService', data: { operation: 'loginClose', id: lease.id }, documentToken: browserDocumentToken });
});
it('releases a failed accepted connection and stops its scheduled reconnect', async () => {
  const { createBrowserUiLoginLease } = await import('../browserUiLogin');
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => message.data.operation === 'loginClose' ? { success: true } : { success: false, error: 'Package unavailable' });
  const opening = expect(createBrowserUiLoginLease('account')).rejects.toThrow('Package unavailable');
  ports[0].ready(); await opening; await vi.advanceTimersByTimeAsync(10000);
  expect(ports).toHaveLength(1);
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ operation: 'loginClose' }) }));
});
