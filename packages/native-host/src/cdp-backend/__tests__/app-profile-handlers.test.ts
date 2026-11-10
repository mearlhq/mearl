import { Window } from 'happy-dom';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hooks = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../../native-capability-services.js', () => ({
  nativeCapabilities: {
    requireCustom: (name: string) => hooks.get(name),
    get: (name: string) => hooks.get(name),
    require: (name: string) => {
      const hook = hooks.get(name);
      if (!hook) throw new Error('Required capability is not installed');
      return hook;
    },
  },
}));
import { APP_PROFILES } from '../../../../app-profiles/src/__tests__/fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cdpSetAppProfile,
  isCdpAppProfileActive,
  refreshCdpAppProfileForNavigation,
} from '../app-profile-handlers';
import { createBuffers } from '../buffers.js';
import { clearCdpFetchInterceptionState } from '../fetch-interceptor.js';
import { clearCdpNetworkControlState } from '../network-control.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearCdpNetworkControlState();
  clearCdpFetchInterceptionState();
});

function createSession(restoreProbe?: unknown) {
  const listeners = new Map<string, (params: any) => void>();
  let nextDocumentScriptId = 1;
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { identifier: `app-profile-script-${nextDocumentScriptId++}` };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 77 };
    if (method === 'Page.captureScreenshot') return { data: 'AQID' };
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: { id: 'main', url: 'https://example.test/' },
          childFrames: [
            {
              frame: {
                id: 'root-webview',
                name: '__mearl_root__',
                url: 'https://example.test/',
              },
            },
          ],
        },
      };
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression);
      if (expression.startsWith("({profile:typeof globalThis.__mearlAppProfile__==='string'")) {
        const probe = restoreProbe as { profile?: unknown; restoreHint?: unknown } | undefined;
        return {
          result: {
            value: {
              profile: probe?.profile,
              restoreHint: probe?.restoreHint === true || typeof probe?.profile === 'string',
            },
          },
        };
      }
      if (expression.startsWith('globalThis["__mearlCdpAppProfileState__"]??null')) {
        return {
          result: {
            value: (restoreProbe as { state?: unknown } | undefined)?.state,
          },
        };
      }
      const activeProfilePrefix = 'globalThis.__mearlAppProfile__===';
      if (expression.startsWith(activeProfilePrefix)) {
        return {
          result: {
            value:
              (restoreProbe as { profile?: unknown } | undefined)?.profile ===
              JSON.parse(expression.slice(activeProfilePrefix.length)),
          },
        };
      }
      if (expression === 'globalThis.__mearlAppProfile__??null') {
        return {
          result: {
            value: (restoreProbe as { profile?: unknown } | undefined)?.profile,
          },
        };
      }
      if (expression === 'location.href') {
        return {
          result: {
            value: 'https://example.test/business',
          },
        };
      }
      if (expression.includes('const properties =')) {
        return {
          result: {
            value: [
              { property: '--mearl-side-panel-toggle-display', value: '', priority: '' },
              { property: '--mearl-device-cutout-display', value: '', priority: '' },
            ],
          },
        };
      }
      if (expression.includes('JSON.stringify({ url:')) {
        return {
          result: {
            value: JSON.stringify({
              url: 'https://example.test/',
              title: 'Example',
              w: 393,
              h: 852,
              dpr: 3,
            }),
          },
        };
      }
    }
    if (method === 'Network.getAllCookies' || method === 'Network.getCookies') {
      return {
        cookies: [
          { name: '_m_h5_tk', value: 'stream-token_123456', domain: '.shop.com', path: '/' },
          { name: 'unb', value: '123456', domain: '.shop.com', path: '/' },
          { name: 'nickname', value: '%5Cu98DE%5Cu732A', domain: '.shop.com', path: '/' },
        ],
      };
    }
    return {};
  });
  const session = {
    tabId: 1000,
    targetId: 'target-a',
    runtimeOwner: { browser: 'a'.repeat(64), target: 'target-a' },
    url: 'https://example.test/business',
    buffers: createBuffers(1000),
    client: {
      sendCommand,
      on: vi.fn((method: string, callback: (params: any) => void) => {
        listeners.set(method, callback);
        return () => listeners.delete(method);
      }),
      createChildSession: vi.fn(),
    },
  } as any;
  return { listeners, sendCommand, session };
}

