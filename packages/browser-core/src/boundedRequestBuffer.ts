import type { CapturedRequest } from './types.js';

export const REQUEST_BUFFER_MAX_ENTRIES = 500;
export const REQUEST_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
export const REQUEST_BUFFER_MAX_FIELD_BYTES = 8 * 1024 * 1024;

export interface RequestBufferAccounting {
  sizes: number[];
  totalBytes: number;
}

export interface RequestBufferLimits {
  maxEntries?: number;
  maxBytes?: number;
  maxFieldBytes?: number;
}

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function serializeForStorage(value: any): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;

  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

export function limitBufferedField(value: any, maxBytes: number): any {
  if (value === null || value === undefined) return value;

  const serialized = serializeForStorage(value);
  const originalBytes = byteLength(serialized);
  if (originalBytes <= maxBytes) return value;

  const marker = `<truncated: ${originalBytes} bytes, buffered preview>\n`;
  if (byteLength(marker) + 3 > maxBytes) {
    return truncateUtf8(`${marker}...`, maxBytes);
  }
  const previewBudget = Math.max(0, maxBytes - byteLength(marker) - 3);
  return `${marker}${truncateUtf8(serialized, previewBudget)}...`;
}

export function estimateRequestBufferBytes(request: CapturedRequest): number {
  try {
    return byteLength(JSON.stringify(request));
  } catch {
    return byteLength(String(request));
  }
}

export function createRequestBufferAccounting(): RequestBufferAccounting {
  return { sizes: [], totalBytes: 0 };
}

function synchronizeAccounting(requests: CapturedRequest[], accounting: RequestBufferAccounting): void {
  if (accounting.sizes.length === requests.length) return;
  accounting.sizes = requests.map(estimateRequestBufferBytes);
  accounting.totalBytes = accounting.sizes.reduce((total, size) => total + size, 0);
}

function applyFieldLimits(request: CapturedRequest, maxFieldBytes: number): void {
  request.postData = limitBufferedField(request.postData, maxFieldBytes);
  request.responseBody = limitBufferedField(request.responseBody, maxFieldBytes);
}

function trimRequestBuffer(
  requests: CapturedRequest[],
  accounting: RequestBufferAccounting,
  maxEntries: number,
  maxBytes: number,
): CapturedRequest[] {
  const removed: CapturedRequest[] = [];
  while (
    requests.length > 1 &&
    (requests.length > maxEntries || accounting.totalBytes > maxBytes)
  ) {
    const request = requests.shift();
    if (request) removed.push(request);
    accounting.totalBytes -= accounting.sizes.shift() ?? 0;
  }
  return removed;
}

export function appendRequestToBuffer(
  requests: CapturedRequest[],
  accounting: RequestBufferAccounting,
  request: CapturedRequest,
  limits: RequestBufferLimits = {},
): CapturedRequest[] {
  const {
    maxEntries = REQUEST_BUFFER_MAX_ENTRIES,
    maxBytes = REQUEST_BUFFER_MAX_BYTES,
    maxFieldBytes = REQUEST_BUFFER_MAX_FIELD_BYTES,
  } = limits;

  synchronizeAccounting(requests, accounting);
  applyFieldLimits(request, maxFieldBytes);

  const size = estimateRequestBufferBytes(request);
  requests.push(request);
  accounting.sizes.push(size);
  accounting.totalBytes += size;
  return trimRequestBuffer(requests, accounting, maxEntries, maxBytes);
}

export function refreshRequestInBuffer(
  requests: CapturedRequest[],
  accounting: RequestBufferAccounting,
  request: CapturedRequest,
  limits: RequestBufferLimits = {},
): CapturedRequest[] {
  const {
    maxEntries = REQUEST_BUFFER_MAX_ENTRIES,
    maxBytes = REQUEST_BUFFER_MAX_BYTES,
    maxFieldBytes = REQUEST_BUFFER_MAX_FIELD_BYTES,
  } = limits;
  const index = requests.indexOf(request);
  if (index === -1) return [];

  synchronizeAccounting(requests, accounting);
  applyFieldLimits(request, maxFieldBytes);

  const previousSize = accounting.sizes[index] ?? 0;
  const nextSize = estimateRequestBufferBytes(request);
  accounting.sizes[index] = nextSize;
  accounting.totalBytes += nextSize - previousSize;
  return trimRequestBuffer(requests, accounting, maxEntries, maxBytes);
}
