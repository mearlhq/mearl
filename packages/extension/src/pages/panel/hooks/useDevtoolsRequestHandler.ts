import { Dispatch, MutableRefObject, SetStateAction, useCallback, useRef } from 'react';
import { decodeTrackingRequest } from '../utils/browserTracking';
import { getCurrentLanguage } from '../utils/i18n';
import { showToast } from '../utils/toast';
import { CapturedRequest, ResponseOverride, RumEvent } from '../types';
import {
  calculateHeadersSize,
  decodeQueryString,
  formatTimestamp,
  generateNonProtocolApiName,
  getHeaderValue,
  normalizeNonProtocolResourceType,
  parseJsonpResponse,
  parseRequestInfo,
  parseSseMessages,
  parseSseResponse,
} from '../utils/helpers';
import { inspectRequest } from '../utils/apiNameExtractor';
import { findMatchingOverride } from '../utils/conditionMatcher';
import {
  mergeCapturedEvents,
  mergeCapturedRequests,
  type PanelRequestCaptureState,
} from '../utils/capturedState';

interface UseDevtoolsRequestHandlerOptions {
  captureStateRef: MutableRefObject<PanelRequestCaptureState>;
  modificationEnabled: boolean;
  apiOverrides: Map<string, ResponseOverride[]>;
  setRequests: Dispatch<SetStateAction<CapturedRequest[]>>;
  setNonCapturedRequests: Dispatch<SetStateAction<CapturedRequest[]>>;
  setRumEvents: Dispatch<SetStateAction<RumEvent[]>>;
  recentlyAutoTranslatedRef: MutableRefObject<Set<string>>;
}

function normalizeBodySize(size: number | undefined): number | undefined {
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined;
}

function requestStartedAt(request: chrome.devtools.network.Request): number {
  const timestamp = Date.parse(request.startedDateTime);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

/** DevTools Network 采集只用于响应修改关闭时的已完成请求。 */
export function useDevtoolsRequestHandler({
  captureStateRef,
  modificationEnabled,
  apiOverrides,
  setRequests,
  setNonCapturedRequests,
  setRumEvents,
  recentlyAutoTranslatedRef,
}: UseDevtoolsRequestHandlerOptions) {
  const requestSequenceRef = useRef(0);
  const eventSequenceRef = useRef(0);
  const commitOrderRef = useRef<Promise<void>>(Promise.resolve());
  const modificationEnabledRef = useRef(modificationEnabled);
  const apiOverridesRef = useRef(apiOverrides);
  modificationEnabledRef.current = modificationEnabled;
  apiOverridesRef.current = apiOverrides;

  const handleRequest = useCallback(
    (request: chrome.devtools.network.Request) => {
      const captureState = captureStateRef.current;
      if (captureState.source !== 'devtools') return;

      const url = request.request.url;
      const method = request.request.method;
      const requestBody = request.request.postData?.text;
      const sequence = ++eventSequenceRef.current;
      const decoded = decodeTrackingRequest({ url, body: requestBody, options: { sequence, now: Date.now() }, locale: getCurrentLanguage() });
      void decoded.catch(() => {});
      const commit = commitOrderRef.current.then(async () => {
      const { events } = await decoded;
      if (captureStateRef.current !== captureState || captureStateRef.current.source !== 'devtools') return;
      if (events.length > 0) {
        setRumEvents(previous => mergeCapturedEvents(previous, events));
        return;
      }
      if (method === 'OPTIONS' || request.response.status === 307) return;

      const timestampMs = requestStartedAt(request);
      const responseHeaders = request.response.headers;
      const responseHeadersSize = calculateHeadersSize(responseHeaders);
      const transferSize = normalizeBodySize(request.response._transferSize ?? undefined);
      const responseBodySize =
        normalizeBodySize(request.response.bodySize) ??
        (transferSize === undefined ? undefined : Math.max(0, transferSize - responseHeadersSize));
      const extraction = await inspectRequest(url, requestBody) ?? undefined;
      if (captureStateRef.current !== captureState) return;
      const isProtocol = Boolean(extraction);
      const parsed = parseRequestInfo(url, requestBody, extraction);
      const rawResourceType =
        ((
          request as chrome.devtools.network.Request & { _resourceType?: string }
        )._resourceType?.toLowerCase() as string | undefined) ?? 'other';
      const resourceType = isProtocol
        ? rawResourceType
        : normalizeNonProtocolResourceType(rawResourceType, url, responseHeaders);
      const requestData: CapturedRequest = {
        id: timestampMs + ++requestSequenceRef.current / 1_000,
        timestamp: formatTimestamp(timestampMs),
        timestampMs,
        method,
        url,
        apiName: extraction?.apiName ?? generateNonProtocolApiName(url, resourceType),
        status: request.response.status,
        statusText: request.response.statusText,
        headers: request.request.headers,
        responseHeaders,
        queryString: decodeQueryString(request.request.queryString || []),
        postData: parsed.postData,
        responseBody: null,
        isProxy: extraction?.isProxy ?? false,
        proxyRequestUrl: extraction?.proxyRequestUrl ?? null,
        proxyData: parsed.proxyData,
        duration:
          request.time !== undefined && request.time >= 0 ? Math.round(request.time) : undefined,
        requestHeadersSize: calculateHeadersSize(request.request.headers),
        responseHeadersSize,
        requestBodySize: normalizeBodySize(request.request.bodySize),
        responseBodySize,
        isSSE: getHeaderValue(responseHeaders, 'content-type').includes('text/event-stream'),
        resourceType,
        source: isProtocol ? 'protocol' : 'requests',
        environment: extraction?.environment,
        namespace: extraction?.namespace,
      };

      const decorate = (value: CapturedRequest): CapturedRequest => {
        let decorated = value;
        if (modificationEnabledRef.current) {
          const override = findMatchingOverride(
            apiOverridesRef.current.get(value.apiName),
            value.postData,
            value.queryString,
          );
          if (override) decorated = { ...decorated, responseOverride: override };
        }
        if (recentlyAutoTranslatedRef.current.delete(value.apiName)) {
          decorated = { ...decorated, isAutoTranslated: true };
        }
        return decorated;
      };
      const setter = isProtocol ? setRequests : setNonCapturedRequests;
      setter(previous => mergeCapturedRequests(previous, [decorate(requestData)]));

      const isBinaryResource = ['image', 'font', 'media'].includes(resourceType);
      if (isBinaryResource) return;

      request.getContent(content => {
        if (captureStateRef.current !== captureState || captureStateRef.current.source !== 'devtools') return;
        let responseBody: unknown;
        try {
          if (requestData.isSSE) {
            responseBody = parseSseResponse(content);
          } else if (isProtocol || resourceType === 'jsonp') {
            responseBody = parseJsonpResponse(content);
          } else {
            responseBody = JSON.parse(content);
          }
        } catch {
          responseBody = parseJsonpResponse(content);
        }

        const completed: CapturedRequest = {
          ...requestData,
          responseBody,
          ...(requestData.isSSE ? { sseMessages: parseSseMessages(content) } : {}),
        };
        setter(previous => mergeCapturedRequests(previous, [decorate(completed)]));
      });
      });
      commitOrderRef.current = commit.catch(error => {
        console.warn('Tracking request decoding failed', error);
        showToast(error instanceof Error ? error.message : String(error), 'error');
      });
      return commitOrderRef.current;
    },
    [captureStateRef, recentlyAutoTranslatedRef, setNonCapturedRequests, setRequests, setRumEvents],
  );

  return { handleRequest };
}
