import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initAnalytics, sanitizeAnalyticsText, trackEvent } from '../analytics';

vi.hoisted(() => { vi.stubEnv('VITE_MEARL_ANALYTICS_ID', 'fixture-id'); vi.stubEnv('VITE_MEARL_ANALYTICS_SECRET', 'fixture-secret'); });
afterAll(() => vi.unstubAllEnvs());

describe('analytics', () => {
  const localGet = chrome.storage.local.get as Mock;
  const localSet = chrome.storage.local.set as Mock;
  const getManifest = chrome.runtime.getManifest as Mock;
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
  const sessionGet = vi.fn();
  const sessionSet = vi.fn();

  function payloadAt(index: number) {
    const call = fetchMock.mock.calls[index];
    if (!call) throw new Error(`Missing fetch call at index ${index}`);
    return JSON.parse(call[1]?.body as string);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    (chrome.storage as any).session = {
      get: sessionGet,
      set: sessionSet,
      remove: vi.fn(),
    };
    localGet.mockResolvedValue({ ga_client_id: 'legacy-uuid-client' });
    localSet.mockResolvedValue(undefined);
    sessionGet.mockResolvedValue({
      ga_session: {
        id: '1785123456789',
        timestamp: Date.now(),
      },
    });
    sessionSet.mockResolvedValue(undefined);
    getManifest.mockReturnValue({ version: '2.0.0' });
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    delete (chrome.storage as any).session;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses a valid shared identity and reports measured page engagement', async () => {
    await initAnalytics('panel');

    const pageViewPayload = payloadAt(0);
    expect(pageViewPayload.client_id).toMatch(/^\d+\.\d+$/);
    expect(localSet).toHaveBeenCalledWith({
      ga_client_id: expect.stringMatching(/^\d+\.\d+$/),
    });
    expect(pageViewPayload.events[0]).toEqual({
      name: 'page_view',
      params: {
        session_id: '1785123456789',
        mearl_version: '2.0.0',
        runtime: 'extension',
        build_channel: 'development',
        page_title: 'panel',
        page_location: 'https://mearl-extension.local/panel',
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });

    vi.advanceTimersByTime(2_500);
    await trackEvent('import_mock', { count: 2 });

    const actionPayload = payloadAt(1);
    expect(actionPayload.events[0]).toEqual({
      name: 'import_mock',
      params: {
        session_id: '1785123456789',
        mearl_version: '2.0.0',
        runtime: 'extension',
        build_channel: 'development',
        engagement_time_msec: 2_500,
        count: 2,
        page_title: 'panel',
        page_location: 'https://mearl-extension.local/panel',
      },
    });

    vi.advanceTimersByTime(1_500);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(payloadAt(2).events[0]).toEqual({
      name: 'page_engagement',
      params: {
        session_id: '1785123456789',
        mearl_version: '2.0.0',
        runtime: 'extension',
        build_channel: 'development',
        engagement_time_msec: 1_500,
        page_title: 'panel',
        page_location: 'https://mearl-extension.local/panel',
      },
    });
  });

  it('redacts direct identifiers and secrets while preserving the error structure', () => {
    const sanitized = sanitizeAnalyticsText(
      'Error for foo@example.com at /Users/tuyan/app.ts ' +
        'https://example.com/api?token=abc&mode=test Bearer header.payload.signature',
      300,
    );

    expect(sanitized).toBe(
      'Error for [email] at /Users/[user]/app.ts ' +
        'https://example.com/api?token=[redacted]&mode=[redacted] Bearer [redacted]',
    );
  });

  it('does not reject when analytics initialization fails', async () => {
    sessionGet.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(trackEvent('import_mock', { count: 1 })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
