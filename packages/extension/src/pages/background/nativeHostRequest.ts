import { MEARL_NATIVE_HOST_NAMES } from '@mearl/browser-core';
const NATIVE_HOST_NAMES = Object.values(MEARL_NATIVE_HOST_NAMES);

class NativeHostConnectionError extends Error {}

function requestOneNativeHost(
  hostName: string,
  action: string,
  data: Record<string, unknown>,
  timeoutMs: number,
  onProgress?: (data: unknown) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(hostName);
    } catch (error) {
      reject(new NativeHostConnectionError(error instanceof Error ? error.message : String(error)));
      return;
    }
    const id = `maintenance_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // The host may already have closed the port after returning its response.
      }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new NativeHostConnectionError('Native host request timed out')),
      timeoutMs,
    );

    port.onMessage.addListener(message => {
      if (message?.id !== id) return;
      if (message.type === 'progress') {
        onProgress?.(message.data);
        return;
      }
      if (message.success) finish(undefined, message.data);
      else finish(new Error(message.error || 'Unknown native host error'));
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      const message = chrome.runtime.lastError?.message || 'Native host disconnected';
      finish(new NativeHostConnectionError(message));
    });

    try {
      port.postMessage({ id, action, data });
    } catch (error) {
      finish(new NativeHostConnectionError(error instanceof Error ? error.message : String(error)));
    }
  });
}

export async function requestNativeHostOnce(
  action: string,
  data: Record<string, unknown> = {},
  timeoutMs = 15_000,
  onProgress?: (data: unknown) => void,
): Promise<unknown> {
  let lastConnectionError: Error | undefined;
  for (const hostName of NATIVE_HOST_NAMES) {
    try {
      return await requestOneNativeHost(hostName, action, data, timeoutMs, onProgress);
    } catch (error) {
      if (!(error instanceof NativeHostConnectionError)) throw error;
      lastConnectionError = error;
    }
  }
  throw lastConnectionError ?? new Error('No Mearl Native Host is available');
}

export interface NativeHostRequestSession {
  request(action: string, data: Record<string, unknown>, timeoutMs: number, onProgress?: (data: unknown) => void): Promise<unknown>;
  close(): void;
}

/** A multi-step operation keeps one Native process and its accepted capability instances. */
function connectRequestSession(hostName: string): NativeHostRequestSession {
  const port = chrome.runtime.connectNative(hostName);
  let closed = false;
  const pending = new Map<string, { finish(error?: Error, value?: unknown): void; progress?: (data: unknown) => void }>();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const call of pending.values()) call.finish(new NativeHostConnectionError('Native host session closed'));
    try { port.disconnect(); } catch { /* The process may already have exited. */ }
  };
  port.onMessage.addListener(message => {
    const call = pending.get(message?.id);
    if (!call) return;
    if (message.type === 'progress') call.progress?.(message.data);
    else call.finish(message.success ? undefined : new Error(message.error || 'Native host operation failed'), message.data);
  });
  port.onDisconnect.addListener(() => {
    const error = new NativeHostConnectionError(chrome.runtime.lastError?.message || 'Native host disconnected');
    for (const call of pending.values()) call.finish(error);
    close();
  });
  return {
    close,
    request(action, data, timeoutMs, progress) {
      if (closed) return Promise.reject(new NativeHostConnectionError('Native host session closed'));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { pending.get(id)?.finish(new NativeHostConnectionError('Native host request timed out')); close(); }, timeoutMs);
        pending.set(id, { progress, finish(error, value) { clearTimeout(timer); pending.delete(id); if (error) reject(error); else resolve(value); } });
        try { port.postMessage({ id, action, data }); }
        catch (error) { pending.get(id)?.finish(new NativeHostConnectionError(String(error))); close(); }
      });
    },
  };
}

export async function startNativeHostRequestSession(action: string, data: Record<string, unknown>, timeoutMs: number, progress?: (data: unknown) => void) {
  let lastError: unknown;
  for (const name of NATIVE_HOST_NAMES) {
    let session: NativeHostRequestSession | undefined;
    let receivedProgress = false;
    try {
      session = connectRequestSession(name);
      const value = await session.request(action, data, timeoutMs, value => { receivedProgress = true; progress?.(value); });
      return { session, value };
    } catch (error) {
      session?.close();
      if (!(error instanceof NativeHostConnectionError) || receivedProgress || !/not found|not registered|failed to start native messaging host/i.test(error.message)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('No Mearl Native Host is available');
}