let directory: string;
let window: Window;
beforeEach(() => {
  window = new Window({
    url: 'https://example.test/',
    settings: { enableJavaScriptEvaluation: true },
  });
  directory = mkdtempSync(join(tmpdir(), 'mearl-profile-runtime-'));
  vi.stubEnv('MEARL_CAPABILITY_DIR', directory);
  hooks.clear();
  hooks.set('app.profileCatalog', () => ({
    namespace: 'fixture',
    profiles: Object.values(APP_PROFILES).map(definition => ({
      ...definition,
      name: 'fixture/' + definition.name,
    })),
    bindings: Object.fromEntries(Object.keys(APP_PROFILES).map(name => [name, 'fixture/' + name])),
  }));
});
afterEach(() => {
  window.close();
  rmSync(directory, { recursive: true, force: true });
  delete (window as any).DemoBridge;
  delete (window as any).__mearlAppProfile__;
});
function bootstrap(sendCommand: ReturnType<typeof vi.fn>): string {
  const call = sendCommand.mock.calls.find(
    ([method, params]) =>
      method === 'Page.addScriptToEvaluateOnNewDocument' &&
      String(params?.source).includes('const config='),
  );
  if (!call) throw new Error('Missing document bootstrap');
  return String(call[1].source);
}
describe('public CDP App profile preparation', () => {
  it('installs a basic UA and restoration marker without App bridges or business globals', async () => {
    const { session, sendCommand } = createSession();
    await cdpSetAppProfile(session, { enabled: true, profile: 'shop', reload: false });
    const source = bootstrap(sendCommand);
    window.eval(source);
    expect(window.navigator.userAgent).toContain('Sample/');
    expect((window as any).__mearlAppProfile__).toBe('shop');
    expect((window as any).FixtureBridge).toBeUndefined();
    expect((window as any).__APP_NAME__).toBeUndefined();
    expect((window as any).__STATUS_BAR_HEIGHT__).toBeUndefined();
    expect(isCdpAppProfileActive(session)).toBe(true);
  });
  it('binds an installed implementation to the original App ID and executes verified code in the page', async () => {
    const source =
      'module.exports.install = config => { window.DemoBridge = { profile: config.profile, version: config.binding.options.appVersion }; window.__mearlAppProfile__ = config.profile; };';
    const sha256 = createHash('sha256').update(source).digest('hex');
    const binding = { id: 'sample/main', sha256 };
    const definition = {
      ...APP_PROFILES.reader,
      name: 'sample/app',
      label: 'Sample',
      pageRuntime: binding,
    };
    hooks.set('app.profileCatalog', () => ({
      namespace: 'sample',
      profiles: [definition],
      bindings: { reader: 'sample/app' },
      order: ['reader'],
    }));
    hooks.set('app.pageRuntime', requested => (requested.sha256 === sha256 ? source : undefined));
    const { session, sendCommand } = createSession();
    await cdpSetAppProfile(session, {
      enabled: true,
      profile: 'reader',
      appVersion: '9.8.7',
      reload: false,
    });
    window.eval(bootstrap(sendCommand));
    expect((window as any).DemoBridge).toEqual({ profile: 'reader', version: '9.8.7' });
    expect(window.navigator.userAgent).toContain('Sample/9.8.7');
  });
  it('rejects missing code before disposing an existing environment', async () => {
    const { session, sendCommand } = createSession();
    await cdpSetAppProfile(session, { enabled: true, profile: 'shop', reload: false });
    sendCommand.mockClear();
    hooks.set('app.profileCatalog', () => ({
      namespace: 'sample',
      profiles: [
        {
          ...APP_PROFILES.reader,
          name: 'sample/app',
          pageRuntime: { id: 'sample/missing', sha256: 'a'.repeat(64) },
        },
      ],
      bindings: { reader: 'sample/app' },
    }));
    await expect(
      cdpSetAppProfile(session, { enabled: true, profile: 'reader', reload: false }),
    ).rejects.toThrow('not installed');
    expect(
      sendCommand.mock.calls.filter(
        ([method]) => method === 'Page.removeScriptToEvaluateOnNewDocument',
      ),
    ).toEqual([]);
    expect(isCdpAppProfileActive(session)).toBe(true);
  });
});

it('retains the previous exact runtime through a navigation followed by failed activation and rollback', async () => {
  const original = 'module.exports.install = () => { window.DemoBridge = "original"; };';
  const updated = 'module.exports.install = () => { window.DemoBridge = "updated"; };';
  const runtime = (source: string) => ({
    id: 'sample/main',
    sha256: createHash('sha256').update(source).digest('hex'),
  });
  const catalog = (source: string) => () => ({
    namespace: 'sample',
    profiles: [{ ...APP_PROFILES.reader, name: 'sample/app', pageRuntime: runtime(source) }],
    bindings: { reader: 'sample/app' },
  });
  const { session, sendCommand, listeners } = createSession();
  hooks.set('app.profileCatalog', catalog(original));
  hooks.set('app.pageRuntime', () => original);
  await cdpSetAppProfile(session, { enabled: true, profile: 'reader', reload: false });
  hooks.set('app.profileCatalog', catalog(updated));
  hooks.set('app.pageRuntime', requested =>
    requested.sha256 === runtime(updated).sha256 ? updated : undefined,
  );
  const normalSend = sendCommand.getMockImplementation()!;
  let fail = true;
  sendCommand.mockImplementation(async (method, params) => {
    if (method === 'Page.getFrameTree' && fail && listeners.has('Page.frameNavigated')) {
      fail = false;
      listeners.get('Page.frameNavigated')?.({
        frame: { id: 'main', url: 'https://example.test/next' },
      });
      throw new Error('activation fixture failure');
    }
    return normalSend(method, params);
  });
  await expect(
    cdpSetAppProfile(session, {
      enabled: true,
      profile: 'reader',
      refreshDefinition: true,
      reload: false,
    }),
  ).rejects.toThrow('activation fixture failure');
  expect(isCdpAppProfileActive(session)).toBe(true);
  expect(existsSync(join(directory, 'page-runtimes', runtime(original).sha256 + '.cjs'))).toBe(
    true,
  );
  const sources = sendCommand.mock.calls.filter(
    ([method, params]) =>
      method === 'Page.addScriptToEvaluateOnNewDocument' &&
      String(params?.source).includes('const config='),
  );
  window.eval(String(sources.at(-1)![1].source));
  expect((window as any).DemoBridge).toBe('original');
});

