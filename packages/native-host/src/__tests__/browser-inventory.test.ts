import { describe, expect, it, vi } from 'vitest';
import {
  ensureDiscoverableCdpBrowser,
  mergeBrowserInventory,
  type ProviderInventoryBrowser,
} from '../browser-inventory.js';
import type { BrowserRecord } from '../browser-registry.js';
import type { ProviderBrowser } from '@mearl/provider';

function connectedBrowser(overrides: Partial<BrowserRecord>): BrowserRecord {
  return {
    pid: 1,
    browserId: 'chrome-a',
    socketPath: '/tmp/chrome-a.sock',
    browserName: 'Chrome',
    nativeHostVersion: '1.40.0',
    transport: 'extension',
    startedAt: '2026-07-20T00:00:00.000Z',
    updatedAt: 1,
    ...overrides,
  };
}

function providerBrowser(
  providerId: string,
  overrides: Partial<ProviderBrowser>,
): ProviderInventoryBrowser {
  return {
    provider: {
      id: providerId,
      name: providerId === 'local' ? 'Local Chrome' : providerId,
      builtin: providerId === 'local',
      version: '1.0.0',
      protocolVersion: 2,
    },
    browser: {
      browserId: 'managed:account-a',
      name: 'account-a',
      status: 'running_disconnected',
      control: { kind: 'host', transport: 'cdp', browserId: 'managed:account-a' },
      ownership: 'owned',
      persistence: 'ephemeral',
      operations: ['close'],
      details: {
        headless: true,
        cdpPort: 9223,
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      ...overrides,
    },
  };
}

describe('browser inventory', () => {
  it('registers a discovered CDP browser only after connectivity succeeds', async () => {
    const availablePublish = vi.fn(() => true);
    const availableMonitor = vi.fn();

    await expect(
      ensureDiscoverableCdpBrowser({
        isPublished: () => false,
        isAvailable: async () => true,
        publish: availablePublish,
        monitor: availableMonitor,
      }),
    ).resolves.toBe(true);
    expect(availablePublish).toHaveBeenCalledOnce();
    expect(availableMonitor).toHaveBeenCalledOnce();

    const rejectedMonitor = vi.fn();
    await expect(
      ensureDiscoverableCdpBrowser({
        isPublished: () => false,
        isAvailable: async () => true,
        publish: () => false,
        monitor: rejectedMonitor,
      }),
    ).resolves.toBe(false);
    expect(rejectedMonitor).not.toHaveBeenCalled();

    const unavailablePublish = vi.fn();
    const unavailableMonitor = vi.fn();
    await expect(
      ensureDiscoverableCdpBrowser({
        isPublished: () => false,
        isAvailable: async () => false,
        publish: unavailablePublish,
        monitor: unavailableMonitor,
      }),
    ).resolves.toBe(false);
    expect(unavailablePublish).not.toHaveBeenCalled();
    expect(unavailableMonitor).not.toHaveBeenCalled();
  });

  it('merges connected and managed records by browserId', () => {
    const result = mergeBrowserInventory(
      [
        connectedBrowser({}),
        connectedBrowser({
          browserId: 'managed:account-a',
          browserName: 'account-a',
          socketPath: '/tmp/account-a.sock',
          transport: 'cdp',
        }),
      ],
      [
        providerBrowser('local', {}),
        providerBrowser('local', {
          browserId: 'managed:account-b',
          name: 'account-b',
          details: { headless: true, createdAt: '2026-07-19T00:00:00.000Z' },
        }),
        providerBrowser('local', {
          browserId: 'managed:account-c',
          name: 'account-c',
          status: 'stopped',
          control: { kind: 'none' },
          persistence: 'persistent',
          operations: ['start', 'deleteData'],
          details: { headless: true, createdAt: '2026-07-18T00:00:00.000Z' },
        }),
      ],
    );

    expect(result).toMatchObject({ count: 4, connectedCount: 2 });
    expect(result.browsers).toEqual([
      expect.objectContaining({
        browserId: 'chrome-a',
        type: 'regular',
        status: 'connected',
      }),
      expect.objectContaining({
        browserId: 'managed:account-a',
        type: 'managed',
        status: 'connected',
        provider: expect.objectContaining({ id: 'local', builtin: true }),
        details: expect.objectContaining({ headless: true }),
      }),
      expect.objectContaining({
        browserId: 'managed:account-b',
        type: 'managed',
        status: 'running_disconnected',
      }),
      expect.objectContaining({
        browserId: 'managed:account-c',
        type: 'managed',
        status: 'stopped',
      }),
    ]);
  });

  it('keeps external provider capabilities out of browser inventory', () => {
    const result = mergeBrowserInventory(
      [
        connectedBrowser({
          browserId: 'provider:example-device:device-a',
          browserName: 'Example device',
          socketPath: '/tmp/example-device-provider.sock',
          transport: 'provider',
          provider: {
            id: 'example-device',
            name: 'Example Device Provider',
            builtin: false,
            version: '0.1.0',
            protocolVersion: 2,
          },
          status: 'connected',
          persistence: 'ephemeral',
          operations: ['close'],
          capabilities: {
            actions: ['page_snapshot', 'page_screenshot'],
            screenshot: 'reconstructed',
          },
        }),
      ],
      [],
    );

    expect(result.browsers).toEqual([
      expect.objectContaining({
        browserId: 'provider:example-device:device-a',
        transport: 'provider',
        provider: {
          id: 'example-device',
          name: 'Example Device Provider',
          builtin: false,
          version: '0.1.0',
          protocolVersion: 2,
        },
      }),
    ]);
    expect(result.browsers[0]).not.toHaveProperty('capabilities');
  });

  it('keeps a pairable provider visible without selecting it as connected', () => {
    const result = mergeBrowserInventory(
      [
        connectedBrowser({
          browserId: 'provider:example-device:pairing',
          browserName: 'Example device',
          socketPath: '/tmp/example-device-provider.sock',
          transport: 'provider',
          provider: { id: 'example-device', name: 'Example Device', builtin: false, protocolVersion: 2 },
          status: 'pairing',
          persistence: 'ephemeral',
          operations: ['close'],
          pairing: {
            kind: 'qr',
            url: 'https://example.test/pair?id=device-a',
            code: 'device-a',
          },
        }),
      ],
      [],
    );

    expect(result).toMatchObject({ count: 1, connectedCount: 0 });
    expect(result.browsers[0]).toMatchObject({
      status: 'pairing',
      pairing: {
        kind: 'qr',
        url: 'https://example.test/pair?id=device-a',
        code: 'device-a',
      },
    });
  });

  it('exposes stable external Provider metadata without transient access URLs', () => {
    const cloud = providerBrowser('example-cloud', {
      browserId: 'managed:example-cloud:cloud-a',
      name: 'cloud-a',
      status: 'stopped',
      control: { kind: 'none' },
      ownership: 'attached',
      persistence: 'persistent',
      operations: ['start'],
      references: [
        { kind: 'session', id: 'session-a' },
        { kind: 'image', id: 'imgc-internal' },
        { kind: 'context', id: 'context-a' },
        { kind: 'context-name', id: 'mearl-browser-context-a' },
      ],
      details: { headless: false, createdAt: '2026-07-20T00:00:00.000Z' },
    });

    const browsers = mergeBrowserInventory([], [cloud]).browsers;
    expect(browsers).toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ id: 'example-cloud', builtin: false }),
        ownership: 'attached',
        persistence: 'persistent',
        references: expect.arrayContaining([
          { kind: 'session', id: 'session-a' },
          { kind: 'context', id: 'context-a' },
        ]),
        status: 'stopped',
      }),
    ]);
    expect(JSON.stringify(browsers[0])).not.toContain('cloud.example');
  });
});
