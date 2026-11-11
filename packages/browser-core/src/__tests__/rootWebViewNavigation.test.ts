import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRootWebViewNavigation,
  type WebViewNavigationRequest,
} from '../rootWebViewNavigation.js';

function fixture(keepSameOriginNavigation = true) {
  const sendCommand = vi.fn(
    async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
      if (method === 'Fetch.getResponseBody')
        return { body: '<html>一次回调</html>', base64Encoded: false };
      return {};
    },
  );
  const shellHeaders = vi.fn(
    async (): Promise<Array<{ name: string; value: string }> | undefined> => [
      { name: 'Server-Timing', value: 'fixture' },
    ],
  );
  const preserveOrigin = vi.fn(() => false);
  const navigation = createRootWebViewNavigation({
    client: { sendCommand },
    shellHeaders,
    preserveOrigin,
    keepSameOriginNavigation,
  });
  navigation.initialize({
    frame: { id: 'main', url: 'https://login.example/start' },
    childFrames: [
      { frame: { id: 'root', name: '__mearl_root__', url: 'https://login.example/start' } },
    ],
  });
  return { sendCommand, shellHeaders, preserveOrigin, navigation };
}

function request(
  frameId = 'root',
  url = 'https://business.example/callback?ticket=once',
): WebViewNavigationRequest {
  return {
    requestId: 'request',
    frameId,
    resourceType: 'Document',
    request: { method: 'GET', url },
  };
}

function response(overrides: Partial<WebViewNavigationRequest> = {}): WebViewNavigationRequest {
  return {
    ...request('main'),
    responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
    ...overrides,
  };
}

function replayUrl(sendCommand: ReturnType<typeof fixture>['sendCommand']): string {
  const fulfillment = sendCommand.mock.calls.find(
    ([method]) => method === 'Fetch.fulfillRequest',
  )?.[1];
  const marker = (fulfillment?.responseHeaders as Array<{ name: string; value: string }>).find(
    header => header.value.startsWith('mearl-document;'),
  );
  return 'https://business.example/.mearl-document/' + marker!.value.match(/desc="([^"]+)"/)![1];
}

afterEach(() => vi.useRealTimers());

