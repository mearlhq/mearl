import { holdOffscreenDocument } from './offscreenLeases';
import { BROWSER_FOLLOW_FETCH_TARGET, type BrowserFrameFetchInput } from '../../shared/browserFetchMessages';

const active = new Map<string, () => void>();
const owners = new Map<string, chrome.runtime.Port>();
function run(id: string, input: BrowserFrameFetchInput, policies: unknown): Promise<unknown> {
  if (!owners.has(id)) return Promise.reject(new Error('Browser request has no live owner'));
  if (active.has(id)) return Promise.reject(new Error('Browser request already exists'));
  const release = holdOffscreenDocument(), frame = document.createElement('iframe'), channel = new MessageChannel();
  const token = crypto.randomUUID(); frame.style.display = 'none';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(startup); clearTimeout(execution); window.removeEventListener('message', ready);
      active.delete(id); channel.port1.postMessage({ type: 'close' }); channel.port1.close(); channel.port2.close(); frame.remove(); release();
      if (error) reject(error); else resolve(result);
    };
    const startup = setTimeout(() => finish(new Error('Browser request frame did not become ready')), 15000);
    const execution = setTimeout(() => finish(new Error('Browser request timed out')), 120000);
    const ready = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'transport-ready' || event.data.context !== token) return;
      window.removeEventListener('message', ready); clearTimeout(startup);
      frame.contentWindow?.postMessage({ type: 'transport-connect', kind: 'fetch', input, policies }, location.origin, [channel.port2]);
    };
    active.set(id, () => finish(new Error('Browser request aborted')));
    channel.port1.onmessage = event => {
      if (event.data?.type !== 'fetch-result') return;
      if (event.data.success) finish(undefined, event.data.value); else finish(new Error(event.data.error || 'Browser request failed'));
    };
    channel.port1.start(); frame.onerror = () => finish(new Error('Browser request frame failed to load'));
    frame.src = chrome.runtime.getURL('src/pages/browser-transport/index.html') + '?context=' + token;
    window.addEventListener('message', ready); document.body.append(frame);
  });
}
export function initializeBrowserFollowFetch() {
  chrome.runtime.onConnect.addListener(port => {
    const sender = port.sender;
    const id = port.name.startsWith(BROWSER_FOLLOW_FETCH_TARGET + ':') ? port.name.slice(BROWSER_FOLLOW_FETCH_TARGET.length + 1) : '';
    if (!id) return;
    if (!sender || sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.documentId !== undefined || !sender.url?.startsWith(chrome.runtime.getURL('')) || !/^[a-f0-9-]{36}$/.test(id) || owners.has(id)) { port.disconnect(); return; }
    owners.set(id, port);
    port.onDisconnect.addListener(() => { if (owners.get(id) !== port) return; owners.delete(id); active.get(id)?.(); });
    port.postMessage({ type: 'ready', id });
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== BROWSER_FOLLOW_FETCH_TARGET || sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.documentId !== undefined || !sender.url?.startsWith(chrome.runtime.getURL('')) || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) return;
    if (message.operation !== 'fetch') return;
    void run(message.id, message.input, message.policies).then(value => respond({ success: true, value }), error => respond({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
}
