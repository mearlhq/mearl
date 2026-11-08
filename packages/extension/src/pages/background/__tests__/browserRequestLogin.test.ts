import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { authorize } = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('../browserCapabilities', () => ({ authorizeBrowserCapabilityUrl: authorize }));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const sender = (documentId = 'doc-a') => ({
  id: extensionId,
  url: `chrome-extension://${extensionId}/popup.html`,
  documentId,
});
const key = 'browser-request-login-leases';
let stored: Record<string, any>;
let rules: Map<number, any>;
let documents: Set<string>;
let connect: (port: any) => void;
const disconnections = new Map<string, () => void>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  disconnections.clear();
  stored = {};
  rules = new Map([[42, { id: 42, action: {}, condition: {} }]]);
  documents = new Set(['doc-a', 'doc-b']);
  authorize.mockImplementation(async (input: string) => new URL(input));
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('chrome', {
    runtime: {
      id: extensionId,
      getContexts: vi.fn(async (filter: any) =>
        [...documents]
          .filter(documentId => !filter.documentIds || filter.documentIds.includes(documentId))
          .map(documentId => ({ documentId })),
      ),
      onConnect: {
        addListener: vi.fn(fn => {
          connect = fn;
        }),
      },
    },
    storage: {
      session: {
        get: vi.fn(async () => structuredClone(stored)),
        set: vi.fn(async value => {
          Object.assign(stored, structuredClone(value));
        }),
      },
    },
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
      HeaderOperation: { REMOVE: 'remove' },
      ResourceType: { MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame' },
      getSessionRules: vi.fn(async () => structuredClone([...rules.values()])),
      updateSessionRules: vi.fn(async ({ removeRuleIds = [], addRules = [] }) => {
        const next = new Map(rules);
        for (const id of removeRuleIds) next.delete(id);
        for (const rule of addRules) {
          if (next.has(rule.id)) throw new Error('Duplicate DNR rule');
          next.set(rule.id, structuredClone(rule));
        }
        rules = next;
      }),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fixture() {
  const api = await import('../browserRequestLogin');
  api.initializeBrowserRequestLogins();
  return {
    ...api,
    openBrowserRequestLogin: (url: string, from: chrome.runtime.MessageSender) => {
      const id = webcrypto.randomUUID();
      connect({
        name: 'browser-request-login:' + id,
        sender: from,
        postMessage: vi.fn(),
        onDisconnect: {
          addListener: (fn: () => void) => {
            disconnections.set(id, fn);
          },
        },
      });
      return api.openBrowserRequestLogin(url, from, id);
    },
  };
}
function loginRules() {
  return [...rules.values()].filter(rule => rule.id >= 1_000_000 && rule.id <= 1_000_127);
}

it('shares a rule for the same accepted origin and releases it only after the last document closes', async () => {
  const api = await fixture();
  const first = await api.openBrowserRequestLogin('https://example.com/login', sender());
  const second = await api.openBrowserRequestLogin('https://example.com/other', sender('doc-b'));
  expect(first).not.toBe(second);
  expect(loginRules()).toHaveLength(1);
  expect(loginRules()[0]).toMatchObject({
    priority: 10,
    condition: { urlFilter: '|https://example.com/', resourceTypes: ['main_frame', 'sub_frame'] },
  });
  expect(loginRules()[0].action.responseHeaders).toHaveLength(3);
  await api.closeBrowserRequestLogin(first, sender());
  expect(loginRules()).toHaveLength(1);
  await api.closeBrowserRequestLogin(second, sender('doc-b'));
  expect(loginRules()).toHaveLength(0);
  expect(rules.has(42)).toBe(true);
});
it('retains an accepted old origin across provider changes and a worker restart', async () => {
  const firstWorker = await fixture();
  const old = await firstWorker.openBrowserRequestLogin('https://old.example.com/login', sender());
  await firstWorker.openBrowserRequestLogin('https://new.example.com/login', sender('doc-b'));
  expect(loginRules()).toHaveLength(2);
  vi.resetModules();
  const secondWorker = await fixture();
  await secondWorker.closeBrowserRequestLogin(old, sender());
  expect(loginRules().map(rule => rule.condition.urlFilter)).toEqual(['|https://new.example.com/']);
});
it('rejects foreign UI/content-script owners without removing another document lease', async () => {
  const api = await fixture();
  const id = await api.openBrowserRequestLogin('https://example.com/', sender());
  await expect(api.closeBrowserRequestLogin(id, sender('doc-b'))).rejects.toThrow(
    'another extension document',
  );
  expect(() =>
    api.openBrowserRequestLogin('https://example.com/', {
      ...sender(),
      url: 'https://example.com/',
    }),
  ).toThrow('extension document');
  expect(loginRules()).toHaveLength(1);
});
it('cleans closed documents and permission revocations while preserving other rules', async () => {
  const api = await fixture();
  await api.openBrowserRequestLogin('https://old.example.com/', sender());
  documents.delete('doc-a');
  await api.openBrowserRequestLogin('https://new.example.com/', sender('doc-b'));
  expect(loginRules().map(rule => rule.condition.urlFilter)).toEqual(['|https://new.example.com/']);
  authorize.mockImplementation(async (url: string) => {
    if (url === 'https://new.example.com')
      throw Object.assign(new Error('Revoked'), { code: 'BROWSER_PERMISSION_REQUIRED' });
    return new URL(url);
  });
  const lease = stored[key][0];
  await api.closeBrowserRequestLogin(lease.id, sender('doc-b'));
  expect(loginRules()).toHaveLength(0);
  expect(rules.has(42)).toBe(true);
});
it('preserves accepted rules on a transient permission-service failure', async () => {
  const api = await fixture();
  await api.openBrowserRequestLogin('https://old.example.com/', sender());
  authorize.mockImplementation(async (url: string) => {
    if (url === 'https://old.example.com') throw new Error('Storage unavailable');
    return new URL(url);
  });
  await expect(
    api.openBrowserRequestLogin('https://new.example.com/', sender('doc-b')),
  ).rejects.toThrow('Storage unavailable');
  expect(loginRules().map(rule => rule.condition.urlFilter)).toEqual(['|https://old.example.com/']);
  expect(stored[key]).toHaveLength(1);
});
it('restores previous rules if saving the new lease fails', async () => {
  const api = await fixture();
  await api.openBrowserRequestLogin('https://old.example.com/', sender());
  vi.mocked(chrome.storage.session.set).mockImplementation(async value => {
    if ((value as Record<string, any>)[key].length === 2) throw new Error('Storage full');
    Object.assign(stored, structuredClone(value));
  });
  await expect(
    api.openBrowserRequestLogin('https://new.example.com/', sender('doc-b')),
  ).rejects.toThrow('Storage full');
  expect(loginRules().map(rule => rule.condition.urlFilter)).toEqual(['|https://old.example.com/']);
  expect(stored[key]).toHaveLength(1);
});
it('does not create a lease after its requesting document has closed', async () => {
  const api = await fixture();
  vi.mocked(chrome.runtime.getContexts).mockImplementation(async filter =>
    filter.documentIds ? [] : ([...documents].map(documentId => ({ documentId })) as never),
  );
  await expect(api.openBrowserRequestLogin('https://example.com/', sender())).rejects.toThrow(
    'document has closed',
  );
  expect(loginRules()).toHaveLength(0);
});
it('releases a document lease when its lifetime port disconnects', async () => {
  const api = await fixture();
  api.initializeBrowserRequestLogins();
  const id = await api.openBrowserRequestLogin('https://example.com/', sender());
  let disconnected!: () => void;
  connect({
    name: 'browser-request-login:' + id,
    sender: sender(),
    postMessage: vi.fn(),
    onDisconnect: {
      addListener: (fn: () => void) => {
        disconnected = fn;
      },
    },
  });
  disconnected();
  await vi.waitFor(() => expect(loginRules()).toHaveLength(0));
});

it('cleans an open whose document closes while DNR is being committed', async () => {
  const api = await fixture();
  const update = chrome.declarativeNetRequest.updateSessionRules;
  vi.mocked(update).mockImplementation(async changes => {
    for (const id of changes.removeRuleIds ?? []) rules.delete(id);
    for (const rule of changes.addRules ?? []) rules.set(rule.id, rule);
    if (changes.addRules?.some(rule => rule.condition.urlFilter === '|https://example.com/'))
      documents.delete('doc-a');
  });
  await expect(api.openBrowserRequestLogin('https://example.com/', sender())).rejects.toThrow(
    'document has closed',
  );
  expect(loginRules()).toHaveLength(0);
  expect(stored[key]).toHaveLength(0);
});
it('releases an explicitly closed lease even when another origin cannot be reauthorized', async () => {
  const api = await fixture();
  const first = await api.openBrowserRequestLogin('https://first.example.com/', sender());
  await api.openBrowserRequestLogin('https://second.example.com/', sender('doc-b'));
  authorize.mockRejectedValue(new Error('Permission storage unavailable'));
  await api.closeBrowserRequestLogin(first, sender());
  expect(loginRules().map(rule => rule.condition.urlFilter)).toEqual([
    '|https://second.example.com/',
  ]);
});
it('reconnects the same accepted lease after a worker restart and releases on document close', async () => {
  const api = await fixture();
  const id = await api.openBrowserRequestLogin('https://example.com/', sender());
  vi.resetModules();
  await fixture();
  let disconnected!: () => void;
  connect({
    name: 'browser-request-login:' + id,
    sender: sender(),
    postMessage: vi.fn(),
    onDisconnect: {
      addListener: (fn: () => void) => {
        disconnected = fn;
      },
    },
  });
  documents.delete('doc-a');
  disconnected();
  await vi.waitFor(() => expect(loginRules()).toHaveLength(0));
});

it('binds a DevTools login port and releases its rules when documentId is unavailable', async () => {
  const token = '75ece965-9526-42c5-8d74-c931779c3090';
  const id = webcrypto.randomUUID();
  const from = { id: extensionId, url: `chrome-extension://${extensionId}/panel.html` };
  chrome.runtime.getURL = path => `chrome-extension://${extensionId}/${path}`;
  chrome.runtime.sendMessage = vi.fn(async () => ({ url: from.url })) as any;
  const api = await import('../browserRequestLogin');
  const { resolveBrowserDocumentSender } = await import('../browserDocuments');
  api.initializeBrowserRequestLogins();
  const postMessage = vi.fn();
  const disconnectListeners: Array<() => void> = [];
  connect({ name: 'browser-request-login:' + id + ':' + token, sender: from, postMessage, disconnect: vi.fn(), onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) } });
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ ready: true }));
  const owner = await resolveBrowserDocumentSender(from, token);
  await api.openBrowserRequestLogin('https://example.com/login', owner, id);
  expect(loginRules()).toHaveLength(1);
  for (const listener of disconnectListeners) listener();
  await vi.waitFor(() => expect(loginRules()).toHaveLength(0));
});
