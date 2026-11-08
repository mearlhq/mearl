import { syncResponseCookies, type ResponseCookieSync } from './response-cookies.js';
/**
 * CDP HTTP proxy / PROTOCOL request / API schema handlers.
 */

import { parseRequestMetadata, type RequestMetadata, type CookieCandidate, SendRequestParams } from '@mearl/browser-core';
import { getRequestProtocolCapability, type PreparedProtocolRequest } from '../capability-contracts.js';
import type { PageSession } from './cdp-session.js';
import { nodeFetch, getCookiesForUrl } from './cdp-utils.js';
import { executeNodeSendRequest } from './send-request.js';
import { registerActions } from './action-registry.js';

export interface CdpProtocolStreamRequestMetadata {
  method: 'GET' | 'POST';
  url: string;
  requestHeaders: Array<{ name: string; value: string }>;
  metadata?: RequestMetadata;
}

export interface CdpProtocolStreamResponseMetadata {
  status: number;
  statusText: string;
  responseHeaders: Array<{ name: string; value: string }>;
}

export interface CdpProtocolStreamCallbacks {
  onRequestPrepared?: (metadata: CdpProtocolStreamRequestMetadata) => void | Promise<void>;
  onResponse?: (metadata: CdpProtocolStreamResponseMetadata) => void | Promise<void>;
  onReceive: (data: unknown) => void | Promise<void>;
}

export async function cdpSendRequest(session: PageSession, data: SendRequestParams): Promise<any> {
  if (!data.url || typeof data.url !== 'string') {
    throw new Error('Invalid url: url must be a non-empty string');
  }

  let cookies: CookieCandidate[] = [];
  if (data.withCookies !== false) {
    try {
      cookies = await getCookiesForUrl(session, new URL(data.url).toString());
    } catch {
      // Cookie injection is best-effort
    }
  }
  return executeNodeSendRequest(data, cookies, (url, headers) =>
    syncResponseCookies(session, url, headers),
  );
}

async function prepareCdpCapturedRequest(
  session: PageSession,
  data: Record<string, unknown>,
  stream = false,
  capability = getRequestProtocolCapability(),
): Promise<PreparedProtocolRequest> {
  const resolved = capability.resolveRequest(data);
  const cookies = await getCookiesForUrl(session, resolved.gatewayUrl.toString());
  const prepared = capability.prepareRequest(resolved, cookies, stream);
  return {
    ...prepared,
    metadata: parseRequestMetadata(prepared.metadata ?? resolved.metadata) ?? undefined,
    requestHeaders: {
      ...(prepared.cookieHeader ? { Cookie: prepared.cookieHeader } : {}),
      ...prepared.requestHeaders,
    },
  };
}

export async function cdpSendProtocolRequest(
  session: PageSession,
  data: Record<string, unknown>,
): Promise<any> {
  const capability = getRequestProtocolCapability();
  const prepared = await prepareCdpCapturedRequest(session, data, false, capability);
  const result = await nodeFetch(prepared.targetUrl.toString(), {
    method: prepared.normalizedMethod,
    headers: prepared.requestHeaders,
    body: prepared.body,
    timeoutMs: prepared.timeout,
  });

  const cookieSync = await syncResponseCookies(session, prepared.targetUrl.href, result.setCookies);
  return {
    success: true,
    ...(cookieSync ? { cookieSync } : {}),
    response: capability.parseResponse(result.body),
    requestData: prepared.requestData,
  };
}

export async function cdpSendProtocolStreamRequest(
  session: PageSession,
  data: Record<string, unknown>,
  callbacks: CdpProtocolStreamCallbacks,
): Promise<{ success: true; response: unknown; requestData: unknown; cookieSync?: ResponseCookieSync }> {
  const capability = getRequestProtocolCapability();
  const prepared = await prepareCdpCapturedRequest(session, data, true, capability);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), prepared.timeout);

  try {
    await callbacks.onRequestPrepared?.({
      method: prepared.normalizedMethod,
      url: prepared.targetUrl.toString(),
      requestHeaders: Object.entries(prepared.requestHeaders).map(([name, value]) => ({
        name,
        value,
      })),
      ...(prepared.metadata && { metadata: prepared.metadata }),
    });
    const response = await fetch(prepared.targetUrl, {
      method: prepared.normalizedMethod,
      headers: prepared.requestHeaders,
      body: prepared.body,
      signal: controller.signal,
      // Signed headers and path-scoped cookies apply only to the prepared URL.
      redirect: 'manual',
    });
    const cookieSync = await syncResponseCookies(
      session,
      response.url || prepared.targetUrl.href,
      response.headers.getSetCookie(),
    );
    const responseHeaders: Array<{ name: string; value: string }> = [];
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'set-cookie') responseHeaders.push({ name, value });
    });
    await callbacks.onResponse?.({
      status: response.status,
      statusText: response.statusText,
      responseHeaders,
    });

    const responseBody = await capability.consumeResponse(response, event =>
      callbacks.onReceive(event.data),
    );
    return { success: true, response: responseBody, requestData: prepared.requestData, ...(cookieSync ? { cookieSync } : {}) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`send_protocol_stream timed out after ${prepared.timeout}ms: ${prepared.api}`, {
        cause: error,
      });
    }
    throw new Error(
      `send_protocol_stream failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerActions([
  { name: 'send_request', session: 'page', handler: cdpSendRequest },
]);
