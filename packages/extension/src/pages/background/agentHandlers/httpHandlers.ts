import { prepareProtocolRequest, type PreparedProtocolRequest } from '../requestProtocol';
import type { ResponseOverride } from '../../../shared/types';
/**
 * HTTP requests and App protocol bridge transport.
 */

import { collectCookies, buildDnrHeaders, fetchWithDnr } from '../utils/dnr';
import {
  assertSafeSendRequestMultipartValue,
  assertSendRequestBase64FileLimits,
  assertSendRequestFileCount,
  assertSendRequestFileLimits,
  decodeSendRequestBase64Bytes,
  findSendRequestHeaderName,
  getSendRequestBodyFile,
  consumeSseResponse,
  UnexpectedSseResponseError,
  inferSendRequestContentType,
  isBinarySendRequestContentType,
  parseJsonResponseText,
  type SendRequestFile,
  type AppProfileHostCapabilities,
  type SendRequestParams,
  type RequestCookie,
  type RequestMetadata,
} from '@mearl/browser-core';
import {
  consumeSendRequestFileTransfer,
  type TransferredRequestFile,
} from './sendRequestFileTransfer';

interface PreparedCapturedRequest extends PreparedProtocolRequest {
  dnrHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[];
}

export interface ProtocolStreamRequestMetadata {
  method: 'GET' | 'POST';
  url: string;
  requestHeaders: Array<{ name: string; value: string }>;
  metadata?: RequestMetadata;
}

export interface ProtocolStreamResponseMetadata {
  status: number;
  statusText: string;
  responseHeaders: Array<{ name: string; value: string }>;
}

async function prepareCapturedRequest(
  data: Record<string, unknown>,
  stream = false,
  snapshot?: AppProfileHostCapabilities,
): Promise<PreparedCapturedRequest> {
  const prepared = await prepareProtocolRequest(data, stream, snapshot);
  return { ...prepared, dnrHeaders: buildDnrHeaders(prepared.targetUrl, prepared.cookies, false, prepared.customHeaders) };
}

function createProtocolFetchOptions(prepared: PreparedCapturedRequest): RequestInit {
  const options: RequestInit = {
    method: prepared.normalizedMethod,
    credentials: 'include',
    headers: prepared.requestHeaders,
  };
  if (prepared.body !== undefined) options.body = prepared.body;
  return options;
}

function collectEffectiveCapturedRequestHeaders(
  fetchHeaders: Record<string, string>,
  dnrHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[],
): Array<{ name: string; value: string }> {
  const headers = new Map<string, { name: string; value: string }>();
  const setHeader = (name: string, value: string, append = false) => {
    const key = name.toLowerCase();
    const existing = headers.get(key);
    headers.set(key, {
      name: existing?.name ?? name,
      value: append && existing ? `${existing.value}, ${value}` : value,
    });
  };

  for (const [name, value] of Object.entries(fetchHeaders)) setHeader(name, value);
  for (const header of dnrHeaders) {
    const key = header.header.toLowerCase();
    if (header.operation === 'remove') {
      headers.delete(key);
      continue;
    }
    if (header.value === undefined) continue;
    setHeader(header.header, header.value, header.operation === 'append');
  }
  return [...headers.values()];
}

