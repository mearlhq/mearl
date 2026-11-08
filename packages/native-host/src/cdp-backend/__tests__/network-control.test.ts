vi.mock('../../native-capability-services.js', () => ({ nativeCapabilities: { require: () => () => ({
  schemaVersion: 1, id: 'environment', kind: 'segmented', label: { en: 'Route' }, description: { en: 'Route selection' }, messages: { changed: { en: 'Changed' }, failed: { en: 'Failed' } }, defaultValue: 'default',
  options: [
    { value: 'default', label: { en: 'Off' }, networkRoutes: { routes: [] } },
    { value: 'pre', label: { en: 'Preview' }, networkRoutes: { routes: [{ fromHost: 'gateway.example.com', toHost: 'gateway.preview.example.com' }, { fromHost: 'other.example.com', toHost: 'other.preview.example.com' }] } },
    { value: 'prod', label: { en: 'Production' }, networkRoutes: { routes: [{ fromHost: 'gateway.preview.example.com', toHost: 'gateway.example.com' }, { fromHost: 'other.preview.example.com', toHost: 'other.example.com' }] } },
  ],
}) } }));
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuffers } from '../buffers.js';
import type { PageSession } from '../cdp-session.js';
import { clearCdpFetchInterceptionState } from '../fetch-interceptor.js';
import { cdpSetMock, clearCdpMockState } from '../mock-handlers.js';
import {
  clearCdpNetworkControlState,
  getCdpNetworkControl,
  setCdpNetworkControl,
} from '../network-control.js';

function createSession(): {
  session: PageSession;
  sendCommand: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  paused: () => ((params: any) => Promise<void>) | undefined;
} {
  let pausedListener: ((params: any) => Promise<void>) | undefined;
  const sendCommand = vi.fn().mockResolvedValue({});
  const on = vi.fn((event: string, listener: (params: any) => Promise<void>) => {
    if (event === 'Fetch.requestPaused') pausedListener = listener;
    return () => {
      if (pausedListener === listener) pausedListener = undefined;
    };
  });
  const session = {
    tabId: 1000,
    targetId: 'target-environment',
    url: 'https://www.example.com/example',
    buffers: createBuffers(1000),
    client: { sendCommand, on },
  } as unknown as PageSession;
  return { session, sendCommand, on, paused: () => pausedListener };
}

afterEach(() => {
  clearCdpMockState();
  clearCdpNetworkControlState();
  clearCdpFetchInterceptionState();
});

describe('CDP Protocol environment switching', () => {
  it('rejects unknown environment values before enabling interception', async () => {
    const { session, sendCommand } = createSession();

    await expect(setCdpNetworkControl(session, { id: 'environment', value: 'online' })).rejects.toThrow(
      'Unknown installed browser control selection',
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('releases its Fetch interception when the installed default option is selected', async () => {
    const { session, sendCommand } = createSession();
    await setCdpNetworkControl(session, { id: 'environment', value: 'pre' });
    sendCommand.mockClear();
    await setCdpNetworkControl(session, { id: 'environment', value: 'default' });
    expect(sendCommand).toHaveBeenCalledWith('Fetch.disable', {});
    expect(getCdpNetworkControl(session)).toEqual({ id: 'environment', value: 'default' });
  });
  it('rewrites production requests to pre-release and supplies CORS response headers', async () => {
    const { session, sendCommand, paused } = createSession();
    await setCdpNetworkControl(session, { id: 'environment', value: 'pre' });

    expect(sendCommand).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' },
      ],
    });
    sendCommand.mockClear();

    await paused()?.({
      requestId: 'request-1',
      request: {
        method: 'GET',
        url: 'https://gateway.example.com/h5/mtop.test.api/1.0/?type=jsonp',
      },
    });
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
      requestId: 'request-1',
      url: 'https://gateway.preview.example.com/h5/mtop.test.api/1.0/?type=jsonp',
    });

    await paused()?.({
      requestId: 'request-1',
      request: {
        method: 'GET',
        url: 'https://gateway.example.com/h5/mtop.test.api/1.0/',
        headers: { Origin: 'https://www.example.com' },
      },
      responseStatusCode: 200,
      responseStatusText: 'OK',
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'access-control-allow-origin', value: '*' },
      ],
    });
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueResponse', {
      requestId: 'request-1',
      responseCode: 200,
      responsePhrase: 'OK',
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'access-control-allow-origin', value: 'https://www.example.com' },
        { name: 'access-control-allow-credentials', value: 'true' },
      ],
    });
  });

  it('rewrites pre-release requests to production and default restores passthrough', async () => {
    const { session, sendCommand, paused } = createSession();
    await setCdpNetworkControl(session, { id: 'environment', value: 'prod' });
    sendCommand.mockClear();

    await paused()?.({
      requestId: 'request-prod',
      request: {
        method: 'GET',
        url: 'https://other.preview.example.com/h5/mtop.test.api/1.0/',
      },
    });
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
      requestId: 'request-prod',
      url: 'https://other.example.com/h5/mtop.test.api/1.0/',
    });

    await setCdpNetworkControl(session, null);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.disable', {});
    expect(getCdpNetworkControl(session)).toBeUndefined();
    expect(paused()).toBeUndefined();
  });

  it('shares one Fetch dispatcher with response mocking', async () => {
    const { session, sendCommand, on, paused } = createSession();
    await setCdpNetworkControl(session, { id: 'environment', value: 'pre' });
    await cdpSetMock(session, {
      apiName: 'mtop.mocked.api',
      mockData: { success: true },
      duration: 0,
    });

    expect(on).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'Fetch.enable')).toHaveLength(1);
    sendCommand.mockClear();

    await paused()?.({
      requestId: 'mocked-request',
      request: {
        method: 'GET',
        url: 'https://gateway.example.com/h5/mtop.mocked.api/1.0/',
        headers: { Origin: 'https://www.example.com' },
      },
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenLastCalledWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'mocked-request' }),
    );

    sendCommand.mockClear();
    await paused()?.({
      requestId: 'unmocked-request',
      request: {
        method: 'GET',
        url: 'https://gateway.example.com/h5/mtop.unmocked.api/1.0/',
      },
    });
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
      requestId: 'unmocked-request',
      url: 'https://gateway.preview.example.com/h5/mtop.unmocked.api/1.0/',
    });
  });
});
