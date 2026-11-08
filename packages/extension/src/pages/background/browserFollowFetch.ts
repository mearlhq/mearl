import { browserTransportPolicies, type BrowserCapabilityResponse } from '@mearl/preset/bundles';
import { BROWSER_FOLLOW_FETCH_TARGET, type BrowserFrameFetchInput } from '../../shared/browserFetchMessages';
import { getAgentAllowedOrigins, getAgentAllowAllDomains, PROXY_PERMISSION_STORAGE_KEY, DISABLED_BUILTIN_ORIGINS_STORAGE_KEY, AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY } from '../../shared/proxyPermissions';

/** A live worker owns each request; its frame receives an immutable CSP scope. */
export async function fetchWithBrowserRedirects(input: BrowserFrameFetchInput, signal: AbortSignal): Promise<BrowserCapabilityResponse> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false, owner: chrome.runtime.Port | undefined, startup: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      clearTimeout(startup); signal.removeEventListener('abort', fail);
      chrome.permissions.onRemoved.removeListener(fail); chrome.storage.onChanged.removeListener(changed);
      owner?.disconnect();
    };
    const rejectCall = (error: unknown) => { if (!settled) { settled = true; dispose(); reject(error); } };
    const fail = () => rejectCall(new Error('Browser request aborted'));
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'sync' && [PROXY_PERMISSION_STORAGE_KEY, DISABLED_BUILTIN_ORIGINS_STORAGE_KEY, AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY].some(key => Object.hasOwn(changes, key))) fail();
    };
    signal.addEventListener('abort', fail, { once: true }); chrome.permissions.onRemoved.addListener(fail); chrome.storage.onChanged.addListener(changed);
    if (signal.aborted) { fail(); return; }
    void (async () => {
      const [domains, allowAll, permissions] = await Promise.all([getAgentAllowedOrigins(), getAgentAllowAllDomains(), chrome.permissions.getAll()]);
      if (settled) return;
      const policies = browserTransportPolicies(domains, permissions.origins ?? [], allowAll, 'eventSource');
      owner = chrome.runtime.connect({ name: BROWSER_FOLLOW_FETCH_TARGET + ':' + id });
      startup = setTimeout(() => rejectCall(new Error('Browser request owner did not become ready')), 15000);
      owner.onDisconnect.addListener(() => { void chrome.runtime.lastError; fail(); });
      const ready = (message: any) => {
        if (message?.type !== 'ready' || message.id !== id || settled) return;
        owner!.onMessage.removeListener(ready); clearTimeout(startup);
        void chrome.runtime.sendMessage({ target: BROWSER_FOLLOW_FETCH_TARGET, operation: 'fetch', id, input, policies }).then(response => {
          if (settled) return;
          if (!response?.success) throw new Error(response?.error || 'Browser request failed');
          settled = true; dispose(); resolve(response.value);
        }).catch(rejectCall);
      };
      owner.onMessage.addListener(ready);
    })().catch(rejectCall);
  });
}
