import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const leases = vi.hoisted(() => ({ hold: vi.fn(), release: vi.fn() }));
vi.mock('../offscreenLeases', () => ({ holdOffscreenDocument: leases.hold }));
let channels: Array<{ port1: any; port2: any }>;
const id = 'a'.repeat(64);
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); channels = [];
  leases.hold.mockReturnValue(leases.release);
  chrome.runtime.getURL = () => 'about:blank';
  chrome.runtime.sendMessage = vi.fn(async () => ({})) as any;
  vi.stubGlobal('MessageChannel', class { port1 = { onmessage: null as any, postMessage: vi.fn(), close: vi.fn(), start: vi.fn() }; port2 = { close: vi.fn() }; constructor() { channels.push(this); } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function prepare() {
  const api = await import('../browserPureCapabilities');
  const opening = api.handlePureRuntime({ operation: 'prepare', id, html: '<script>fixture</script>' });
  channels[0].port1.onmessage({ data: { type: 'ready', success: true } }); await opening; return api;
}
it('prepares once, correlates concurrent results and expires the retained lease when idle', async () => {
  const api = await prepare();
  await api.handlePureRuntime({ operation: 'prepare', id, html: '<script>fixture</script>' });
  expect(channels).toHaveLength(1);
  const first = api.handlePureRuntime({ operation: 'invoke', id, handler: 'value', input: 'a' });
  const second = api.handlePureRuntime({ operation: 'invoke', id, handler: 'value', input: 'b' });
  await Promise.resolve(); await Promise.resolve();
  const inputs = channels[0].port1.postMessage.mock.calls.map(([value]: any) => value);
  channels[0].port1.onmessage({ data: { type: 'result', id: inputs[1].id, success: true, value: 'b-result' } });
  channels[0].port1.onmessage({ data: { type: 'result', id: inputs[0].id, success: true, value: 'a-result' } });
  expect(await Promise.all([first, second])).toEqual(['a-result', 'b-result']);
  expect(leases.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(leases.release).toHaveBeenCalledTimes(1); expect(document.querySelectorAll('iframe')).toHaveLength(0);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'mearl-browser-pure-idle' });
  await expect(api.handlePureRuntime({ operation: 'invoke', id, handler: 'value' })).rejects.toThrow('PURE_RUNTIME_MISSING');
});
it('times out an operation and releases every pending caller and the document lease', async () => {
  const api = await prepare();
  const calls = Promise.allSettled([api.handlePureRuntime({ operation: 'invoke', id, handler: 'value' }), api.handlePureRuntime({ operation: 'invoke', id, handler: 'value' })]);
  await vi.advanceTimersByTimeAsync(10_000);
  for (const result of await calls) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(result.reason.message).toContain('timed out'); }
  expect(leases.release).toHaveBeenCalledTimes(1); expect(document.querySelectorAll('iframe')).toHaveLength(0);
});
it('rejects reuse with different accepted code and transfers its connection only once', async () => {
  const api = await prepare();
  await expect(api.handlePureRuntime({ operation: 'prepare', id, html: 'different' })).rejects.toThrow('identity conflict');
  const frame = document.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  for (let count = 0; count < 2; count++) window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'mearl-plugin-ready' } }));
  expect(post).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
});

it('accepts runtime requests from the worker and ignores UI or tab senders', async () => {
  const api = await import('../browserPureCapabilities');
  let listener!: (message: any, sender: any, respond: any) => any;
  chrome.runtime.id = 'owned';
  vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(value => { listener = value as any; });
  api.initializeBrowserPureOffscreen();
  const respond = vi.fn();
  const message = { target: api.PURE_RUNTIME_TARGET, data: { operation: 'prepare', id, html: 'fixture' } };
  listener(message, { id: 'owned', documentId: 'popup' }, respond);
  listener(message, { id: 'owned', tab: { id: 1 } }, respond);
  listener(message, { id: 'other' }, respond);
  expect(channels).toHaveLength(0);
  expect(listener(message, { id: 'owned' }, respond)).toBe(true);
  channels[0].port1.onmessage({ data: { type: 'ready', success: true } });
  await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(respond).toHaveBeenCalledWith({ success: true, value: null });
  await vi.advanceTimersByTimeAsync(60_000);
});
