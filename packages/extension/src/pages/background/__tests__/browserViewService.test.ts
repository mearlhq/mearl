import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { handleBrowserView } from '../browserViewService';
const mocks = vi.hoisted(() => ({
  view: vi.fn(),
  prepare: vi.fn(),
  run: vi.fn(),
  enabled: vi.fn(),
  login: vi.fn(),
  closeLogin: vi.fn(),
  authorize: vi.fn(),
  origins: vi.fn(),
  allowAll: vi.fn(),
}));
vi.mock('../browserCapabilityRegistry', () => ({
  browserCapabilityRegistry: () => ({ view: mocks.view }),
}));
vi.mock('../browserCapabilities', () => ({
  authorizeBrowserCapabilityUrl: mocks.authorize,
  prepareBrowserCapabilities: mocks.prepare,
  runAcceptedBrowserCapability: mocks.run,
}));
vi.mock('../../../shared/proxyPermissions', () => ({
  getAgentAllowedOrigins: mocks.origins,
  getAgentAllowAllDomains: mocks.allowAll,
}));
vi.mock('../externalServices', () => ({ isExternalServiceEnabled: mocks.enabled }));
vi.mock('../browserRequestLogin', () => ({
  openBrowserRequestLogin: mocks.login,
  closeBrowserRequestLogin: mocks.closeLogin,
}));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const sender = {
  id: extensionId,
  documentId: 'doc-a',
  url: `chrome-extension://${extensionId}/popup.html`,
};
const instanceId = '12345678-1234-1234-1234-123456789abc';
const base = { instanceId, bundleId: 'example', revision: 'accepted', slot: 'requestImport' };
const message = (operation: string, extra = {}) => ({ ...base, operation, ...extra });
let session: Record<string, any>, local: Record<string, any>;
beforeEach(() => {
  vi.clearAllMocks();
  session = {};
  local = { 'json-modal-view-mode': 'code', privateToken: 'secret' };
  chrome.runtime.id = extensionId;
  chrome.permissions = {
    getAll: vi.fn(async () => ({ origins: ['https://example.com/*'] })),
  } as any;
  mocks.origins.mockResolvedValue(['*://*.example.com/*']);
  mocks.allowAll.mockResolvedValue(false);
  mocks.authorize.mockImplementation(async value => new URL(value));
  chrome.runtime.getContexts = vi.fn(async () => [{ documentId: sender.documentId }]) as any;
  const storage = (record: Record<string, any>) => ({
    get: vi.fn(async (keys: string | string[] | null) =>
      keys === null
        ? { ...record }
        : Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys])
              .filter(key => Object.hasOwn(record, key))
              .map(key => [key, record[key]]),
          ),
    ),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(record, structuredClone(value));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete record[key];
    }),
  });
  chrome.storage.session = storage(session) as any;
  chrome.storage.local = storage(local) as any;
  mocks.view.mockResolvedValue({
    ...base,
    html: '<main>original</main>',
    definition: {
      schemaVersion: 1,
      entry: 'view.html',
      actions: {
        query: {
          hook: 'request.example',
          setting: 'exampleEnabled',
          disabledResult: { success: false, error: 'EXAMPLE_DISABLED' },
        },
      },
      preferences: {
        mode: { shared: 'json.viewMode' },
        own: {},
        highlight: { area: 'session', shared: 'editor.highlight' },
      },
      transports: {
        events: { kind: 'eventSource', setting: 'exampleEnabled' },
        socket: { kind: 'websocket', setting: 'exampleEnabled' },
      },
      logins: { example: { url: 'https://example.com/login', title: 'Login' } },
    },
  });
  mocks.prepare.mockResolvedValue({
    'request.example': {
      invocation: {
        code: new TextEncoder().encode('module.exports = () => ({query: () => "accepted"})'),
        sha256: 'a'.repeat(64),
        handlers: ['query'],
        handler: 'query',
        config: { endpoint: 'old' },
      },
    },
  });
  mocks.run.mockResolvedValue({ success: true, value: 'accepted' });
  mocks.enabled.mockResolvedValue(true);
  mocks.login.mockResolvedValue('lease');
});
it('accepts extension documents only and rejects stale, cross-document and undeclared operations', async () => {
  expect(
    await handleBrowserView(message('open'), { ...sender, url: 'https://example.com' }),
  ).toMatchObject({ success: false });
  expect(mocks.view).not.toHaveBeenCalled();
  expect(await handleBrowserView(message('open', { revision: 'stale' }), sender)).toMatchObject({
    success: false,
  });
  expect(await handleBrowserView(message('open'), sender)).toEqual({ success: true });
  expect(
    await handleBrowserView(message('invoke', { action: 'query' }), {
      ...sender,
      documentId: 'other',
    }),
  ).toMatchObject({ success: false });
  expect(
    await handleBrowserView(message('invoke', { action: 'undeclared' }), sender),
  ).toMatchObject({ success: false });
  expect(
    await handleBrowserView(message('invoke', { action: 'query', revision: 'new' }), sender),
  ).toMatchObject({ success: false });
  expect(mocks.run).not.toHaveBeenCalled();
});
it('retains paired UI/runtime across replacement and worker restarts while checking current permission settings', async () => {
  await handleBrowserView(message('open'), sender);
  mocks.view.mockResolvedValue(undefined);
  mocks.prepare.mockReset();
  // Round-trip through Chrome's JSON storage representation, as after a worker restart.
  session = JSON.parse(JSON.stringify(session));
  chrome.storage.session.get = vi.fn(async key => ({
    [key as string]: session[key as string],
  })) as any;
  expect(
    await handleBrowserView(message('invoke', { action: 'query', input: { page: 2 } }), sender),
  ).toMatchObject({ success: true, data: { value: 'accepted' } });
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      code: expect.any(Uint8Array),
      handler: 'query',
      config: { endpoint: 'old' },
      input: { page: 2 },
    }),
  );
  mocks.enabled.mockResolvedValue(false);
  expect(await handleBrowserView(message('invoke', { action: 'query' }), sender)).toEqual({
    success: true,
    data: { success: false, error: 'EXAMPLE_DISABLED' },
  });
  expect(mocks.run).toHaveBeenCalledOnce();
});
it('reads and writes approved shared keys without exposing other storage and rejects session writes from background', async () => {
  await handleBrowserView(message('open'), sender);
  expect(await handleBrowserView(message('preferences'), sender)).toEqual({
    success: true,
    data: { mode: 'code' },
  });
  expect(
    await handleBrowserView(message('preferences', { key: 'mode', value: 'tree' }), sender),
  ).toEqual({ success: true });
  expect(local['json-modal-view-mode']).toBe('tree');
  await handleBrowserView(message('preferences', { key: 'own', value: { owned: true } }), sender);
  expect(local['browser-view:example:requestImport:own']).toEqual({ owned: true });
  expect(
    await handleBrowserView(message('preferences', { key: 'highlight', value: false }), sender),
  ).toMatchObject({ success: false });
  expect(
    await handleBrowserView(
      message('preferences', { key: 'privateToken', value: 'changed' }),
      sender,
    ),
  ).toMatchObject({ success: false });
  expect(local.privateToken).toBe('secret');
});
it('preserves exact module bytes including a UTF-8 BOM through accepted session storage', async () => {
  const code = new TextEncoder().encode('\ufeffmodule.exports = () => ({query: () => "accepted"})');
  const sha256 = createHash('sha256').update(code).digest('hex');
  mocks.prepare.mockResolvedValue({
    'request.example': {
      invocation: { code, sha256, handlers: ['query'], handler: 'query', config: {} },
    },
  });
  await handleBrowserView(message('open'), sender);
  await handleBrowserView(message('invoke', { action: 'query' }), sender);
  const invocation = mocks.run.mock.calls[0][0];
  expect(invocation.code).toEqual(code);
  expect(createHash('sha256').update(invocation.code).digest('hex')).toBe(invocation.sha256);
});
it('releases instances and same-document login leases after provider removal', async () => {
  await handleBrowserView(message('open'), sender);
  expect(
    await handleBrowserView(message('loginOpen', { login: 'example', id: instanceId }), sender),
  ).toMatchObject({ success: true, data: { definition: { url: 'https://example.com/login' } } });
  expect(mocks.login).toHaveBeenCalledWith('https://example.com/login', sender, instanceId);
  mocks.view.mockResolvedValue(undefined);
  expect(
    await handleBrowserView(message('close'), { ...sender, documentId: 'other' }),
  ).toMatchObject({ success: false });
  expect(await handleBrowserView(message('close'), sender)).toEqual({ success: true });
  expect(await handleBrowserView(message('invoke', { action: 'query' }), sender)).toMatchObject({
    success: false,
  });
  expect(await handleBrowserView(message('loginClose', { id: instanceId }), sender)).toEqual({
    success: true,
  });
  expect(mocks.closeLogin).toHaveBeenCalledWith(instanceId, sender);
});
it('rejects a closed accepting document and prunes records owned by closed documents', async () => {
  chrome.runtime.getContexts = vi.fn(async () => []) as any;
  expect(await handleBrowserView(message('open'), sender)).toMatchObject({ success: false });
  chrome.runtime.getContexts = vi.fn(async () => [{ documentId: sender.documentId }]) as any;
  session['browser-view-instance:closed'] = { documentId: 'closed-doc' };
  await handleBrowserView(message('open'), sender);
  expect(session['browser-view-instance:closed']).toBeUndefined();
});

