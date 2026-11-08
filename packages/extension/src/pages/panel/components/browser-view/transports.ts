import type { BrowserViewTransport } from '@mearl/preset/bundles';

interface TransportPolicy {
  url: string;
  kind: BrowserViewTransport['kind'];
  policies: string[];
}
interface Connection {
  dispose(): void;
  kind?: BrowserViewTransport['kind'];
}
export interface BrowserViewTransportEvent {
  id: string;
  type: string;
  readyState: number;
  [key: string]: unknown;
}

/** Native transports live in private extension frames whose CSP intersects both permission sets. */
export function createBrowserViewTransports(
  authorize: (input: { name: string; url: string }) => Promise<TransportPolicy>,
  emit: (event: BrowserViewTransportEvent) => void,
  declarations: Record<string, BrowserViewTransport>,
) {
  const connections = new Map<string, Connection>();
  let disposed = false;
  const close = (id: string, notify = false) => {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    connection.dispose();
    if (notify) {
      emit({ id, type: 'error', readyState: connection.kind === 'websocket' ? 3 : 2 });
      if (connection.kind === 'websocket')
        emit({ id, type: 'close', readyState: 3, code: 1006, reason: '', wasClean: false });
    }
  };
  const closeAll = (notify: boolean) => {
    for (const id of [...connections.keys()]) close(id, notify);
  };
  return {
    close,
    invalidate: () => closeAll(true),
    dispose: () => {
      disposed = true;
      closeAll(false);
    },
    async open(input: { id: string; name: string; url: string }) {
      if (
        disposed ||
        !Object.hasOwn(declarations, input.name) ||
        !/^[a-f0-9-]{36}$/.test(input.id) ||
        connections.has(input.id) ||
        connections.size >= 16
      )
        throw new Error('Browser view transport is unavailable');
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.setAttribute('aria-hidden', 'true');
      const channel = new MessageChannel(),
        token = crypto.randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const connection: Connection = {
        kind: declarations[input.name].kind,
        dispose: () => {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          channel.port1.postMessage({ type: 'close' });
          channel.port1.close();
          channel.port2.close();
          frame.remove();
        },
      };
      const onMessage = (event: MessageEvent) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.type !== 'transport-ready' ||
          event.data.context !== token ||
          connections.get(input.id) !== connection
        )
          return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        frame.contentWindow?.postMessage(
          { type: 'transport-connect', ...policy },
          location.origin,
          [channel.port2],
        );
      };
      let policy: TransportPolicy;
      connections.set(input.id, connection);
      try {
        policy = await authorize({ name: input.name, url: input.url });
        connection.kind = policy.kind;
        if (connections.get(input.id) !== connection || disposed)
          throw new Error('Browser view transport closed while preparing');
        channel.port1.onmessage = event => {
          if (
            connections.get(input.id) !== connection ||
            !['open', 'message', 'error', 'close'].includes(event.data?.type)
          )
            return;
          emit({ ...event.data, id: input.id });
          if (
            event.data.type === 'close' ||
            (event.data.type === 'error' && event.data.readyState === 2)
          )
            close(input.id);
        };
        channel.port1.start();
        window.addEventListener('message', onMessage);
        frame.src =
          chrome.runtime.getURL('src/pages/browser-transport/index.html') + '?context=' + token;
        timer = setTimeout(() => close(input.id, true), 15000);
        frame.onerror = () => close(input.id, true);
        document.body.append(frame);
      } catch (error) {
        if (connections.get(input.id) === connection) close(input.id);
        throw error;
      }
    },
  };
}
