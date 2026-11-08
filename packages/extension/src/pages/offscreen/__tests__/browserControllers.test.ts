import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BROWSER_CONTROLLER_OFFSCREEN_TARGET as target } from '../../../shared/browserCapabilityMessages';

let receive: (message: any, sender: any, callback: (value: any) => void) => unknown;
let channels: any[];
const id = '11111111-1111-4111-8111-111111111111';
const sender = { id: 'owned' };
async function send(operation: string, input: any = {}, source: any = sender): Promise<any> {
  return new Promise(resolve => {
    if (!receive({ target, id, token: 'accepted', operation, ...input }, source, resolve))
      resolve(undefined);
  });
}
const selected = {
  bundleId: 'example',
  revision: 'accepted',
  slot: 'captureController',
  html: '<div>controller</div>',
  definition: { schemaVersion: 1, entry: 'controller.html', actions: {}, transports: {} },
};
async function start() {
  const started = send('start', {
    selected,
    ownerDocumentId: 'owner',
    bootstrap: { locale: 'en', context: {}, preferences: {} },
  });
  const port = channels[0].port1;
  port.onmessage({ data: { type: 'view-ready' } });
  port.onmessage({ data: { type: 'view-call', id: 1, method: 'mounted' } });
  expect(await started).toEqual({ success: true, data: null });
  return port;
}
beforeEach(async () => {
  vi.resetModules();
  channels = [];
  vi.stubGlobal('chrome', {
    runtime: {
      id: sender.id,
      getURL: (file: string) => 'https://extension.test/' + file,
      onConnect: { addListener: vi.fn() },
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
      },
      sendMessage: vi.fn(async () => ({ success: true, data: { cleaned: true } })),
    },
  });
  vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set').mockImplementation(() => {});
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = { start: vi.fn(), close: vi.fn(), postMessage: vi.fn(), onmessage: null };
      port2 = { close: vi.fn() };
      constructor() {
        channels.push(this);
      }
    },
  );
  (await import('../browserControllers')).initializeBrowserControllersOffscreen();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('waits for accepted commands and async cleanup while keeping the host bridge alive', async () => {
  const port = await start();
  const command = send('command', { method: 'command', input: { method: 'source.setOverride' } });
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'view-command', id: 1 }),
    ),
  );
  const closing = send('close'),
    anotherClose = send('close');
  expect(await send('held')).toEqual({ held: true });
  expect(await send('command', { method: 'command' })).toMatchObject({
    success: false,
    error: expect.stringContaining('closing'),
  });
  expect(
    port.postMessage.mock.calls.some(
      ([value]: any[]) => value.type === 'view-command' && value.method === 'dispose',
    ),
  ).toBe(false);
  port.onmessage({
    data: { type: 'view-command-result', id: 1, success: true, value: { ruleId: 42 } },
  });
  expect(await command).toEqual({ success: true, data: { ruleId: 42 } });
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'view-command',
      id: 2,
      method: 'dispose',
      input: undefined,
    }),
  );
  expect(document.querySelector('iframe')).not.toBeNull();
  port.onmessage({
    data: { type: 'view-call', id: 2, method: 'invoke', input: { action: 'cleanup' } },
  });
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'view-result',
      id: 2,
      success: true,
      value: { cleaned: true },
    }),
  );
  port.onmessage({ data: { type: 'view-command-result', id: 2, success: true } });
  expect(await closing).toMatchObject({ success: true });
  expect(await anotherClose).toMatchObject({ success: true });
  expect(await send('held')).toEqual({ held: false });
  expect(document.querySelector('iframe')).toBeNull();
  expect(port.close).toHaveBeenCalledOnce();
});
it('binds the session token and rejects document-originated runtime control', async () => {
  expect(await send('start', { selected }, { id: 'foreign' })).toBeUndefined();
  expect(await send('start', { selected }, { id: 'owned', documentId: 'ui' })).toBeUndefined();
  const port = await start();
  expect(await send('command', { token: 'other', method: 'command' })).toMatchObject({
    success: false,
    error: expect.stringContaining('owner changed'),
  });
  const closed = send('close');
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'view-command', method: 'dispose' }),
    ),
  );
  port.onmessage({ data: { type: 'view-command-result', id: 1, success: true } });
  await closed;
});
it('reports cleanup failure after releasing the frame and work lease', async () => {
  const port = await start();
  const closing = send('close');
  await vi.waitFor(() =>
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'dispose' })),
  );
  port.onmessage({
    data: { type: 'view-command-result', id: 1, success: false, error: 'release failed' },
  });
  expect(await closing).toEqual({ success: false, error: 'release failed' });
  expect(await send('held')).toEqual({ held: false });
  expect(document.querySelector('iframe')).toBeNull();
});
it('uses the offscreen owner port to finish cleanup even while the worker has stopped', async () => {
  vi.useFakeTimers();
  try {
    const port = await start();
    const connect = vi.mocked(chrome.runtime.onConnect.addListener).mock.calls[0][0];
    let disconnected!: () => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => ({
      success: true,
      data: message.method === 'owner.live' ? false : null,
    }));
    connect({
      name: 'mearl-browser-controller:' + id,
      sender: { id: 'owned', documentId: 'owner' },
      onDisconnect: {
        addListener: (listener: () => void) => {
          disconnected = listener;
        },
      },
    } as any);
    disconnected();
    await vi.advanceTimersByTimeAsync(300);
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'dispose' }));
    port.onmessage({ data: { type: 'view-command-result', id: 1, success: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await send('held')).toEqual({ held: false });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'closed' }),
    );
  } finally {
    vi.useRealTimers();
  }
});
