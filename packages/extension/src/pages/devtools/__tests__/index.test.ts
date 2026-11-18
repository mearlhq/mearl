import { expect, it, vi } from 'vitest';
import { DEVICE_PREVIEW_DEVTOOLS_VISIBILITY_ACTION } from '../../../shared/devicePreviewPanel';

it('reports Mearl panel visibility and restores it when the DevTools port reconnects', async () => {
  const panel = {
    onShown: { addListener: vi.fn() },
    onHidden: { addListener: vi.fn() },
  };
  const create = vi.fn((_title, _icon, _page, callback) => callback(panel));
  const ports: Array<ReturnType<typeof makePort>> = [];
  function makePort() {
    return {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };
  }
  const connect = vi.fn(() => {
    const port = makePort();
    ports.push(port);
    return port;
  });
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: { ...chrome.runtime, id: 'test-extension', connect },
    devtools: { inspectedWindow: { tabId: 42 }, panels: { create } },
  });

  try {
    await import('../index');
    const visibility = (visible: boolean) => ({
      action: DEVICE_PREVIEW_DEVTOOLS_VISIBILITY_ACTION,
      visible,
    });
    expect(connect).toHaveBeenCalledExactlyOnceWith({ name: 'devtools-page-42' });
    expect(ports[0].postMessage).toHaveBeenCalledExactlyOnceWith(visibility(false));

    panel.onShown.addListener.mock.calls[0][0]();
    expect(ports[0].postMessage).toHaveBeenLastCalledWith(visibility(true));
    ports[0].onDisconnect.addListener.mock.calls[0][0]();
    await vi.advanceTimersByTimeAsync(250);
    expect(ports[1].postMessage).toHaveBeenCalledExactlyOnceWith(visibility(true));

    panel.onHidden.addListener.mock.calls[0][0]();
    expect(ports[1].postMessage).toHaveBeenLastCalledWith(visibility(false));
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
