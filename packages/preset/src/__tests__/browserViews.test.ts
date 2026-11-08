import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { buildBrowserViewPage, selectBrowserView, validateBrowserView, validateBundleManifest, type BrowserViewDefinition, type PreparedBundle } from '../bundles.js';

const definition = (): BrowserViewDefinition => ({ schemaVersion: 1, entry: 'views/import.html', actions: { query: { hook: 'request.example', setting: 'exampleEnabled', disabledResult: { success: false, error: 'EXAMPLE_DISABLED' } } }, preferences: { source: { shared: 'json.viewMode' } }, logins: { example: { url: 'https://example.com/login', title: { en: 'Login', zh_CN: '登录' } } } });
function bundle(id = 'example'): PreparedBundle {
  const metadata = new TextEncoder().encode(JSON.stringify(definition()));
  const html = new TextEncoder().encode('<main>Existing form</main>');
  return { source: 'https://example.com/bundle.json', revision: 'a'.repeat(64), manifest: { schemaVersion: 1, id, version: '1.0.0', resources: { 'views/import.json': { sha256: 'b'.repeat(64), byteLength: metadata.length }, 'views/import.html': { sha256: 'c'.repeat(64), byteLength: html.length }, 'runtime.cjs': { sha256: 'd'.repeat(64), byteLength: 1 } }, contributions: { appProfiles: [], browserViews: { requestImport: 'views/import.json' }, browserRuntimes: { extension: { entry: 'runtime.cjs', bindings: { 'request.example': 'query' } } } } }, resources: { 'views/import.json': metadata, 'views/import.html': html, 'runtime.cjs': new Uint8Array([1]) } };
}
it('selects a captured existing-position view and rejects ambiguous or foreign handlers', () => {
  const first = bundle();
  expect(selectBrowserView([first], 'requestImport', '1.0.0')).toEqual({ bundleId: 'example', revision: first.revision, slot: 'requestImport', definition: definition(), html: '<main>Existing form</main>' });
  expect(() => selectBrowserView([first, bundle('other')], 'requestImport', '1.0.0')).toThrow('multiple providers');
  delete first.manifest.contributions!.browserRuntimes;
  expect(() => selectBrowserView([first], 'requestImport', '1.0.0')).toThrow('own browser runtime');
  expect(selectBrowserView([], 'requestImport', '1.0.0')).toBeUndefined();
});
it('selects independent case and import views and rejects providers competing for the same position', () => {
  const value = bundle();
  value.manifest.contributions!.browserViews!.requestCases = 'views/import.json';
  expect(selectBrowserView([value], 'requestCases', '1.0.0')).toMatchObject({ bundleId: 'example', slot: 'requestCases' });
  expect(selectBrowserView([value], 'requestImport', '1.0.0')).toMatchObject({ slot: 'requestImport' });
  const other = bundle('other'); delete other.manifest.contributions!.browserViews!.requestImport;
  other.manifest.contributions!.browserViews!.requestCases = 'views/import.json';
  expect(() => selectBrowserView([value, other], 'requestCases', '1.0.0')).toThrow('multiple providers');
  expect(selectBrowserView([value, other], 'requestImport', '1.0.0')).toMatchObject({ bundleId: 'example' });
});
it('keeps capture launcher selection independent and validates its runtime ownership', () => {
  const value = bundle();
  value.manifest.contributions!.browserViews!.captureLauncher = 'views/import.json';
  expect(selectBrowserView([value], 'captureLauncher', '1.0.0')).toMatchObject({ slot: 'captureLauncher' });
  const other = bundle('other');
  delete other.manifest.contributions!.browserViews!.requestImport;
  other.manifest.contributions!.browserViews!.captureLauncher = 'views/import.json';
  expect(() => selectBrowserView([value, other], 'captureLauncher', '1.0.0')).toThrow('multiple providers');
  expect(selectBrowserView([value, other], 'requestImport', '1.0.0')).toMatchObject({ bundleId: 'example' });
  delete value.manifest.contributions!.browserRuntimes;
  expect(() => selectBrowserView([value], 'captureLauncher', '1.0.0')).toThrow('own browser runtime');
});
it.each([
  (v: any) => { v.entry = '../outside.html'; },
  (v: any) => { v.actions.query.hook = 'constructor'; v.actions.query.setting = 'agentEnabled'; },
  (v: any) => { delete v.actions.query.disabledResult; },
  (v: any) => { v.preferences.second = { shared: 'json.viewMode' }; },
  (v: any) => { v.preferences.source.area = 'sync'; },
  (v: any) => { v.logins.example.url = 'https://user:secret@example.com'; },
  (v: any) => { v.logins.example.url = 'javascript:alert(1)'; },
  (v: any) => { v.logins.example.url = 'http://example.com'; },
  (v: any) => { v.logins.example.title.en = ''; },
  (v: any) => { v.extra = true; },
])('rejects invalid metadata without evaluating view code %#', edit => {
  const value = definition(); edit(value);
  expect(() => validateBrowserView(value)).toThrow('BUNDLE_INVALID');
});
it('requires declared metadata and HTML resources and bounded manifest positions', () => {
  const value = bundle();
  value.manifest.contributions!.browserViews!.requestImport = 'missing.json';
  expect(() => validateBundleManifest(value.manifest, '1.0.0')).toThrow('declared resources');
  value.manifest.contributions!.browserViews = { arbitrary: 'views/import.json' };
  expect(() => validateBundleManifest(value.manifest, '1.0.0')).toThrow();
  const missing = bundle(); delete missing.manifest.resources['views/import.html'];
  expect(() => selectBrowserView([missing], 'requestImport', '1.0.0')).toThrow('declared resource');
  const large = bundle(); large.manifest.resources['views/import.json'].byteLength = 65537;
  expect(() => validateBundleManifest(large.manifest, '1.0.0')).toThrow('64 KiB');
});
it('captures metadata independently and keeps loopback fixtures valid', () => {
  const value = definition(); value.logins!.example.url = 'http://127.0.0.1:1234/login';
  const accepted = validateBrowserView(value); value.preferences!.source.area = 'session';
  expect(accepted.preferences!.source.area).toBeUndefined();
});

