import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ page: vi.fn(async (_input: unknown) => '<runtime/>'), offscreen: vi.fn(async (operation: () => Promise<unknown>) => operation()) }));
vi.mock('@mearl/preset/bundles', async original => ({ ...(await original<any>()), buildBrowserPureCapabilityPage: mocks.page }));
vi.mock('../offscreenDocument', () => ({ withOffscreenDocument: mocks.offscreen }));
import { bundleDigest } from '@mearl/preset/bundles';
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto);
  chrome.runtime.id = 'owned'; chrome.runtime.getURL = file => 'chrome-extension://owned/' + file;
  chrome.runtime.sendMessage = vi.fn(async (message: any) => ({ success: true, value: message.data.operation === 'invoke' ? message.data.input : null })) as any;
});
afterEach(() => vi.unstubAllGlobals());
async function invocation(value = 'accepted') {
  const code = new TextEncoder().encode('module.exports=()=>({value: input=>input});');
  return { code, sha256: await bundleDigest(code), handlers: ['value'], handler: 'value', config: { mode: 'fixture' }, input: { value } };
}
it('shares preparation across concurrent calls and keeps each accepted input separate', async () => {
  const { runAcceptedBrowserPureCapability } = await import('../browserPureCapabilities');
  const first = await invocation('a'), second = await invocation('b');
  expect(await Promise.all([runAcceptedBrowserPureCapability(first), runAcceptedBrowserPureCapability(second)])).toEqual([{ value: 'a' }, { value: 'b' }]);
  expect(mocks.page).toHaveBeenCalledTimes(1);
  const messages = vi.mocked(chrome.runtime.sendMessage).mock.calls.map(([message]: any) => message);
  expect(messages.filter(message => message.data.operation === 'prepare')).toHaveLength(1);
  expect(new Set(messages.map(message => message.data.id)).size).toBe(1);
  expect(mocks.page.mock.calls[0][0]).not.toHaveProperty('input');
  expect(mocks.page.mock.calls[0][0]).not.toHaveProperty('handler');
});
it('captures code, configuration and input before awaiting digest work and checks cached resource integrity', async () => {
  const { runAcceptedBrowserPureCapability } = await import('../browserPureCapabilities');
  const input = await invocation();
  const running = runAcceptedBrowserPureCapability(input);
  input.code.fill(0); input.config.mode = 'changed'; input.input.value = 'changed'; input.handlers[0] = 'other';
  expect(await running).toEqual({ value: 'accepted' });
  expect(mocks.page.mock.calls[0][0]).toMatchObject({ config: { mode: 'fixture' }, handlers: ['value'] });
  const invalid = await invocation(); invalid.code.fill(0);
  await expect(runAcceptedBrowserPureCapability(invalid)).rejects.toThrow('digest');
  expect(mocks.page).toHaveBeenCalledTimes(1);
});
it('recreates an expired runtime once without switching accepted code', async () => {
  const { runAcceptedBrowserPureCapability } = await import('../browserPureCapabilities');
  let missing = true;
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: any) => {
    if (message.data.operation === 'invoke' && missing) { missing = false; return { success: false, error: 'PURE_RUNTIME_MISSING' }; }
    return { success: true, value: 'result' };
  });
  expect(await runAcceptedBrowserPureCapability(await invocation())).toBe('result');
  const calls = vi.mocked(chrome.runtime.sendMessage).mock.calls.map(([message]: any) => message.data);
  expect(calls.map(value => value.operation)).toEqual(['prepare', 'invoke', 'prepare', 'invoke']);
  expect(new Set(calls.map(value => value.id)).size).toBe(1);
});
