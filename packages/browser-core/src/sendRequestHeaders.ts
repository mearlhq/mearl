import { findSendRequestHeaderName } from './sendRequestFiles.js';

export interface SendRequestSourceHeaders {
  referer?: string;
  origin?: string;
}

function resolveHeader(
  headers: Record<string, string>,
  name: string,
  fallback: string,
): string | undefined {
  const key = findSendRequestHeaderName(headers, name);
  if (!key) return fallback;
  return headers[key] === '' ? undefined : headers[key];
}

export function getSendRequestSourceHeaders(
  targetUrl: URL,
  headers: Record<string, string> = {},
): SendRequestSourceHeaders {
  return {
    referer: resolveHeader(headers, 'Referer', `${targetUrl.origin}/mearl`),
    origin: resolveHeader(headers, 'Origin', targetUrl.origin),
  };
}
