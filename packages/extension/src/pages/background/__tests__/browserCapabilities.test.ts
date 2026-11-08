import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundleDigest, prepareBundle } from '@mearl/preset/bundles';
import { isAgentDomainAuthorized } from '../../../shared/proxyPermissions';
import { buildCookieHeader, fetchWithDnr } from '../utils/dnr';

vi.mock('../../../shared/proxyPermissions', () => ({
  isAgentDomainAuthorized: vi.fn(async () => true),
}));
vi.mock('../offscreenDocument', () => ({
  withOffscreenDocument: async (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../utils/dnr', async original => ({
  ...(await original<typeof import('../utils/dnr')>()),
  buildCookieHeader: vi.fn(async () => ({
    header: 'Cookie',
    value: 'session=fixture',
    operation: 'set',
  })),
  fetchWithDnr: vi.fn(async (_url, _headers, operation) => operation()),
}));

let listener: (message: any, sender: any, respond: (value: any) => void) => unknown;
let message: any;
let operation: (id: string) => Promise<unknown>;
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const sender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/src/pages/offscreen/index.html`,
};
async function dispatch(
  id: string,
  method = 'request',
  input: unknown = { url: 'https://example.com/api' },
  source: unknown = sender,
) {
  return new Promise<any>(resolve =>
    listener({ target: 'mearl-browser-capability-host', id, method, input }, source, resolve),
  );
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.mocked(isAgentDomainAuthorized).mockResolvedValue(true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('fixture body', { status: 200 })),
  );
  operation = async id => dispatch(id);
  vi.stubGlobal('chrome', {
    permissions: { contains: vi.fn(async () => true) },
    cookies: { getAll: vi.fn(async () => [{ name: 'tenant', value: 'fixture', domain: 'identity.example.com' }]) },
    declarativeNetRequest: { HeaderOperation: { SET: 'set' } },
    runtime: {
      id: extensionId,
      getURL: (file: string) => `chrome-extension://${extensionId}/${file}`,
      onConnect: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn(fn => {
          listener = fn;
        }),
      },
      sendMessage: vi.fn(async value => {
        message = value;
        return { success: true, value: await operation(value.id) };
      }),
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const bytes = new TextEncoder().encode('module.exports=()=>({schema:()=>1});');
  const manifest = {
    schemaVersion: 1,
    id: 'service',
    version: '1.0.0',
    resources: { 'main.cjs': { byteLength: bytes.byteLength, sha256: await bundleDigest(bytes) } },
    contributions: {
      appProfiles: [],
      browserRuntimes: {
        extension: { entry: 'main.cjs', bindings: { 'request.apiSchema': 'schema' } },
      },
    },
  };
  const bundle = await prepareBundle('https://example.com/bundle.json', {
    expectedId: 'service',
    mearlApiVersion: '1.0.0',
    load: async source =>
      source.endsWith('bundle.json') ? new TextEncoder().encode(JSON.stringify(manifest)) : bytes,
  });
  // Import after resetModules so the store used by the dispatcher shares this prototype.
  const api = await import('../browserCapabilities');
  const { BrowserBundleStore: CurrentStore } =
    await import('@mearl/preset/bundles');
  const list = vi.spyOn(CurrentStore.prototype, 'list').mockResolvedValue({
    bundles: [bundle],
    errors: [],
    activeRevision: null,
    revisions: { service: bundle.revision },
  } as never);
  return { ...api, bundle, list };
}

