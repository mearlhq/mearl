import { holdOffscreenDocument } from './offscreenLeases';

export const PURE_RUNTIME_TARGET = 'mearl-browser-pure-runtime';
export const PURE_RUNTIME_IDLE_TARGET = 'mearl-browser-pure-idle';
const IDLE_MS = 60_000;
const MAX_MODULES = 16;
interface Runtime {
  html: string; ready: Promise<void>; invoke(handler: string, input: unknown): Promise<unknown>;
  idle: boolean; lastUsed: number; close(reason: Error): void;
}
const runtimes = new Map<string, Runtime>();

function createRuntime(id: string, html: string): Runtime {
  const release = holdOffscreenDocument();
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('plugin/sandbox.html');
  const channel = new MessageChannel();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let serial = 0, closed = false, prepared = false, connected = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let accept!: () => void, fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { accept = resolve; fail = reject; });
  const startup = setTimeout(() => runtime.close(new Error('Pure browser runtime did not become ready')), 15_000);
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (closed || pending.size || !prepared) return;
    idleTimer = setTimeout(() => {
      runtime.close(new Error('Pure browser runtime expired'));
    }, IDLE_MS);
  };
  const onMessage = (event: MessageEvent) => {
    if (closed || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'mearl-plugin-host-ready') frame.contentWindow?.postMessage({ type: 'mearl-plugin-load', html }, '*');
    if (event.data?.type === 'mearl-plugin-ready' && !connected) { connected = true; frame.contentWindow?.postMessage({ type: 'mearl-plugin-connect' }, '*', [channel.port2]); }
  };
  const runtime: Runtime = {
    html, ready,
    get idle() { return prepared && pending.size === 0; },
    lastUsed: Date.now(),
    async invoke(handler, input) {
      await ready;
      if (closed) throw new Error('Pure browser runtime closed');
      if (pending.size >= 64) throw new Error('Too many pending pure browser calls');
      clearTimeout(idleTimer);
      runtime.lastUsed = Date.now();
      return new Promise((resolve, reject) => {
        const callId = ++serial;
        const timer = setTimeout(() => runtime.close(new Error('Pure browser operation timed out')), 10_000);
        pending.set(callId, { resolve, reject, timer });
        try { channel.port1.postMessage({ type: 'invoke', id: callId, handler, input }); }
        catch (error) { runtime.close(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    close(reason) {
      if (closed) return;
      closed = true;
      clearTimeout(startup); clearTimeout(idleTimer);
      window.removeEventListener('message', onMessage);
      channel.port1.close(); channel.port2.close(); frame.remove(); release();
      if (runtimes.get(id) === runtime) runtimes.delete(id);
      fail(reason);
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(reason); }
      pending.clear();
      void chrome.runtime.sendMessage({ target: PURE_RUNTIME_IDLE_TARGET }).catch(() => {});
    },
  };
  channel.port1.onmessage = event => {
    const message = event.data;
    if (closed) return;
    if (message?.type === 'ready' && !prepared) {
      if (message.success !== true) { runtime.close(new Error(message.error || 'Pure browser runtime failed')); return; }
      prepared = true; clearTimeout(startup); accept(); scheduleIdle(); return;
    }
    if (message?.type !== 'result' || !Number.isSafeInteger(message.id)) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.success === true) call.resolve(message.value);
    else call.reject(new Error(message.error || 'Pure browser operation failed'));
    runtime.lastUsed = Date.now(); scheduleIdle();
  };
  channel.port1.start();
  frame.onerror = () => runtime.close(new Error('Pure browser runtime could not load'));
  window.addEventListener('message', onMessage);
  runtimes.set(id, runtime);
  document.body.append(frame);
  return runtime;
}

export async function handlePureRuntime(input: any): Promise<unknown> {
  if (!input || typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw new Error('Invalid pure browser runtime identity');
  if (input.operation === 'prepare') {
    if (typeof input.html !== 'string' || input.html.length > 64 * 1024 * 1024) throw new Error('Invalid pure browser runtime document');
    const current = runtimes.get(input.id);
    if (current) { if (current.html !== input.html) throw new Error('Pure browser runtime identity conflict'); await current.ready; return null; }
    if (runtimes.size >= MAX_MODULES) {
      const idle = [...runtimes.values()].filter(value => value.idle).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new Error('Too many active pure browser runtimes');
      idle.close(new Error('Pure browser runtime evicted'));
    }
    const runtime = createRuntime(input.id, input.html);
    await runtime.ready; return null;
  }
  if (input.operation === 'invoke' && typeof input.handler === 'string') {
    const runtime = runtimes.get(input.id);
    if (!runtime) throw new Error('PURE_RUNTIME_MISSING');
    return runtime.invoke(input.handler, input.input);
  }
  throw new Error('Unknown pure browser operation');
}
export function initializeBrowserPureOffscreen() {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== PURE_RUNTIME_TARGET || sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.documentId !== undefined) return;
    void handlePureRuntime(message.data).then(value => respond({ success: true, value }), error => respond({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
}