describe('root WebView navigation', () => {
  it('keeps one explicitly requested reload in the business WebView', async () => {
    const { navigation, sendCommand } = fixture();
    const url = 'https://business.example/start';
    const cancel = navigation.allowLocalReload('root', url + '#preview');
    expect(await navigation.handle(request('unrelated', url))).toBe(false);
    expect(await navigation.handle(request('root', url))).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    cancel();
    expect(await navigation.handle(request('root', url))).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith('Page.navigate', { url });
    navigation.dispose();
  });

  it('keeps the real top request in the network and rule pipeline', async () => {
    const { navigation, sendCommand } = fixture();
    expect(await navigation.handle(request('main'))).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it('commits the shell before requesting the page and promotes a cross-origin WebView redirect', async () => {
    const { navigation, sendCommand } = fixture();
    const url = 'https://login.example/start';
    const frame = { id: 'main', url, mimeType: 'text/html' };
    navigation.initialize({ frame });
    expect(navigation.prepareShellReload()).toBeTypeOf('function');
    expect(await navigation.handle(request('main', url))).toBe(true);
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({
        responseCode: 200,
        responseHeaders: expect.arrayContaining([{ name: 'Server-Timing', value: 'fixture' }]),
      }),
    );

    navigation.handleFrameEvent('Page.frameNavigated', { frame });
    navigation.handleFrameEvent('Page.frameAttached', { frameId: 'root', parentFrameId: 'main' });
    expect(await navigation.handle(request('root', url))).toBe(false);
    expect(await navigation.handle(request('root', 'https://login.example/redirected'))).toBe(
      false,
    );
    const callback = request();
    expect(await navigation.handle(callback)).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Page.navigate', { url: callback.request.url });
    expect(sendCommand).not.toHaveBeenCalledWith('Fetch.getResponseBody', expect.anything());
    navigation.dispose();
  });

  it('keeps callback URLs and form submissions on the original top-level request path', async () => {
    const { navigation, sendCommand } = fixture();
    const url = 'https://login.example/start';
    const frame = { id: 'main', url, mimeType: 'text/html' };
    navigation.initialize({ frame: { ...frame, url: url + '?code=once' } });
    expect(navigation.prepareShellReload()).toBeUndefined();

    navigation.initialize({ frame });
    navigation.prepareShellReload();
    const post = request('main', url);
    post.request.method = 'POST';
    expect(await navigation.handle(post)).toBe(false);
    expect(await navigation.handle(request('main', url))).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it.each([false, true])(
    'delivers a synthetic HTML response at the response/request stage (%s)',
    async requestStage => {
      const { navigation, sendCommand } = fixture();
      const params = requestStage ? request('main') : response();
      const body = Buffer.from('<html>mocked document</html>').toString('base64');
      expect(
        await navigation.fulfillResponse(params, {
          responseCode: 200,
          responseHeaders: response().responseHeaders,
          body,
        }),
      ).toBe(true);
      expect(await navigation.handle(request('root', replayUrl(sendCommand)))).toBe(true);
      expect(sendCommand).toHaveBeenLastCalledWith(
        'Fetch.fulfillRequest',
        expect.objectContaining({ body }),
      );
      expect(sendCommand).not.toHaveBeenCalledWith('Fetch.getResponseBody', expect.anything());
      navigation.dispose();
    },
  );

  it('keeps same-origin GETs in the root WebView and promotes a cross-origin redirect', async () => {
    const { navigation, sendCommand } = fixture();
    const local = request('root', 'https://login.example/next');
    expect(navigation.isSameOriginRootNavigation(local)).toBe(true);
    expect(await navigation.handle(local)).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(await navigation.handle(request())).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Page.navigate', { url: request().request.url });
    navigation.dispose();
  });

  it('promotes same-origin GETs when the host does not load them directly', async () => {
    const { navigation, sendCommand } = fixture(false);
    const local = request('root', 'https://login.example/next');
    expect(navigation.isSameOriginRootNavigation(local)).toBe(false);
    expect(await navigation.handle(local)).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Page.navigate', { url: local.request.url });
    navigation.dispose();
  });

  it('promotes a navigation from a cross-origin root back to the shell origin', async () => {
    const { navigation, sendCommand } = fixture();
    navigation.handleFrameEvent('Page.frameNavigated', {
      frame: { id: 'root', parentId: 'main', url: 'https://business.example/form' },
    });
    const back = request('root', 'https://login.example/callback');
    expect(navigation.isSameOriginRootNavigation(back)).toBe(false);
    expect(await navigation.handle(back)).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Page.navigate', { url: back.request.url });
    navigation.dispose();
  });

  it('promotes cross-origin GETs with their navigation source', async () => {
    const url = 'https://business.example/callback';
    const { navigation, sendCommand } = fixture();
    const original = request('root', url);
    original.request.headers = {
      Referer: 'https://login.example/',
      Origin: 'https://login.example',
      Cookie: 'old=1',
    };
    original.request.urlFragment = '#section';
    const child = { sendCommand: vi.fn().mockResolvedValue({}) };
    expect(await navigation.handle(original, child)).toBe(true);
    expect(child.sendCommand).toHaveBeenCalledExactlyOnceWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({ responseCode: 204 }),
    );
    expect(sendCommand).toHaveBeenLastCalledWith('Page.navigate', { url: url + '#section' });
    const callback = request('main', url);
    callback.request.headers = {
      Cookie: 'fresh=1',
      'User-Agent': 'current',
      referer: 'https://business.example/',
    };
    expect(await navigation.handle(callback)).toBe(false);
    expect(callback.request.headers).toEqual({
      Referer: 'https://login.example/',
      Origin: 'https://login.example',
      Cookie: 'fresh=1',
      'User-Agent': 'current',
    });
    navigation.dispose();
  });

  it('retains the navigation source when an App definition refresh reissues a local GET', async () => {
    const { navigation, sendCommand } = fixture();
    const url = 'https://login.example/next';
    const local = request('root', url);
    local.request.headers = { Referer: 'https://login.example/start', Cookie: 'old=1' };
    navigation.preserveNavigationSource(local);
    const top = request('main', url);
    expect(await navigation.handle(top)).toBe(false);
    expect(top.request.headers).toEqual({ Referer: 'https://login.example/start' });
    const next = request('main', url);
    expect(await navigation.handle(next)).toBe(false);
    expect(next.request.headers).toBeUndefined();
    expect(sendCommand).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it('delivers HTML once, preserves status and UTF-8, and does not replay cookies or stale transport headers', async () => {
    const { navigation, sendCommand } = fixture();
    const headers = [
      { name: 'Content-Type', value: 'text/html; charset=gbk' },
      { name: 'Content-Encoding', value: 'gzip' },
      { name: 'Content-Length', value: '12' },
      { name: 'Set-Cookie', value: 'session=fixture' },
      { name: 'X-Frame-Options', value: 'DENY' },
      {
        name: 'Content-Security-Policy',
        value: "default-src 'self'; frame-ancestors 'none'; script-src 'nonce-test'",
      },
    ];
    expect(
      await navigation.handle(response({ responseStatusCode: 404, responseHeaders: headers })),
    ).toBe(true);
    const top = sendCommand.mock.calls.find(([method]) => method === 'Fetch.fulfillRequest')![1]!;
    expect(top.responseHeaders).toContainEqual({ name: 'Set-Cookie', value: 'session=fixture' });
    expect(top.responseHeaders).not.toContainEqual(
      expect.objectContaining({ name: 'Content-Security-Policy' }),
    );
    const replay = request('root', replayUrl(sendCommand));
    expect(await navigation.handle(replay)).toBe(true);
    const child = sendCommand.mock.calls.at(-1)![1]!;
    expect(child.responseCode).toBe(404);
    expect(Buffer.from(child.body as string, 'base64').toString()).toBe('<html>一次回调</html>');
    expect(child.responseHeaders).toContainEqual({
      name: 'Content-Type',
      value: 'text/html; charset=utf-8',
    });
    expect(child.responseHeaders).toContainEqual({
      name: 'Content-Security-Policy',
      value: "default-src 'self'; script-src 'nonce-test'",
    });
    expect(child.responseHeaders).not.toContainEqual(
      expect.objectContaining({ name: 'Set-Cookie' }),
    );
    expect(child.responseHeaders).not.toContainEqual(
      expect.objectContaining({ name: 'Content-Encoding' }),
    );
    expect(await navigation.handle(replay)).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.failRequest', {
      requestId: 'request',
      errorReason: 'Aborted',
    });
    navigation.dispose();
  });

  it.each([
    { responseStatusCode: 302 },
    { responseStatusCode: 204 },
    { responseErrorReason: 'Failed' },
    { responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }] },
    {
      responseHeaders: [
        { name: 'Content-Type', value: 'text/html' },
        { name: 'Content-Disposition', value: 'attachment; filename=report.html' },
      ],
    },
  ])(
    'leaves redirects, non-HTML and downloads untouched without consuming their body',
    async overrides => {
      const { navigation, sendCommand } = fixture();
      expect(await navigation.handle(response(overrides))).toBe(false);
      expect(sendCommand).not.toHaveBeenCalled();
      navigation.dispose();
    },
  );

  it('hands a top POST HTML response to the root without turning it into a GET', async () => {
    const { navigation, sendCommand } = fixture();
    const post = { ...request('main').request, method: 'POST' };
    expect(await navigation.handle({ ...request('main'), request: post })).toBe(false);
    expect(await navigation.handle(response({ request: post }))).toBe(true);
    expect(await navigation.handle(request('root', replayUrl(sendCommand)))).toBe(true);
    expect(sendCommand).not.toHaveBeenCalledWith('Page.navigate', expect.anything());
    navigation.dispose();
  });

  it('fails expired and mismatched internal addresses instead of requesting a callback again', async () => {
    vi.useFakeTimers();
    const { navigation, sendCommand } = fixture();
    await navigation.handle(response());
    const url = replayUrl(sendCommand);
    expect(await navigation.handle(request('advertisement', url))).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.failRequest', expect.anything());
    vi.advanceTimersByTime(30_001);
    expect(await navigation.handle(request('root', url))).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.failRequest', expect.anything());
    navigation.dispose();
  });

  it.each(['unreadable', 'oversized'])(
    'aborts %s HTML safely without a second network request',
    async failure => {
      const { navigation, sendCommand } = fixture();
      sendCommand.mockImplementation(async method => {
        if (method === 'Fetch.getResponseBody') {
          if (failure === 'unreadable') throw new Error('body unavailable');
          return { body: 'a'.repeat(24 * 1024 * 1024), base64Encoded: true };
        }
        return {};
      });
      expect(await navigation.handle(response())).toBe(true);
      expect(sendCommand).toHaveBeenLastCalledWith('Fetch.failRequest', expect.anything());
      expect(sendCommand).not.toHaveBeenCalledWith('Page.navigate', expect.anything());
      navigation.dispose();
    },
  );

  it('bounds a stalled HTML body and ignores a late result without replaying the callback', async () => {
    vi.useFakeTimers();
    const { navigation, sendCommand } = fixture();
    let complete!: (value: unknown) => void;
    sendCommand.mockImplementation(async method =>
      method === 'Fetch.getResponseBody'
        ? new Promise(resolve => {
            complete = resolve;
          })
        : {},
    );
    const pending = navigation.handle(response());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.failRequest', expect.anything());
    complete({ body: '<html>late callback</html>', base64Encoded: false });
    await Promise.resolve();
    expect(sendCommand).not.toHaveBeenCalledWith('Fetch.fulfillRequest', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
    navigation.dispose();
  });

  it('checks decoded UTF-8 size before constructing a base64 copy', async () => {
    const { navigation, sendCommand } = fixture();
    sendCommand.mockImplementation(async method =>
      method === 'Fetch.getResponseBody'
        ? { body: '界'.repeat(6 * 1024 * 1024), base64Encoded: false }
        : {},
    );
    expect(await navigation.handle(response())).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.failRequest', expect.anything());
    expect(sendCommand).not.toHaveBeenCalledWith('Fetch.fulfillRequest', expect.anything());
    navigation.dispose();
  });

  it('tracks the new root from Page events without querying a paused renderer', async () => {
    const { navigation, sendCommand } = fixture();
    await navigation.handle(response());
    navigation.handleFrameEvent('Page.frameNavigated', {
      frame: { id: 'main', url: 'https://business.example/callback' },
    });
    navigation.handleFrameEvent('Page.frameAttached', {
      frameId: 'new-root',
      parentFrameId: 'main',
    });
    navigation.handleFrameEvent('Page.frameAttached', { frameId: 'layer', parentFrameId: 'main' });
    navigation.handleFrameEvent('Page.frameDetached', { frameId: 'new-root', reason: 'swap' });
    expect(await navigation.handle(request('new-root', replayUrl(sendCommand)))).toBe(true);
    expect(await navigation.handle(request('layer'))).toBe(false);
    expect(sendCommand).not.toHaveBeenCalledWith('Page.getFrameTree');
    navigation.dispose();
  });

  it('reports a same-shell root commit without reporting shell startup or nested frames', async () => {
    const { navigation, sendCommand } = fixture();
    await navigation.handle(response());
    const commit = (frame: {
      id: string;
      url: string;
      urlFragment?: string;
      name?: string;
      parentId?: string;
    }) => navigation.handleFrameEvent('Page.frameNavigated', { frame });
    const origin = 'https://business.example';
    expect(commit({ id: 'main', url: origin + '/callback' })).toBeUndefined();
    const root = { id: 'new-root', parentId: 'main', name: '__mearl_root__' };
    expect(commit({ ...root, url: 'about:blank' })).toBeUndefined();
    expect(commit({ ...root, url: replayUrl(sendCommand) })).toBeUndefined();
    expect(commit({ ...root, url: origin + '/nested', parentId: 'new-root' })).toBeUndefined();
    expect(commit({ ...root, url: origin + '/next?item=1', urlFragment: '#details' })).toBe(
      origin + '/next?item=1#details',
    );
    navigation.dispose();
  });

  it('identifies the root by its delivery token even when another iframe attaches first', async () => {
    const { navigation, sendCommand } = fixture();
    await navigation.handle(response());
    navigation.handleFrameEvent('Page.frameNavigated', {
      frame: { id: 'main', url: request().request.url },
    });
    navigation.handleFrameEvent('Page.frameAttached', {
      frameId: 'advertisement',
      parentFrameId: 'main',
    });
    navigation.handleFrameEvent('Page.frameAttached', {
      frameId: 'new-root',
      parentFrameId: 'main',
    });
    expect(await navigation.handle(request('advertisement'))).toBe(false);
    expect(await navigation.handle(request('new-root', replayUrl(sendCommand)))).toBe(true);
    expect(await navigation.handle(request('advertisement'))).toBe(false);
    navigation.dispose();
  });

  it('does not let an obsolete response discard the current document delivery', async () => {
    const { navigation, sendCommand } = fixture();
    let rejectOld!: (error: Error) => void;
    sendCommand.mockImplementation(async (method, params) => {
      if (method !== 'Fetch.getResponseBody') return {};
      if (params?.requestId === 'old')
        return new Promise((_resolve, reject) => {
          rejectOld = reject;
        });
      return { body: '<html>current</html>', base64Encoded: false };
    });
    const old = navigation.handle(response({ requestId: 'old' }));
    await vi.waitFor(() => expect(rejectOld).toBeTypeOf('function'));
    await navigation.handle(response({ requestId: 'current' }));
    const url = replayUrl(sendCommand);
    rejectOld(new Error('navigation cancelled'));
    await old;
    expect(await navigation.handle(request('root', url))).toBe(true);
    expect(sendCommand).toHaveBeenLastCalledWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({ body: Buffer.from('<html>current</html>').toString('base64') }),
    );
    navigation.dispose();
  });

  it('releases pending response data when disposed', async () => {
    const { navigation, sendCommand } = fixture();
    await navigation.handle(response());
    const url = replayUrl(sendCommand);
    navigation.dispose();
    sendCommand.mockClear();
    expect(await navigation.handle(request('root', url))).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('leaves POST, development proxies and unrelated frames unchanged', async () => {
    const { navigation, sendCommand, preserveOrigin, shellHeaders } = fixture();
    expect(
      await navigation.handle({ ...request(), request: { ...request().request, method: 'POST' } }),
    ).toBe(false);
    expect(await navigation.handle(request('advertisement'))).toBe(false);
    preserveOrigin.mockReturnValue(true);
    expect(await navigation.handle(request())).toBe(false);
    shellHeaders.mockResolvedValue(undefined);
    expect(await navigation.handle(response())).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it('does not resume an already consumed request when parent navigation fails', async () => {
    const { navigation, sendCommand } = fixture();
    sendCommand.mockRejectedValue(new Error('target closed'));
    const child = { sendCommand: vi.fn().mockResolvedValue({}) };
    expect(await navigation.handle(request(), child)).toBe(true);
    expect(child.sendCommand).toHaveBeenCalledTimes(1);
    navigation.dispose();
  });
});