it('pins accepted config and changes the callable provider revision when only config changes', async () => {
  const { bundle, list, prepareBrowserCapabilities } = await fixture();
  const state = { bundles: [bundle], errors: [], revisions: { service: bundle.revision }, activation: { preset: { defaults: { capabilities: { service: { manager: 'first' } } } }, snapshot: { bundleRevisions: { service: bundle.revision } } }, installation: { overrides: {} } };
  list.mockImplementation(async () => structuredClone(state) as never);
  const first = (await prepareBrowserCapabilities(['request.apiSchema']))['request.apiSchema'];
  expect(first.invocation.config).toEqual({ manager: 'first' });
  state.activation.preset.defaults.capabilities.service.manager = 'second';
  const second = (await prepareBrowserCapabilities(['request.apiSchema']))['request.apiSchema'];
  expect(second.revision).not.toBe(first.revision);
  expect(second.invocation.config).toEqual({ manager: 'second' });
  expect(first.invocation.config).toEqual({ manager: 'first' });
  await expect(prepareBrowserCapabilities(['request.apiSchema'], { bundleId: 'service', revision: first.revision })).rejects.toMatchObject({ code: 'BUNDLE_CONFLICT' });
  await expect(prepareBrowserCapabilities(['request.apiSchema'], { bundleId: 'service', bundleRevision: bundle.revision })).resolves.toMatchObject({ 'request.apiSchema': { revision: second.revision } });
  state.installation.overrides = { capabilities: { service: { manager: 'user-choice' } } };
  expect((await prepareBrowserCapabilities(['request.apiSchema']))['request.apiSchema'].invocation.config).toEqual({ manager: 'user-choice' });
});

it('uses the captured selection without rereading a replacement installation', async () => {
  const { bundle, list, prepareBrowserCapability } = await fixture();
  const captured = await list();
  list.mockResolvedValue({ bundles: [], errors: [], revisions: {}, activeRevision: null } as never);
  list.mockClear();
  const accepted = await prepareBrowserCapability('request.apiSchema', undefined, captured);
  expect(accepted).toMatchObject({ bundleId: 'service', revision: bundle.revision });
  expect(list).not.toHaveBeenCalled();
  await expect(prepareBrowserCapability('request.apiSchema', { bundleId: 'service', revision: '0'.repeat(64) }, captured)).rejects.toThrow('handler changed');
  operation = id => dispatch(id, 'request', { url: 'https://example.com/api' });
  vi.mocked(isAgentDomainAuthorized).mockResolvedValue(false);
  expect(await accepted!.invoke({})).toMatchObject({ success: false });
  expect(fetch).not.toHaveBeenCalled();
});

it('passes the selected config to pre-activation factory validation', async () => {
  const { bundle, validateBrowserCapabilities } = await fixture();
  await validateBrowserCapabilities([bundle], ['service'], { service: { manager: 'selected' } });
  expect(message.html).toContain('"config":{"manager":"selected"}');
});

