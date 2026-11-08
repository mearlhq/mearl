import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installWebsiteInstallationBridge } from '../installationWebsite';
const send = vi.hoisted(() => vi.fn());
vi.mock('../chromeSafe', () => ({ safeSendMessage: send }));
let dispose: (() => void) | undefined;
const activation = { isActive: true, hasBeenActive: true };
const id = '00000000-0000-4000-8000-000000000001';
function request(operation: string, patch = {}) {
  window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data: { type: 'mearl-website-request', id, operation, presetId: 'team', ...patch } }));
}
beforeEach(() => {
  vi.stubGlobal('location', new URL('https://guide.example.test/installed.html'));
  vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({ version: '3.0.0', version_name: '3.0.0-beta.5' } as chrome.runtime.Manifest);
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  activation.isActive = true;
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: activation });
  send.mockReset().mockResolvedValue({ success: true, data: { browserReady: false } });
  dispose = installWebsiteInstallationBridge();
});
afterEach(() => { dispose?.(); Reflect.deleteProperty(navigator, 'userActivation'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reports only the extension version without a background or network request', () => {
  request('version');
  expect(send).not.toHaveBeenCalled();
  expect(window.postMessage).toHaveBeenCalledWith({ type: 'mearl-website-response', id, success: true, data: { version: '3.0.0-beta.5' } }, location.origin);
});
it('forwards only allowlisted installation fields and operations', async () => {
  request('status', { source: 'https://attacker.example/preset.json' });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send).toHaveBeenCalledWith({ action: 'mearlWebsiteInstallation', operation: 'status', presetId: 'team' });
  expect(window.postMessage).toHaveBeenCalledWith(expect.objectContaining({ success: true }), location.origin);
});
it('forwards a candidate catalog without accepting page-supplied authorization', async () => {
  request('open', { catalogUrl: 'https://guide.example.test/catalog.json', authorize: true, operationOverride: 'confirmSource' });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send).toHaveBeenCalledWith({ action: 'mearlWebsiteInstallation', operation: 'open', presetId: 'team', catalogUrl: 'https://guide.example.test/catalog.json' });
  request('confirmSource');
  expect(send).toHaveBeenCalledOnce();
});
it('ignores unsolicited installation, unknown operations and forged replies', () => {
  activation.isActive = false;
  request('open'); request('execute'); request('status', { id: 'invalid' });
  window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'https://other.example', data: { type: 'mearl-website-request', id, operation: 'status', presetId: 'team' } }));
  expect(send).not.toHaveBeenCalled();
});
it('allows concurrent status checks while serializing opens and removes the listener on disposal', async () => {
  const finish: Array<(value: unknown) => void> = [];
  send.mockImplementation(() => new Promise(resolve => { finish.push(resolve); }));
  request('status'); request('status'); request('open'); request('open');
  expect(send).toHaveBeenCalledTimes(3);
  expect(window.postMessage).toHaveBeenCalledWith(expect.objectContaining({ error: 'INSTALLATION_BUSY' }), location.origin);
  finish.forEach(resolve => resolve({ success: true }));
  await vi.waitFor(() => expect(window.postMessage).toHaveBeenCalledTimes(4));
  dispose?.(); request('version');
  expect(window.postMessage).toHaveBeenCalledTimes(4);
});
