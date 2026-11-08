import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';
import type { InjectedAppProfileConfig } from '@mearl/browser-core';
import { BrowserBundleStore, bundleDigest, prepareBundle } from '@mearl/preset/bundles';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), read: vi.fn(), authorize: vi.fn(), cookies: vi.fn(), run: vi.fn() }));
vi.mock('../browserCapabilities', () => ({ prepareBrowserCapabilities: mocks.prepare, authorizeBrowserCapabilityUrl: mocks.authorize }));
vi.mock('../browserCapabilityRegistry', () => ({ browserCapabilityRegistry: () => ({ browserRuntimeBytes: mocks.read }) }));
vi.mock('../browserPureCapabilities', () => ({ runAcceptedBrowserPureCapability: mocks.run }));
vi.mock('../utils/dnr', () => ({ collectCookies: mocks.cookies }));
import { captureAppProfileHostCapabilities, appProfileRuntimePins, replaceAppProfileRuntimePins } from '../appProfileHostCapabilities';
import { getAppProfileUserInfo } from '../utils/appProfileUserInfo';
import { prepareProtocolRequest } from '../requestProtocol';
let store: BrowserBundleStore;
let database: IDBFactory;
const hooks = { 'app.userInfo.scope': 'scope', 'app.userInfo.resolve': 'identity', 'request.protocol.resolve': 'resolve', 'request.protocol.prepare': 'prepare', 'request.protocol.streamError': 'error' };
const config = (): InjectedAppProfileConfig => ({ ...resolveAppProfile('shop').injected, bridges: [{ global: 'FixtureBridge', style: 'fixtureBridge' }] });
async function install(version: string) {
  const code = new TextEncoder().encode(`module.exports=(_host,config)=>({scope:()=>({cookieNames:['uid']}),identity:({cookies})=>({userId:cookies[0].value,userName:config.label}),resolve:input=>({api:input.api,requestData:input.data,normalizedMethod:'GET',gatewayUrl:'https://api.example.test/',timeout:1000}),prepare:({resolved})=>({...resolved,targetUrl:'https://api.example.test/${version}',requestHeaders:{},cookieHeader:''}),error:()=>config.label});`);
  const sha256 = await bundleDigest(code);
  const manifest = { schemaVersion: 1, id: 'protocol', version, resources: { 'runtime.cjs': { sha256, byteLength: code.length } }, contributions: { appProfiles: [], browserRuntimes: { extension: { entry: 'runtime.cjs', bindings: hooks } } } };
  const bundle = await prepareBundle('https://source.example.test/bundle.json', { mearlApiVersion: '1.0.0', expectedId: 'protocol', load: async source => source.endsWith('.cjs') ? code : new TextEncoder().encode(JSON.stringify(manifest)) });
  await store.install(bundle, null);
  mocks.prepare.mockResolvedValue(Object.fromEntries(Object.entries(hooks).map(([hook, handler]) => [hook, { bundleId: 'protocol', revision: bundle.revision, invocation: { code, sha256, handler, handlers: Object.values(hooks), config: { label: version } } }])));
  return { bundle, sha256 };
}
beforeEach(() => {
  vi.clearAllMocks(); database = new IDBFactory();
  store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: database });
  mocks.read.mockImplementation(sha => store.browserRuntimeBytes(sha));
  mocks.authorize.mockImplementation(async value => new URL(value));
  mocks.cookies.mockResolvedValue([]);
  mocks.run.mockImplementation(async input => {
    const module = { exports: undefined as any };
    new Function('module', new TextDecoder().decode(input.code))(module);
    return module.exports({}, input.config)[input.handler](input.input);
  });
  vi.stubGlobal('chrome', { ...chrome, cookies: { getAll: vi.fn(async () => [{ name: 'uid', value: '123' }] as any) } });
});
afterEach(async () => { await store.close(); vi.unstubAllGlobals(); });
it('retains the accepted identity and PROTOCOL implementation across package removal and store reconstruction', async () => {
  const first = await install('1.0.0');
  const bound = await captureAppProfileHostCapabilities(config());
  await store.pinPageRuntimes(appProfileRuntimePins('tab:7', bound));
  await store.remove('protocol', first.bundle.revision);
  await store.close(); store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: database });
  mocks.prepare.mockResolvedValue({}); mocks.prepare.mockClear();
  expect(await getAppProfileUserInfo('https://app.example.test/', bound.hostCapabilities)).toEqual({ userId: '123', userName: '1.0.0' });
  const request = await prepareProtocolRequest({ api: 'fixture.api', data: { original: true } }, true, bound.hostCapabilities);
  expect(request.targetUrl.href).toBe('https://api.example.test/1.0.0');
  expect((await request.streamError('expired')).message).toBe('1.0.0');
  expect(mocks.prepare).not.toHaveBeenCalled();
  await store.pinPageRuntimes(replaceAppProfileRuntimePins('tab:7', bound));
  await expect(store.browserRuntimeBytes(first.sha256)).rejects.toThrow('missing or corrupt');
});
it('lets new bindings use the replacement while existing bindings retain their code and configuration', async () => {
  const first = await install('1.0.0'); const old = await captureAppProfileHostCapabilities(config());
  await store.pinPageRuntimes(appProfileRuntimePins('tab:7', old)); await store.remove('protocol', first.bundle.revision);
  await install('2.0.0'); const next = await captureAppProfileHostCapabilities(config());
  expect((await getAppProfileUserInfo('https://app.example.test/', old.hostCapabilities)).userName).toBe('1.0.0');
  expect((await getAppProfileUserInfo('https://app.example.test/', next.hostCapabilities)).userName).toBe('2.0.0');
  expect(await captureAppProfileHostCapabilities(old)).toBe(old);
});
it('still enforces current permissions and does not fall back when a retained module is missing', async () => {
  const first = await install('1.0.0'); const bound = await captureAppProfileHostCapabilities(config());
  mocks.authorize.mockRejectedValueOnce(new Error('permission revoked'));
  await expect(getAppProfileUserInfo('https://app.example.test/', bound.hostCapabilities)).rejects.toThrow('permission revoked');
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
  await store.remove('protocol', first.bundle.revision); mocks.prepare.mockClear();
  await expect(getAppProfileUserInfo('https://app.example.test/', bound.hostCapabilities)).rejects.toThrow('missing or corrupt');
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('does not load host protocols for the basic UA implementation', async () => {
  const basic = resolveAppProfile('shop').injected;
  expect(await captureAppProfileHostCapabilities(basic)).toBe(basic);
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it.each([undefined, { contributions: { browserRuntimes: { extension: null } } }])('isolates a corrupt unrelated package while rebuilding valid App references (%j)', async manifest => {
  const installed = await install('1.0.0'); const bound = await captureAppProfileHostCapabilities(config());
  await store.pinPageRuntimes(appProfileRuntimePins('tab:7', bound));
  const databaseHandle = await new Promise<IDBDatabase>((resolve, reject) => { const request = database.open('mearl-capabilities-v3'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await new Promise<void>((resolve, reject) => { const transaction = databaseHandle.transaction('bundles', 'readwrite'); transaction.objectStore('bundles').put({ id: 'broken', revision: 'invalid', byteLength: -1, bundle: { manifest } }); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
  databaseHandle.close();
  expect((await store.list()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'broken' })]));
  await store.synchronizePageRuntimePins(appProfileRuntimePins('tab:7', bound));
  expect((await getAppProfileUserInfo('https://app.example.test/', bound.hostCapabilities)).userName).toBe('1.0.0');
  expect((await store.browserRuntimeBytes(installed.sha256)).length).toBeGreaterThan(0);
});
