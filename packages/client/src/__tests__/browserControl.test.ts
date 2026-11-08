import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { browsers } = vi.hoisted(() => ({
  browsers: [
    {
      pid: 1,
      browserId: 'chrome-a',
      socketPath: '/tmp/chrome-a.sock',
      browserName: 'Chrome',
      transport: 'extension' as const,
      lastFocusedAt: 2,
    },
    {
      pid: 2,
      browserId: 'edge-b',
      socketPath: '/tmp/edge-b.sock',
      browserName: 'Edge',
      transport: 'cdp' as const,
      lastFocusedAt: 1,
    },
  ],
}));

vi.mock('../browserRegistry.js', () => ({
  listLiveBrowsers: () => browsers,
  findBrowser: (items: typeof browsers, selector: string) => {
    const normalized = selector.toLowerCase();
    return (
      items.find(item => item.browserId === normalized) ??
      items.find(item => item.browserName.toLowerCase() === normalized) ??
      null
    );
  },
  describeBrowser: (browser: (typeof browsers)[number]) => browser.browserName,
}));

import { decorateBrowserListResult, invoke } from '../socket.js';

beforeEach(() => {
  vi.stubEnv('MEARL_BROWSER', '');
});

afterEach(async () => {
  await invoke('browser_select_browser', {});
  vi.unstubAllEnvs();
});

describe('browser routing actions', () => {
  it('decorates the unified browser list and selects a default target asynchronously', async () => {
    const inventory = {
      count: 2,
      connectedCount: 2,
      browsers: [
        { browserId: 'chrome-a', name: 'Chrome', type: 'regular', status: 'connected' },
        { browserId: 'edge-b', name: 'Edge', type: 'regular', status: 'connected' },
      ],
    };
    expect(decorateBrowserListResult(inventory)).toMatchObject({
      defaultBrowserId: 'chrome-a',
    });

    await expect(invoke('browser_select_browser', { browser: 'Edge' })).resolves.toEqual({
      selected: { browserId: 'edge-b', name: 'Edge' },
    });
    expect(decorateBrowserListResult(inventory)).toMatchObject({
      defaultBrowserId: 'edge-b',
    });
  });

  it('never marks a disconnected managed browser as the default target', () => {
    const result = decorateBrowserListResult({
      count: 2,
      connectedCount: 1,
      browsers: [
        {
          browserId: 'managed:offline',
          name: 'offline',
          type: 'managed',
          status: 'running_disconnected',
        },
        { browserId: 'chrome-a', name: 'Chrome', type: 'regular', status: 'connected' },
      ],
    });

    expect(result.defaultBrowserId).toBe('chrome-a');
  });

  it('requires a full browser id when connected browser names are duplicated', () => {
    vi.stubEnv('MEARL_BROWSER', 'shared');

    expect(() =>
      decorateBrowserListResult({
        count: 2,
        connectedCount: 2,
        browsers: [
          { browserId: 'managed:local', name: 'Shared', type: 'managed', status: 'connected' },
          {
            browserId: 'example-cloud:session',
            name: 'Shared',
            type: 'example-cloud',
            status: 'connected',
          },
        ],
      }),
    ).toThrow(/ambiguous.*managed:local, example-cloud:session/i);
  });

  it('prefers a full browser id even when browser names are duplicated', () => {
    vi.stubEnv('MEARL_BROWSER', 'example-cloud:session');

    expect(
      decorateBrowserListResult({
        count: 2,
        connectedCount: 2,
        browsers: [
          { browserId: 'managed:local', name: 'Shared', type: 'managed', status: 'connected' },
          {
            browserId: 'example-cloud:session',
            name: 'Shared',
            type: 'example-cloud',
            status: 'connected',
          },
        ],
      }),
    ).toMatchObject({ defaultBrowserId: 'example-cloud:session' });
  });
});