it('settles waiting calls when the host closes before initialization', async () => {
  const script = buildBrowserViewPage('<main/>').match(/<script>([\s\S]*?)<\/script>/)![1];
  let listener!: (event: unknown) => void;
  const parent = { postMessage() {} };
  const window: any = { parent, addEventListener: (_name: string, fn: typeof listener) => { listener = fn; } };
  runInNewContext(script, { window });
  const channel = new MessageChannel();
  try {
    listener({ source: parent, data: { type: 'mearl-plugin-connect' }, ports: [channel.port1] });
    const waiting = expect(window.mearlView.call('invoke')).rejects.toThrow('closed');
    channel.port2.postMessage({ type: 'view-close' });
    await waiting;
  } finally { channel.port1.close(); channel.port2.close(); }
});

it('exchanges context, callbacks, host errors and closing over a source-bound private port without Node globals', async () => {
  const html = buildBrowserViewPage('<main>Existing form</main>');
  expect(html).toContain("connect-src 'none'"); expect(html).toContain("frame-src 'none'");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  let listener: (value: unknown) => void = () => {};
  const parent = { postMessage: vi.fn() }, document = { dispatchEvent: vi.fn() };
  const window: any = { parent, addEventListener: (_name: string, fn: typeof listener) => { listener = fn; } };
  runInNewContext(script, { window, document, KeyboardEvent: class { constructor(readonly type: string, readonly options: unknown) {} } }, { timeout: 1000 });
  expect(parent.postMessage).toHaveBeenCalledWith({ type: 'mearl-plugin-ready' }, '*');
  const channel = new MessageChannel();
  try {
    listener({ source: {}, data: { type: 'mearl-plugin-connect' }, ports: [channel.port1] });
    const calls: any[] = [];
    channel.port2.on('message', message => {
      calls.push(message);
      if (message.type === 'view-ready') channel.port2.postMessage({ type: 'view-init', bootstrap: { locale: 'zh_CN', context: { open: true }, preferences: { source: 'saved' } } });
      if (message.type === 'view-call') channel.port2.postMessage({ type: 'view-result', id: message.id, success: message.method !== 'denied', ...(message.method === 'denied' ? { error: 'Permission required' } : { value: message.input }) });
    });
    listener({ source: parent, data: { type: 'mearl-plugin-connect' }, ports: [channel.port1] });
    expect(await window.mearlView.ready()).toMatchObject({ locale: 'zh_CN', preferences: { source: 'saved' } });
    expect(await window.mearlView.call('import', { apiName: 'example', responseData: { 中文: true } })).toEqual({ apiName: 'example', responseData: { 中文: true } });
    await expect(window.mearlView.call('denied')).rejects.toThrow('Permission required');
    const context = vi.fn(); window.mearlView.onContext(context);
    channel.port2.postMessage({ type: 'view-context', context: { open: false } });
    await vi.waitFor(() => expect(context).toHaveBeenCalledWith({ open: false }));
    const event = vi.fn(); const unsubscribe = window.mearlView.onEvent(event);
    channel.port2.postMessage({ type: 'view-event', event: { source: 'transport', id: 'owned', type: 'message', data: '中文' } });
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith({ source: 'transport', id: 'owned', type: 'message', data: '中文' }));
    unsubscribe();
    channel.port2.postMessage({ type: 'view-key', key: 'Escape' });
    await vi.waitFor(() => expect(document.dispatchEvent).toHaveBeenCalled());
    channel.port2.postMessage({ type: 'view-close' });
    await vi.waitFor(async () => { await expect(window.mearlView.call('closed')).rejects.toThrow('closed'); });
    expect(calls[0].type).toBe('view-ready');
  } finally { channel.port1.close(); channel.port2.close(); }
});

