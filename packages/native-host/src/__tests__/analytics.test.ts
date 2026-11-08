import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({ clientId: 'test-client' })),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('../version.js', () => ({
  NATIVE_HOST_VERSION: '2.0.0',
}));

import { classifyAnalyticsError, setAnalyticsClientId, trackAction } from '../analytics.js';

describe('native-host analytics', () => {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubEnv('MEARL_ANALYTICS_ENDPOINT', 'https://metrics.example.com/collect');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports the native-host version without fabricated engagement time', () => {
    expect(setAnalyticsClientId('1234567890.1785123456')).toBe(true);
    trackAction('tab_list', {
      success: true,
      transport: 'extension',
      duration_ms: 25,
      extension_version: '2.0.0',
      mearl_version: 'overridden',
    });

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('Missing analytics request');
    const payload = JSON.parse(call[1]?.body as string);
    expect(payload).toEqual({
      client_id: '1234567890.1785123456',
      events: [
        {
          name: 'agent_action',
          params: {
            action: 'tab_list',
            success: true,
            transport: 'extension',
            duration_ms: 25,
            extension_version: '2.0.0',
            mearl_version: '2.0.0',
            runtime: 'native_host',
            build_channel: 'production',
          },
        },
      ],
    });
    expect(call[1]).toMatchObject({
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });
  });

  it('rejects malformed shared identities and groups errors without raw messages', () => {
    expect(setAnalyticsClientId('uuid-value')).toBe(false);
    expect(classifyAnalyticsError(new Error('Request timed out after 1000ms'))).toBe('timeout');
    expect(classifyAnalyticsError(new Error('Cookie access not authorized'))).toBe(
      'permission_denied',
    );
    expect(classifyAnalyticsError(new Error('No matching tab found'))).toBe('not_found');
    expect(classifyAnalyticsError(new Error('Native host disconnected'))).toBe('unavailable');
    expect(classifyAnalyticsError(new Error('tabId is required'))).toBe('invalid_request');
    expect(classifyAnalyticsError(new Error('Script failed'))).toBe('execution_error');
  });
});


it('does not send analytics without a configured endpoint or capability', () => {
  vi.stubEnv('MEARL_ANALYTICS_ENDPOINT', '');
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  try { trackAction('tab_list'); expect(fetcher).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
