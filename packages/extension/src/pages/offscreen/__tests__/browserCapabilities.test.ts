import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runBrowserCapabilitySandbox } from '../browserCapabilities';

let channel: { port1: any; port2: any };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    runtime: { getURL: (file: string) => `https://extension.test/${file}` },
  });
  vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set').mockImplementation(() => {});
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = { start: vi.fn(), close: vi.fn(), postMessage: vi.fn(), onmessage: null };
      port2 = { close: vi.fn() };
      constructor() {
        channel = { port1: this.port1, port2: this.port2 };
      }
    },
  );
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps the execution deadline after ready and releases its iframe and both ports', async () => {
  const result = runBrowserCapabilitySandbox('owned', '<p>fixture</p>', 20000);
  const rejection = expect(result).rejects.toThrow('execution timed out');
  const frame = document.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  window.dispatchEvent(
    new MessageEvent('message', {
      source: frame.contentWindow,
      data: { type: 'mearl-plugin-ready' },
    }),
  );
  expect(post).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15001);
  expect(frame.isConnected).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  await rejection;
  expect(frame.isConnected).toBe(false);
  expect(channel.port1.close).toHaveBeenCalled();
  expect(channel.port2.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds startup when the sandbox never connects', async () => {
  const result = runBrowserCapabilitySandbox('owned', '<p>fixture</p>');
  const rejection = expect(result).rejects.toThrow('did not become ready');
  await vi.advanceTimersByTimeAsync(15000);
  await rejection;
  expect(document.querySelector('iframe')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('releases the sandbox immediately on a result and ignores other frame messages', async () => {
  const result = runBrowserCapabilitySandbox('owned', '<p>fixture</p>');
  const frame = document.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  window.dispatchEvent(
    new MessageEvent('message', { source: window, data: { type: 'mearl-plugin-ready' } }),
  );
  expect(post).not.toHaveBeenCalled();
  channel.port1.onmessage({ data: { type: 'result', success: true, value: { schema: true } } });
  await expect(result).resolves.toEqual({ schema: true });
  expect(frame.isConnected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('releases immediately when its owner aborts and ignores a late result', async () => {
  const controller = new AbortController();
  const result = runBrowserCapabilitySandbox('owned', '<p>fixture</p>', 120000, controller.signal);
  const rejected = expect(result).rejects.toThrow('aborted');
  const frame = document.querySelector('iframe')!;
  controller.abort();
  await rejected;
  expect(frame.isConnected).toBe(false);
  channel.port1.onmessage({ data: { type: 'result', success: true, value: 'late' } });
  expect(vi.getTimerCount()).toBe(0);
});
it('does not allocate an iframe or lease for an already canceled owner', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(runBrowserCapabilitySandbox('owned', '', 120000, controller.signal)).rejects.toThrow();
  expect(document.querySelector('iframe')).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});
it('destroys a resident sandbox when its actual worker owner port disconnects', async () => {
  const { initializeBrowserCapabilityOffscreen } = await import('../browserCapabilities');
  const { hasOffscreenWork } = await import('../offscreenLeases');
  let listener: any, ready: any, disconnected: any;
  const port = { disconnect: vi.fn(), onMessage: { addListener: vi.fn(fn => { ready = fn; }), removeListener: vi.fn() }, onDisconnect: { addListener: vi.fn(fn => { disconnected = fn; }) } };
  Object.assign(chrome.runtime, { id: 'owned', onMessage: { addListener: vi.fn(fn => { listener = fn; }) }, connect: vi.fn(() => port) });
  initializeBrowserCapabilityOffscreen();
  const reply = vi.fn(), id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  listener({ target: 'mearl-browser-capability-offscreen', id, html: '<p>fixture</p>', timeoutMs: 120000 }, { id: 'owned', url: 'https://extension.test/worker.js' }, reply);
  expect(document.querySelector('iframe')).toBeNull();
  ready({ type: 'ready', id }); await Promise.resolve();
  expect(document.querySelector('iframe')).not.toBeNull(); expect(hasOffscreenWork()).toBe(true);
  disconnected(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(document.querySelector('iframe')).toBeNull(); expect(hasOffscreenWork()).toBe(false);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: false, error: 'Browser capability aborted' }));
  expect(vi.getTimerCount()).toBe(0);
});
