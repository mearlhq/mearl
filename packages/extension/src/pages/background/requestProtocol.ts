import { runAcceptedBrowserPureCapability } from './browserPureCapabilities';
import { prepareAppProfileCapabilities } from './appProfileHostCapabilities';
import { parseRequestMetadata, type RequestMetadata, type RequestCookie, type AppProfileHostCapabilities } from '@mearl/browser-core';
import { BundleError } from '@mearl/preset/bundles';
import { authorizeBrowserCapabilityUrl } from './browserCapabilities';
import { collectCookies } from './utils/dnr';

interface ResolvedProtocolRequest {
  requestData: unknown; normalizedMethod: 'GET' | 'POST'; timeout: number;
  gatewayUrl: string; customHeaders: Record<string, string>;
  metadata?: RequestMetadata;
}
export interface PreparedProtocolRequest extends Omit<ResolvedProtocolRequest, 'gatewayUrl'> {
  gatewayUrl: URL; targetUrl: URL; requestHeaders: Record<string, string>; cookieHeader: string; body?: string;
  cookies: RequestCookie[];
  streamError(text: string): Promise<Error>;
}

/** Every phase of one request keeps the same accepted protocol implementation. */
export async function prepareProtocolRequest(input: Record<string, unknown>, stream: boolean, snapshot?: AppProfileHostCapabilities): Promise<PreparedProtocolRequest> {
  const hooks = ['request.protocol.resolve', 'request.protocol.prepare', 'request.protocol.streamError'] as const;
  const accepted = await prepareAppProfileCapabilities([...hooks], snapshot);
  const resolve = accepted[hooks[0]], prepare = accepted[hooks[1]], error = accepted[hooks[2]];
  if (!resolve || !prepare || !error) throw new Error('REQUEST_PROTOCOL_NOT_INSTALLED');
  if ([prepare, error].some(value => value.bundleId !== resolve.bundleId || value.revision !== resolve.revision)) throw new BundleError('BUNDLE_INVALID', 'Request protocol handlers must belong to one implementation');
  const resolved = await runAcceptedBrowserPureCapability({ ...resolve.invocation, input }) as ResolvedProtocolRequest;
  const gatewayUrl = await authorizeBrowserCapabilityUrl(resolved.gatewayUrl);
  const cookies = await collectCookies(gatewayUrl);
  const value = await runAcceptedBrowserPureCapability({ ...prepare.invocation, input: { resolved, cookies, stream } }) as Omit<PreparedProtocolRequest, 'gatewayUrl' | 'targetUrl' | 'cookies' | 'streamError'> & { gatewayUrl: string; targetUrl: string };
  const targetUrl = await authorizeBrowserCapabilityUrl(value.targetUrl);
  if (!Number.isFinite(value.timeout) || value.timeout <= 0 || !['GET', 'POST'].includes(value.normalizedMethod)) throw new Error('Invalid prepared protocol request');
  const metadata = parseRequestMetadata(value.metadata ?? resolved.metadata) ?? undefined;
  return { ...value, metadata, gatewayUrl, targetUrl, cookies,
    streamError: async text => new Error(String(await runAcceptedBrowserPureCapability({ ...error.invocation, input: { text } }))),
  };
}