it('rejects a corrupt installation association without falling back to default config', async () => {
  const { bundle, list, prepareBrowserCapabilities } = await fixture();
  list.mockResolvedValue({ bundles: [bundle], errors: [], revisions: { service: bundle.revision }, activation: { preset: { defaults: { capabilities: { service: { manager: 'default' } } } }, snapshot: { bundleRevisions: { service: bundle.revision } } }, installationError: 'Corrupt association', installation: undefined } as never);
  await expect(prepareBrowserCapabilities(['request.apiSchema'])).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
it('delegates a verified module through offscreen and applies cookie/DNR headers using existing host APIs', async () => {
  const { invokeBrowserCapability } = await fixture();
  operation = id =>
    dispatch(id, 'request', {
      url: 'https://example.com/api',
      method: 'POST',
      headers: { Accept: 'application/json' },
      injectedHeaders: { tenant: 'fixture' },
      withCookies: true,
      body: '{}',
    });
  await expect(invokeBrowserCapability('request.apiSchema', {})).resolves.toMatchObject({
    available: true,
    value: { success: true, value: { ok: true, status: 200, body: 'fixture body' } },
  });
  expect(message.html).toContain('schema');
  expect(buildCookieHeader).toHaveBeenCalledWith(new URL('https://example.com/api'));
  expect(fetchWithDnr).toHaveBeenCalledWith(
    new URL('https://example.com/api'),
    [
      { header: 'tenant', value: 'fixture', operation: 'set' },
      { header: 'Cookie', value: 'session=fixture', operation: 'set' },
    ],
    expect.any(Function),
  );
  expect(fetch).toHaveBeenCalledWith(
    'https://example.com/api',
    expect.objectContaining({ credentials: 'include', body: '{}', redirect: 'manual' }),
  );
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  await expect(dispatch(message.id)).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('no longer active'),
  });
});
it.each([301, 302, 303, 307, 308, 304])(
  'reports redirect status %s without following it or misclassifying cache responses',
  async status => {
    const { invokeBrowserCapability } = await fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status })),
    );
    const result = await invokeBrowserCapability('request.apiSchema', {});
    expect(result).toMatchObject({
      value: { success: true, value: { status, ...(status === 304 ? {} : { redirected: true }) } },
    });
    if (status === 304) expect((result as any).value.value).not.toHaveProperty('redirected');
  },
);
it.each([
  { source: { ...sender, id: 'other' } },
  { source: { ...sender, url: `chrome-extension://${extensionId}/options.html` } },
  { source: { ...sender, tab: { id: 1 } } },
  { method: 'unknown' },
  { input: { url: 'file:///etc/passwd' } },
  { input: { url: 'https://user:secret@example.com/' } },
  { input: { url: 'https://example.com', headers: { invalid: 1 } } },
])('rejects spoofed senders and malformed host calls %#', async value => {
  const { invokeBrowserCapability } = await fixture();
  operation = id => dispatch(id, value.method, value.input, value.source);
  const result = await invokeBrowserCapability('request.apiSchema', {});
  expect(result).toMatchObject({ value: { success: false } });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['domain', 'permission'])(
  'requires the current %s authorization before cookie/network access',
  async kind => {
    const { invokeBrowserCapability } = await fixture();
    if (kind === 'domain') vi.mocked(isAgentDomainAuthorized).mockResolvedValue(false);
    else Object.assign(chrome.permissions, { contains: vi.fn(async () => false) });
    operation = id => dispatch(id, 'cookie', { url: 'https://example.com', name: 'tenant' });
    expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
      value: { success: false, error: expect.stringContaining('permission required') },
    });
    expect(chrome.cookies.getAll).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('denies factory initialization network access and still releases the invocation', async () => {
  const { validateBrowserCapabilities, bundle } = await fixture();
  operation = async id => {
    const result = await dispatch(id, 'cookie', { url: 'https://example.com', name: 'tenant' });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('defer browser operations'),
    });
    throw new Error(result.error);
  };
  await expect(validateBrowserCapabilities([bundle], ['service'])).rejects.toThrow(
    'defer browser operations',
  );
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
  await expect(dispatch(message.id)).resolves.toMatchObject({ success: false });
});
it('returns an absent hook without creating a sandbox and preserves tenant-cookie failure fallback', async () => {
  const { invokeBrowserCapability } = await fixture();
  await expect(invokeBrowserCapability('absent', {})).resolves.toEqual({ available: false });
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  vi.mocked(chrome.cookies.getAll).mockRejectedValue(new Error('Cookie unavailable'));
  operation = id => dispatch(id, 'cookie', { url: 'https://example.com/', name: 'tenant' });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
    value: { success: true, value: undefined },
  });
});

