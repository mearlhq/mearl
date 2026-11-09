import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseInstallationConfig } from '@mearl/preset/installation';
import { createInstallationService } from '../installationService';
import { createBrowserCapabilityRegistry } from '../browserCapabilityRegistry';
import { getAgentAllowedOrigins } from '../../../shared/proxyPermissions';
import {
  INSTALLATION_ACTION,
  INSTALLATION_BRIDGE_URL,
  INSTALLATION_SITE,
  INSTALLATION_VIEW_PATH,
} from '../../../shared/installation';

const agent = vi.hoisted(() => ({
  allowed: ['*://*.example.test/*'],
  disabled: [] as string[],
  all: false,
}));
vi.mock('../../../shared/proxyPermissions', () => ({
  getAgentAllowAllDomains: vi.fn(async () => agent.all),
  getAgentAllowedOrigins: vi.fn(async () =>
    agent.allowed.filter(origin => !agent.disabled.includes(origin)),
  ),
  getAllStoredAgentOrigins: vi.fn(async () => agent.allowed),
  getDisabledBuiltinOrigins: vi.fn(async () => agent.disabled),
  setStoredAgentOrigins: vi.fn(async value => {
    agent.allowed = value;
  }),
  setDisabledBuiltinOrigins: vi.fn(async value => {
    agent.disabled = value;
  }),
}));
vi.mock('../browserCapabilityRegistry', () => ({
  BROWSER_BUNDLE_API_VERSION: '1.0.0',
  browserCapabilityRegistry: vi.fn(),
  createBrowserCapabilityRegistry: vi.fn(),
}));
vi.mock('../utils/dnr', () => ({ withCookieInjection: vi.fn((_url, call) => call()) }));

let records: Record<string, any>;
let config: ReturnType<typeof parseInstallationConfig>;
let now: number;
let grants: boolean;
let topUrl: string;
let frame: any;
let status: any;
let tabs: Map<number, { id: number; url: string }>;
let nextTab: number;
let selection: {
  activeRevision: string | null;
  installationToken: string | null;
  revisions: Record<string, string>;
};
const owner = () =>
  ({
    url: INSTALLATION_BRIDGE_URL,
    origin: INSTALLATION_SITE.origin,
    tab: { id: 1 },
    frameId: 2,
    documentId: 'bridge-document',
    documentLifecycle: 'active',
  }) as chrome.runtime.MessageSender;
const input = (operation = 'open', presetId = 'team') => ({
  action: INSTALLATION_ACTION,
  operation,
  presetId,
  catalogUrl: 'https://guide.example.test/catalog.json',
});
const make = (
  install = vi.fn(async () => {
    status = {
      ...status,
      browserReady: true,
      presetId: 'team',
      presetSource: config.presets!.team.source,
    };
  }),
) => ({
  install,
  service: createInstallationService({
    configuration: async () => structuredClone(config),
    registry: {
      installationStatus: async () => status,
      captureInstallationSelection: async () => structuredClone(selection),
    } as any,
    install,
    now: () => now,
  }),
});
const uiSender = (id: string) => {
  const value = records[`mearl-installation:${id}`];
  return {
    id: 'installed-extension',
    url: `chrome-extension://installed-extension/${INSTALLATION_VIEW_PATH}?session=${id}`,
    tab: { id: value.viewTabId },
    frameId: 0,
  } as chrome.runtime.MessageSender;
};
const internal = (operation: string, session: string, authorize?: boolean) => ({
  action: INSTALLATION_ACTION,
  operation,
  session,
  ...(authorize ? { authorize } : {}),
});

async function openManaged(
  service: ReturnType<typeof createInstallationService>,
  presetId = 'team',
  existing?: chrome.runtime.MessageSender,
) {
  const url = chrome.runtime.getURL(INSTALLATION_VIEW_PATH);
  const tab = existing?.tab ?? (await chrome.tabs.create({ url }));
  const sender =
    existing ??
    ({
      id: chrome.runtime.id,
      url,
      tab,
      frameId: 0,
    } as chrome.runtime.MessageSender);
  const previous = status;
  status = { ...status, presetId, presetSource: config.presets![presetId].source };
  try {
    const result = (await service.internal(
      { action: INSTALLATION_ACTION, operation: 'restart' },
      sender,
    )) as { session: string };
    tabs.get(tab.id!)!.url = `${url}?session=${result.session}`;
    return result;
  } finally {
    status = previous;
  }
}

it('leaves the guide idle after status checks and rejects legacy automatic open requests', async () => {
  const { service, install } = make();
  await expect(service.external(input('status'), owner())).resolves.toMatchObject({
    browserReady: false,
  });
  await expect(service.external(input('openIfMissing'), owner())).rejects.toThrow(
    'INVALID_INSTALLATION_REQUEST',
  );
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});

