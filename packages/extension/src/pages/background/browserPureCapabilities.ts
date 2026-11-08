import { clonePresetDefaults } from '@mearl/preset';
import { buildBrowserPureCapabilityPage, bundleDigest, MAX_BUNDLE_BYTES, type BrowserCapabilityInvocation } from '@mearl/preset/bundles';
import { withOffscreenDocument } from './offscreenDocument';

const TARGET = 'mearl-browser-pure-runtime';
const IDLE_TARGET = 'mearl-browser-pure-idle';
const preparation = new Map<string, Promise<void>>();
export async function runAcceptedBrowserPureCapability(input: BrowserCapabilityInvocation): Promise<unknown> {
  if (!(input.code instanceof Uint8Array) || !input.code.byteLength || input.code.byteLength > MAX_BUNDLE_BYTES || !Array.isArray(input.handlers)) throw new Error('Invalid pure browser module');
  const code = Uint8Array.from(input.code), sha256 = input.sha256, handlers = [...input.handlers], handler = input.handler;
  const config = clonePresetDefaults(input.config ?? {});
  if (!handler || !handlers.includes(handler)) throw new Error('Unknown pure browser handler');
  let acceptedInput: unknown;
  try {
    const serialized = JSON.stringify(input.input);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > 64 * 1024 * 1024) throw new Error('Pure browser input exceeds 64 MiB');
    acceptedInput = serialized === undefined ? undefined : JSON.parse(serialized);
  } catch (error) { throw new Error('Invalid pure browser input', { cause: error }); }
  if (await bundleDigest(code) !== sha256) throw new Error('Pure browser module digest does not match');
  const id = await bundleDigest(new TextEncoder().encode(JSON.stringify({ sha256, handlers, config })));
  const request = async (operation: string, extra = {}) => {
    const result = await chrome.runtime.sendMessage({ target: TARGET, data: { operation, id, ...extra } });
    if (!result?.success) throw new Error(result?.error || 'Pure browser runtime failed');
    return result.value;
  };
  return withOffscreenDocument(async () => {
    const prepare = async () => {
      let pending = preparation.get(id);
      if (!pending) {
        pending = buildBrowserPureCapabilityPage({ code, sha256, handlers, config }).then(html => request('prepare', { html })).then(() => {});
        preparation.set(id, pending);
        void pending.catch(() => { if (preparation.get(id) === pending) preparation.delete(id); });
      }
      await pending;
    };
    await prepare();
    try { return await request('invoke', { handler, input: acceptedInput }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'PURE_RUNTIME_MISSING') throw error;
      preparation.delete(id); await prepare();
      return request('invoke', { handler, input: acceptedInput });
    }
  });
}
export function initializeBrowserPureCapabilities() {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.target !== IDLE_TARGET || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('src/pages/offscreen/index.html')) return;
    preparation.clear();
    void withOffscreenDocument(async () => {}).catch(console.warn);
  });
}
