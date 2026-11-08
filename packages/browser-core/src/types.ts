// ─── SSE ─────────────────────────────────────────────────────────────────────

export interface SSEMessage {
  event: string;
  data: any;
  eventId?: string;
  timestamp?: number;
  duration?: number;
}

// ─── Response Override ────────────────────────────────────────────────────────

export interface ResponseOverride {
  url?: string;
  apiName: string;
  responseData?: any;
  originalData?: any;
  modifiedData?: any;
  duration?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
  disabled?: boolean;
  isSSE?: boolean;
}

// ─── CapturedRequest ─────────────────────────────────────────────────────────────

export interface CapturedRequest {
  namespace?: string;
  environment?: string;
  id: number;
  timestamp: string;
  timestampMs: number;
  method: string;
  url: string;
  apiName: string;
  status: number;
  statusText: string;
  headers: Array<{ name: string; value: string }>;
  responseHeaders: Array<{ name: string; value: string }>;
  queryString: Array<{ name: string; value: string }>;
  postData: any;
  responseBody: any;
  isProxy: boolean;
  proxyRequestUrl: string | null;
  proxyData: any;
  hasPreflight?: boolean;
  responseOverride?: ResponseOverride;
  isSSE?: boolean;
  duration?: number;
  requestHeadersSize?: number;
  responseHeadersSize?: number;
  requestBodySize?: number;
  responseBodySize?: number;
  isPending?: boolean;
  sseMessages?: SSEMessage[];
  _internalRequestId?: string;
  _createdByInjected?: boolean;
  tabId?: number;
  isAutoTranslated?: boolean;
  source?: 'protocol' | 'requests';
  resourceType?: string;
  /** Monotonic sequence assigned when the request started. */
  captureSequence?: number;
}

// ─── RumEvent ─────────────────────────────────────────────────────────────────

export interface RumEvent {
  id: string;
  source: 'rum' | 'aplus' | 'arms';
  batchId: number;
  batchTimestampMs: number;
  batchTimestamp: string;
  event_type: string;
  type?: string;
  name?: string;
  url?: string;
  timestamp: number;
  success?: number;
  status_code?: number;
  method?: string;
  duration?: number;
  /** Internal sequence of the tracking request that produced this event. */
  captureSequence?: number;
  _raw: Record<string, any>;
  point?: { mainSpm: string; highlightSpm: string };
  validation?: {
    level: 'success' | 'warning' | 'error';
    issues: { level: 'warning' | 'error'; message: string }[];
    checks: string[];
  };
  _context: {
    requestUrl: string;
    app: Record<string, any>;
    user: Record<string, any>;
    session: Record<string, any>;
    view: Record<string, any>;
    properties: Record<string, any>;
    os: Record<string, any>;
    net: Record<string, any>;
  };
}

// ─── NavigationDivider ────────────────────────────────────────────────────────

export interface NavigationDivider {
  type: 'navigation-divider';
  id: number;
  timestampMs: number;
  url: string;
}

// ─── Console Log ─────────────────────────────────────────────────────────────

export interface ConsoleLog {
  level: string;
  message: string;
  /** Unix epoch time in milliseconds. */
  timestampMs: number;
  source?: string;
  args: string[];
  captureSequence: number;
  origin: 'console' | 'exception' | 'browser';
}
