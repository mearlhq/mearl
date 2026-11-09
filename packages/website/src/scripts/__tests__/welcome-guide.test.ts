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

vi.mock('../../lib/site', () => ({ siteBase: '/mearl/' }));

const guide = { url: 'https://guide.example.test/installed.html' };
let controller: AbortController;
let fetchMock: ReturnType<typeof vi.fn>;
const headResponse = () => ({ type: 'opaque', status: 0, ok: false }) as Response;
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
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('guide reachability probe', () => {
  it('accepts an opaque HEAD response from the configured guide', async () => {
    fetchMock.mockResolvedValue(headResponse());
    await expect(probeGuide(guide, { signal: controller.signal })).resolves.toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.origin).toBe('https://guide.example.test');
    expect(url.pathname).toBe('/installed.html');
    expect(url.searchParams.get('mearl_probe')).toMatch(/^[a-f0-9-]{36}$/);
    expect(options).toEqual({
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restricts automatic requests to public IP space', async () => {
    fetchMock.mockResolvedValue(headResponse());
    await expect(
      probeGuide(guide, {
        publicOnly: true,
        signal: controller.signal,
      }),
    ).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][1].targetAddressSpace).toBe('public');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('requires an explicit capability before using automatic public-only requests', () => {
    expect(supportsPublicProbe(guide.url)).toBe(false);
    vi.stubGlobal(
      'Request',
      class {
        targetAddressSpace: string;
        constructor(_url: string, init: { targetAddressSpace: string }) {
          this.targetAddressSpace = init.targetAddressSpace;
        }
      },
    );
    expect(supportsPublicProbe(guide.url)).toBe(true);
  });
  it('can probe a proxied guide from a frame with local network access disabled', async () => {
    const frame = document.createElement('iframe');
    vi.spyOn(document, 'createElement').mockReturnValue(frame);
    vi.spyOn(document.body, 'append').mockImplementation(() => {});
    const remove = vi.spyOn(frame, 'remove');
    const features = () => ['local-network', 'loopback-network'];
    Object.defineProperty(document, 'featurePolicy', { configurable: true, value: { features } });
    const request = vi.fn().mockResolvedValue(headResponse());
    Object.defineProperties(frame, {
      contentDocument: { value: { featurePolicy: { features, allowsFeature: () => false } } },
      contentWindow: { value: { fetch: request } },
    });
    try {
      await expect(probeWithoutLocalNetwork(guide, controller.signal)).resolves.toBe(true);
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
  it('handles network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(probeGuide(guide, { signal: controller.signal })).resolves.toBe(false);
  });
  it('aborts a stalled network request after five seconds', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const promise = probeGuide(guide, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe(false);
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
    const promise = probeGuide(guide, { signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toBe(false);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    complete(headResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start a cancelled request', async () => {
    controller.abort();
    await expect(probeGuide(guide, { signal: controller.signal })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses a fresh query on retry', async () => {
    fetchMock.mockResolvedValue(headResponse());
    await probeGuide(guide, { signal: controller.signal });
    await probeGuide(guide, { signal: controller.signal });
    expect(fetchMock.mock.calls[0][0].href).not.toBe(fetchMock.mock.calls[1][0].href);
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

describe('silent welcome page discovery', () => {
  it('reads the catalog at the site root from a localized page', async () => {
    window.history.replaceState({}, '', '/mearl/en/installed.html');
    const load = vi
      .spyOn(installation, 'loadInstallationConfig')
      .mockResolvedValue({ schemaVersion: 1 });
    await initGuide();
    expect(load).toHaveBeenCalledWith(
      new URL('/mearl/installation.json', window.location.origin),
      window.location.origin,
      expect.any(AbortSignal),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <aside data-custom-website-banner hidden>
        <a data-custom-website-link>Open</a>
        <button data-custom-website-close>Close</button>
        <button data-custom-website-never>Don't show again</button>
      </aside>
      <main>Welcome</main>`;
    vi.stubGlobal('navigator', {
      userAgent: 'Chrome/148',
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    vi.spyOn(installation, 'loadInstallationConfig').mockResolvedValue({ schemaVersion: 1, guide });
  });

  it('shows a link without replacing the current page when the guide is reachable', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    fetchMock.mockResolvedValue(headResponse());
    await initGuide();
    expect(replace).not.toHaveBeenCalled();
    expect(document.querySelector('[data-custom-website-banner]')).not.toHaveProperty(
      'hidden',
      true,
    );
    expect(document.querySelector('[data-custom-website-link]')).toHaveProperty('href', guide.url);
  });

  it.each([
    ['close', 'sessionStorage'],
    ['never', 'localStorage'],
  ] as const)('can dismiss using %s', async (button, scope) => {
    fetchMock.mockResolvedValue(headResponse());
    await initGuide();
    document.querySelector<HTMLButtonElement>(`[data-custom-website-${button}]`)!.click();
    const banner = document.querySelector<HTMLElement>('[data-custom-website-banner]')!;
    expect(banner.hidden).toBe(true);
    expect(window[scope].getItem('mearl-intranet-banner-dismissed')).toBe('1');

    delete banner.dataset.dismissed;
    await initGuide();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(banner.hidden).toBe(true);
  });

  it('stays on the public welcome page after a failed probe', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('Offline'));
    await initGuide();
    expect(replace).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-custom-website-banner]')).toHaveProperty('hidden', true);
  });

  it('restores the cached banner before the catalog loads and clears it after a failed probe', async () => {
    fetchMock.mockResolvedValueOnce(headResponse()).mockRejectedValueOnce(new TypeError('Offline'));
    await initGuide();

    const banner = document.querySelector<HTMLElement>('[data-custom-website-banner]')!;
    const link = banner.querySelector<HTMLAnchorElement>('[data-custom-website-link]')!;
    banner.hidden = true;
    link.removeAttribute('href');
    let finish!: (config: Awaited<ReturnType<typeof installation.loadInstallationConfig>>) => void;
    vi.mocked(installation.loadInstallationConfig).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const refresh = initGuide();
    expect(banner.hidden).toBe(false);
    expect(link.href).toBe(guide.url);
    expect(fetchMock).toHaveBeenCalledOnce();

    finish({ schemaVersion: 1, guide });
    await refresh;
    expect(banner.hidden).toBe(true);
    expect(link.hasAttribute('href')).toBe(false);

    vi.mocked(installation.loadInstallationConfig).mockResolvedValueOnce({ schemaVersion: 1 });
    const nextVisit = initGuide();
    expect(banner.hidden).toBe(true);
    await nextVisit;
  });

  it('keeps a dismissed cached banner hidden when revalidation completes', async () => {
    fetchMock.mockResolvedValue(headResponse());
    await initGuide();

    const refresh = initGuide();
    document.querySelector<HTMLButtonElement>('[data-custom-website-close]')!.click();
    await refresh;

    expect(document.querySelector('[data-custom-website-banner]')).toHaveProperty('hidden', true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not request access when a silent probe is unavailable', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Chrome/148',
      permissions: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) },
    });
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    await initGuide();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