beforeEach(() => {
  vi.clearAllMocks();
  records = {};
  now = 1000;
  grants = true;
  nextTab = 90;
  tabs = new Map();
  agent.allowed = ['*://*.example.test/*'];
  agent.disabled = [];
  agent.all = false;
  config = parseInstallationConfig(
    {
      schemaVersion: 1,
      guide: {
        url: 'https://guide.example.test/installed.html',
      },
      presets: {
        team: {
          label: 'Team',
          source: 'https://guide.example.test/presets/team.json',
          origins: ['*://*.example.test/*'],
        },
      },
    },
    INSTALLATION_SITE.origin,
  );
  topUrl = config.guide!.url;
  frame = {
    url: INSTALLATION_BRIDGE_URL,
    parentFrameId: 0,
    documentId: 'bridge-document',
    parentDocumentId: 'top-document',
    documentLifecycle: 'active',
  };
  status = { browserReady: false, settingsPending: [], pending: [] };
  selection = { activeRevision: null, installationToken: null, revisions: {} };
  Object.assign(chrome, {
    runtime: {
      id: 'installed-extension',
      getURL: (path: string) => `chrome-extension://installed-extension/${path}`,
      getManifest: () => ({ version: '3.0.0' }),
      getContexts: vi.fn(async ({ tabIds }: { tabIds: number[] }) =>
        tabIds.flatMap(tabId => {
          const tab = tabs.get(tabId);
          return tab?.url.startsWith('chrome-extension://installed-extension/')
            ? [{ tabId, frameId: 0, documentUrl: tab.url }]
            : [];
        }),
      ),
    },
    permissions: { contains: vi.fn(async () => grants) },
    storage: {
      session: {
        get: vi.fn(async (key: string | null) =>
          key === null ? structuredClone(records) : { [key]: structuredClone(records[key]) },
        ),
        set: vi.fn(async (value: object) => {
          Object.assign(records, structuredClone(value));
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key];
        }),
      },
    },
    webNavigation: {
      getFrame: vi.fn(async ({ frameId }: { frameId: number }) =>
        frameId === 0
          ? {
              url: topUrl,
              parentFrameId: -1,
              documentId: 'top-document',
              documentLifecycle: 'active',
            }
          : frame,
      ),
    },
    tabs: {
      create: vi.fn(async () => {
        const tab = { id: ++nextTab, url: 'about:blank' };
        tabs.set(tab.id, tab);
        return tab;
      }),
      get: vi.fn(async id => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('closed');
        return tab;
      }),
      update: vi.fn(async (id, patch) => {
        const tab = tabs.get(id)!;
        if (patch.url) {
          const session = new URL(patch.url).searchParams.get('session');
          expect(records[`mearl-installation:${session}`].viewTabId).toBe(id);
          tab.url = patch.url;
        }
        return tab;
      }),
      reload: vi.fn(async () => {}),
      remove: vi.fn(async id => tabs.delete(id)),
    },
  });
});

