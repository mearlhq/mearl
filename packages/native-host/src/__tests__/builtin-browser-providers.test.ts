import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  localBrowsers: [] as any[],
  launchLocal: vi.fn(),
  discoverTargets: vi.fn(),
}));

vi.mock('../managed-browser.js', () => ({
  listManagedBrowsers: () => mocks.localBrowsers,
  launchManagedBrowser: mocks.launchLocal,
  closeManagedBrowser: vi.fn(),
}));
vi.mock('../browser-registry.js', () => ({ listRegisteredBrowsers: () => [] }));
vi.mock('../cdp-backend/discover.js', () => ({ discoverTargets: mocks.discoverTargets }));

import { createLocalBrowserProvider } from '../builtin-providers/local.js';

function createRuntime() {
  return createLocalBrowserProvider({
    nativeHostScript: '/fixture/native-host.js',
    exportCookies: vi.fn(),
    log: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.localBrowsers = [];
});

describe('built-in Provider lifecycle', () => {
  it('copies a DevTools link to a page in the selected running local browser', async () => {
    mocks.localBrowsers = [
      {
        browserId: 'managed:profile',
        name: 'profile',
        running: true,
        persistent: false,
        headless: true,
        cdpPort: 59652,
        createdAt: '2026-09-08T00:00:00Z',
      },
    ];
    mocks.discoverTargets.mockResolvedValue([
      { type: 'browser_ui', id: 'browser-ui' },
      { type: 'service_worker', id: 'worker' },
      { type: 'page', id: 'settings', url: 'chrome://settings/' },
      { type: 'page', id: 'current-page', url: 'https://example.test/' },
    ]);
    const runtime = createRuntime();
    expect((await runtime.listBrowsers())[0]?.operations).toContain('access');
    const access = await runtime.getAccess({ browserId: 'managed:profile' });
    expect(mocks.discoverTargets).toHaveBeenCalledWith(59652);
    expect(access).toMatchObject({ kind: 'cdp-devtools', sensitive: true });
    const url = new URL(access.url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      'devtools://devtools/bundled/inspector.html',
    );
    expect(url.searchParams.get('ws')).toBe('127.0.0.1:59652/devtools/page/current-page');
  });

  it('does not advertise access for a stopped local browser', async () => {
    mocks.localBrowsers = [
      {
        browserId: 'managed:profile',
        name: 'profile',
        running: false,
        persistent: true,
        headless: true,
        cdpPort: 59652,
        createdAt: '2026-09-08T00:00:00Z',
      },
    ];
    const runtime = createRuntime();
    expect((await runtime.listBrowsers())[0]?.operations).not.toContain('access');
    await expect(runtime.getAccess({ browserId: 'managed:profile' })).rejects.toThrow(
      'does not support access',
    );
    expect(mocks.discoverTargets).not.toHaveBeenCalled();
  });

  it('reports when the running local browser has no page to inspect', async () => {
    mocks.localBrowsers = [
      {
        browserId: 'managed:profile',
        name: 'profile',
        running: true,
        persistent: false,
        headless: true,
        cdpPort: 59652,
        createdAt: '2026-09-08T00:00:00Z',
      },
    ];
    mocks.discoverTargets.mockResolvedValue([{ type: 'service_worker', id: 'worker' }]);
    await expect(createRuntime().getAccess({ browserId: 'managed:profile' })).rejects.toThrow(
      'no inspectable page',
    );
  });

  it('declares the shared cookie-sync form component for local launches', () => {
    expect(
      createRuntime().definition.browserType.inputSchema.properties.copyCookieDomains,
    ).toMatchObject({ type: 'object', component: 'cookie-sync' });
  });

  it('restarts the selected local profile with its stored launch settings', async () => {
    const browser = {
      browserId: 'managed:profile',
      name: 'profile',
      running: false,
      persistent: true,
      headless: false,
      cdpPort: 9222,
      createdAt: '2026-09-08T00:00:00Z',
    };
    mocks.localBrowsers = [browser];
    mocks.launchLocal.mockResolvedValue({ ...browser, running: true });
    await expect(createRuntime().start({ browserId: browser.browserId })).resolves.toMatchObject({
      browserId: browser.browserId,
      status: 'running_disconnected',
      persistence: 'persistent',
    });
    expect(mocks.launchLocal).toHaveBeenCalledWith(
      {
        name: 'profile',
        persistent: true,
        headless: false,
      },
      expect.anything(),
    );
  });
});
