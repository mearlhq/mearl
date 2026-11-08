import type { CapturedRequest } from './types.js';

export interface RequestStreamCapture {
  request: CapturedRequest;
  startTimeMs: number;
  lastMessageTimeMs?: number;
}

export interface RequestStreamCaptureStart {
  id: number;
  api: string;
  url: string;
  source?: CapturedRequest['source'];
  namespace?: string;
  environment?: string;
  method: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  requestData?: unknown;
  timestampMs?: number;
  tabId?: number;
  captureSequence: number;
}

export interface RequestStreamCaptureResponse {
  status: number;
  statusText: string;
  responseHeaders: Array<{ name: string; value: string }>;
}

function parseRequestData(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function parseQueryString(url: string): Array<{ name: string; value: string }> {
  const queryString: Array<{ name: string; value: string }> = [];
  try {
    new URL(url).searchParams.forEach((value, name) => queryString.push({ name, value }));
  } catch {
    // Synthetic request URLs retain an empty query.
  }
  return queryString;
}

function redactSensitiveHeaders(
  headers: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  const sensitiveNames = new Set(['authorization', 'cookie', 'proxy-authorization']);
  return headers.map(header =>
    sensitiveNames.has(header.name.toLowerCase()) ? { ...header, value: '<redacted>' } : header,
  );
}

export function createRequestStreamCapture(data: RequestStreamCaptureStart): RequestStreamCapture {
  const timestampMs = data.timestampMs ?? Date.now();
  const url = data.url;
  return {
    startTimeMs: timestampMs,
    request: {
      id: data.id,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      method: data.method,
      url,
      apiName: data.api,
      ...(data.namespace !== undefined ? { namespace: data.namespace } : {}),
      ...(data.environment !== undefined ? { environment: data.environment } : {}),
      status: 0,
      statusText: 'SSE Streaming',
      headers: redactSensitiveHeaders(data.requestHeaders ?? []),
      responseHeaders: [],
      queryString: parseQueryString(url),
      postData: parseRequestData(data.requestData ?? null),
      responseBody: [],
      isProxy: true,
      proxyRequestUrl: null,
      proxyData: null,
      isSSE: true,
      isPending: true,
      ...(data.tabId !== undefined ? { tabId: data.tabId } : {}),
      source: data.source ?? 'requests',
      resourceType: 'fetch',
      captureSequence: data.captureSequence,
    },
  };
}

export function updateRequestStreamCaptureResponse(
  capture: RequestStreamCapture,
  response: RequestStreamCaptureResponse,
): void {
  capture.request.status = response.status;
  capture.request.statusText = response.statusText;
  capture.request.responseHeaders = response.responseHeaders;
}

export function appendRequestStreamCaptureChunk(
  capture: RequestStreamCapture,
  data: unknown,
  timestampMs = Date.now(),
): boolean {
  if (!Array.isArray(capture.request.responseBody)) return false;
  capture.request.responseBody.push({
    event: 'message',
    data,
    timestamp: timestampMs,
    duration: capture.lastMessageTimeMs === undefined ? 0 : timestampMs - capture.lastMessageTimeMs,
  });
  capture.lastMessageTimeMs = timestampMs;
  return true;
}

export function finishRequestStreamCapture(
  capture: RequestStreamCapture,
  options: { timestampMs?: number; error?: string } = {},
): void {
  const timestampMs = options.timestampMs ?? Date.now();
  capture.request.isPending = false;
  capture.request.duration = Math.max(0, timestampMs - capture.startTimeMs);
  if (options.error) {
    capture.request.statusText = options.error;
    if (Array.isArray(capture.request.responseBody) && capture.request.responseBody.length === 0) {
      capture.request.responseBody = { error: options.error };
    }
    return;
  }
  if (capture.request.status === 0) capture.request.status = 200;
  if (!capture.request.statusText || capture.request.statusText === 'SSE Streaming') {
    capture.request.statusText = 'OK';
  }
}
