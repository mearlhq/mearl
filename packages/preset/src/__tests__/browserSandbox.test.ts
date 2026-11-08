import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { buildBrowserCapabilityPage, bundleDigest } from '../bundles.js';

async function page(code: string, options: { handler?: string; handlers?: string[]; input?: unknown; config?: Record<string, any> } = {}) {
  const bytes = new TextEncoder().encode(code);
  return buildBrowserCapabilityPage({ code: bytes, sha256: await bundleDigest(bytes), handlers: options.handlers ?? ['value'], ...options });
}

async function execute(html: string, host: (method: string, input: any) => Promise<unknown> = async () => undefined) {
  const script = html.match(/<script>([\s\S]*)<\/script>$/)?.[1];
  if (!script) throw new Error('Expected the sandbox bootstrap');
  let listener: (event: unknown) => void = () => {};
  const channel = new MessageChannel();
  const parent = { postMessage: vi.fn() };
  runInNewContext(script, { window: { parent, addEventListener: (_name: string, fn: typeof listener) => { listener = fn; } } }, { timeout: 1000 });
  return new Promise<unknown>((resolve, reject) => {
    const close = () => { channel.port1.close(); channel.port2.close(); };
    channel.port2.on('message', async message => {
      if (message.type === 'host-call') {
        try { channel.port2.postMessage({ type: 'host-result', id: message.id, success: true, value: await host(message.method, message.input) }); }
        catch (error) { channel.port2.postMessage({ type: 'host-result', id: message.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
      }
      if (message.type === 'result') { close(); if (message.success) resolve(message.value); else reject(new Error(message.error)); }
    });
    listener({ source: parent, data: { type: 'mearl-plugin-connect' }, ports: [channel.port1] });
  });
}

describe('browser capability sandbox bootstrap', () => {
  it('runs a factory without Node globals and invokes only declared handlers', async () => {
    const html = await page('module.exports = (host, config) => ({ value: input => ({ value: input.value + config.add, node: typeof process, require: typeof require, buffer: typeof Buffer }) });', { handler: 'value', input: { value: 4 }, config: { add: 3 } });
    expect(await execute(html)).toEqual({ value: 7, node: 'undefined', require: 'undefined', buffer: 'undefined' });
    expect(html).toContain("connect-src 'none'");
  });

  it('validates every declared export before invoking business operations', async () => {
    const host = vi.fn();
    expect(await execute(await page('module.exports = host => ({ value: () => host.request({ url: "https://example.com" }) });'), host)).toEqual({ handlers: ['value'] });
    expect(host).not.toHaveBeenCalled();
    await expect(execute(await page('module.exports = () => ({});'))).rejects.toThrow('missing a declared handler');
    await expect(execute(await page('module.exports = () => ({});', { handlers: ['constructor'] }))).rejects.toThrow('missing a declared handler');
    await expect(execute(await page('module.exports = {};'))).rejects.toThrow('must export a factory');
  });

  it('round trips host requests, cookie values and host errors over its private channel', async () => {
    const host = vi.fn(async (method, input) => method === 'cookie' ? 'tenant-a' : { ok: true, body: input.tenant });
    const html = await page('module.exports = host => ({ value: async input => { const tenant = await host.cookie({ url: input.url, name: "tenant", withRelatedCookies: true }); return host.request({ url: input.url, tenant, withCookies: true, withSourceHeaders: true, withXsrf: false, cookieHeaders: { "x-csrf-token": "csrfToken" }, credentials: "same-origin", formBody: { account: "中文", empty: "" } }); } });', { handler: 'value', input: { url: 'https://example.com' } });
    expect(await execute(html, host)).toEqual({ ok: true, body: 'tenant-a' });
    expect(host.mock.calls.map(([method]) => method)).toEqual(['cookie', 'request']);
    expect(host.mock.calls[0][1]).toEqual({ url: 'https://example.com', name: 'tenant', withRelatedCookies: true });
    expect(host.mock.calls[1][1]).toEqual({ url: 'https://example.com', tenant: 'tenant-a', withCookies: true, withSourceHeaders: true, withXsrf: false, cookieHeaders: { "x-csrf-token": "csrfToken" }, credentials: "same-origin", formBody: { account: '中文', empty: '' } });
    await expect(execute(html, async () => { throw new Error('Permission required'); })).rejects.toThrow('Permission required');
  });

  it('escapes HTML boundaries in code, input and configuration', async () => {
    const value = '</script><img src=x onerror=alert(1)>\u2028';
    const html = await page('module.exports = (host, config) => ({ value: input => [input.text, config.text] });', { handler: 'value', input: { text: value }, config: { text: value } });
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(await execute(html)).toEqual([value, value]);
  });

  it('captures inputs before digest work can observe caller changes', async () => {
    const code = new TextEncoder().encode('module.exports = (host, config) => ({ value: input => input.text + config.suffix });');
    const input = { text: 'accepted' }, config = { suffix: '-value' };
    const preparing = buildBrowserCapabilityPage({ code, sha256: await bundleDigest(code), handlers: ['value'], handler: 'value', input, config });
    code.fill(0); input.text = 'changed'; config.suffix = '-changed';
    expect(await execute(await preparing)).toBe('accepted-value');
  });

  it('rejects invalid code, undeclared handlers and oversized metadata before execution', async () => {
    const code = new TextEncoder().encode('module.exports = () => ({ value: () => 1 });');
    await expect(buildBrowserCapabilityPage({ code, sha256: '0'.repeat(64), handlers: ['value'] })).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await expect(page('module.exports = () => ({});', { handler: 'other' })).rejects.toThrow('Invalid browser module handler');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(buildBrowserCapabilityPage({ code: new Uint8Array(17 * 1024 * 1024), sha256: '0'.repeat(64), handlers: [] })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    expect(digest).not.toHaveBeenCalled(); digest.mockRestore();
    await expect(page('invalid syntax', { config: { huge: 'x'.repeat(262144) } })).rejects.toMatchObject({ code: 'BUNDLE_QUOTA' });
    await expect(execute(await page('invalid syntax'))).rejects.toThrow();
  });
});