export async function handleSendProtocolRequest(
  data: Record<string, unknown>,
  snapshot?: AppProfileHostCapabilities,
  onRequestPrepared?: (metadata: ProtocolStreamRequestMetadata) => void,
  selectOverride?: (request: { url: string; postData?: string }) => Pick<ResponseOverride, 'responseData' | 'duration'> | undefined,
): Promise<{
  success: boolean;
  response?: any;
  requestData?: any;
  error?: string;
}> {
  const prepared = await prepareCapturedRequest(data, false, snapshot);
  const url = prepared.targetUrl.toString();
  onRequestPrepared?.({
    method: prepared.normalizedMethod,
    url,
    requestHeaders: collectEffectiveCapturedRequestHeaders(prepared.requestHeaders, prepared.dnrHeaders),
    ...(prepared.metadata && { metadata: prepared.metadata }),
  });
  const override = selectOverride?.({
    url,
    postData: prepared.body ?? JSON.stringify({ data: prepared.requestData }),
  });
  const overrideResponse = typeof override?.responseData === 'string'
    ? parseJsonResponseText(override.responseData)
    : override?.responseData;
  if (override?.duration !== undefined) {
    if (override.duration > 0) await new Promise(resolve => setTimeout(resolve, override.duration));
    return { success: true, response: overrideResponse, requestData: prepared.requestData };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), prepared.timeout);

  try {
    return await fetchWithDnr(prepared.targetUrl, prepared.dnrHeaders, async () => {
      const fetchOptions = createProtocolFetchOptions(prepared);
      fetchOptions.signal = controller.signal;
      const response = await fetch(url, fetchOptions);

      const responseText = await response.text();
      return {
        success: true,
        response: override ? overrideResponse : parseJsonResponseText(responseText),
        requestData: prepared.requestData,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`App protocol request timed out after ${prepared.timeout}ms: ${prepared.targetUrl.origin}`, {
        cause: error,
      });
    }
    throw new Error(
      `App protocol request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function handleSendProtocolStreamRequest(
  data: Record<string, unknown>,
  onReceive: (data: unknown) => void,
  onRequestPrepared?: (metadata: ProtocolStreamRequestMetadata) => void,
  onResponse?: (metadata: ProtocolStreamResponseMetadata) => void,
  snapshot?: AppProfileHostCapabilities,
): Promise<{ success: true; response: unknown; requestData: unknown }> {
  const prepared = await prepareCapturedRequest(data, true, snapshot);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), prepared.timeout);
  try {
    const responseBody = await fetchWithDnr(prepared.targetUrl, prepared.dnrHeaders, async () => {
      const fetchOptions = createProtocolFetchOptions(prepared);
      fetchOptions.signal = controller.signal;
      onRequestPrepared?.({
        method: prepared.normalizedMethod,
        url: prepared.targetUrl.toString(),
        requestHeaders: collectEffectiveCapturedRequestHeaders(
          fetchOptions.headers as Record<string, string>,
          prepared.dnrHeaders,
        ),
        ...(prepared.metadata && { metadata: prepared.metadata }),
      });
      const response = await fetch(prepared.targetUrl.toString(), fetchOptions);
      const responseHeaders: Array<{ name: string; value: string }> = [];
      response.headers.forEach((value, name) => responseHeaders.push({ name, value }));
      onResponse?.({
        status: response.status,
        statusText: response.statusText,
        responseHeaders,
      });
      try { return await consumeSseResponse(response, event => onReceive(event.data)); }
      catch (error) { if (error instanceof UnexpectedSseResponseError) throw await prepared.streamError(error.body); throw error; }
    });
    return { success: true, response: responseBody, requestData: prepared.requestData };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`send_protocol_stream timed out after ${prepared.timeout}ms: ${prepared.targetUrl.origin}`, {
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

// ─── send_request ────────────────────────────────────────────────────────────

function resolveInlineRequestFiles(files: SendRequestFile[]): TransferredRequestFile[] {
  assertSendRequestFileCount(files.length);
  const resolved = files.map((file, index) => {
    if (!file || typeof file !== 'object') {
      throw new Error(`files[${index}] must be an object`);
    }
    if (file.filePath) {
      throw new Error(
        `files[${index}].filePath must be transferred by Mearl native-host before reaching the extension`,
      );
    }
    if (typeof file.base64 !== 'string') {
      throw new Error(`files[${index}] must provide base64 content`);
    }
    const filename = assertSafeSendRequestMultipartValue(file.filename, `files[${index}].filename`);
    const contentType =
      typeof file.contentType === 'string' && file.contentType.trim()
        ? assertSafeSendRequestMultipartValue(
            file.contentType.trim(),
            `files[${index}].contentType`,
          )
        : inferSendRequestContentType(filename);
    const bytes = decodeSendRequestBase64Bytes(file.base64, `files[${index}].base64`);
    return {
      fieldName: assertSafeSendRequestMultipartValue(file.fieldName, `files[${index}].fieldName`),
      filename,
      contentType,
      file: new File([bytes], filename, {
        type: contentType,
      }),
    };
  });
  assertSendRequestFileLimits(resolved.map(file => file.file.size));
  assertSendRequestBase64FileLimits(resolved.map(file => file.file.size));
  return resolved;
}

function buildMultipartFormData(
  formValues: SendRequestParams['formData'],
  files: TransferredRequestFile[],
): FormData {
  if (
    formValues !== undefined &&
    (formValues === null || typeof formValues !== 'object' || Array.isArray(formValues))
  ) {
    throw new Error('formData must be an object');
  }

  const multipart = new FormData();
  for (const [name, value] of Object.entries(formValues ?? {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`formData.${name} must be a string, number, or boolean`);
    }
    multipart.append(
      assertSafeSendRequestMultipartValue(name, `formData field "${name}"`),
      String(value),
    );
  }
  for (const file of files) {
    multipart.append(file.fieldName, file.file);
  }
  return multipart;
}

type ExtensionSendRequestParams = SendRequestParams & {
  transferId?: unknown;
  binaryBody?: boolean;
};

export async function handleSendRequest(data: ExtensionSendRequestParams): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  bodyType: 'json' | 'text' | 'base64';
  attachedCookieCount: number;
  [key: string]: any;
}> {
  const transferredFiles =
    data.transferId === undefined ? undefined : consumeSendRequestFileTransfer(data.transferId);
  const binaryBody = data.binaryBody === true;
  if (binaryBody && !transferredFiles) throw new Error('binaryBody requires a file transfer');
  const {
    url,
    method = 'GET',
    headers = {},
    params,
    body,
    formData,
    files,
    withCookies = true,
    responseType = 'auto',
    timeout = 30000,
  } = data;

  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('Invalid url: url must be a non-empty string');
  }

  const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  const normalizedMethod = method.toUpperCase();
  if (!ALLOWED_METHODS.includes(normalizedMethod)) {
    throw new Error(`Invalid method: ${method}. Allowed: ${ALLOWED_METHODS.join(', ')}`);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      targetUrl.searchParams.set(key, String(value));
    }
  }

  // Collect cookies if needed
  let attachedCookieCount = 0;
  let cookies: RequestCookie[] | undefined;

  if (withCookies) {
    try {
      cookies = await collectCookies(targetUrl);
      attachedCookieCount = cookies.length;
    } catch (error) {
      console.warn('[send_request] Failed to get cookies:', error);
    }
  }

  // Skip auto X-XSRF-TOKEN injection if user explicitly provided it
  const userProvidedXsrf = Object.keys(headers).some(key => key.toLowerCase() === 'x-xsrf-token');
  const dnrHeaders = buildDnrHeaders(targetUrl, cookies, userProvidedXsrf, headers);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetchWithDnr(targetUrl, dnrHeaders, async () => {
      const requestHeaders: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      };

      const rawBodyFile = getSendRequestBodyFile(
        binaryBody ? { ...data, bodyFile: { base64: '' } } : data,
      );
      const hasMultipartPayload =
        !rawBodyFile &&
        (formData !== undefined || files !== undefined || transferredFiles !== undefined);
      let requestBody: BodyInit | undefined;
      if (rawBodyFile) {
        const rawFiles = transferredFiles ?? resolveInlineRequestFiles([rawBodyFile]);
        if (rawFiles.length !== 1) throw new Error('bodyFile requires exactly one file');
        requestBody = rawFiles[0].file;
        if (!findSendRequestHeaderName(requestHeaders, 'content-type')) {
          requestHeaders['Content-Type'] = rawFiles[0].contentType;
        }
      } else if (hasMultipartPayload) {
        if (body !== undefined && body !== null) {
          throw new Error('body cannot be combined with formData or files');
        }
        if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
          throw new Error(`${normalizedMethod} requests cannot use formData or files`);
        }
        if (findSendRequestHeaderName(requestHeaders, 'content-type')) {
          throw new Error(
            'Do not set Content-Type when using formData or files; the browser sets the boundary',
          );
        }
        if (files !== undefined && !Array.isArray(files)) {
          throw new Error('files must be an array');
        }
        const resolvedFiles = transferredFiles ?? resolveInlineRequestFiles(files ?? []);
        requestBody = buildMultipartFormData(formData, resolvedFiles);
      } else if (
        body !== undefined &&
        body !== null &&
        !['GET', 'HEAD'].includes(normalizedMethod)
      ) {
        if (typeof body === 'string') {
          requestBody = body;
          if (!findSendRequestHeaderName(requestHeaders, 'content-type')) {
            requestHeaders['Content-Type'] = 'text/plain';
          }
        } else {
          requestBody = JSON.stringify(body);
          if (!findSendRequestHeaderName(requestHeaders, 'content-type')) {
            requestHeaders['Content-Type'] = 'application/json';
          }
        }
      }

      const response = await fetch(targetUrl.toString(), {
        method: normalizedMethod,
        headers: requestHeaders,
        body: requestBody,
        credentials: withCookies ? 'include' : 'omit',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const contentType = (responseHeaders['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      let responseBody: any;
      let bodyType: 'json' | 'text' | 'base64';

      if (
        responseType !== 'text' &&
        responseType !== 'json' &&
        isBinarySendRequestContentType(contentType)
      ) {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        responseBody = btoa(binary);
        bodyType = 'base64';
      } else {
        const responseText = await response.text();
        const trimmed = responseText.trimStart();
        const shouldParseJson =
          responseType === 'json' ||
          (responseType === 'auto' && contentType.includes('application/json')) ||
          (responseType === 'auto' && (trimmed.startsWith('{') || trimmed.startsWith('[')));
        if (shouldParseJson) {
          try {
            responseBody = JSON.parse(responseText);
            bodyType = 'json';
          } catch {
            responseBody = responseText;
            bodyType = 'text';
          }
        } else {
          responseBody = responseText;
          bodyType = 'text';
        }
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        bodyType,
        attachedCookieCount,
      };
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms: ${targetUrl.toString()}`, {
        cause: error,
      });
    }
    throw new Error(
      `send_request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
