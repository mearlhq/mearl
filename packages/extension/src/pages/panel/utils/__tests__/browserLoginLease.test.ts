import { browserDocumentToken } from '../../../../shared/browserDocument';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserLoginLease } from '../browserLoginLease';
let ports: Array<{ ready(): void; closed(): void; disconnect: ReturnType<typeof vi.fn> }>;
beforeEach(() => {
  vi.useFakeTimers();
  ports = [];
  chrome.runtime.connect = vi.fn(() => {
    let message!: (value: unknown) => void, disconnected!: () => void;
    const port = {
      onMessage: {
        addListener: (fn: typeof message) => {
          message = fn;
        },
      },
      onDisconnect: {
        addListener: (fn: typeof disconnected) => {
          disconnected = fn;
        },
      },
      disconnect: vi.fn(() => disconnected()),
    };
    ports.push({
      ready: () => message({ ready: true }),
      closed: () => disconnected(),
      disconnect: port.disconnect,
    });
    return port as any;
  });
});
afterEach(() => vi.useRealTimers());
it('accepts only after port readiness, reconnects the same lease and stops reconnecting after release', async () => {
  const accept = vi.fn(async () => {}),
    release = vi.fn(async () => {});
  const lease = createBrowserLoginLease('owned', accept, release);
  const opening = lease.connect();
  expect(accept).not.toHaveBeenCalled();
  ports[0].ready();
  await opening;
  expect(accept).toHaveBeenCalledOnce();
  ports[0].closed();
  await vi.advanceTimersByTimeAsync(1000);
  ports[1].ready();
  await vi.advanceTimersByTimeAsync(0);
  expect(accept).toHaveBeenCalledTimes(2);
  expect(chrome.runtime.connect).toHaveBeenNthCalledWith(2, {
    name: 'browser-request-login:owned:' + browserDocumentToken,
  });
  await lease.close();
  await vi.advanceTimersByTimeAsync(6000);
  expect(ports).toHaveLength(2);
  expect(release).toHaveBeenCalledOnce();
  await expect(lease.connect()).rejects.toThrow('closed');
});
it('settles a closed pending handshake and releases failed or late acceptance', async () => {
  const release = vi.fn(async () => {}),
    accept = vi.fn(async () => {});
  const lease = createBrowserLoginLease('owned', accept, release);
  const opening = expect(lease.connect()).rejects.toThrow('closed');
  await lease.close();
  await opening;
  expect(accept).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10000);
  expect(ports).toHaveLength(1);
});
it('times out readiness, releases the port and permits explicit cleanup without leaking retries', async () => {
  const release = vi.fn(async () => {});
  const lease = createBrowserLoginLease('owned', async () => {}, release);
  const opening = expect(lease.connect()).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(5000);
  await opening;
  expect(ports[0].disconnect).toHaveBeenCalledOnce();
  await lease.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(ports).toHaveLength(1);
  expect(release).toHaveBeenCalledOnce();
});
