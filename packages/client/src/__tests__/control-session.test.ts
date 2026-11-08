import { describe, expect, it, vi, afterEach } from 'vitest';
const { invokeLocal, localConnectorId } = vi.hoisted(() => ({
  invokeLocal: vi.fn(),
  localConnectorId: vi.fn(() => null as string | null),
}));
vi.mock('../socket.js', () => ({ invoke: invokeLocal }));
vi.mock('../unifiedConfig.js', () => ({
  loadCloudServerConfig: () => null,
  resolveServer: () => ({}),
  loadLocalConnectorId: localConnectorId,
}));
import { UnifiedClient } from '../unified.js';
import { parseClientArgs } from '../cli.js';

function mockCloudRequests(client: UnifiedClient, lookup: () => unknown) {
  const send = vi.fn((line: string) => {
    const request = JSON.parse(line);
    const data =
      request.action === 'connector_list'
        ? { connectors: [{ connectorId: 'node-a', name: 'Remote' }] }
        : request.action === '__control_session_resolve'
          ? { session: lookup() }
          : {};
    queueMicrotask(() => (client as any).handleResponse({ id: request.id, success: true, data }));
  });
  (client as any).ws = { readyState: 1, send, close: vi.fn() };
  return send;
}

afterEach(() => {
  vi.resetAllMocks();
});
describe('control session routing', () => {
  it('pins Provider sessions and permits screenshot-based creation', async () => {
    const id = 's_Aa1_-xYz';
    invokeLocal
      .mockResolvedValueOnce({
        session: { sessionId: id, browserId: 'provider:fixture:a', transport: 'provider' },
      })
      .mockResolvedValueOnce({ released: true });
    const client = new UnifiedClient();
    const first = await client.invoke('page_screenshot', { tabId: 7 }, { session: 'new' });
    expect(first.session).toEqual({
      sessionId: id,
      browserId: 'mearl:local:provider:fixture:a',
      transport: 'provider',
    });
    await client.invoke('browser_release', {}, { session: first.session.sessionId });
    expect(invokeLocal.mock.calls[1]![2]).toMatchObject({
      browser: 'provider:fixture:a',
      controlSessionId: id,
    });
  });
  it('creates lazily and pins follow-up calls without an extra lifecycle action', async () => {
    const id = 's_Aa1_-xYz';
    invokeLocal
      .mockResolvedValueOnce({
        tabId: 12,
        session: {
          sessionId: id,
          browserId: 'chrome:a',
          transport: 'extension',
          status: 'active',
          tabs: [],
        },
      })
      .mockResolvedValueOnce({ snapshot: 'page' });
    const client = new UnifiedClient();
    const first = await client.invoke(
      'tab_open',
      { url: 'https://example.com' },
      { session: 'new' },
    );
    expect(invokeLocal.mock.calls[0]![2]).toMatchObject({ controlSessionId: 'new' });
    expect(first.session).toMatchObject({
      sessionId: id,
      browserId: 'mearl:local:chrome:a',
      transport: 'extension',
    });
    await client.invoke('page_snapshot', { tabId: 12 }, { session: first.session.sessionId });
    expect(invokeLocal.mock.calls[1]![2]).toMatchObject({
      browser: 'chrome:a',
      controlSessionId: id,
    });
    expect(invokeLocal.mock.calls.map(call => call[0])).toEqual(['tab_open', 'page_snapshot']);
  });

  it('rejects browser/transport mismatches and only accepts new on observation or opening', async () => {
    const session = 's_Aa1_-xYz';
    invokeLocal.mockResolvedValue({
      session: { sessionId: session, browserId: 'chrome', transport: 'extension' },
    });
    const client = new UnifiedClient();
    await expect(
      client.invoke('page_click', { tabId: 1 }, { session, transport: 'cdp' }),
    ).rejects.toThrow('change transport');
    await expect(
      client.invoke('page_click', { tabId: 1 }, { session, browser: 'mearl:local:other' }),
    ).rejects.toThrow('does not match');
    await expect(client.invoke('page_click', { tabId: 1 }, { session: 'new' })).rejects.toThrow(
      'requires tab_open',
    );
    expect(invokeLocal.mock.calls.map(call => call[0])).toEqual(['__control_session_resolve']);
  });

  it('serializes a remote session separately from action payload', async () => {
    const client = new UnifiedClient({ serverUrl: 'ws://127.0.0.1:8081' });
    invokeLocal.mockResolvedValue({ session: null });
    const send = mockCloudRequests(client, () => ({
      sessionId: 's_Aa1_-xYz',
      browserId: 'chrome',
      transport: 'extension',
    }));
    await client.invoke(
      'page_snapshot',
      { tabId: 1 },
      {
        session: 's_Aa1_-xYz',
      },
    );
    expect(JSON.parse(send.mock.calls[2]![0])).toMatchObject({
      connector: 'node-a',
      browser: 'chrome',
      controlSessionId: 's_Aa1_-xYz',
      data: { tabId: 1 },
    });
    client.disconnect();
  });

  it.each(['unavailable', 'missing'])(
    'queries the same-machine connector when local ownership is %s',
    async state => {
      localConnectorId.mockReturnValue('node-a');
      if (state === 'unavailable') invokeLocal.mockRejectedValue(new Error('Socket unavailable'));
      else invokeLocal.mockResolvedValue({ session: null });
      const client = new UnifiedClient({ serverUrl: 'ws://127.0.0.1:8081' });
      const send = mockCloudRequests(client, () => ({
        sessionId: 's_Aa1_-xYz',
        browserId: 'chrome',
        transport: 'extension',
      }));
      await client.invoke('page_snapshot', { tabId: 1 }, { session: 's_Aa1_-xYz' });
      expect(JSON.parse(send.mock.calls[2]![0])).toMatchObject({
        action: 'page_snapshot',
        connector: 'node-a',
        browser: 'chrome',
      });
      client.disconnect();
    },
  );

  it('keeps ambiguous lookups out of the route cache', async () => {
    const session = { sessionId: 's_Aa1_-xYz', browserId: 'chrome', transport: 'extension' };
    invokeLocal.mockImplementation(async action =>
      action === '__control_session_resolve' ? { session } : {},
    );
    const client = new UnifiedClient({ serverUrl: 'ws://127.0.0.1:8081' });
    let remoteSession: typeof session | null = session;
    mockCloudRequests(client, () => remoteSession);
    await expect(
      client.invoke('page_snapshot', { tabId: 1 }, { session: session.sessionId }),
    ).rejects.toThrow('CONTROL_SESSION_AMBIGUOUS');
    remoteSession = null;
    await client.invoke('page_snapshot', { tabId: 1 }, { session: session.sessionId });
    await client.invoke('page_snapshot', { tabId: 1 }, { session: session.sessionId });
    expect(
      invokeLocal.mock.calls.filter(call => call[0] === '__control_session_resolve'),
    ).toHaveLength(2);
    expect(invokeLocal.mock.calls.at(-1)![2]).toMatchObject({ browser: 'chrome' });
    client.disconnect();
  });

  it('deduplicates the same owner reached through local and cloud transports', async () => {
    localConnectorId.mockReturnValue('node-a');
    const session = { sessionId: 's_Aa1_-xYz', browserId: 'chrome', transport: 'extension' };
    invokeLocal.mockImplementation(async action =>
      action === '__control_session_resolve' ? { session } : {},
    );
    const client = new UnifiedClient({ serverUrl: 'ws://127.0.0.1:8081' });
    const send = mockCloudRequests(client, () => session);
    await client.invoke('page_snapshot', { tabId: 1 }, { session: session.sessionId });
    expect(invokeLocal.mock.calls.at(-1)![2]).toMatchObject({ browser: 'chrome' });
    expect(send.mock.calls.map(call => JSON.parse(call[0]).action)).toEqual([
      'connector_list',
      '__control_session_resolve',
    ]);
    client.disconnect();
  });

  it('rejects ambiguous host ownership even when a remote connector finds the id', async () => {
    invokeLocal.mockRejectedValue(
      new Error('CONTROL_SESSION_AMBIGUOUS: multiple hosts own this id'),
    );
    const client = new UnifiedClient({ serverUrl: 'ws://127.0.0.1:8081' });
    const send = mockCloudRequests(client, () => ({
      sessionId: 's_Aa1_-xYz',
      browserId: 'chrome',
      transport: 'extension',
    }));
    await expect(
      client.invoke('page_snapshot', { tabId: 1 }, { session: 's_Aa1_-xYz' }),
    ).rejects.toThrow('CONTROL_SESSION_AMBIGUOUS');
    expect(send.mock.calls.map(call => JSON.parse(call[0]).action)).toEqual([
      'connector_list',
      '__control_session_resolve',
    ]);
    client.disconnect();
  });

  it('routes a known local session when cloud discovery fails', async () => {
    invokeLocal.mockResolvedValue({
      session: {
        sessionId: 's_Aa1_-xYz',
        browserId: 'chrome',
        transport: 'extension',
      },
    });
    const client = new UnifiedClient({ serverUrl: 'ws://127.0.0.1:8081' });
    vi.spyOn(client, 'listConnectors').mockRejectedValue(new Error('Cloud unavailable'));
    await client.invoke('page_snapshot', { tabId: 1 }, { session: 's_Aa1_-xYz' });
    expect(invokeLocal.mock.calls.at(-1)![2]).toMatchObject({ browser: 'chrome' });
    client.disconnect();
  });

  it.each(['extension', 'cdp', 'provider'] as const)(
    'resolves %s sessions in a fresh client',
    async transport => {
      const session = { sessionId: 's_aB3d_E-f', browserId: 'chrome:a', transport };
      invokeLocal
        .mockResolvedValueOnce({ tabId: 12, session })
        .mockResolvedValueOnce({ session })
        .mockResolvedValueOnce({ snapshot: 'page' });
      const first = await new UnifiedClient().invoke('tab_open', {}, { session: 'new' });
      await new UnifiedClient().invoke(
        'page_snapshot',
        { tabId: 12 },
        { session: first.session.sessionId },
      );
      expect(invokeLocal.mock.calls[1]).toMatchObject([
        '__control_session_resolve',
        { sessionId: session.sessionId },
        { controlSource: 'local' },
      ]);
      expect(invokeLocal.mock.calls[2]![2]).toMatchObject({
        browser: 'chrome:a',
        controlSessionId: session.sessionId,
        ...(transport === 'cdp' ? { transport: 'cdp' } : {}),
      });
    },
  );

  it('rejects missing sessions without dispatching an action to a default browser', async () => {
    invokeLocal.mockResolvedValue({ session: null });
    await expect(
      new UnifiedClient().invoke('page_click', { tabId: 1 }, { session: 's_aB3d_E-f' }),
    ).rejects.toThrow('CONTROL_SESSION_NOT_FOUND');
    expect(invokeLocal.mock.calls.map(call => call[0])).toEqual(['__control_session_resolve']);
  });

  it('rejects long session ids without querying hosts', async () => {
    await expect(
      new UnifiedClient().invoke(
        'page_snapshot',
        { tabId: 1 },
        {
          session:
            'mearl-session:mearl%3Alocal%3Achrome:cs_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:extension',
        },
      ),
    ).rejects.toThrow('Invalid session id');
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('accepts session on CLI commands without adding task actions', () => {
    expect(
      parseClientArgs(['page_snapshot', '--session', 'new', '--payload', '{"tabId":1}']),
    ).toMatchObject({ session: 'new', payload: { tabId: 1 } });
  });
});
