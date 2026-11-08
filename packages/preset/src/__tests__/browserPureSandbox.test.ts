import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { buildBrowserPureCapabilityPage, bundleDigest } from '../bundles.js';
async function page(code: string, config = {}) {
  const bytes = new TextEncoder().encode(code);
  return buildBrowserPureCapabilityPage({ code: bytes, sha256: await bundleDigest(bytes), handlers: ['value'], config });
}
async function runtime(html: string) {
  let listener: (event: any) => void = () => {};
  const channel = new MessageChannel();
  const parent = { postMessage: vi.fn() };
  const script = html.match(/<script>([\s\S]*)<\/script>$/)?.[1];
  if (!script) throw new Error('No runtime script');
  runInNewContext(script, { window: { parent, addEventListener: (_: string, fn: typeof listener) => { listener = fn; } } }, { timeout: 1000 });
  let serial = 0;
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let ready!: () => void, fail!: (error: Error) => void;
  const prepared = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  channel.port2.on('message', message => {
    if (message.type === 'ready') { if (message.success) ready(); else fail(new Error(message.error)); return; }
    const call = calls.get(message.id); if (!call) return; calls.delete(message.id);
    if (message.success) call.resolve(message.value); else call.reject(new Error(message.error));
  });
  listener({ source: parent, data: { type: 'mearl-plugin-connect' }, ports: [channel.port1] });
  try { await prepared; } catch (error) { channel.port1.close(); channel.port2.close(); throw error; }
  return { invoke: (input: unknown, handler = 'value') => new Promise((resolve, reject) => { const id = ++serial; calls.set(id, { resolve, reject }); channel.port2.postMessage({ type: 'invoke', id, handler, input }); }), close: () => { channel.port1.close(); channel.port2.close(); } };
}
it('reuses the compiled module over numbered calls and exposes no Node globals', async () => {
  const source = await page('module.exports = (_, config) => { let count = 0; return { value: input => ({ value: input + config.add, count: ++count, node: typeof process, require: typeof require }) }; };', { add: 2 });
  const current = await runtime(source);
  try {
    expect(await current.invoke(3)).toEqual({ value: 5, count: 1, node: 'undefined', require: 'undefined' });
    expect(await current.invoke(4)).toEqual({ value: 6, count: 2, node: 'undefined', require: 'undefined' });
    await expect(current.invoke(null, 'other')).rejects.toThrow('Unknown pure runtime handler');
    expect(source).toContain("connect-src 'none'");
  } finally { current.close(); }
});
it('rejects host operations and keeps the runtime usable after a failed call', async () => {
  const current = await runtime(await page('module.exports = host => ({ value: input => input ? host.cookie({ url: "https://example.test/", name: "secret" }) : "plain" });'));
  try { await expect(current.invoke(true)).rejects.toThrow('Host operations are unavailable'); expect(await current.invoke(false)).toBe('plain'); }
  finally { current.close(); }
});
it('keeps call inputs outside the cached document and validates its resource digest', async () => {
  const code = new TextEncoder().encode('module.exports=()=>({value: input=>input});');
  const input = { code, sha256: await bundleDigest(code), handlers: ['value'], config: {} };
  expect(await buildBrowserPureCapabilityPage({ ...input, input: 'first', handler: 'value' } as any)).toBe(await buildBrowserPureCapabilityPage({ ...input, input: 'second', handler: 'value' } as any));
  await expect(buildBrowserPureCapabilityPage({ ...input, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
});

it('rejects initialization when a declared export is missing', async () => {
  await expect(runtime(await page('module.exports=()=>({});'))).rejects.toThrow('missing a declared handler');
});