describe('website installation authority', () => {
  it('requires an explicit catalog for both website transports', async () => {
    const { service } = make();
    const { catalogUrl: _catalogUrl, ...request } = input('open');
    const direct = {
      ...owner(),
      id: chrome.runtime.id,
      url: config.guide!.url,
      origin: new URL(config.guide!.url).origin,
      frameId: 0,
      documentId: 'top-document',
    };
    await expect(
      service.website({ ...request, action: 'mearlWebsiteInstallation' }, direct),
    ).rejects.toThrow('INVALID_INSTALLATION_REQUEST');
    await expect(service.external(request, owner())).rejects.toThrow(
      'INVALID_INSTALLATION_REQUEST',
    );
    await expect(service.external({ ...input(), operation: ['status'] }, owner())).rejects.toThrow(
      'INVALID_INSTALLATION_REQUEST',
    );
    await expect(
      service.external({ ...input(), source: 'https://attacker.example/' }, owner()),
    ).rejects.toThrow('INVALID_INSTALLATION_REQUEST');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it.each([
    { origin: 'https://attacker.example.test' },
    { id: 'other-extension' },
    { documentLifecycle: 'prerender' },
    { documentId: 'stale-document' },
    { url: `${INSTALLATION_BRIDGE_URL}?source=evil` },
  ])('rejects an untrusted or stale external document %j', async patch => {
    const { service } = make();
    await expect(
      service.external(input(), { ...owner(), ...patch } as chrome.runtime.MessageSender),
    ).rejects.toThrow();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('requires a direct frame under a page on the catalog origin', async () => {
    const { service } = make();
    frame.parentFrameId = 7;
    await expect(service.external(input(), owner())).rejects.toThrow('SOURCE_DENIED');
    frame.parentFrameId = 0;
    topUrl = 'https://other.example.test/untrusted.html';
    await expect(service.external(input(), owner())).rejects.toThrow('SOURCE_DENIED');
  });
  it('rejects a request from a bridge attached to a replaced top-level document', async () => {
    const { service } = make();
    frame.parentDocumentId = 'previous-top-document';
    await expect(service.external(input(), owner())).rejects.toThrow('INSTALLATION_PARENT_DENIED');
  });
  it.each(['bridge.html', 'connect.html', 'en/connect.html'])(
    'rejects top-level installation requests from %s',
    async path => {
      const { service } = make();
      topUrl = new URL(path, INSTALLATION_SITE).href;
      await expect(
        service.external(input('open'), {
          ...owner(),
          url: topUrl,
          frameId: 0,
          documentId: 'top-document',
        }),
      ).rejects.toThrow('SOURCE_DENIED');
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    },
  );
  it('reports ready only for the catalog source and identity', async () => {
    const { service } = make();
    const { session } = await openManaged(service);
    const inspect = () => service.internal(internal('inspect', session), uiSender(session));
    status = {
      ...status,
      browserReady: true,
      presetId: 'team',
      presetSource: 'https://other.example.test/team.json',
      pending: [{ id: 'node' }],
    };
    expect(await inspect()).toMatchObject({
      browserReady: false,
      localComponentCount: 0,
    });
    status.presetSource = config.presets!.team.source;
    expect(await inspect()).toMatchObject({
      browserReady: true,
      localComponentCount: 1,
    });
    status.settingsPending = ['simulation'];
    expect(await inspect()).toMatchObject({ browserReady: false });
    status.settingsPending = [];
    grants = false;
    expect(await inspect()).toMatchObject({ browserReady: false });
    grants = true;
    agent.allowed = [];
    expect(await inspect()).toMatchObject({ browserReady: false });
  });
  it('reuses its own view when Chrome omits the tab URL', async () => {
    const { service } = make();
    const one = (await service.external(input(), owner())) as { session: string };
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 91 } as chrome.tabs.Tab);
    const two = (await service.external(input(), owner())) as { session: string };
    expect(two.session).toBe(one.session);
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({
      contextTypes: ['TAB'],
      tabIds: [91],
    });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.reload).toHaveBeenCalledWith(91);
  });
  it.each([
    { frameId: 1 },
    { documentUrl: 'chrome-extension://installed-extension/src/pages/options/index.html' },
    {
      documentUrl: `chrome-extension://installed-extension/${INSTALLATION_VIEW_PATH}?session=other`,
    },
  ])('requires the allocated top-level installation context %j', async patch => {
    const { service } = make();
    const { session } = (await service.external(input(), owner())) as { session: string };
    Object.assign(chrome.runtime, {
      getContexts: vi.fn(async () => [
        {
          tabId: 91,
          frameId: 0,
          documentUrl: `chrome-extension://installed-extension/${INSTALLATION_VIEW_PATH}?session=${session}`,
          ...patch,
        },
      ]),
    });
    await service.external(input(), owner());
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
  it('reuses the current view and does not navigate a tab that the user took elsewhere', async () => {
    const { service } = make();
    const one = (await service.external(input(), owner())) as { session: string };
    const two = (await service.external(input(), owner())) as { session: string };
    expect(two.session).toBe(one.session);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    tabs.get(91)!.url = 'https://user.example.test/';
    await service.external(input(), owner());
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(tabs.get(91)!.url).toBe('https://user.example.test/');
  });
});

describe('website source confirmation', () => {
  const catalogUrl = 'https://guide.example.test/catalog.json';
  const sender = () => ({
    ...owner(),
    id: chrome.runtime.id,
    url: config.guide!.url,
    origin: new URL(config.guide!.url).origin,
    frameId: 0,
    documentId: 'top-document',
  });
  const website = (operation = 'open', patch = {}) => ({
    action: 'mearlWebsiteInstallation',
    operation,
    presetId: 'team',
    catalogUrl,
    ...patch,
  });
  const setup = () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(config), { headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const install = vi.fn(async () => {
      status = {
        ...status,
        browserReady: true,
        presetId: 'team',
        presetSource: config.presets!.team.source,
      };
    });
    const native = { capture: vi.fn(async () => undefined), request: vi.fn() };
    const service = createInstallationService({
      registry: {
        installationStatus: async () => status,
        captureInstallationSelection: async () => structuredClone(selection),
      } as any,
      install,
      native,
      now: () => now,
    });
    return { service, fetcher, install, native };
  };
  afterEach(() => vi.unstubAllGlobals());
  it('routes a catalog from the embedded bridge into the same source-confirmation session', async () => {
    const f = setup();
    const input = (operation: string, url = catalogUrl) => ({
      action: INSTALLATION_ACTION,
      operation,
      presetId: 'team',
      catalogUrl: url,
    });
    await expect(
      f.service.external(input('open', 'https://other.example/catalog.json'), owner()),
    ).rejects.toThrow('INSTALLATION_SOURCE_DENIED');
    await expect(f.service.external(input('status'), owner())).resolves.toMatchObject({
      requiresSourceConfirmation: true,
    });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    const opened = (await f.service.external(input('open'), owner())) as { session: string };
    expect(await f.service.website(website(), sender())).toEqual(opened);
    expect(
      await f.service.internal(internal('inspect', opened.session), uiSender(opened.session)),
    ).toMatchObject({
      needsSourceConfirmation: true,
      sourceRequest: { catalogUrl, requestingPage: config.guide!.url },
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.native.capture).not.toHaveBeenCalled();
  });
  it('only discovers the confirmation requirement and opens an extension view before any catalog or local-service access', async () => {
    const f = setup();
    expect(await f.service.website(website('status'), sender())).toMatchObject({
      requiresSourceConfirmation: true,
      browserReady: false,
    });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    const opened = (await f.service.website(website(), sender())) as { session: string };
    expect(
      await f.service.internal(internal('inspect', opened.session), uiSender(opened.session)),
    ).toMatchObject({
      needsSourceConfirmation: true,
      sourceRequest: { catalogUrl, requestingPage: config.guide!.url },
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
    expect(f.native.capture).not.toHaveBeenCalled();
    expect(await f.service.website(website(), sender())).toEqual(opened);
    expect(chrome.tabs.create).toHaveBeenCalledOnce();
  });
  it.each([
    'http://guide.example.test/catalog.json',
    'https://attacker.test/catalog.json',
    'https://user:secret@guide.example.test/catalog.json',
    `${catalogUrl}?token=secret`,
    `${catalogUrl}#config`,
  ])('rejects a mismatched or noncanonical catalog before fetching %s', async source => {
    const f = setup();
    await expect(
      f.service.website(website('open', { catalogUrl: source }), sender()),
    ).rejects.toThrow('SOURCE_DENIED');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('requires both an extension-owned source confirmation and an explicit installation confirmation even with existing permissions', async () => {
    const f = setup();
    const { session } = (await f.service.website(website(), sender())) as { session: string };
    const ui = uiSender(session);
    await expect(f.service.internal(internal('install', session, true), ui)).rejects.toThrow(
      'SOURCE_CONFIRMATION_REQUIRED',
    );
    await expect(f.service.internal(internal('confirmSource', session), sender())).rejects.toThrow(
      'VIEW_REQUIRED',
    );
    await expect(
      f.service.internal(internal('confirmSource', session), {
        ...ui,
        tab: { id: 999 },
      } as chrome.runtime.MessageSender),
    ).rejects.toThrow('VIEW_REQUIRED');
    expect(f.fetcher).not.toHaveBeenCalled();
    const accepted = await f.service.internal(internal('confirmSource', session), ui);
    expect(accepted).toMatchObject({
      label: 'Team',
      source: config.presets!.team.source,
      sourceRequest: { catalogUrl },
      needsInstall: true,
    });
    expect(accepted).not.toHaveProperty('needsSourceConfirmation');
    expect(f.fetcher).toHaveBeenCalledWith(
      catalogUrl,
      expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
    );
    expect(f.install).not.toHaveBeenCalled();
    await expect(f.service.internal(internal('install', session), ui)).rejects.toThrow(
      'AUTHORIZATION_REQUIRED',
    );
    expect(f.install).not.toHaveBeenCalled();
    expect(await f.service.internal(internal('install', session, true), ui)).toMatchObject({
      browserReady: true,
      needsInstall: false,
    });
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.install).toHaveBeenCalledWith(
      config.presets!.team.source,
      'team',
      config.presets!.team.origins,
    );
  });
  it('requires catalog access and keeps a denied request retryable without fetching', async () => {
    const f = setup();
    grants = false;
    const { session } = (await f.service.website(website(), sender())) as { session: string };
    expect(await f.service.internal(internal('inspect', session), uiSender(session))).toMatchObject(
      { missingOrigins: ['https://guide.example.test/*'] },
    );
    await expect(
      f.service.internal(internal('confirmSource', session), uiSender(session)),
    ).rejects.toThrow('PERMISSION_REQUIRED');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.native.capture).not.toHaveBeenCalled();
    expect(records[`mearl-installation:${session}`].kind).toBe('source-request');
  });
  it.each(['guide', 'preset', 'document'])(
    'rejects a changed %s while reading a candidate catalog',
    async change => {
      const f = setup();
      const { session } = (await f.service.website(website(), sender())) as { session: string };
      if (change === 'guide') config.guide!.url = 'https://guide.example.test/other.html';
      if (change === 'preset') delete config.presets!.team;
      if (change === 'document')
        vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({
          url: topUrl,
          documentId: 'new-document',
        } as any);
      await expect(
        f.service.internal(internal('confirmSource', session), uiSender(session)),
      ).rejects.toThrow();
      expect(f.install).not.toHaveBeenCalled();
      expect(f.native.capture).not.toHaveBeenCalled();
      expect(records[`mearl-installation:${session}`].kind).toBe('source-request');
    },
  );
  it('pins the accepted catalog and rejects changes before installation', async () => {
    const f = setup();
    const { session } = (await f.service.website(website(), sender())) as { session: string };
    await f.service.internal(internal('confirmSource', session), uiSender(session));
    config.presets!.team.origins.push('https://new.example.test/*');
    await expect(
      f.service.internal(internal('install', session, true), uiSender(session)),
    ).rejects.toThrow('CATALOG_CHANGED');
    expect(f.install).not.toHaveBeenCalled();
  });
  it('cancels without fetching or installing and expires pending requests without restarting another installation', async () => {
    const f = setup();
    const { session } = (await f.service.website(website(), sender())) as { session: string };
    const ui = uiSender(session);
    await expect(f.service.internal(internal('cancel', session), ui)).resolves.toEqual({
      cancelled: true,
    });
    expect(records).toEqual({});
    const next = (await f.service.website(website(), sender())) as { session: string };
    const nextUi = uiSender(next.session);
    now += 16 * 60_000;
    await expect(
      f.service.internal(internal('confirmSource', next.session), nextUi),
    ).rejects.toThrow('SOURCE_EXPIRED');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
  });
});

describe('extension installation session', () => {
  it('recovers an expired automatic view from the installed trusted preset in the same tab', async () => {
    const native = {
      capture: vi.fn(async () => ({
        protocol: 1 as const,
        selection: 'a'.repeat(64),
        id: 'team',
        source: config.presets!.team.source,
      })),
      request: vi.fn(),
    };
    const service = createInstallationService({
      configuration: async () => config,
      registry: {
        installationStatus: async () => status,
        captureInstallationSelection: async () => structuredClone(selection),
      } as any,
      native,
      now: () => now,
    });
    const { session } = await openManaged(service);
    const sender = uiSender(session);
    now += 16 * 60_000;
    await expect(service.internal(internal('inspect', session), sender)).rejects.toThrow(
      'SESSION_EXPIRED',
    );
    const recovered = (await service.internal(internal('restart', session), sender)) as {
      session: string;
    };
    expect(recovered.session).not.toBe(session);
    expect(records[`mearl-installation:${recovered.session}`]).toMatchObject({
      presetId: 'team',
      viewTabId: sender.tab!.id,
      nativeSelection: 'a'.repeat(64),
    });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(native.request).not.toHaveBeenCalled();
    const updatedSender = {
      ...sender,
      url: `chrome-extension://installed-extension/${INSTALLATION_VIEW_PATH}?session=${recovered.session}`,
    };
    await expect(
      service.internal(internal('inspect', recovered.session), updatedSender),
    ).resolves.toMatchObject({ needsInstall: true });
  });
  it('cannot recover arbitrary or untrusted presets or recover from a child frame', async () => {
    const { service, install } = make();
    const { session } = await openManaged(service);
    const sender = uiSender(session);
    await expect(service.internal(internal('restart', session), sender)).rejects.toThrow(
      'PRESET_UNAVAILABLE',
    );
    status = { ...status, presetId: 'team', presetSource: 'https://attacker.test/team.json' };
    await expect(service.internal(internal('restart', session), sender)).rejects.toThrow(
      'PRESET_UNAVAILABLE',
    );
    await expect(
      service.internal({ ...internal('restart', session), presetId: 'team' }, sender),
    ).rejects.toThrow('INVALID_INSTALLATION_REQUEST');
    await expect(
      service.internal(internal('restart', session), { ...sender, frameId: 1 }),
    ).rejects.toThrow('VIEW_REQUIRED');
    expect(install).not.toHaveBeenCalled();
  });
  it('shows the accepted authorization preview offline but revalidates the catalog before installation', async () => {
    const configuration = vi.fn(async () => structuredClone(config));
    const install = vi.fn();
    const service = createInstallationService({
      configuration,
      registry: {
        installationStatus: async () => status,
        captureInstallationSelection: async () => structuredClone(selection),
      } as any,
      install,
      now: () => now,
    });
    const { session } = await openManaged(service);
    configuration.mockRejectedValue(new Error('Failed to fetch'));
    grants = false;
    await expect(
      service.internal(internal('inspect', session), uiSender(session)),
    ).resolves.toMatchObject({ label: 'Team', missingOrigins: config.presets!.team.origins });
    await expect(
      service.internal(internal('install', session, true), uiSender(session)),
    ).rejects.toThrow('Failed to fetch');
    expect(install).not.toHaveBeenCalled();
  });
  it('accepts Chrome storage key ordering without weakening catalog identity checks', async () => {
    const { service } = make();
    const { session } = await openManaged(service);
    const record = records[`mearl-installation:${session}`];
    record.preset = {
      label: record.preset.label,
      origins: record.preset.origins,
      source: record.preset.source,
    };
    await expect(
      service.internal(internal('inspect', session), uiSender(session)),
    ).resolves.toMatchObject({ needsInstall: true });
    record.preset.origins = ['https://attacker.test/*'];
    await expect(service.internal(internal('inspect', session), uiSender(session))).rejects.toThrow(
      'CATALOG_CHANGED',
    );
  });
  it('allows only its allocated top-level extension view', async () => {
    const { service, install } = make();
    const { session } = await openManaged(service);
    const sender = uiSender(session);
    for (const patch of [
      { url: 'https://guide.example.test/' },
      { url: 'chrome-extension://installed-extension/popup.html' },
      { tab: { id: 500 } },
      { frameId: 3 },
    ]) {
      await expect(
        service.internal(internal('install', session), {
          ...sender,
          ...patch,
        } as chrome.runtime.MessageSender),
      ).rejects.toThrow('VIEW_REQUIRED');
    }
    expect(install).not.toHaveBeenCalled();
    await expect(service.internal(internal('install', session), sender)).resolves.toMatchObject({
      browserReady: true,
      needsInstall: false,
    });
  });
  it('requires browser grants and explicit Agent authorization before changing stored domains', async () => {
    const { service, install } = make();
    const { session } = await openManaged(service);
    const sender = uiSender(session);
    agent.allowed = [];
    expect(await service.internal(internal('inspect', session), sender)).toMatchObject({
      missingAuthorization: config.presets!.team.origins,
    });
    await expect(service.internal(internal('install', session), sender)).rejects.toThrow(
      'AUTHORIZATION_REQUIRED',
    );
    grants = false;
    await expect(service.internal(internal('install', session, true), sender)).rejects.toThrow(
      'PERMISSION_REQUIRED',
    );
    expect(agent.allowed).toEqual([]);
    expect(install).not.toHaveBeenCalled();
    grants = true;
    await service.internal(internal('install', session, true), sender);
    expect(agent.allowed).toEqual(
      config.presets!.team.origins.map(origin => origin.replace(/^(?:https?|\*):/, '*:')),
    );
  });
  it('does not restore authorization revoked after an automatic request was accepted', async () => {
    const { service, install } = make();
    const { session } = await openManaged(service);
    agent.allowed = [];
    vi.mocked(getAgentAllowedOrigins).mockResolvedValueOnce(config.presets!.team.origins);
    await expect(service.internal(internal('install', session), uiSender(session))).rejects.toThrow(
      'AUTHORIZATION_REQUIRED',
    );
    expect(agent.allowed).toEqual([]);
    expect(install).not.toHaveBeenCalled();
  });
  it('deduplicates a live install and preserves a completed receipt across worker recreation', async () => {
    let complete!: () => void;
    const install = vi.fn(
      () =>
        new Promise<void>(resolve => {
          complete = () => {
            status = {
              ...status,
              browserReady: true,
              presetId: 'team',
              presetSource: config.presets!.team.source,
            };
            resolve();
          };
        }),
    );
    const { service } = make(install);
    const { session } = await openManaged(service);
    const sender = uiSender(session);
    const first = service.internal(internal('install', session), sender);
    const second = service.internal(internal('install', session), sender);
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    complete();
    await Promise.all([first, second]);
    const recreated = make().service;
    await expect(recreated.internal(internal('inspect', session), sender)).resolves.toMatchObject({
      browserReady: true,
      needsInstall: false,
    });
    status.browserReady = false;
    await expect(recreated.internal(internal('inspect', session), sender)).resolves.toMatchObject({
      browserReady: false,
      needsInstall: false,
    });
  });
  it('pins the selection before work and never re-applies a completed session', async () => {
    const { service, install } = make();
    const { session } = await openManaged(service);
    const sender = uiSender(session);
    selection.installationToken = 'a'.repeat(64);
    await expect(service.internal(internal('inspect', session), sender)).rejects.toThrow(
      'SELECTION_CHANGED',
    );
    await expect(service.internal(internal('install', session), sender)).rejects.toThrow(
      'SELECTION_CHANGED',
    );
    expect(install).not.toHaveBeenCalled();
    await openManaged(service, 'team', sender);
    await service.internal(internal('install', session), sender);
    selection.activeRevision = 'b'.repeat(64);
    status.presetId = 'other';
    expect(await service.internal(internal('inspect', session), sender)).toMatchObject({
      needsInstall: false,
      browserReady: false,
    });
    expect(await service.internal(internal('install', session), sender)).toMatchObject({
      needsInstall: false,
      browserReady: false,
    });
    expect(install).toHaveBeenCalledTimes(1);
  });
  it('keeps authorization grants from concurrent installation views', async () => {
    config.presets!.second = {
      label: 'Second',
      source: 'https://second.test/preset.json',
      origins: ['https://second.test/*'],
    };
    agent.allowed = [];
    const { service } = make();
    const one = await openManaged(service);
    const two = await openManaged(service, 'second');
    await Promise.all([
      service.internal(internal('install', one.session, true), uiSender(one.session)),
      service.internal(internal('install', two.session, true), uiSender(two.session)),
    ]);
    expect(agent.allowed).toEqual(
      [...config.presets!.team.origins, ...config.presets!.second.origins].map(origin =>
        origin.replace(/^(?:https?|\*):/, '*:'),
      ),
    );
  });
  it('expires sessions and rejects catalog changes before installation', async () => {
    const { service, install } = make();
    const { session } = await openManaged(service);
    const sender = uiSender(session);
    config.presets!.team.source = 'https://guide.example.test/changed.json';
    await expect(service.internal(internal('install', session), sender)).rejects.toThrow(
      'CATALOG_CHANGED',
    );
    now += 16 * 60_000;
    await expect(service.internal(internal('install', session), sender)).rejects.toThrow(
      'SESSION_EXPIRED',
    );
    expect(records).toEqual({});
    expect(install).not.toHaveBeenCalled();
  });
});

describe('catalog resource and commit authority', () => {
  const realDownload = async (resource?: string, beforeConfirm?: () => void) => {
    const committed = vi.fn();
    vi.mocked(createBrowserCapabilityRegistry).mockImplementation(
      (_store, load) =>
        ({
          applyPreset: async (input: any) => {
            expect(input.expectedSelection).toEqual(selection);
            await load(resource ?? config.presets!.team.source, { maxBytes: 4096 });
            beforeConfirm?.();
            await input.confirm();
            committed();
            status = {
              ...status,
              browserReady: true,
              presetId: 'team',
              presetSource: config.presets!.team.source,
            };
            return { pending: [] };
          },
        }) as any,
    );
    const service = createInstallationService({
      configuration: async () => structuredClone(config),
      registry: {
        installationStatus: async () => status,
        captureInstallationSelection: async () => structuredClone(selection),
      } as any,
    });
    const { session } = await openManaged(service);
    const request = service.internal(internal('install', session), uiSender(session));
    return { request, committed };
  };
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    'http://guide.example.test/preset.json',
    'https://attacker.test/preset.json',
    'https://user:secret@guide.example.test/preset.json',
  ])('rejects an undeclared resource before fetch %s', async resource => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { request, committed } = await realDownload(resource);
    await expect(request).rejects.toThrow('RESOURCE_DENIED');
    expect(fetcher).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });
  it('does not expand an HTTP catalog scope into HTTPS even when Chrome already permits it', async () => {
    config.presets!.team.origins.push('http://legacy.test/*');
    agent.all = true;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { request } = await realDownload('https://legacy.test/bundle.json');
    await expect(request).rejects.toThrow('RESOURCE_DENIED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['catalog', 'permission'])(
    'confirms the accepted catalog and permissions immediately before activation: %s',
    async change => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}')),
      );
      const { request, committed } = await realDownload(undefined, () => {
        if (change === 'catalog')
          config.presets!.team.source = 'https://guide.example.test/new.json';
        else grants = false;
      });
      await expect(request).rejects.toThrow(
        change === 'catalog' ? 'CATALOG_CHANGED' : 'PERMISSION_CHANGED',
      );
      expect(committed).not.toHaveBeenCalled();
    },
  );
});

describe('attached native installation', () => {
  const receipt = 'a'.repeat(64);
  const setup = (
    apply: (data: any) => Promise<any>,
    nativeStatus: () => any = () => ({
      id: 'team',
      revision: receipt,
      ready: true,
      browserSyncRequired: true,
    }),
  ) => {
    const native = {
      capture: vi.fn(async () => ({ protocol: 1 as const, selection: null })),
      request: vi.fn(async data =>
        ['apply', 'resume'].includes(data.operation) ? apply(data) : nativeStatus(),
      ),
    };
    const service = createInstallationService({
      configuration: async () => structuredClone(config),
      registry: {
        installationStatus: async () => status,
        captureInstallationSelection: async () => structuredClone(selection),
      } as any,
      native,
      now: () => now,
    });
    return { native, service };
  };
  afterEach(() => vi.unstubAllGlobals());
  it.each(['SKILL_PLUGIN_REGISTRATION_CONFLICT', 'SKILL_PLUGIN_REGISTRATION_REQUIRED'])(
    'allows explicit replacement for a current registration issue: %s',
    async reason => {
      const f = setup(
        async () => {
          status = {
            ...status,
            presetId: 'team',
            presetSource: config.presets!.team.source,
            browserReady: true,
          };
          return { id: 'team', revision: receipt };
        },
        () => ({
          id: 'team',
          revision: receipt,
          ready: false,
          hosts: [{ state: 'active' }],
          pending: [{ runtime: 'node', id: 'helper', reason }],
        }),
      );
      const opened = await openManaged(f.service);
      const ui = uiSender(opened.session);
      await f.service.internal(internal('install', opened.session), ui);
      await f.service.internal(
        { ...internal('retry', opened.session, true), replaceSkills: ['helper'] },
        ui,
      );
      expect(f.native.request).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'resume', replaceSkills: ['helper'] }),
        expect.any(Number),
      );
    },
  );
  it('forwards only explicitly confirmed pending Skill conflicts on a retry and does not persist replacement authority', async () => {
    const f = setup(
      async () => {
        status = {
          ...status,
          presetId: 'team',
          presetSource: config.presets!.team.source,
          browserReady: true,
        };
        return { id: 'team', revision: receipt };
      },
      () => ({
        id: 'team',
        revision: receipt,
        ready: false,
        hosts: [{ state: 'active' }],
        pending: [{ runtime: 'node', id: 'helper', reason: 'SKILL_SOURCE_CONFLICT' }],
      }),
    );
    const opened = await openManaged(f.service);
    const ui = uiSender(opened.session);
    await f.service.internal(internal('install', opened.session), ui);
    await expect(
      f.service.internal(
        { ...internal('install', opened.session, true), replaceSkills: ['helper'] },
        ui,
      ),
    ).rejects.toThrow('INVALID_INSTALLATION_REQUEST');
    await expect(
      f.service.internal({ ...internal('retry', opened.session), replaceSkills: ['helper'] }, ui),
    ).rejects.toThrow('INVALID_INSTALLATION_REQUEST');
    await expect(
      f.service.internal(
        { ...internal('retry', opened.session, true), replaceSkills: ['other'] },
        ui,
      ),
    ).rejects.toThrow('INVALID_SKILL_REPLACEMENT_SELECTION');
    await f.service.internal(
      { ...internal('retry', opened.session, true), replaceSkills: ['helper'] },
      ui,
    );
    expect(f.native.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'resume',
        replaceSkills: ['helper'],
        expectedRevision: receipt,
      }),
      expect.any(Number),
    );
    expect(records[`mearl-installation:${opened.session}`]).not.toHaveProperty('replaceSkills');
    await f.service.internal(internal('retry', opened.session, true), ui);
    const resumes = f.native.request.mock.calls.filter(([data]) => data.operation === 'resume');
    expect(resumes.at(-1)![0]).not.toHaveProperty('replaceSkills');
  });
  it('reports local component reasons without treating another browser grant as a local failure', async () => {
    let pending = [
      { runtime: 'browser', id: 'browser-module', reason: 'BROWSER_SYNC_REQUIRED' },
      { runtime: 'node', id: 'existing-skill', reason: 'SKILL_SOURCE_CONFLICT' },
    ];
    const f = setup(
      async () => {
        status = {
          ...status,
          presetId: 'team',
          presetSource: config.presets!.team.source,
          browserReady: true,
        };
        return { id: 'team', revision: receipt };
      },
      () => ({
        id: 'team',
        revision: receipt,
        ready: false,
        hosts: [{ state: 'active' }],
        pending,
      }),
    );
    const opened = await openManaged(f.service);
    await expect(
      f.service.internal(internal('install', opened.session), uiSender(opened.session)),
    ).resolves.toMatchObject({
      localStatus: 'pending',
      localIssues: [{ id: 'existing-skill', reason: 'SKILL_SOURCE_CONFLICT' }],
    });
    pending = pending.filter(entry => entry.runtime === 'browser');
    await expect(
      f.service.internal(internal('inspect', opened.session), uiSender(opened.session)),
    ).resolves.toMatchObject({ localStatus: 'ready', localIssues: [], ready: true });
  });
  it('reads each resource once in bounded chunks and releases the captured scope after installation', async () => {
    const bytes = new Uint8Array(150_000).fill(97);
    const fetcher = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    let captured!: string;
    const f = setup(async data => {
      captured = data.session;
      expect(data.expectedRevision).toBe(null);
      const first = (await service.native(
        {
          operation: 'resource',
          session: data.session,
          source: config.presets!.team.source,
          offset: 0,
          maxBytes: bytes.byteLength,
        },
        vi.fn(),
      )) as any;
      const second = (await service.native(
        {
          operation: 'resource',
          session: data.session,
          source: config.presets!.team.source,
          offset: 131072,
          maxBytes: bytes.byteLength,
        },
        vi.fn(),
      )) as any;
      expect(atob(first.data)).toHaveLength(131072);
      expect(atob(second.data)).toHaveLength(18928);
      await service.native({ operation: 'confirm', session: data.session }, vi.fn());
      status = {
        ...status,
        presetId: 'team',
        presetSource: config.presets!.team.source,
        browserReady: true,
      };
      return { id: 'team', revision: receipt };
    });
    const { service } = f;
    const opened = await openManaged(service);
    expect(
      await service.internal(internal('install', opened.session), uiSender(opened.session)),
    ).toMatchObject({ ready: true, localStatus: 'ready' });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(
      service.native(
        {
          operation: 'resource',
          session: captured,
          source: config.presets!.team.source,
          offset: 0,
          maxBytes: bytes.byteLength,
        },
        vi.fn(),
      ),
    ).rejects.toThrow('SESSION_EXPIRED');
  });
  it('resumes the same session after Node commit and temporary browser synchronization failure', async () => {
    const module = await import('../browserPresetSync');
    let failed = false;
    const sync = vi
      .spyOn(module, 'synchronizeBrowserPreset')
      .mockImplementation(async (_input, _transport, _registry, accepted) => {
        await accepted?.confirm();
        if (!failed) {
          failed = true;
          return { ...status, ready: false, accepted: false, error: 'temporarily unavailable' };
        }
        selection.activeRevision = 'b'.repeat(64);
        selection.installationToken = 'c'.repeat(64);
        status = {
          ...status,
          browserReady: true,
          ready: true,
          presetId: 'team',
          presetSource: config.presets!.team.source,
        };
        return status;
      });
    try {
      const f = setup(async data => {
        const result = (await service.native(
          { operation: 'sync', session: data.session, installationRevision: receipt },
          vi.fn(),
        )) as any;
        if (result.accepted === false) throw new Error('Browser activation rejected');
        return { id: 'team', revision: receipt };
      });
      const { service } = f;
      const opened = await openManaged(service);
      await expect(
        service.internal(internal('install', opened.session), uiSender(opened.session)),
      ).rejects.toThrow('Browser activation rejected');
      expect(records[`mearl-installation:${opened.session}`].nativeSelection).toBe(receipt);
      expect(
        await service.internal(internal('inspect', opened.session), uiSender(opened.session)),
      ).toMatchObject({ needsInstall: true });
      expect(
        await service.internal(internal('install', opened.session), uiSender(opened.session)),
      ).toMatchObject({ ready: true, localStatus: 'ready' });
      expect(
        f.native.request.mock.calls
          .filter(([data]) => ['apply', 'resume'].includes(data.operation))
          .map(([data]) => data.expectedRevision),
      ).toEqual([null, receipt]);
    } finally {
      sync.mockRestore();
    }
  });
  it('retains Node-only success without modifying an independent browser selection', async () => {
    status = {
      ...status,
      browserReady: true,
      presetId: 'independent',
      presetSource: 'https://independent.test/preset.json',
    };
    selection.activeRevision = 'b'.repeat(64);
    let disconnected = false;
    const f = setup(
      async () => ({
        id: 'team',
        revision: receipt,
        browserSyncRequired: false,
        localComponentCount: 1,
      }),
      () => {
        if (disconnected) throw new Error('Native host has exited.');
        return { id: 'team', revision: receipt, ready: true, browserSyncRequired: false };
      },
    );
    const opened = await openManaged(f.service);
    expect(
      await f.service.internal(internal('install', opened.session), uiSender(opened.session)),
    ).toMatchObject({
      ready: true,
      browserReady: false,
      browserRequired: false,
      localStatus: 'ready',
    });
    expect(selection.activeRevision).toBe('b'.repeat(64));
    expect(status.presetId).toBe('independent');
    disconnected = true;
    expect(
      await f.service.internal(internal('inspect', opened.session), uiSender(opened.session)),
    ).toMatchObject({
      ready: false,
      browserReady: false,
      browserRequired: false,
      localStatus: 'setup-required',
      localComponentCount: 1,
    });
  });
  it('does not restore a local installation whose receipt was replaced elsewhere', async () => {
    let replaced = false;
    const f = setup(
      async () => {
        status = {
          ...status,
          browserReady: true,
          presetId: 'team',
          presetSource: config.presets!.team.source,
        };
        return { id: 'team', revision: receipt };
      },
      () =>
        replaced
          ? { ready: false, changed: true }
          : { id: 'team', revision: receipt, ready: false, browserSyncRequired: true },
    );
    const opened = await openManaged(f.service);
    expect(
      await f.service.internal(internal('install', opened.session), uiSender(opened.session)),
    ).toMatchObject({ localStatus: 'pending' });
    replaced = true;
    await expect(
      f.service.internal(
        { ...internal('install', opened.session), operation: 'retry' },
        uiSender(opened.session),
      ),
    ).rejects.toThrow('SELECTION_CHANGED');
    expect(f.native.request.mock.calls.filter(([data]) => data.operation === 'apply')).toHaveLength(
      1,
    );
  });
});

