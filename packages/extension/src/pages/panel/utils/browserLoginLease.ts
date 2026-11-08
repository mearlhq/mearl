import { browserDocumentToken } from '../../../shared/browserDocument';
import { BROWSER_REQUEST_LOGIN_PORT } from '../../../shared/browserRequestUi';

/** A document keeps the same accepted login lease when its service worker reconnects. */
export function createBrowserLoginLease(
  id: string,
  accept: () => Promise<void>,
  release: () => Promise<void>,
) {
  let closed = false;
  let port: chrome.runtime.Port | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const schedule = () => {
    clearTimeout(retry);
    if (closed) return;
    retry = setTimeout(() => {
      void connect().catch(schedule);
    }, 1000);
  };
  const connect = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('Login connection closed'));
    if (pending) return pending;
    if (port) return Promise.resolve();
    pending = new Promise<void>((resolve, reject) => {
      const current = chrome.runtime.connect({ name: BROWSER_REQUEST_LOGIN_PORT + id + ':' + browserDocumentToken });
      port = current;
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error('Login connection timed out'));
        current.disconnect();
      }, 5000);
      current.onMessage.addListener(message => {
        if (message?.ready !== true || ready || closed) return;
        ready = true;
        clearTimeout(timeout);
        void accept().then(
          () => {
            if (closed) reject(new Error('Login connection closed'));
            else if (port !== current) reject(new Error('Login connection interrupted'));
            else resolve();
          },
          error => {
            reject(error);
            current.disconnect();
          },
        );
      });
      current.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        clearTimeout(timeout);
        reject(new Error('Login connection closed'));
        if (port === current) {
          port = undefined;
          schedule();
        }
      });
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(retry);
    const current = port;
    port = undefined;
    current?.disconnect();
    // Acceptance may already be in flight when the document or login closes.
    await pending?.catch(() => {});
    await release();
  };
  return { id, connect, close };
}
