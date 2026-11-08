import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../cdp-session';
import {
  clearCdpFetchInterceptionState,
  registerCdpFetchPauseHandler,
  unregisterCdpFetchPauseHandler,
} from '../fetch-interceptor';

function createSession() {
  const sendCommand = vi.fn(async (_method: string, _params?: unknown) => ({}));
  let paused: (params: unknown) => Promise<void> = async () => {};
  const dispose = vi.fn();
  const session = {
    client: {
      sendCommand,
      on: vi.fn((_event, listener) => {
        paused = listener;
        return dispose;
      }),
    },
  } as unknown as PageSession;
  return { session, sendCommand, dispose, pause: (params: unknown) => paused(params) };
}
afterEach(() => clearCdpFetchInterceptionState());

describe('shared Fetch interception patterns', () => {
  const documents = [
    { urlPattern: '*', requestStage: 'Request' as const, resourceType: 'Document' },
  ];
  it('expands and narrows patterns as features enter and leave the session', async () => {
    const { session, sendCommand } = createSession();
    await registerCdpFetchPauseHandler(session, 'profile', 200, () => false, documents);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.enable', { patterns: documents });
    await registerCdpFetchPauseHandler(session, 'mock', 100, () => false);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' },
      ],
    });
    await unregisterCdpFetchPauseHandler(session, 'mock');
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.enable', { patterns: documents });
    await unregisterCdpFetchPauseHandler(session, 'profile');
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.disable', {});
  });
  it('continues a request when definition refresh fails', async () => {
    const { session, sendCommand, pause } = createSession();
    await registerCdpFetchPauseHandler(
      session,
      'profile',
      200,
      () => {
        throw new Error('failed');
      },
      documents,
    );
    await pause({ requestId: 'doc', request: {} });
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', { requestId: 'doc' });
  });
  it('composes migrated navigation headers with later request rules', async () => {
    const { session, sendCommand, pause } = createSession();
    await registerCdpFetchPauseHandler(
      session,
      'navigation',
      150,
      ({ params }) => {
        params.request.headers = { Referer: 'https://login.example/' };
        return false;
      },
      documents,
    );
    const rule = vi.fn(({ params }) => {
      expect(params.request.headers.Referer).toBe('https://login.example/');
      params.request.headers.Authorization = 'fixture';
      return false;
    });
    await registerCdpFetchPauseHandler(session, 'header-rule', 75, rule, documents);
    await pause({ requestId: 'callback', request: { headers: {} } });
    expect(rule).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
      requestId: 'callback',
      headers: [
        { name: 'Referer', value: 'https://login.example/' },
        { name: 'Authorization', value: 'fixture' },
      ],
    });
  });
  it('can register again after a failed Fetch setup', async () => {
    const { session, sendCommand, dispose } = createSession();
    sendCommand.mockRejectedValueOnce(new Error('Fetch unavailable'));
    await expect(
      registerCdpFetchPauseHandler(session, 'profile', 200, () => false, documents),
    ).rejects.toThrow('Fetch unavailable');
    expect(dispose).toHaveBeenCalledOnce();
    await expect(
      registerCdpFetchPauseHandler(session, 'profile', 200, () => false, documents),
    ).resolves.toBeUndefined();
  });
});
