import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  assertSafeSendRequestMultipartValue,
  assertSendRequestFileLimits,
  findSendRequestHeaderName,
  getSendRequestBodyFile,
  getSendRequestSourceHeaders,
  isBinarySendRequestContentType,
  serializeRequestCookies,
  type RequestCookie,
  type SendRequestParams,
} from '@mearl/browser-core';
import { resolveSendRequestFiles } from '../send-request-file-utils.js';
import { nodeFetch } from './cdp-utils.js';
import type { ResponseCookieSync } from './response-cookies.js';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

interface MultipartFileContent {
  fieldName: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = findSendRequestHeaderName(headers, name);
  if (existing && existing !== name) delete headers[existing];
  headers[name] = value;
}

function removeHeader(headers: Record<string, string>, name: string): void {
  const existing = findSendRequestHeaderName(headers, name);
  if (existing) delete headers[existing];
}

function escapeMultipartQuotedValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '%22');
}

async function readMultipartFiles(
  files: NonNullable<SendRequestParams['files']>,
): Promise<MultipartFileContent[]> {
  const resolved = await resolveSendRequestFiles(files);
  const contents = await Promise.all(
    resolved.map(async (file, index) => {
      if (file.content) return file.content;
      try {
        return await readFile(file.filePath!);
      } catch (error) {
        throw new Error(
          `Unable to read files[${index}].filePath: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }),
  );
  assertSendRequestFileLimits(contents.map(content => content.byteLength));
  return resolved.map((file, index) => ({
    fieldName: file.descriptor.fieldName,
    filename: file.descriptor.filename,
    contentType: file.descriptor.contentType,
    content: contents[index]!,
  }));
}

async function buildMultipartBody(
  formData: SendRequestParams['formData'],
  files: SendRequestParams['files'],
): Promise<{ contentType: string; body: Buffer }> {
  if (
    formData !== undefined &&
    (formData === null || typeof formData !== 'object' || Array.isArray(formData))
  ) {
    throw new Error('formData must be an object');
  }
  if (files !== undefined && !Array.isArray(files)) {
    throw new Error('files must be an array');
  }

  const resolvedFiles = await readMultipartFiles(files ?? []);
  const boundary = `----mearl-${randomUUID()}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(formData ?? {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`formData.${name} must be a string, number, or boolean`);
    }
    const safeName = escapeMultipartQuotedValue(
      assertSafeSendRequestMultipartValue(name, `formData field "${name}"`),
    );
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${String(value)}\r\n`,
      ),
    );
  }

  for (const file of resolvedFiles) {
    const fieldName = escapeMultipartQuotedValue(file.fieldName);
    const filename = escapeMultipartQuotedValue(file.filename);
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function hasMultipartPayload(data: SendRequestParams): boolean {
  return data.formData !== undefined || data.files !== undefined;
}

export async function executeNodeSendRequest(
  data: SendRequestParams,
  cookies: readonly RequestCookie[] = [],
  onResponseCookies?: (
    url: string,
    headers: readonly string[],
  ) => Promise<ResponseCookieSync | undefined>,
): Promise<any> {
  const {
    url,
    method = 'GET',
    headers = {},
    params,
    body,
    formData,
    files,
    responseType = 'auto',
    timeout = 30000,
  } = data;

  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('Invalid url: url must be a non-empty string');
  }
  const normalizedMethod = method.toUpperCase();
  if (!ALLOWED_METHODS.has(normalizedMethod)) {
    throw new Error(`Invalid method: ${method}. Allowed: ${[...ALLOWED_METHODS].join(', ')}`);
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('timeout must be a positive number');
  }

  const targetUrl = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) {
    targetUrl.searchParams.set(key, String(value));
  }

  const requestHeaders: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ...headers,
  };
  const resolvedSourceHeaders = getSendRequestSourceHeaders(targetUrl, headers);
  if (resolvedSourceHeaders.referer) {
    setHeader(requestHeaders, 'Referer', resolvedSourceHeaders.referer);
  } else {
    removeHeader(requestHeaders, 'Referer');
  }
  if (resolvedSourceHeaders.origin) {
    setHeader(requestHeaders, 'Origin', resolvedSourceHeaders.origin);
  } else {
    removeHeader(requestHeaders, 'Origin');
  }

  const cookieHeader = serializeRequestCookies(cookies);
  if (cookieHeader) setHeader(requestHeaders, 'Cookie', cookieHeader);
  const xsrfToken = cookies.find(cookie => cookie.name === 'XSRF-TOKEN')?.value;
  if (xsrfToken && !findSendRequestHeaderName(requestHeaders, 'x-xsrf-token')) {
    setHeader(requestHeaders, 'X-XSRF-TOKEN', xsrfToken);
  }

  let requestBody: string | Buffer | undefined;
  const rawBodyFile = getSendRequestBodyFile(data);
  if (rawBodyFile) {
    const [file] = await readMultipartFiles([rawBodyFile]);
    requestBody = file!.content;
    if (!findSendRequestHeaderName(requestHeaders, 'content-type')) {
      setHeader(requestHeaders, 'Content-Type', file!.contentType);
    }
    setHeader(requestHeaders, 'Content-Length', String(requestBody.byteLength));
  } else if (hasMultipartPayload(data)) {
    if (body !== undefined && body !== null) {
      throw new Error('body cannot be combined with formData or files');
    }
    if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
      throw new Error(`${normalizedMethod} requests cannot use formData or files`);
    }
    if (findSendRequestHeaderName(requestHeaders, 'content-type')) {
      throw new Error(
        'Do not set Content-Type when using formData or files; Mearl sets the boundary',
      );
    }
    const multipart = await buildMultipartBody(formData, files);
    requestBody = multipart.body;
    setHeader(requestHeaders, 'Content-Type', multipart.contentType);
    setHeader(requestHeaders, 'Content-Length', String(multipart.body.byteLength));
  } else if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(normalizedMethod)) {
    if (typeof body === 'string') {
      requestBody = body;
      if (!findSendRequestHeaderName(requestHeaders, 'content-type')) {
        setHeader(requestHeaders, 'Content-Type', 'text/plain');
      }
    } else {
      requestBody = JSON.stringify(body);
      if (!findSendRequestHeaderName(requestHeaders, 'content-type')) {
        setHeader(requestHeaders, 'Content-Type', 'application/json');
      }
    }
  }

  const result = await nodeFetch(targetUrl.toString(), {
    method: normalizedMethod,
    headers: requestHeaders,
    body: requestBody,
    timeoutMs: timeout,
  });
  const cookieSync =
    data.withCookies !== false
      ? await onResponseCookies?.(targetUrl.href, result.setCookies)
      : undefined;
  const contentType = (result.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const responseHeaders = Object.fromEntries(
    Object.entries(result.headers).filter(
      ([name]) => name.toLowerCase() !== 'set-cookie' && name.toLowerCase() !== 'set-cookie2',
    ),
  );

  let responseBody: unknown;
  let bodyType: 'json' | 'text' | 'base64';
  if (responseType === 'auto' && isBinarySendRequestContentType(contentType)) {
    responseBody = result.bodyBuffer.toString('base64');
    bodyType = 'base64';
  } else {
    const trimmed = result.body.trimStart();
    const shouldParseJson =
      responseType === 'json' ||
      (responseType === 'auto' && contentType.includes('application/json')) ||
      (responseType === 'auto' && (trimmed.startsWith('{') || trimmed.startsWith('[')));
    if (shouldParseJson) {
      try {
        responseBody = JSON.parse(result.body);
        bodyType = 'json';
      } catch {
        if (responseType === 'json') throw new Error('send_request expected a JSON response');
        responseBody = result.body;
        bodyType = 'text';
      }
    } else {
      responseBody = result.body;
      bodyType = 'text';
    }
  }

  return {
    success: true,
    status: result.status,
    statusText: result.statusText,
    headers: responseHeaders,
    body: responseBody,
    bodyType,
    attachedCookieCount: cookies.length,
    ...(cookieSync ? { cookieSync } : {}),
  };
}