describe('trusted automatic preset updates', () => {
  beforeEach(() => {
    const local: Record<string, unknown> = {};
    chrome.storage.local = {
      get: vi.fn(async key => ({ [key]: local[key] })),
      set: vi.fn(async patch => {
        Object.assign(local, patch);
      }),
      remove: vi.fn(async key => {
        delete local[key];
      }),
    } as any;
  });
  const installed = () => {
    selection.activeRevision = 'a'.repeat(64);
    status = {
      ...status,
      presetId: 'team',
      presetSource: config.presets!.team.source,
      browserReady: true,
    };
  };
  it('updates an installed browser preset without opening a tab or promoting it to Node installation', async () => {
    installed();
    const install = vi.fn(async () => {
      selection.activeRevision = 'b'.repeat(64);
    });
    const native = {
      capture: vi.fn(async () => ({ protocol: 1 as const, selection: null })),
      request: vi.fn(),
    };
    const service = createInstallationService({
      configuration: async () => config,
      registry: {
        installationStatus: async () => status,
        captureInstallationSelection: async () => structuredClone(selection),
      } as any,
      install,
      native,
      now: () => now,
    });
    expect(await service.autoUpdate()).toMatchObject({ status: 'updated', id: 'team' });
    expect(native.request).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith(
      config.presets!.team.source,
      'team',
      config.presets!.team.origins,
    );
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(Object.keys(records)).toEqual([]);
  });
  it('does not choose a recommended preset or trust a same-name arbitrary source', async () => {
    const f = make();
    expect(await f.service.autoUpdate()).toEqual({ status: 'skipped' });
    installed();
    status.presetSource = 'https://other.example.test/presets/team.json';
    expect(await f.service.autoUpdate()).toMatchObject({ status: 'untrusted' });
    expect(f.install).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('keeps a shared browser snapshot when its Native Host is unavailable', async () => {
    installed();
    status.installationRevision = 'c'.repeat(64);
    const f = make();
    expect(await f.service.autoUpdate()).toMatchObject({ status: 'waiting-native' });
    expect(f.install).not.toHaveBeenCalled();
  });
  it('stops before installation for new grants and opens one background authorization view', async () => {
    installed();
    grants = false;
    const f = make();
    expect(await f.service.autoUpdate()).toMatchObject({ status: 'permission-required' });
    expect(await f.service.autoUpdate()).toMatchObject({ status: 'permission-required' });
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ active: false }),
    );
    expect(f.install).not.toHaveBeenCalled();
    expect(selection.activeRevision).toBe('a'.repeat(64));
  });
  it('updates a matching installed native preset through its captured selection', async () => {
    installed();
    status.installationRevision = 'c'.repeat(64);
    const native = {
      capture: vi.fn(async () => ({
        protocol: 1 as const,
        selection: 'c'.repeat(64),
        id: 'team',
        source: config.presets!.team.source,
      })),
      request: vi.fn(async data =>
        data.operation === 'update'
          ? { id: 'team', revision: 'd'.repeat(64) }
          : { ready: true, id: 'team', revision: 'd'.repeat(64) },
      ),
    };
    const service = createInstallationService({
      configuration: async () => config,
      registry: {
        installationStatus: async () => status,
        captureInstallationSelection: async () => structuredClone(selection),
      } as any,
      native,
      now: () => now,
    });
    expect(await service.autoUpdate()).toMatchObject({ status: 'updated' });
    expect(native.request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'update', expectedRevision: 'c'.repeat(64) }),
      expect.any(Number),
    );
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

it('does not replace a newer browser selection accepted while loading the update catalog', async () => {
  selection.activeRevision = 'a'.repeat(64);
  status = {
    ...status,
    presetId: 'team',
    presetSource: config.presets!.team.source,
    browserReady: true,
  };
  const install = vi.fn();
  const service = createInstallationService({
    configuration: async () => {
      selection.activeRevision = 'b'.repeat(64);
      return config;
    },
    registry: {
      installationStatus: async () => status,
      captureInstallationSelection: async () => structuredClone(selection),
    } as any,
    install,
  });
  expect(await service.autoUpdate()).toMatchObject({ status: 'skipped' });
  expect(install).not.toHaveBeenCalled();
});
