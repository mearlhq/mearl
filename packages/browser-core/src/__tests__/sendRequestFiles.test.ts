import { describe, expect, it } from 'vitest';
import {
  SEND_REQUEST_MAX_FILES,
  SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES,
  SEND_REQUEST_MAX_TOTAL_FILE_BYTES,
  assertSafeSendRequestMultipartValue,
  assertSendRequestBase64FileLimits,
  assertSendRequestFileLimits,
  decodeSendRequestBase64Bytes,
  findSendRequestHeaderName,
  inferSendRequestContentType,
  isBinarySendRequestContentType,
  getSendRequestBodyFile,
} from '../index';

describe('send_request file utilities', () => {
  it('validates mutually exclusive raw binary body sources', () => {
    expect(
      getSendRequestBodyFile({
        url: 'https://example.test',
        method: 'POST',
        bodyFile: { base64: 'AA==' },
      }),
    ).toMatchObject({ fieldName: 'body', base64: 'AA==', contentType: 'application/octet-stream' });
    for (const request of [
      { method: 'GET', bodyFile: { base64: 'AA==' } },
      { method: 'POST', bodyFile: { base64: 'AA==', filePath: '/tmp/file' } },
      { method: 'POST', body: '', bodyFile: { base64: 'AA==' } },
      { method: 'POST', files: [], bodyFile: { base64: 'AA==' } },
      { method: 'POST', formData: {}, bodyFile: { base64: 'AA==' } },
      { method: 'POST', bodyFile: { base64: 'AA==', contentType: 'image/png\r\nx: y' } },
    ])
      expect(() =>
        getSendRequestBodyFile({ url: 'https://example.test', ...request } as any),
      ).toThrow();
  });
  it('infers known MIME types case-insensitively', () => {
    expect(inferSendRequestContentType('logo.PNG')).toBe('image/png');
    expect(inferSendRequestContentType('archive.unknown')).toBe('application/octet-stream');
  });

  it('normalizes valid base64 and rejects invalid payloads', () => {
    expect(decodeSendRequestBase64Bytes(' YWJj\n', 'payload')).toEqual(
      new Uint8Array([97, 98, 99]),
    );
    expect(() => decodeSendRequestBase64Bytes('a===', 'payload')).toThrow(
      'payload must be valid base64',
    );
    expect(() => decodeSendRequestBase64Bytes('YQ=', 'payload')).toThrow(
      'payload must be valid base64',
    );
    expect(() => decodeSendRequestBase64Bytes('A=', 'payload')).toThrow(
      'payload must be valid base64',
    );
  });

  it('shares header and response content-type detection across transports', () => {
    expect(findSendRequestHeaderName({ 'content-TYPE': 'text/plain' }, 'Content-Type')).toBe(
      'content-TYPE',
    );
    expect(isBinarySendRequestContentType('image/png')).toBe(true);
    expect(isBinarySendRequestContentType('application/json')).toBe(false);
  });

  it('rejects unsafe multipart metadata', () => {
    expect(assertSafeSendRequestMultipartValue('file', 'fieldName')).toBe('file');
    expect(() => assertSafeSendRequestMultipartValue('bad\r\nname', 'fieldName')).toThrow(
      'without control characters',
    );
  });

  it('enforces file count and aggregate byte limits', () => {
    expect(() => assertSendRequestFileLimits([SEND_REQUEST_MAX_TOTAL_FILE_BYTES])).not.toThrow();
    expect(() =>
      assertSendRequestFileLimits(new Array(SEND_REQUEST_MAX_FILES + 1).fill(0)),
    ).toThrow(`files exceeds maximum of ${SEND_REQUEST_MAX_FILES}`);
    expect(() => assertSendRequestFileLimits([SEND_REQUEST_MAX_TOTAL_FILE_BYTES + 1])).toThrow(
      'files total size exceeds',
    );
    expect(() =>
      assertSendRequestBase64FileLimits([SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES]),
    ).not.toThrow();
    expect(() =>
      assertSendRequestBase64FileLimits([SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES + 1]),
    ).toThrow('base64 files total size exceeds');
    expect(Math.ceil(SEND_REQUEST_MAX_TOTAL_BASE64_FILE_BYTES / 3) * 4).toBeLessThan(
      10 * 1024 * 1024,
    );
  });
});
