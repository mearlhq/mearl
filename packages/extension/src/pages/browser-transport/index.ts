import { applyBrowserConnectionPolicies, type BrowserFrameFetchInput } from '../../shared/browserFetchMessages';
import {
  browserTransportUrl,
  type BrowserViewTransport,
} from '@mearl/preset/bundles';

let connected = false;
window.addEventListener('message', event => {
  if (
    connected ||
    event.source !== window.parent ||
    window.parent === window ||
    event.origin !== location.origin ||
    event.data?.type !== 'transport-connect' ||
    !event.ports[0]
  )
    return;
  connected = true;
  const port = event.ports[0];
  const { url, kind, policies } = event.data as {
    url: string;
    kind: BrowserViewTransport['kind'] | 'fetch';
    policies: string[];
  };
  let transport: WebSocket | EventSource | undefined;
  let closed = false;
  const controller = new AbortController();
  const emit = (type: string, extra: Record<string, unknown> = {}) => {
    if (!closed)
      port.postMessage({
        type,
        readyState: transport?.readyState ?? (kind === 'websocket' ? 3 : 2),
        ...extra,
      });
  };
  port.onmessage = event => {
    if (event.data?.type !== 'close') return;
    closed = true;
    transport?.close(); controller.abort();
    port.close();
  };
  port.start();
  try {
    applyBrowserConnectionPolicies(policies, document);
    if (kind === 'fetch') {
      const input = event.data.input as BrowserFrameFetchInput;
      const target = new URL(input.url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid browser request URL');
      let body: BodyInit | undefined = input.body;
      if (input.formBody) { const form = new FormData(); for (const [key, value] of Object.entries(input.formBody)) form.append(key, value); body = form; }
      if (input.cache !== undefined && !['default', 'no-store'].includes(input.cache)) throw new Error('Invalid browser request cache mode');
      void fetch(target.href, { method: input.method, headers: input.headers, body, credentials: input.credentials, redirect: 'follow', ...(input.cache ? { cache: input.cache } : {}), signal: controller.signal }).then(async response => ({ ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: await response.text(), redirected: response.redirected })).then(value => { if (!closed) port.postMessage({ type: 'fetch-result', success: true, value }); }, error => { if (!closed) port.postMessage({ type: 'fetch-result', success: false, error: String(error) }); });
      window.addEventListener('pagehide', () => controller.abort(), { once: true });
      return;
    }
    browserTransportUrl(url, kind);
    transport = kind === 'websocket' ? new WebSocket(url) : new EventSource(url);
    transport.onopen = () => emit('open');
    transport.onmessage = event =>
      emit('message', { data: event.data, origin: event.origin, lastEventId: event.lastEventId });
    transport.onerror = () => emit('error');
    if (transport instanceof WebSocket)
      transport.onclose = event =>
        emit('close', { code: event.code, reason: event.reason, wasClean: event.wasClean });
  } catch (error) {
    if (kind === 'fetch') { port.postMessage({ type: 'fetch-result', success: false, error: error instanceof Error ? error.message : String(error) }); return; }
    emit('error', { error: error instanceof Error ? error.message : String(error) });
    if (kind === 'websocket') emit('close', { code: 1006, reason: '', wasClean: false });
  }
  window.addEventListener(
    'pagehide',
    () => {
      closed = true;
      transport?.close();
      port.close();
    },
    { once: true },
  );
});
window.parent.postMessage(
  { type: 'transport-ready', context: new URLSearchParams(location.search).get('context') },
  location.origin,
);