it('rejects a handler invocation after its accepted provider revision changes', async () => {
  const { invokeBrowserCapability, bundle } = await fixture();
  await expect(
    invokeBrowserCapability(
      'request.apiSchema',
      {},
      { bundleId: 'service', revision: '0'.repeat(64) },
    ),
  ).rejects.toThrow('handler changed');
  await expect(
    invokeBrowserCapability(
      'request.apiSchema',
      {},
      { bundleId: 'other', revision: bundle.revision },
    ),
  ).rejects.toThrow('handler changed');
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('preserves source headers and sends URL-matched ordinary and first-party partition Cookies in path order', async () => {
  const { invokeBrowserCapability } = await fixture();
  vi.mocked(chrome.cookies.getAll).mockImplementation(async details => (
    details.partitionKey ? [
      { name: 'session', value: 'partition', domain: 'sub.example.com', path: '/', partitionKey: details.partitionKey },
      { name: 'SSO', value: 'shared', domain: '.example.com', path: '/', partitionKey: details.partitionKey },
    ] : [
      { name: 'session', value: 'target', domain: 'sub.example.com', path: '/api' },
      { name: 'XSRF-TOKEN', value: 'target%2Fcsrf', domain: 'sub.example.com', path: '/api' },
    ]
  ) as never);
  operation = id => dispatch(id, 'request', {
    url: 'https://sub.example.com/api', withCookies: true, withSourceHeaders: true,
  });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({ value: { success: true } });
  expect(buildCookieHeader).not.toHaveBeenCalled();
  expect(chrome.cookies.getAll).toHaveBeenCalledTimes(2);
  expect(chrome.cookies.getAll).toHaveBeenCalledWith({ url: 'https://sub.example.com/api' });
  expect(chrome.cookies.getAll).toHaveBeenCalledWith({
    url: 'https://sub.example.com/api',
    partitionKey: { topLevelSite: 'https://sub.example.com', hasCrossSiteAncestor: false },
  });
  expect(vi.mocked(fetchWithDnr).mock.calls[0][1]).toEqual([
    { header: 'Referer', operation: 'set', value: 'https://sub.example.com/mearl' },
    { header: 'Origin', operation: 'set', value: 'https://sub.example.com' },
    { header: 'Cookie', operation: 'set', value: 'session=target; XSRF-TOKEN=target%2Fcsrf; session=partition; SSO=shared' },
    { header: 'X-XSRF-TOKEN', operation: 'set', value: 'target%2Fcsrf' },
  ]);
});
it('allows explicit injected source headers to override defaults without duplicate header names', async () => {
  const { invokeBrowserCapability } = await fixture();
  operation = id =>
    dispatch(id, 'request', {
      url: 'https://example.com/api',
      withSourceHeaders: true,
      injectedHeaders: {
        rEfErEr: 'https://example.com/custom',
        ORIGIN: 'https://example.com/custom-origin',
      },
    });
  await invokeBrowserCapability('request.apiSchema', {});
  const injected = vi.mocked(fetchWithDnr).mock.calls[0][1];
  expect(injected).toHaveLength(2);
  expect(
    Object.fromEntries(injected.map(value => [value.header.toLowerCase(), value.value])),
  ).toEqual({
    origin: 'https://example.com/custom-origin',
    referer: 'https://example.com/custom',
  });
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
});

it.each([{}, { account: '中文 a/b', empty: '', CaseSensitive: 'kept', 'query[]': 'one,two' }])(
  'constructs multipart fields in the host without changing values %j',
  async formBody => {
    const { invokeBrowserCapability } = await fixture();
    operation = id =>
      dispatch(id, 'request', { url: 'https://example.com/api', method: 'POST', formBody });
    expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
      value: { success: true },
    });
    const options = vi.mocked(fetch).mock.calls[0][1];
    expect(options?.body).toBeInstanceOf(FormData);
    expect(Object.fromEntries((options?.body as FormData).entries())).toEqual(formBody);
    expect(
      Object.keys(options?.headers ?? {}).some(name => name.toLowerCase() === 'content-type'),
    ).toBe(false);
    expect(options?.credentials).toBe('omit');
  },
);
it.each([null, [], 'invalid', { invalid: 1 }])(
  'rejects malformed form fields before cookie or network access %j',
  async formBody => {
    const { invokeBrowserCapability } = await fixture();
    operation = id =>
      dispatch(id, 'request', {
        url: 'https://example.com/api',
        method: 'POST',
        formBody,
        withCookies: true,
      });
    expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
      value: { success: false, error: expect.stringContaining('form fields must be strings') },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(buildCookieHeader).not.toHaveBeenCalled();
  },
);
it('rejects simultaneous raw and multipart bodies', async () => {
  const { invokeBrowserCapability } = await fixture();
  operation = id =>
    dispatch(id, 'request', { url: 'https://example.com/api', body: '{}', formBody: {} });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
    value: { success: false, error: expect.stringContaining('mutually exclusive') },
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('captures immutable accepted code for cleanup after selection changes while checking current permissions', async () => {
  const { prepareBrowserCapability, bundle } = await fixture();
  const accepted = await prepareBrowserCapability('request.apiSchema');
  expect(accepted).toMatchObject({ bundleId: 'service', revision: bundle.revision });
  const { BrowserBundleStore } = await import('@mearl/preset/bundles');
  vi.mocked(BrowserBundleStore.prototype.list).mockResolvedValue({
    bundles: [],
    errors: [],
    revisions: {},
    activeRevision: null,
  } as never);
  expect(await prepareBrowserCapability('request.apiSchema')).toBeNull();
  operation = id => dispatch(id, 'request', { url: 'https://example.com/api' });
  expect(await accepted!.invoke({ cleanup: true })).toMatchObject({ success: true });
  expect(message.html).toContain('schema');
  vi.mocked(isAgentDomainAuthorized).mockResolvedValue(false);
  expect(await accepted!.invoke({ cleanup: true })).toMatchObject({
    success: false,
    error: expect.stringContaining('permission required'),
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('returns normalized response headers for content-type based login detection', async () => {
  const { invokeBrowserCapability } = await fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>SSO</html>', {
          headers: { 'Content-Type': 'text/html', 'X-Fixture': 'kept' },
        }),
    ),
  );
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
    value: {
      success: true,
      value: { headers: { 'content-type': 'text/html', 'x-fixture': 'kept' } },
    },
  });
});
it('collects related cookies only when requested and allows the source policy to omit XSRF', async () => {
  const { invokeBrowserCapability } = await fixture();
  vi.mocked(chrome.cookies.getAll).mockImplementation(
    async details =>
      (details.partitionKey
        ? [{ name: 'csrfToken', value: 'partition%2Fcsrf', domain: 'example.com', path: '/', partitionKey: details.partitionKey }]
        : [{ name: 'XSRF-TOKEN', value: 'xsrf', domain: 'example.com', path: '/' }]) as never,
  );
  operation = async id => {
    expect(
      await dispatch(id, 'cookie', {
        url: 'https://example.com/',
        name: 'csrfToken',
        withRelatedCookies: true,
      }),
    ).toEqual({ success: true, value: 'partition%2Fcsrf' });
    return dispatch(id, 'request', {
      url: 'https://example.com/',
      withCookies: true,
      withSourceHeaders: true,
      withXsrf: false,
      injectedHeaders: { 'x-csrf-token': 'partition%2Fcsrf' },
    });
  };
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
    value: { success: true },
  });
  const headers = vi.mocked(fetchWithDnr).mock.calls[0][1];
  expect(headers).toEqual(
    expect.arrayContaining([
      { header: 'Origin', operation: 'set', value: 'https://example.com' },
      { header: 'x-csrf-token', operation: 'set', value: 'partition%2Fcsrf' },
    ]),
  );
  expect(headers.some(header => header.header.toLowerCase() === 'x-xsrf-token')).toBe(false);
  expect(
    headers.some(header => header.header === 'Cookie' && header.value?.includes('XSRF-TOKEN=xsrf')),
  ).toBe(true);
});
it('preserves an explicitly requested browser credential policy', async () => {
  const { invokeBrowserCapability } = await fixture();
  operation = id =>
    dispatch(id, 'request', { url: 'https://example.com/', credentials: 'same-origin' });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
    value: { success: true },
  });
  expect(fetch).toHaveBeenCalledWith(
    'https://example.com/',
    expect.objectContaining({ credentials: 'same-origin' }),
  );
});
it('pairs Cookie and derived CSRF from one collection across deterministic Cookie rotation', async () => {
  const { invokeBrowserCapability } = await fixture();
  let generation = 0;
  vi.mocked(chrome.cookies.getAll).mockImplementation(async details =>
    details.partitionKey
      ? []
      : ([
          { name: 'csrfToken', value: ++generation === 1 ? 'original%2FA' : 'rotated%2FB', domain: 'example.com', path: '/' },
        ] as never),
  );
  operation = id =>
    dispatch(id, 'request', {
      url: 'https://example.com/',
      withCookies: true,
      withSourceHeaders: true,
      withXsrf: false,
      cookieHeaders: { 'x-csrf-token': 'csrfToken' },
    });
  for (const token of ['original%2FA', 'rotated%2FB']) {
    expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
      value: { success: true },
    });
    const headers = vi.mocked(fetchWithDnr).mock.calls.at(-1)![1];
    expect(headers).toEqual(
      expect.arrayContaining([
        { header: 'Cookie', operation: 'set', value: 'csrfToken=' + token },
        { header: 'x-csrf-token', operation: 'set', value: token },
      ]),
    );
  }
  expect(generation).toBe(2);
});
it('lets explicit injected headers override Cookie mappings without duplicate headers', async () => {
  const { invokeBrowserCapability } = await fixture();
  vi.mocked(chrome.cookies.getAll).mockImplementation(async details => (details.partitionKey ? [] : [
    { name: 'csrfToken', value: 'cookie', domain: 'example.com', path: '/' },
  ]) as never);
  operation = id =>
    dispatch(id, 'request', {
      url: 'https://example.com/',
      withCookies: true,
      withSourceHeaders: true,
      cookieHeaders: { 'x-csrf-token': 'csrfToken' },
      injectedHeaders: { 'X-CSRF-Token': 'explicit' },
    });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
    value: { success: true },
  });
  expect(
    vi
      .mocked(fetchWithDnr)
      .mock.calls[0][1].filter(entry => entry.header.toLowerCase() === 'x-csrf-token'),
  ).toEqual([{ header: 'X-CSRF-Token', operation: 'set', value: 'explicit' }]);
});
it('requires Cookie collection for Cookie mappings', async () => {
  const { invokeBrowserCapability } = await fixture();
  operation = id =>
    dispatch(id, 'request', {
      url: 'https://example.com/',
      cookieHeaders: { 'x-csrf-token': 'csrfToken' },
    });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({
    value: { success: false, error: expect.stringContaining('require withCookies') },
  });
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('authorizes both origins and keeps the exact domain/partition Cookie scope', async () => {
  const { invokeBrowserCapability } = await fixture();
  operation = id => dispatch(id, 'cookie', { url: 'https://identity.example.com/', name: 'tenant', domain: true, partitionKey: { topLevelSite: 'https://example.com' } });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({ value: { success: true, value: 'fixture' } });
  expect(isAgentDomainAuthorized).toHaveBeenCalledWith('identity.example.com');
  expect(isAgentDomainAuthorized).toHaveBeenCalledWith('example.com');
  expect(chrome.cookies.getAll).toHaveBeenCalledWith({ domain: 'identity.example.com', partitionKey: { topLevelSite: 'https://example.com' } });
});
it('does not read a partition whose origin is not authorized', async () => {
  const { invokeBrowserCapability } = await fixture();
  vi.mocked(isAgentDomainAuthorized).mockImplementation(async name => name !== 'denied.example.com');
  operation = id => dispatch(id, 'cookie', { url: 'https://identity.example.com/', name: 'tenant', domain: true, partitionKey: { topLevelSite: 'https://denied.example.com' } });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({ value: { success: false } });
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
});
it('reports scoped Cookie errors instead of silently changing identity sources', async () => {
  const { invokeBrowserCapability } = await fixture();
  vi.mocked(chrome.cookies.getAll).mockRejectedValue(new Error('cookie lookup failed'));
  operation = id => dispatch(id, 'cookie', { url: 'https://identity.example.com/', name: 'tenant', domain: true });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({ value: { success: false, error: 'cookie lookup failed' } });
});

it('filters child-domain Cookies by Agent grants without changing native query order', async () => {
  const { invokeBrowserCapability } = await fixture();
  vi.mocked(isAgentDomainAuthorized).mockImplementation(async domain => domain === 'identity.example.com');
  vi.mocked(chrome.cookies.getAll).mockResolvedValue([
    { name: 'tenant', value: 'denied', domain: 'denied.identity.example.com' },
    { name: 'tenant', value: 'allowed', domain: '.identity.example.com' },
    { name: 'tenant', value: 'later', domain: 'identity.example.com' },
  ] as never);
  operation = id => dispatch(id, 'cookie', { url: 'https://identity.example.com/', name: 'tenant', domain: true });
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({ value: { success: true, value: 'allowed' } });
  expect(chrome.cookies.getAll).toHaveBeenCalledWith({ domain: 'identity.example.com' });
  expect(isAgentDomainAuthorized).toHaveBeenCalledWith('denied.identity.example.com');
  vi.mocked(chrome.cookies.getAll).mockResolvedValue([{ name: 'tenant', value: 'denied', domain: 'denied.identity.example.com' }] as never);
  expect(await invokeBrowserCapability('request.apiSchema', {})).toMatchObject({ value: { success: true, value: undefined } });
});

it('cancels the host and sandbox owner when its UI request disconnects', async () => {
  const { prepareBrowserCapability } = await fixture();
  let owner: any;
  operation = async id => {
    owner = { name: 'mearl-browser-capability-owner:' + id, sender, disconnect: vi.fn(), postMessage: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } };
    const connect = vi.mocked(chrome.runtime.onConnect.addListener).mock.calls[0][0];
    for (const source of [{ ...sender, id: 'foreign' }, { ...sender, url: 'https://page.example.test/' }, { ...sender, tab: { id: 1 } }]) {
      const forged = { ...owner, sender: source, disconnect: vi.fn(), postMessage: vi.fn() };
      connect(forged);
      expect(forged.disconnect).toHaveBeenCalledOnce(); expect(forged.postMessage).not.toHaveBeenCalled();
    }
    connect(owner);
    const duplicate = { ...owner, disconnect: vi.fn(), postMessage: vi.fn() };
    connect(duplicate); expect(duplicate.disconnect).toHaveBeenCalledOnce(); expect(duplicate.postMessage).not.toHaveBeenCalled();
    return new Promise(() => {});
  };
  const accepted = await prepareBrowserCapability('request.apiSchema');
  const controller = new AbortController();
  const result = accepted!.invoke({}, controller.signal);
  const rejected = expect(result).rejects.toThrow('aborted');
  await vi.waitFor(() => expect(owner?.postMessage).toHaveBeenCalled());
  controller.abort(); await rejected;
  expect(owner.disconnect).toHaveBeenCalledOnce();
  expect(await dispatch(message.id)).toMatchObject({ success: false });
});
it('does not start a canceled browser invocation', async () => {
  const { prepareBrowserCapability } = await fixture();
  const accepted = await prepareBrowserCapability('request.apiSchema');
  const controller = new AbortController(); controller.abort();
  await expect(accepted!.invoke({}, controller.signal)).rejects.toThrow();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it('does not send a sandbox job when canceled during asynchronous page preparation', async () => {
  const { prepareBrowserCapability } = await fixture();
  const accepted = await prepareBrowserCapability('request.apiSchema');
  const controller = new AbortController();
  const result = accepted!.invoke({}, controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