it('authorizes declared transport kinds against the accepted document and current service/domain/Chrome grants', async () => {
  mocks.enabled.mockResolvedValue(true);
  await handleBrowserView(message('open'), sender);
  const result = await handleBrowserView(
    message('transport', { name: 'socket', url: 'wss://example.com:8080/capture' }),
    sender,
  );
  expect(result).toMatchObject({
    success: true,
    data: { kind: 'websocket', url: 'wss://example.com:8080/capture', policies: expect.any(Array) },
  });
  expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith('https://example.com:8080/capture');
  expect(mocks.enabled).toHaveBeenCalledWith('exampleEnabled');
  mocks.authorize.mockClear();
  mocks.enabled.mockResolvedValue(false);
  expect(
    await handleBrowserView(
      message('transport', { name: 'events', url: 'https://example.com/sse' }),
      sender,
    ),
  ).toMatchObject({ success: false, error: expect.stringContaining('disabled') });
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it('rejects undeclared, cross-document, invalid and revoked transport targets without changing the accepted runtime', async () => {
  mocks.enabled.mockResolvedValue(true);
  await handleBrowserView(message('open'), sender);
  for (const input of [
    { name: 'missing', url: 'https://example.com' },
    { name: 'events', url: 'file:///tmp/file' },
    { name: 'socket', url: 'https://example.com' },
  ])
    expect(await handleBrowserView(message('transport', input), sender)).toMatchObject({
      success: false,
    });
  expect(
    await handleBrowserView(message('transport', { name: 'events', url: 'https://example.com' }), {
      ...sender,
      documentId: 'other',
    }),
  ).toMatchObject({ success: false });
  expect(mocks.authorize).not.toHaveBeenCalled();
  mocks.authorize.mockRejectedValue(new Error('Browser host permission required'));
  expect(
    await handleBrowserView(
      message('transport', { name: 'events', url: 'https://example.com' }),
      sender,
    ),
  ).toMatchObject({ success: false, error: 'Browser host permission required' });
});

it('accepts and retains a source-verified DevTools document without Chrome documentId', async () => {
  const { resolveBrowserDocumentSender } = await import('../browserDocuments');
  const token = '75ece965-9526-42c5-8d74-c931779c3090';
  chrome.runtime.getURL = path => `chrome-extension://${extensionId}/${path}`;
  chrome.runtime.getContexts = vi.fn(async () => []) as any;
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ url: sender.url });
  const owner = await resolveBrowserDocumentSender({ id: sender.id, url: sender.url }, token);
  expect(await handleBrowserView(message('open'), owner)).toEqual({ success: true });
  expect((await handleBrowserView(message('preferences'), owner)).success).toBe(true);
  expect(session['browser-view-instance:' + instanceId].documentId).toBe('mearl-document:' + token);
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  expect((await handleBrowserView(message('open', { instanceId: '22345678-1234-1234-1234-123456789abc' }), owner)).success).toBe(false);
});