it('keeps the full environment on navigation after its provider is removed', async () => {
  const source = 'module.exports.install = () => { window.DemoBridge = "retained"; };';
  const runtime = { id: 'sample/main', sha256: createHash('sha256').update(source).digest('hex') };
  hooks.set('app.profileCatalog', () => ({
    namespace: 'sample',
    profiles: [{ ...APP_PROFILES.reader, name: 'sample/app', pageRuntime: runtime }],
    bindings: { reader: 'sample/app' },
  }));
  hooks.set('app.pageRuntime', () => source);
  const { session, sendCommand } = createSession();
  await cdpSetAppProfile(session, { enabled: true, profile: 'reader', reload: false });
  hooks.clear();
  sendCommand.mockClear();
  await expect(refreshCdpAppProfileForNavigation(session)).resolves.toBeUndefined();
  expect(
    sendCommand.mock.calls.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument'),
  ).toEqual([]);
  expect(isCdpAppProfileActive(session)).toBe(true);
});

it('rejects settings from a child execution context before mutating the top profile', async () => {
  const { session, sendCommand, listeners } = createSession();
  await cdpSetAppProfile(session, { enabled: true, profile: 'wallet', reload: false });
  sendCommand.mockClear();
  listeners.get('Runtime.bindingCalled')!({
    name: '__mearlCdpAppProfileRelay',
    executionContextId: 101,
    payload: JSON.stringify({
      type: 'settings',
      requestId: 1,
      payload: { profile: 'wallet', settingId: 'language', value: 'en-US' },
    }),
  });
  await vi.waitFor(() =>
    expect(
      sendCommand.mock.calls.some(
        ([method, params]) =>
          method === 'Runtime.evaluate' &&
          String(params?.expression).includes('APP_BRIDGE_SETTINGS_RESPONSE'),
      ),
    ).toBe(true),
  );
  expect(
    sendCommand.mock.calls.some(
      ([method]) => method === 'Page.reload' || method === 'Page.addScriptToEvaluateOnNewDocument',
    ),
  ).toBe(false);
});

it('closes pending authorization on handoff and never delivers its result after resume', async () => {
  const { session, sendCommand, listeners } = createSession();
  let finish!: (value: Record<string, unknown>) => void;
  const wait = vi.fn(
    () =>
      new Promise<Record<string, unknown>>(resolve => {
        finish = resolve;
      }),
  );
  const close = vi.fn(async () => {});
  hooks.set('sample.authorization', () => ({
    start: async () => ({ browserId: 'auth-fixture', qrSvg: '<svg/>' }),
    wait,
    close,
  }));
  hooks.set('app.profileCatalog', () => ({
    namespace: 'fixture',
    profiles: [
      {
        ...APP_PROFILES.wallet,
        name: 'fixture/wallet',
        actions: { ...APP_PROFILES.wallet.actions, behaviors: { getAuthCode: 'authCode' } },
      },
    ],
    bindings: { wallet: 'fixture/wallet' },
  }));
  const lease = new AbortController();
  session.hostSignal = lease.signal;
  session.onHostRequestActivity = vi.fn();
  session.assertHostControl = vi.fn(async () => {});
  await cdpSetAppProfile(session, { enabled: true, profile: 'wallet', reload: false });
  listeners.get('Runtime.bindingCalled')!({
    name: '__mearlCdpAppProfileRelay',
    executionContextId: 101,
    payload: JSON.stringify({ type: 'authCode', requestId: 42, payload: { appId: 'fixture' } }),
  });
  await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
  expect(session.onHostRequestActivity).toHaveBeenLastCalledWith(true);
  lease.abort();
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith('auth-fixture'));
  session.hostSignal = new AbortController().signal;
  sendCommand.mockClear();
  finish({ authCode: 'must-not-be-delivered' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(session.onHostRequestActivity).toHaveBeenLastCalledWith(false);
  expect(
    sendCommand.mock.calls.some(([, params]) =>
      String(params?.expression).includes('APP_BRIDGE_AUTH_CODE_RESPONSE'),
    ),
  ).toBe(false);
  listeners.get('Runtime.bindingCalled')!({
    name: '__mearlCdpAppProfileRelay',
    executionContextId: 101,
    payload: JSON.stringify({ type: 'authCode', requestId: 43, payload: { appId: 'fixture' } }),
  });
  await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
  finish({ authCode: 'new-approved-fixture' });
  await vi.waitFor(() =>
    expect(
      sendCommand.mock.calls.some(([, params]) =>
        String(params?.expression).includes('new-approved-fixture'),
      ),
    ).toBe(true),
  );
});