it('accepts a resident capture controller without letting it claim other positions', () => {
  const value = bundle();
  value.manifest.contributions!.browserViews!.captureController = 'views/import.json';
  expect(validateBundleManifest(value.manifest, '1.0.0').contributions!.browserViews!.captureController).toBe('views/import.json');
  expect(selectBrowserView([value], 'captureController', '1.0.0')).toMatchObject({ slot: 'captureController' });
  delete value.manifest.contributions!.browserRuntimes;
  expect(() => selectBrowserView([value], 'captureController', '1.0.0')).toThrow('own browser runtime');
});
it('awaits private commands, reports failures and releases only the registering handler', async () => {
  const script = buildBrowserViewPage('<main/>').match(/<script>([\s\S]*?)<\/script>/)![1];
  let listener!: (event: unknown) => void;
  const parent = { postMessage() {} };
  const window: any = { parent, addEventListener: (_name: string, fn: typeof listener) => { listener = fn; } };
  runInNewContext(script, { window });
  const channel = new MessageChannel();
  const results: any[] = [];
  channel.port2.on('message', value => results.push(value));
  try {
    listener({ source: parent, data: { type: 'mearl-plugin-connect' }, ports: [channel.port1] });
    channel.port2.postMessage({ type: 'view-init', bootstrap: {} });
    await window.mearlView.ready();
    let finish!: (value: unknown) => void;
    const remove = window.mearlView.handle('dispose', () => new Promise(resolve => { finish = resolve; }));
    expect(() => window.mearlView.handle('dispose', () => {})).toThrow('duplicate');
    channel.port2.postMessage({ type: 'view-command', id: 1, method: 'dispose' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(results.filter(value => value.type === 'view-command-result')).toHaveLength(0);
    finish({ cleaned: true });
    await vi.waitFor(() => expect(results).toContainEqual({ type: 'view-command-result', id: 1, success: true, value: { cleaned: true } }));
    remove();
    window.mearlView.handle('dispose', () => { throw new Error('cleanup failed'); });
    remove();
    channel.port2.postMessage({ type: 'view-command', id: 2, method: 'dispose' });
    channel.port2.postMessage({ type: 'view-command', id: 3, method: 'missing' });
    await vi.waitFor(() => expect(results).toContainEqual({ type: 'view-command-result', id: 2, success: false, error: 'Error: cleanup failed' }));
    expect(results).toContainEqual({ type: 'view-command-result', id: 3, success: false, error: 'Unknown browser view command' });
  } finally { channel.port1.close(); channel.port2.close(); }
});

it('keeps modal view documents transparent even when a bundle styles its body', () => {
  const entry = '<style>body{background:white}</style><main>Modal</main>';
  const page = buildBrowserViewPage(entry);
  expect(page.indexOf('data-mearl-view-surface')).toBeGreaterThan(page.indexOf(entry));
  expect(page).toContain('html,body{background:transparent!important}');
});
