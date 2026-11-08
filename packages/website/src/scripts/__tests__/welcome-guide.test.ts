// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initGuide,
  localNetworkPermission,
  mayAutoProbe,
  probeGuide,
  probeWithoutLocalNetwork,
  supportsPublicProbe,
} from '../welcome-guide';
import * as installation from '../../lib/installation.mjs';

const guide = {
  url: 'https://guide.example.test/installed.html',
  registry: 'https://registry.example.test/',
};
let controller: AbortController;
let fetchMock: ReturnType<typeof vi.fn>;
const pong = () =>
  new Response('{"pong":true}', { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  controller = new AbortController();
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  controller.abort();
  window.dispatchEvent(new Event('pagehide'));
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('npm registry environment probe', () => {
  it('checks the standard ping response without credentials, redirects or cache', async () => {
    fetchMock.mockResolvedValue(pong());
    await expect(probeGuide(guide, { manual: false, signal: controller.signal })).resolves.toBe(
      'ready',
    );
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.origin).toBe('https://registry.example.test');
    expect(url.pathname).toBe('/-/ping');
    expect(url.searchParams.get('mearl_probe')).toMatch(/^[a-f0-9-]{36}$/);
    expect(options).toEqual({
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response('{"pong":true}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    () => new Response('{"pong":"true"}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
  ])('rejects login, error and non-ping bodies', async response => {
    fetchMock.mockResolvedValue(response());
    await expect(probeGuide(guide, { manual: false, signal: controller.signal })).resolves.toBe(
      'unavailable',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restricts automatic requests to public IP space even when local access is denied', async () => {
    fetchMock.mockResolvedValue(pong());
    await expect(
      probeGuide(guide, {
        manual: false,
        publicOnly: true,
        permission: { state: 'denied' } as PermissionStatus,
        signal: controller.signal,
      }),
    ).resolves.toBe('ready');
    expect(fetchMock.mock.calls[0][1].targetAddressSpace).toBe('public');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('requires an explicit capability before using automatic public-only requests', () => {
    expect(supportsPublicProbe(guide.registry)).toBe(false);
    vi.stubGlobal(
      'Request',
      class {
        targetAddressSpace: string;
        constructor(_url: string, init: { targetAddressSpace: string }) {
          this.targetAddressSpace = init.targetAddressSpace;
        }
      },
    );
    expect(supportsPublicProbe(guide.registry)).toBe(true);
  });
  it('can probe a proxied registry from a frame with local network access disabled', async () => {
    const frame = document.createElement('iframe');
    vi.spyOn(document, 'createElement').mockReturnValue(frame);
    vi.spyOn(document.body, 'append').mockImplementation(() => {});
    const remove = vi.spyOn(frame, 'remove');
    const features = () => ['local-network', 'loopback-network'];
    Object.defineProperty(document, 'featurePolicy', { configurable: true, value: { features } });
    const request = vi.fn().mockResolvedValue(pong());
    Object.defineProperties(frame, {
      contentDocument: { value: { featurePolicy: { features, allowsFeature: () => false } } },
      contentWindow: { value: { fetch: request } },
    });
    try {
      await expect(probeWithoutLocalNetwork(guide, controller.signal)).resolves.toBe('ready');
      expect(frame.allow).toContain("local-network 'none'");
      expect(request).toHaveBeenCalledExactlyOnceWith(
        expect.any(URL),
        expect.not.objectContaining({ targetAddressSpace: expect.anything() }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(document, 'featurePolicy');
    }
  });
  it('handles network and redirect errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(probeGuide(guide, { manual: false, signal: controller.signal })).resolves.toBe(
      'unavailable',
    );
  });
  it('aborts a stalled network request after five seconds', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const promise = probeGuide(guide, { manual: false, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe('unavailable');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases pending work on cancellation and ignores a late response', async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise(resolve => {
        complete = resolve;
      }),
    );
    const promise = probeGuide(guide, { manual: true, signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toBe('cancelled');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    complete(pong());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start a cancelled or denied request', async () => {
    controller.abort();
    await expect(probeGuide(guide, { manual: true, signal: controller.signal })).resolves.toBe(
      'cancelled',
    );
    await expect(
      probeGuide(guide, {
        manual: true,
        permission: { state: 'denied' } as PermissionStatus,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses a fresh query on retry', async () => {
    fetchMock.mockResolvedValue(pong());
    await probeGuide(guide, { manual: false, signal: controller.signal });
    fetchMock.mockResolvedValue(pong());
    await probeGuide(guide, { manual: false, signal: controller.signal });
    expect(fetchMock.mock.calls[0][0].href).not.toBe(fetchMock.mock.calls[1][0].href);
  });
  it('waits for the network permission decision before starting the short deadline', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const permission = Object.assign(new EventTarget(), {
      state: 'prompt',
    }) as unknown as PermissionStatus;
    const promise = probeGuide(guide, { manual: true, permission, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    Object.assign(permission, { state: 'granted' });
    permission.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe('unavailable');
  });
  it('stops immediately when permission is denied', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const permission = Object.assign(new EventTarget(), {
      state: 'prompt',
    }) as unknown as PermissionStatus;
    const promise = probeGuide(guide, { manual: true, permission, signal: controller.signal });
    Object.assign(permission, { state: 'denied' });
    permission.dispatchEvent(new Event('change'));
    await expect(promise).resolves.toBe('denied');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('bounds an unanswered permission dialog', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const promise = probeGuide(guide, { manual: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(promise).resolves.toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('permission compatibility', () => {
  it('only automatically probes when allowed or on an explicitly older Chromium', () => {
    expect(mayAutoProbe({ state: 'granted' } as PermissionStatus, 'Chrome/148')).toBe(true);
    expect(mayAutoProbe({ state: 'prompt' } as PermissionStatus, 'Chrome/148')).toBe(false);
    expect(mayAutoProbe(undefined, 'Chrome/141')).toBe(true);
    expect(mayAutoProbe(undefined, 'Chrome/148')).toBe(false);
    expect(mayAutoProbe(undefined, 'Unknown')).toBe(false);
  });
  it('falls back to the legacy permission name only on supported Chromium', async () => {
    const permission = { state: 'prompt' };
    const query = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Unknown permission'))
      .mockResolvedValue(permission);
    vi.stubGlobal('navigator', { userAgent: 'Chrome/148', permissions: { query } });
    expect(await localNetworkPermission()).toBe(permission);
    expect(query.mock.calls.map(call => call[0].name)).toEqual([
      'local-network',
      'local-network-access',
    ]);
  });
  it('does not query the unsafe legacy name on older or unknown browsers', async () => {
    const query = vi.fn().mockRejectedValue(new TypeError('Unknown permission'));
    vi.stubGlobal('navigator', { userAgent: 'Chrome/130', permissions: { query } });
    expect(await localNetworkPermission()).toBeUndefined();
    expect(query.mock.calls.map(call => call[0].name)).toEqual(['local-network']);
  });
});

describe('welcome guide configuration recovery', () => {
  function markup() {
    document.body.innerHTML =
      '<div data-guide hidden><p data-guide-status></p><button data-guide-detect>检测引导连接</button><button data-guide-cancel hidden>取消</button><a data-guide-link>打开引导</a></div>';
  }
  it('reads the shared configuration from a localized welcome page', async () => {
    markup();
    document.querySelector<HTMLElement>('[data-guide]')!.dataset.configUrl =
      '/mearl/installation.json';
    const load = vi
      .spyOn(installation, 'loadInstallationConfig')
      .mockResolvedValue({ schemaVersion: 1 });
    await initGuide();
    expect(load).toHaveBeenCalledWith(
      new URL('/mearl/installation.json', window.location.href),
      window.location.origin,
      expect.any(AbortSignal),
    );
  });
  it('clears a configuration error when retry succeeds with the public default', async () => {
    markup();
    const load = vi
      .spyOn(installation, 'loadInstallationConfig')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue({ schemaVersion: 1 });
    await initGuide();
    expect(document.querySelector<HTMLElement>('[data-guide]')!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-guide-detect]')!.click();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(document.querySelector<HTMLElement>('[data-guide]')!.hidden).toBe(true);
    expect(document.querySelector('[data-guide-status]')!.textContent).toBe('');
    expect(document.querySelector('[data-guide-link]')!.hasAttribute('href')).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
  });
  it('retries a public registry even if local-network access is denied', async () => {
    markup();
    vi.stubGlobal('navigator', {
      userAgent: 'Chrome/148',
      permissions: { query: vi.fn().mockResolvedValue({ state: 'denied' }) },
    });
    vi.stubGlobal(
      'Request',
      class {
        targetAddressSpace: string;
        constructor(_url: string, init: { targetAddressSpace: string }) {
          this.targetAddressSpace = init.targetAddressSpace;
        }
      },
    );
    vi.spyOn(installation, 'loadInstallationConfig').mockResolvedValue({ schemaVersion: 1, guide });
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('Offline')).mockResolvedValueOnce(pong());
    await initGuide();
    document.querySelector<HTMLButtonElement>('[data-guide-detect]')!.click();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(guide.url));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(([, options]) => options.targetAddressSpace === 'public'),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('drops an old link when restoring a page after the guide configuration is removed', async () => {
    markup();
    vi.stubGlobal('navigator', {
      userAgent: 'Chrome/148',
      permissions: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) },
    });
    vi.spyOn(installation, 'loadInstallationConfig')
      .mockResolvedValueOnce({ schemaVersion: 1, guide })
      .mockResolvedValue({ schemaVersion: 1 });
    await initGuide();
    expect(document.querySelector<HTMLAnchorElement>('[data-guide-link]')!.href).toBe(guide.url);
    window.dispatchEvent(new Event('pagehide'));
    await initGuide();
    expect(document.querySelector<HTMLElement>('[data-guide]')!.hidden).toBe(true);
    expect(document.querySelector('[data-guide-link]')!.hasAttribute('href')).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
  });
});
