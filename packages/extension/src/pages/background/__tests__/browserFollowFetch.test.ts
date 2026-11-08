import { beforeEach, expect, it, vi } from 'vitest';
const policy = vi.hoisted(() => ({ domains: vi.fn(), all: vi.fn() }));
vi.mock('../../../shared/proxyPermissions', () => ({ getAgentAllowedOrigins: policy.domains, getAgentAllowAllDomains: policy.all, PROXY_PERMISSION_STORAGE_KEY: 'origins', DISABLED_BUILTIN_ORIGINS_STORAGE_KEY: 'disabled', AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY: 'all' }));
import { fetchWithBrowserRedirects } from '../browserFollowFetch';
let ready: (value: unknown) => void;
let disconnected: () => void;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let removed: () => void;
let port: any;
let requestId: string;
const input = { url: 'https://query.example.test/', method: 'GET', headers: {}, credentials: 'include' as const };
beforeEach(() => {
  policy.domains.mockReset().mockResolvedValue(['*://query.example.test/*']); policy.all.mockReset().mockResolvedValue(false);
  port = { disconnect: vi.fn(), onMessage: { addListener: vi.fn(fn => { ready = fn; }), removeListener: vi.fn() }, onDisconnect: { addListener: vi.fn(fn => { disconnected = fn; }) } };
  chrome.runtime.connect = vi.fn((options: any) => { requestId = options.name.split(':')[1]; return port; }) as any;
  vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue({ success: true, value: { ok: true, status: 200, body: 'owned' } });
  chrome.permissions = { getAll: vi.fn(async () => ({ origins: ['https://query.example.test/*'] })), onRemoved: { addListener: vi.fn(fn => { removed = fn; }), removeListener: vi.fn() } } as any;
  chrome.storage.onChanged = { addListener: vi.fn(fn => { changed = fn; }), removeListener: vi.fn() } as any;
});
async function open() {
  const controller = new AbortController(), result = fetchWithBrowserRedirects(input, controller.signal);
  await vi.waitFor(() => expect(port.onMessage.addListener).toHaveBeenCalledOnce());
  return { controller, result };
}
it('waits for its resident owner and intersects both permission sets before sending a following request', async () => {
  const { result } = await open();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled(); ready({ type: 'ready', id: 'other' }); expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  ready({ type: 'ready', id: requestId });
  await expect(result).resolves.toMatchObject({ body: 'owned' });
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ operation: 'fetch', input, policies: ['connect-src http://query.example.test:* https://query.example.test:* ws://query.example.test:* wss://query.example.test:*', 'connect-src https://query.example.test:*'] }));
  expect(port.disconnect).toHaveBeenCalledOnce(); expect(chrome.permissions.onRemoved.removeListener).toHaveBeenCalledWith(removed); expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(changed);
});
it.each(['signal', 'owner', 'permission', 'domain'] as const)('cancels an accepted request after %s loss and ignores a late result', async kind => {
  let finish!: (value: unknown) => void;
  vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, controller } = await open(); const rejected = expect(result).rejects.toThrow('aborted');
  ready({ type: 'ready', id: requestId });
  if (kind === 'signal') controller.abort(); else if (kind === 'owner') disconnected(); else if (kind === 'permission') removed(); else changed({ origins: { newValue: [] } }, 'sync');
  await rejected; expect(port.disconnect).toHaveBeenCalledOnce(); finish({ success: true, value: { body: 'late' } });
});
it('does not start an iframe request when canceled during asynchronous policy preparation', async () => {
  let finish!: (value: string[]) => void; policy.domains.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), result = fetchWithBrowserRedirects(input, controller.signal);
  const rejected = expect(result).rejects.toThrow('aborted'); controller.abort(); await rejected; finish([]); await Promise.resolve();
  expect(chrome.runtime.connect).not.toHaveBeenCalled(); expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
