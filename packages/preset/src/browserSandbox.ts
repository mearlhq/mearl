import { BundleError, MAX_BUNDLE_BYTES, bundleDigest } from './bundle.js';
import { clonePresetDefaults } from './manifest.js';
import type { JsonObject } from './types.js';

export interface BrowserCapabilityRequest {
  url: string;
  method?: string;
  credentials?: 'omit' | 'same-origin' | 'include';
  redirect?: 'manual' | 'follow';
  cache?: 'default' | 'no-store';
  headers?: Record<string, string>;
  injectedHeaders?: Record<string, string>;
  cookieHeaders?: Record<string, string>;
  withCookies?: boolean;
  /** Reuse the host source-header policy, including XSRF when cookies are requested. */
  withSourceHeaders?: boolean;
  withXsrf?: boolean;
  body?: string;
  formBody?: Record<string, string>;
}
export interface BrowserCapabilityResponse { ok: boolean; status: number; statusText: string; body: string; redirected?: boolean; headers?: Record<string, string> }
export interface BrowserCapabilityHost {
  request(input: BrowserCapabilityRequest): Promise<BrowserCapabilityResponse>;
  cookie(input: { url: string; name: string; withRelatedCookies?: boolean; domain?: boolean; partitionKey?: { topLevelSite: string } }): Promise<string | undefined>;
}
export interface BrowserCapabilityInvocation {
  code: Uint8Array;
  sha256: string;
  handlers: string[];
  handler?: string;
  input?: unknown;
  config?: JsonObject;
}

