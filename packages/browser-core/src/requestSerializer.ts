/**
 * Request serialization utilities — pure computation, no environment dependencies.
 */

import type { CapturedRequest } from './types.js';
import { getStructure } from './dataStructure.js';

export interface SerializeOptions {
  includeBody?: boolean;
  includeHeaders?: boolean;
  maxBodySize?: number;
  fields?: string[];
  keysOnly?: boolean;
}

// ─── Path utilities ───────────────────────────────────────────────────────────

function parsePath(path: string): (string | number)[] {
  if (path.length > 1000) throw new Error('Path too long: maximum 1000 characters allowed');
  const keys: (string | number)[] = [];
  let current = '';
  for (let i = 0; i < path.length; i++) {
    const char = path[i];
    if (char === '.') {
      if (current) {
        keys.push(current);
        current = '';
      }
    } else if (char === '[') {
      if (current) {
        keys.push(current);
        current = '';
      }
      let j = i + 1;
      while (j < path.length && path[j] !== ']') j++;
      if (j < path.length) {
        const index = parseInt(path.substring(i + 1, j), 10);
        if (!isNaN(index)) {
          if (index < 0 || index > 100000)
            throw new Error(`Array index out of safe range: ${index}`);
          keys.push(index);
        }
        i = j;
      }
    } else {
      current += char;
    }
  }
  if (current) keys.push(current);
  if (keys.length > 50) throw new Error('Path too deep: maximum 50 levels allowed');
  return keys;
}

function getValueByPath(obj: any, path: string): any {
  const keys = parsePath(path);
  let current = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

export function setValueByPath(obj: any, path: string, value: any): void {
  const keys = parsePath(path);
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];
    if (current[key] === null || current[key] === undefined) {
      current[key] = typeof nextKey === 'number' ? [] : {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

// ─── Structure helpers ────────────────────────────────────────────────────────

function truncateData(data: any, maxSize: number): any {
  const str = JSON.stringify(data);
  if (str.length <= maxSize) return data;
  const truncated = str.substring(0, maxSize);
  return `<truncated: ${str.length} bytes, showing first ${maxSize} chars>\n${truncated}...`;
}

function extractFields(data: any, fields: string[]): Record<string, any> {
  if (fields.length > 100) throw new Error('Too many fields: maximum 100 fields allowed');
  const result: Record<string, any> = {};
  for (const fieldPath of fields) {
    try {
      result[fieldPath] = getValueByPath(data, fieldPath);
    } catch (error) {
      result[fieldPath] = `<error: ${error instanceof Error ? error.message : 'field not found'}>`;
    }
  }
  return result;
}

// ─── Serializer ───────────────────────────────────────────────────────────────

export function serializeRequest(request: CapturedRequest, options: SerializeOptions = {}): any {
  const {
    fields,
    includeBody = !fields?.length,
    includeHeaders = false,
    maxBodySize = 50000,
    keysOnly = false,
  } = options;

  const result: any = {
    id: request.id,
    timestamp: request.timestamp,
    timestampMs: request.timestampMs,
    method: request.method,
    url: request.url,
    apiName: request.apiName,
    status: request.status,
    statusText: request.statusText,
    queryString: request.queryString,
    duration: request.duration,
    captureSequence: request.captureSequence,
    isPending: request.isPending,
    isSSE: request.isSSE,
    source: request.source,
    resourceType: request.resourceType,
  };

  if (includeHeaders) {
    result.headers = request.headers;
    result.responseHeaders = request.responseHeaders;
  }

  if (keysOnly) {
    result.postDataStructure = request.postData ? getStructure(request.postData) : null;
    result.responseBodyStructure = request.responseBody ? getStructure(request.responseBody) : null;
    return result;
  }

  if (includeBody) {
    result.postData =
      request.postData == null ? request.postData : truncateData(request.postData, maxBodySize);
    result.responseBody =
      request.responseBody == null
        ? request.responseBody
        : truncateData(request.responseBody, maxBodySize);
  }

  if (fields && fields.length > 0) {
    result.extractedFields = extractFields(request.responseBody, fields);
  }

  return result;
}
