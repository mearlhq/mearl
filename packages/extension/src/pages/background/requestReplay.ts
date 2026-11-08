import { parseJsonResponseText } from '@mearl/browser-core';
import { prepareBrowserCapabilities, authorizeBrowserCapabilityUrl } from './browserCapabilities';
import { runAcceptedBrowserPureCapability } from './browserPureCapabilities';
import { collectCookies, withCookieInjection } from './utils/dnr';

export async function replayProtocolRequest(input: { originalUrl: string; requestData: unknown }) {
  const accepted = (await prepareBrowserCapabilities(['request.replay.prepare']))['request.replay.prepare'];
  if (!accepted) throw new Error('Request replay capability is not installed');
  const original = await authorizeBrowserCapabilityUrl(input.originalUrl);
  const cookies = await collectCookies(original);
  const prepared = await runAcceptedBrowserPureCapability({ ...accepted.invocation, input: { request: input, cookies } }) as { url: string; method: string; headers: Record<string, string>; body?: string };
  const target = await authorizeBrowserCapabilityUrl(prepared.url);
  if (target.origin !== original.origin || !['GET', 'POST'].includes(prepared.method)) throw new Error('Invalid request replay target');
  const response = await withCookieInjection(target, () => fetch(target, { method: prepared.method, headers: prepared.headers, body: prepared.body, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(30_000) }));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return { success: true, response: parseJsonResponseText(await response.text()), requestData: input.requestData };
}