/** This function is serialized into an opaque sandbox, never evaluated by the extension worker. */
function runBrowserCapability(payload: { code: string; handlers: string[]; handler?: string; input?: unknown; config: JsonObject }) {
  let connected = false;
  window.addEventListener('message', async event => {
    if (event.source !== window.parent || event.data?.type !== 'mearl-plugin-connect' || !event.ports[0] || connected) return;
    connected = true;
    const port = event.ports[0];
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let serial = 0;
    const call = (method: 'request' | 'cookie', input: unknown) => new Promise<any>((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      try { port.postMessage({ type: 'host-call', id, method, input }); }
      catch (error) { pending.delete(id); reject(error); }
    });
    port.onmessage = response => {
      const value = response.data;
      if (value?.type !== 'host-result' || !Number.isSafeInteger(value.id)) return;
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      if (value.success === true) request.resolve(value.value);
      else request.reject(new Error(typeof value.error === 'string' ? value.error : 'Browser host call failed'));
    };
    port.start();
    try {
      const module: { exports: any } = { exports: {} };
      const evaluate = new Function('module', 'exports', '"use strict";\n' + payload.code);
      evaluate(module, module.exports);
      const factory = module.exports;
      if (typeof factory !== 'function') throw new Error('Browser capability must export a factory');
      const handlers = await factory(Object.freeze({ request: (input: unknown) => call('request', input), cookie: (input: unknown) => call('cookie', input) }), payload.config);
      if (!handlers || typeof handlers !== 'object' || payload.handlers.some(name => !Object.hasOwn(handlers, name) || typeof handlers[name] !== 'function')) throw new Error('Browser capability factory is missing a declared handler');
      const value = payload.handler === undefined ? { handlers: payload.handlers } : await handlers[payload.handler](payload.input);
      port.postMessage({ type: 'result', success: true, value });
    } catch (error) {
      port.postMessage({ type: 'result', success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  window.parent.postMessage({ type: 'mearl-plugin-ready' }, '*');
}

/** Both sandbox renderers use the same validated JSON payload. */
async function encodeBrowserCapability(input: BrowserCapabilityInvocation): Promise<string> {
  if (!(input.code instanceof Uint8Array) || input.code.byteLength === 0 || input.code.byteLength > MAX_BUNDLE_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Invalid browser module size');
  if (!Array.isArray(input.handlers) || input.handlers.length > 256) throw new BundleError('BUNDLE_QUOTA', 'Browser module declares too many handlers');
  const handlers = [...input.handlers];
  if (new Set(handlers).size !== handlers.length || handlers.some(name => typeof name !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(name)) || input.handler !== undefined && !handlers.includes(input.handler)) throw new BundleError('BUNDLE_INVALID', 'Invalid browser module handler');
  const bytes = Uint8Array.from(input.code);
  const config = clonePresetDefaults(input.config ?? {});
  if (new TextEncoder().encode(JSON.stringify(config)).byteLength > 262144) throw new BundleError('BUNDLE_QUOTA', 'Browser module configuration exceeds 256 KiB');
  const handler = input.handler;
  let acceptedInput: unknown;
  try { acceptedInput = input.input === undefined ? undefined : JSON.parse(JSON.stringify(input.input)); }
  catch { throw new BundleError('BUNDLE_INVALID', 'Browser module input must be JSON'); }
  const sha256 = input.sha256;
  if (!/^[a-f0-9]{64}$/.test(sha256) || await bundleDigest(bytes) !== sha256) throw new BundleError('BUNDLE_INTEGRITY', 'Browser module digest does not match');
  let code: string;
  try { code = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new BundleError('BUNDLE_INVALID', 'Browser module must be UTF-8'); }
  const data = JSON.stringify({ code, handlers, handler, input: acceptedInput, config }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (new TextEncoder().encode(data).byteLength > 64 * 1024 * 1024) throw new BundleError('BUNDLE_QUOTA', 'Browser module invocation exceeds 64 MiB');
  return data;
}

export async function buildBrowserCapabilityPage(input: BrowserCapabilityInvocation): Promise<string> {
  const data = await encodeBrowserCapability(input);
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'"><script>(${runBrowserCapability.toString()})(${data});</script>`;
}

/** Serialized into the opaque sandbox; this execution path has no host capabilities. */
function runPureCapability(payload: { code: string; handlers: string[]; config: JsonObject }) {
  let connected = false;
  window.addEventListener('message', async event => {
    if (connected || event.source !== window.parent || event.data?.type !== 'mearl-plugin-connect' || !event.ports[0]) return;
    connected = true;
    const port = event.ports[0];
    try {
      const module: { exports: any } = { exports: {} };
      new Function('module', 'exports', '"use strict";\n' + payload.code)(module, module.exports);
      if (typeof module.exports !== 'function') throw new Error('Browser capability must export a factory');
      const unavailable = async () => { throw new Error('Host operations are unavailable in a pure runtime'); };
      const handlers = await module.exports(Object.freeze({ request: unavailable, cookie: unavailable }), payload.config);
      if (!handlers || typeof handlers !== 'object' || payload.handlers.some(name => !Object.hasOwn(handlers, name) || typeof handlers[name] !== 'function')) throw new Error('Browser capability factory is missing a declared handler');
      port.onmessage = async event => {
        const message = event.data;
        if (message?.type !== 'invoke' || !Number.isSafeInteger(message.id)) return;
        try {
          if (!payload.handlers.includes(message.handler)) throw new Error('Unknown pure runtime handler');
          const value = await handlers[message.handler](message.input);
          port.postMessage({ type: 'result', id: message.id, success: true, value });
        } catch (error) {
          port.postMessage({ type: 'result', id: message.id, success: false, error: error instanceof Error ? error.message : String(error) });
        }
      };
      port.start();
      port.postMessage({ type: 'ready', success: true });
    } catch (error) {
      port.postMessage({ type: 'ready', success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  window.parent.postMessage({ type: 'mearl-plugin-ready' }, '*');
}

export async function buildBrowserPureCapabilityPage(input: Omit<BrowserCapabilityInvocation, 'handler' | 'input'>): Promise<string> {
  const { code, sha256, handlers, config } = input;
  const data = await encodeBrowserCapability({ code, sha256, handlers, config });
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'"><script>(${runPureCapability.toString()})(${data});</script>`;
}
