import type { RumEvent } from '@mearl/browser-core';
import { createTrackingPlugin } from '@mearl/plugin-tracking';
const builtinTracking = createTrackingPlugin();
import { prepareBrowserCapabilities } from './browserCapabilities';
import { runAcceptedBrowserPureCapability } from './browserPureCapabilities';
import { isExtensionUiSender } from './extensionMessageTrust';

export interface TrackingRequestInput {
  url: string;
  body?: string | Record<string, unknown> | null;
  options?: { now?: number; sequence?: number };
  locale?: string;
}
export interface TrackingRequestResult { available: boolean; tracking: boolean; events: RumEvent[] }
type Selection = Awaited<ReturnType<typeof prepareBrowserCapabilities>>;
let selected: Promise<Selection> | undefined;
export function invalidateBrowserTracking() { selected = undefined; }
function selection(): Promise<Selection> {
  if (!selected) {
    const pending = prepareBrowserCapabilities(['tracking.decode', 'tracking.spm']).then(value => {
      const decode = value['tracking.decode'], spm = value['tracking.spm'];
      if (decode && spm && (decode.bundleId !== spm.bundleId || decode.revision !== spm.revision)) throw new Error('Tracking handlers must belong to one implementation');
      return value;
    });
    selected = pending;
    void pending.catch(() => { if (selected === pending) selected = undefined; });
  }
  return selected;
}
interface Pending {
  input: TrackingRequestInput; bytes: number; accepted: Promise<Selection>;
  resolve(result: TrackingRequestResult): void; reject(error: unknown): void;
}
const pending: Pending[] = [];
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length) {
      const first = pending.shift()!, batch = [first];
      let bytes = first.bytes;
      while (pending[0]?.accepted === first.accepted && batch.length < 32 && bytes + pending[0].bytes <= 16 * 1024 * 1024) {
        const next = pending.shift()!; batch.push(next); bytes += next.bytes;
      }
      try {
        const handler = (await first.accepted)['tracking.decode'];
        if (!handler) {
          for (const item of batch) {
            try {
              item.resolve({ available: true, tracking: builtinTracking.tracking().matches(item.input.url), events: builtinTracking.tracking().parse(item.input.url, item.input.body, item.input.options) });
            } catch (error) { item.reject(error); }
          }
          continue;
        }
        const results = await runAcceptedBrowserPureCapability({ ...handler.invocation, input: batch.map(item => item.input) });
        if (!Array.isArray(results) || results.length !== batch.length || results.some(value => !value || typeof value.tracking !== 'boolean' || !Array.isArray(value.events) || value.error !== undefined && typeof value.error !== 'string')) throw new Error('Invalid tracking decoder result');
        for (const [index, item] of batch.entries()) {
          const result = results[index];
          if (result.error !== undefined) {
            const error = new Error(result.error); error.name = 'TrackingRequestError'; item.reject(error);
          } else item.resolve({ tracking: result.tracking, events: result.events, available: true });
        }
      } catch (error) { for (const item of batch) item.reject(error); }
    }
  } finally { draining = false; }
}
/** Requests accepted in the same turn share an immutable implementation and one sandbox call. */
function enqueue(input: TrackingRequestInput, accepted: Promise<Selection>): Promise<TrackingRequestResult> {
  const serialized = JSON.stringify(input);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > 63 * 1024 * 1024) return Promise.reject(new Error('Tracking request exceeds the browser runtime budget'));
  const captured = JSON.parse(serialized) as TrackingRequestInput;
  return new Promise((resolve, reject) => {
    pending.push({ input: captured, bytes, accepted, resolve, reject });
    queueMicrotask(() => { void drain(); });
  });
}
export function captureBrowserTrackingDecoder() {
  const accepted = selection();
  return (input: TrackingRequestInput) => enqueue(input, accepted);
}
export function decodeBrowserTrackingRequest(input: TrackingRequestInput) { return captureBrowserTrackingDecoder()(input); }
export async function resolveBrowserTrackingSpm(input: { eventType?: string; raw: Record<string, unknown> }) {
  const handler = (await selection())['tracking.spm'];
  if (!handler) return builtinTracking.spm(input);
  const result = await runAcceptedBrowserPureCapability({ ...handler.invocation, input }) as { mainSpm: string; highlightSpm: string };
  if (!result || typeof result.mainSpm !== 'string' || typeof result.highlightSpm !== 'string') throw new Error('Invalid tracking point result');
  return result;
}
export async function handleBrowserTracking(input: unknown, sender: chrome.runtime.MessageSender) {
  if (!isExtensionUiSender(sender, chrome.runtime.id)) return { success: false, error: 'Extension UI required' };
  try {
    if (!input || typeof input !== 'object') throw new Error('Expected a tracking operation');
    const value = input as Record<string, any>;
    if (value.operation === 'decode' && typeof value.input?.url === 'string') return { success: true, data: await decodeBrowserTrackingRequest(value.input) };
    if (value.operation === 'spm' && value.input?.raw && typeof value.input.raw === 'object' && !Array.isArray(value.input.raw)) return { success: true, data: await resolveBrowserTrackingSpm(value.input) };
    throw new Error('Unknown tracking operation');
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}
