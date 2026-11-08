import {
  SEND_REQUEST_MAX_FILES,
  SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES,
  SEND_REQUEST_MAX_TOTAL_FILE_BYTES,
  type SendRequestParams,
  type SendRequestFile,
} from './browserActionProtocol.js';

const MIME_TYPES: Record<string, string> = {
  '.apng': 'image/apng',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

export function getSendRequestBodyFile(data: SendRequestParams): SendRequestFile | undefined {
  if (data.bodyFile === undefined) return undefined;
  if (data.body !== undefined || data.formData !== undefined || data.files !== undefined) {
    throw new Error('bodyFile cannot be combined with body, formData or files');
  }
  const method = (data.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD')
    throw new Error(`${method} requests cannot use bodyFile`);
  const file = data.bodyFile;
  if (
    !file ||
    typeof file !== 'object' ||
    Array.isArray(file) ||
    Object.keys(file).some(key => !['filePath', 'base64', 'contentType'].includes(key))
  ) {
    throw new Error('bodyFile must contain filePath or base64, and optional contentType');
  }
  if ((file.filePath !== undefined) === (file.base64 !== undefined)) {
    throw new Error('bodyFile requires exactly one of filePath or base64');
  }
  const contentType =
    file.contentType === undefined
      ? 'application/octet-stream'
      : assertSafeSendRequestMultipartValue(file.contentType, 'bodyFile.contentType');
  return { ...file, fieldName: 'body', filename: 'body.bin', contentType } as SendRequestFile;
}

export function assertSafeSendRequestMultipartValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty string without control characters`);
  }
  return value;
}

function normalizeSendRequestBase64(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a base64 string`);
  const normalized = value.replace(/\s+/g, '');
  const paddingLength = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const contentLength = normalized.length - paddingLength;
  const hasValidCharacters = /^[A-Za-z0-9+/]*={0,2}$/.test(normalized);
  const hasValidContentLength = contentLength % 4 !== 1;
  const hasValidPadding =
    paddingLength === 0 ||
    (normalized.length % 4 === 0 &&
      ((paddingLength === 1 && contentLength % 4 === 3) ||
        (paddingLength === 2 && contentLength % 4 === 2)));
  if (!hasValidCharacters || !hasValidContentLength || !hasValidPadding) {
    throw new Error(`${label} must be valid base64`);
  }
  return normalized;
}

export function decodeSendRequestBase64Bytes(
  value: unknown,
  label: string,
): Uint8Array<ArrayBuffer> {
  const normalized = normalizeSendRequestBase64(value, label);
  let binary: string;
  try {
    binary = atob(normalized);
  } catch (error) {
    throw new Error(`${label} must be valid base64`, { cause: error });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function inferSendRequestContentType(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  const extension = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

export function findSendRequestHeaderName(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  return Object.keys(headers).find(key => key.toLowerCase() === normalized);
}

export function isBinarySendRequestContentType(contentType: string): boolean {
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('font/') ||
    contentType === 'application/octet-stream' ||
    contentType === 'application/pdf' ||
    contentType === 'application/zip' ||
    contentType === 'application/gzip' ||
    contentType === 'application/x-gzip' ||
    contentType === 'application/x-tar' ||
    contentType === 'application/x-bzip2' ||
    contentType === 'application/wasm'
  );
}

export function assertSendRequestFileCount(fileCount: number): void {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new Error('files length must be a non-negative safe integer');
  }
  if (fileCount > SEND_REQUEST_MAX_FILES) {
    throw new Error(`files exceeds maximum of ${SEND_REQUEST_MAX_FILES}`);
  }
}

export function assertSendRequestFileLimits(byteLengths: readonly number[]): void {
  assertSendRequestFileCount(byteLengths.length);
  let totalBytes = 0;
  for (let index = 0; index < byteLengths.length; index += 1) {
    const byteLength = byteLengths[index];
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(`files[${index}].byteLength must be a non-negative safe integer`);
    }
    totalBytes += byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SEND_REQUEST_MAX_TOTAL_FILE_BYTES) {
      throw new Error(`files total size exceeds ${SEND_REQUEST_MAX_TOTAL_FILE_BYTES} byte limit`);
    }
  }
}

export function assertSendRequestBase64FileLimits(byteLengths: readonly number[]): void {
  let totalBytes = 0;
  for (let index = 0; index < byteLengths.length; index += 1) {
    const byteLength = byteLengths[index];
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(`base64 files[${index}].byteLength must be a non-negative safe integer`);
    }
    totalBytes += byteLength;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES
    ) {
      throw new Error(
        `base64 files total size exceeds ${SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES} byte limit`,
      );
    }
  }
}
