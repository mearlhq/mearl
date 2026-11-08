import { holdOffscreenDocument } from './offscreenLeases';
import {
  BROWSER_CAPABILITY_OFFSCREEN_TARGET,
  BROWSER_CAPABILITY_HOST_TARGET,
  BROWSER_CAPABILITY_OWNER_PORT,
} from '../../shared/browserCapabilityMessages';

/** Extension APIs remain in the background; installed code runs inside the opaque sandbox. */
export async function runBrowserCapabilitySandbox(
  id: string,
  html: string,
  timeoutMs = 120000,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const release = holdOffscreenDocument();
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('plugin/sandbox.html');
  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      dispose();
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(new Error('Browser capability aborted'));
    const startup = setTimeout(() => {
      finish(new Error('Browser capability sandbox did not become ready'));
    }, 15000);
    const execution = setTimeout(() => {
      finish(new Error('Browser capability execution timed out'));
    }, timeoutMs);
    const dispose = () => {
      clearTimeout(startup);
      clearTimeout(execution);
      signal?.removeEventListener('abort', aborted);
      window.removeEventListener('message', onMessage);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      release();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type === 'mearl-plugin-host-ready')
        frame.contentWindow?.postMessage({ type: 'mearl-plugin-load', html }, '*');
      if (event.data?.type === 'mearl-plugin-ready') {
        clearTimeout(startup);
        frame.contentWindow?.postMessage({ type: 'mearl-plugin-connect' }, '*', [channel.port2]);
      }
    };
    channel.port1.onmessage = async event => {
      const message = event.data;
      if (
        message?.type === 'host-call' &&
        Number.isSafeInteger(message.id) &&
        ['request', 'cookie'].includes(message.method)
      ) {
        let result;
        try {
          const response = await chrome.runtime.sendMessage({
            target: BROWSER_CAPABILITY_HOST_TARGET,
            id,
            method: message.method,
            input: message.input,
          });
          result = { type: 'host-result', id: message.id, ...response };
        } catch (error) {
          result = {
            type: 'host-result',
            id: message.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        try {
          channel.port1.postMessage(result);
        } catch {
          /* The caller may have released its sandbox. */
        }
      }
      if (message?.type === 'result') {
        if (message.success === true) finish(undefined, message.value);
        else
          finish(
            new Error(
              typeof message.error === 'string' ? message.error : 'Browser capability failed',
            ),
          );
      }
    };
    channel.port1.start();
    frame.onerror = () => {
      finish(new Error('Browser capability sandbox could not load'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    window.addEventListener('message', onMessage);
    document.body.append(frame);
  });
}

/** The worker port owns the sandbox even when Chrome terminates its sender. */
async function runOwnedSandbox(id: string, html: string, timeoutMs: number) {
  const controller = new AbortController();
  const port = chrome.runtime.connect({ name: BROWSER_CAPABILITY_OWNER_PORT + id });
  await new Promise<void>((resolve, reject) => {
    const startup = setTimeout(() => { port.disconnect(); reject(new Error('Browser capability owner did not become ready')); }, 15000);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      clearTimeout(startup);
      controller.abort();
      reject(new Error('Browser capability owner disconnected'));
    });
    const ready = (message: any) => {
      if (message?.type !== 'ready' || message.id !== id) return;
      clearTimeout(startup); port.onMessage.removeListener(ready); resolve();
    };
    port.onMessage.addListener(ready);
  });
  return runBrowserCapabilitySandbox(id, html, timeoutMs, controller.signal);
}

export function initializeBrowserCapabilityOffscreen(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message?.target !== BROWSER_CAPABILITY_OFFSCREEN_TARGET ||
      sender.id !== chrome.runtime.id ||
      sender.tab !== undefined ||
      sender.documentId !== undefined ||
      !sender.url?.startsWith(chrome.runtime.getURL(''))
    )
      return;
    if (
      typeof message.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(message.id) ||
      typeof message.html !== 'string' ||
      !Number.isSafeInteger(message.timeoutMs) ||
      message.timeoutMs <= 0 ||
      message.timeoutMs > 120000
    )
      return;
    void runOwnedSandbox(message.id, message.html, message.timeoutMs).then(
      value => sendResponse({ success: true, value }),
      error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  });
}
