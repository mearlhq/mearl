import { parseRequestMetadata, type RequestMetadata } from '@mearl/browser-core';
import { prepareBrowserCapabilities } from './browserCapabilities';
import { runAcceptedBrowserPureCapability } from './browserPureCapabilities';
import { isExtensionUiSender } from './extensionMessageTrust';

interface Input { url: string; body?: unknown }
type Selection = Awaited<ReturnType<typeof prepareBrowserCapabilities>>;
let selection: Promise<Selection> | undefined;
export function invalidateRequestInspection() { selection = undefined; }
interface Pending { input: Input; bytes: number; accepted: Promise<Selection>; resolve(value: RequestMetadata | null): void; reject(reason: unknown): void }
const pending: Pending[] = [];
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length) {
      const first = pending.shift()!, batch = [first];
      let bytes = first.bytes;
      while (pending[0]?.accepted === first.accepted && batch.length < 32 && bytes + pending[0].bytes <= 16 * 1024 * 1024) { const next = pending.shift()!; bytes += next.bytes; batch.push(next); }
      try {
        const handler = (await first.accepted)['request.inspect'];
        if (!handler) { for (const item of batch) item.resolve(null); continue; }
        const results = await runAcceptedBrowserPureCapability({ ...handler.invocation, input: batch.map(item => item.input) });
        if (!Array.isArray(results) || results.length !== batch.length) throw new Error('Invalid request inspection batch');
        for (const [index, item] of batch.entries()) {
          try { item.resolve(parseRequestMetadata(results[index])); } catch (error) { item.reject(error); }
        }
      } catch (error) { for (const item of batch) item.reject(error); }
    }
  } finally { draining = false; }
}
export function inspectBrowserRequest(input: Input): Promise<RequestMetadata | null> {
  if (!selection) {
    const preparing = prepareBrowserCapabilities(['request.inspect']);
    selection = preparing;
    void preparing.catch(() => { if (selection === preparing) selection = undefined; });
  }
  const accepted = selection;
  const serialized = JSON.stringify(input);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > 63 * 1024 * 1024) return Promise.reject(new Error('Request inspection exceeds the browser runtime budget'));
  const captured = JSON.parse(serialized) as Input;
  return new Promise((resolve, reject) => {
    pending.push({ input: captured, bytes, accepted, resolve, reject });
    queueMicrotask(() => { void drain(); });
  });
}
export async function handleRequestInspection(input: any, sender: chrome.runtime.MessageSender) {
  if (!isExtensionUiSender(sender, chrome.runtime.id)) return { success: false, error: 'Extension UI required' };
  try {
    if (input?.operation === 'import') {
      const handler = (await prepareBrowserCapabilities(['request.import']))['request.import'];
      return { success: true, data: handler ? await runAcceptedBrowserPureCapability({ ...handler.invocation, input: input.input }) : null };
    }
    if (!input || typeof input.url !== 'string') throw new Error('Request URL required');
    return { success: true, data: await inspectBrowserRequest(input) };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}
