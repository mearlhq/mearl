import { describe, expect, it } from 'vitest';
import { validateBrowserRequestUi, selectBrowserRequestUi, browserUiText, browserRequestUiLink, browserRequestLoginError, validateBrowserRequestDetail, validateBundleManifest, type BrowserRequestUi, type PreparedBundle } from '../bundles.js';

function ui(): BrowserRequestUi {
  const text = { en: 'Example', zh_CN: '示例' };
  return { schemaVersion: 1, service: 'example', setting: { key: 'exampleEnabled', label: text }, apiLink: { url: 'https://example.com/api', query: { type: 'RPC' }, apiParameter: 'name', versionParameter: 'version', title: text }, login: { url: 'https://example.com/login', title: text, requiredMessage: text, errorIncludes: ['Not logged in', '未登录'] }, details: { hook: 'request.example.details', toggleLabel: text, interfaceLabel: text, maintainerLabel: text, viewTitle: text, notFound: text } };
}
function bundle(id = 'example'): PreparedBundle {
  const bytes = new TextEncoder().encode(JSON.stringify(ui()));
  return { source: 'https://example.com/bundle.json', revision: 'a'.repeat(64), manifest: { schemaVersion: 1, id, version: '1.0.0', resources: { 'ui.json': { sha256: 'b'.repeat(64), byteLength: bytes.byteLength }, 'runtime.cjs': { sha256: 'c'.repeat(64), byteLength: 1 } }, contributions: { appProfiles: [], requestUi: 'ui.json', browserRuntimes: { extension: { entry: 'runtime.cjs', bindings: { 'request.example.details': 'details' } } } } }, resources: { 'ui.json': bytes, 'runtime.cjs': new Uint8Array([1]) } };
}
describe('finite request UI contributions', () => {
  it('captures independent definitions and resolves translations, links and literal login errors', () => {
    const input = ui();
    const value = validateBrowserRequestUi(input);
    input.setting.label.en = 'changed';
    expect(value.setting.label.en).toBe('Example');
    expect(browserUiText(value.setting.label, 'zh-CN')).toBe('示例');
    expect(browserUiText(value.setting.label, 'zh_CN')).toBe('示例');
    expect(browserUiText({ en: 'Fallback' }, 'zh_CN')).toBe('Fallback');
    expect(browserUiText(value.setting.label, 'en')).toBe('Example');
    expect(browserRequestUiLink(value, 'api.test <x>', '1.0+a b')).toBe('https://example.com/api?type=RPC&name=api.test%20%3Cx%3E&version=1.0%2Ba%20b');
    expect(browserRequestLoginError(value, 'Failure: NOT LOGGED IN')).toBe(true);
    expect(browserRequestLoginError(value, '权限：未登录')).toBe(true);
    expect(browserRequestLoginError(value, 'Network unavailable')).toBe(false);
  });
  it('requires the detail handler in the same browser module and rejects ambiguous providers', () => {
    const first = bundle();
    expect(selectBrowserRequestUi([first], '1.0.0')).toEqual({ bundleId: 'example', revision: first.revision, definition: ui() });
    expect(() => selectBrowserRequestUi([first, bundle('other')], '1.0.0')).toThrow('multiple providers');
    delete first.manifest.contributions!.browserRuntimes;
    expect(() => selectBrowserRequestUi([first], '1.0.0')).toThrow('own browser runtime');
    expect(selectBrowserRequestUi([], '1.0.0')).toBeUndefined();
  });
  it('binds optional saving to the same provider and rejects malformed save declarations', () => {
    const value = bundle();
    const definition = { ...ui(), save: { hook: 'request.example.save', setting: 'exampleEnabled' } };
    const bytes = new TextEncoder().encode(JSON.stringify(definition));
    value.resources['ui.json'] = bytes;
    value.manifest.resources['ui.json'].byteLength = bytes.byteLength;
    expect(() => selectBrowserRequestUi([value], '1.0.0')).toThrow('own browser runtime');
    value.manifest.contributions!.browserRuntimes!.extension!.bindings['request.example.save'] = 'save';
    expect(selectBrowserRequestUi([value], '1.0.0')?.definition.save).toEqual(definition.save);
    expect(() => validateBrowserRequestUi({ ...definition, save: { hook: '../save', setting: 'exampleEnabled' } })).toThrow();
    expect(() => validateBrowserRequestUi({ ...definition, save: { hook: 'save', setting: 'agentEnabled' } })).toThrow();
    expect(() => validateBrowserRequestUi({ ...definition, save: { ...definition.save, endpoint: 'https://example.com' } })).toThrow();
  });
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com/', 'https://user:secret@example.com/', 'https://example.com/#fragment'])('rejects privileged or non-HTTPS UI URLs: %s', url => {
    const value = ui(); value.login.url = url;
    expect(() => validateBrowserRequestUi(value)).toThrow();
    expect(() => validateBrowserRequestDetail({ displayValue: 'Interface', jumpUrl: url })).toThrow();
  });
  it('allows owned loopback fixtures and validates returned text/link data', () => {
    const value = ui(); value.login.url = 'http://127.0.0.1:3000/login';
    expect(validateBrowserRequestUi(value).login.url).toBe(value.login.url);
    const detail = { displayValue: 'Service#query (1.0)', jumpUrl: 'https://example.com/view?service=example', maintainerDisplayValue: 'Owner', maintainerTitle: 'Team' };
    expect(validateBrowserRequestDetail(detail)).toEqual(detail);
    expect(() => validateBrowserRequestDetail({ ...detail, html: '<img>' })).toThrow();
    expect(() => validateBrowserRequestDetail({ ...detail, maintainerDisplayValue: 1 })).toThrow();
  });
  it.each([
    (value: BrowserRequestUi) => { value.apiLink.versionParameter = value.apiLink.apiParameter; },
    (value: BrowserRequestUi) => { value.apiLink.query.name = 'fixed'; },
    (value: BrowserRequestUi) => { value.apiLink.url += '?fixed=1'; },
    (value: BrowserRequestUi) => { value.login.errorIncludes = ['']; },
    (value: BrowserRequestUi) => { value.details.hook = '../invoke'; },
    (value: BrowserRequestUi) => { value.setting.label = {} as never; },
    (value: BrowserRequestUi) => { value.setting.key = 'language'; },
    (value: BrowserRequestUi) => { value.setting.key = 'agentEnabled'; },
    (value: BrowserRequestUi) => { value.setting.label = { en: 'x'.repeat(1025) }; },
    (value: BrowserRequestUi) => { Object.assign(value.details, { script: 'alert(1)' }); },
  ])('rejects malformed or executable declarations', mutate => { const value = ui(); mutate(value); expect(() => validateBrowserRequestUi(value)).toThrow(); });
  it('checks declared UI resource presence and size before reading it', () => {
    const value = bundle();
    value.manifest.contributions!.requestUi = 'missing.json';
    expect(() => validateBundleManifest(value.manifest, '1.0.0')).toThrow('declared resource');
    value.manifest.contributions!.requestUi = 'ui.json'; value.manifest.resources['ui.json'].byteLength = 65537;
    expect(() => selectBrowserRequestUi([value], '1.0.0')).toThrow('64 KiB');
  });
});
