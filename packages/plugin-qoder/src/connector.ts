import { resolveActionTimeoutSec } from '@mearl/client/action-timeouts';
import type { CloudConnectorStateChange } from '@mearl/cloud-connector/contracts';
import type { ConnectorIdentity } from '@mearl/cloud-connector/contracts';
import type { QoderConnectorEndpoint } from './endpoint.js';
import { qoderAuthenticationHint, resolveQoderPersonalAccessToken } from './auth.js';

export const QODER_TOOL_NAME = 'mearl';
export const DEFAULT_QODER_API_BASE_URL = 'https://api.qoder.com';

const DEFAULT_DISCOVERY_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RECONNECT_INTERVAL_MS = 5000;
const MAX_RECENT_SESSIONS = 100;
const MAX_RECENT_TOOL_EVENTS = 20;
const MAX_CACHED_RESULTS = 100;

export type QoderContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string };
    };

export interface QoderPublicEvent {
  id?: string;
  type?: string;
  name?: string;
  input?: unknown;
  processed_at?: string;
  [key: string]: unknown;
}

interface QoderSession {
  id: string;
  status?: string;
  updated_at?: string;
}

interface QoderListResponse<T> {
  data: T[];
}

interface QoderSendResponse {
  data?: Array<{ id?: string }>;
}

export interface QoderPairingRequest {
  sessionId: string;
  event: QoderPublicEvent & { id: string };
}

export interface QoderSseFrame {
  id?: string;
  event?: string;
  data: QoderPublicEvent;
}

export class QoderApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'QoderApiError';
  }
}

class QoderPairingExpiredError extends Error {
  constructor() {
    super(
      'Qoder pairing is no longer pending. Generate a new pairing URL with `npx @mearl/plugin-qoder pair`, run the new connector command, and immediately invoke the mearl tool with action "pair". Do not reuse this URL.',
    );
    this.name = 'QoderPairingExpiredError';
  }
}

function isPendingActionNotFound(error: unknown): boolean {
  return (
    error instanceof QoderApiError &&
    /^Pending action\b.*\bwas not found\.?$/i.test(error.message.trim())
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: 'Mearl returned a value that cannot be serialized' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ScreenshotValue {
  data: string;
  meta: Record<string, unknown> & { format: 'png' | 'jpeg' };
}

interface BatchScreenshotResult {
  metadata: Record<string, unknown>;
  screenshots: ScreenshotValue[];
}

function asScreenshot(value: unknown): ScreenshotValue | null {
  if (!isRecord(value) || typeof value.data !== 'string' || !isRecord(value.meta)) return null;
  const format = value.meta.format;
  if (format !== 'png' && format !== 'jpeg') return null;
  return { data: value.data, meta: { ...value.meta, format } };
}

function extractBatchScreenshots(value: unknown): BatchScreenshotResult | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;

  const screenshots: ScreenshotValue[] = [];
  const results = value.results.map(result => {
    if (!isRecord(result) || result.action !== 'page_screenshot') return result;
    const screenshot = asScreenshot(result.data);
    if (!screenshot) return result;

    const data = { ...(result.data as Record<string, unknown>) };
    delete data.data;
    data.meta = screenshot.meta;
    data.imageContentIndex = screenshots.length + 1;
    screenshots.push(screenshot);
    return { ...result, data };
  });

  if (screenshots.length === 0) return null;
  return { metadata: { ...value, results }, screenshots };
}

function imageContentBlock(screenshot: ScreenshotValue): QoderContentBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: `image/${screenshot.meta.format}`,
      data: screenshot.data,
    },
  };
}

export interface FormattedQoderResult {
  content: QoderContentBlock[];
  fallbackContent: QoderContentBlock[];
}

/** Format screenshots as multimodal tool results while retaining a text-only API fallback. */
export function formatQoderToolResult(value: unknown): FormattedQoderResult {
  const directScreenshot = asScreenshot(value);
  const nestedScreenshot =
    !directScreenshot && isRecord(value) ? asScreenshot(value.screenshot) : null;
  const screenshot = directScreenshot ?? nestedScreenshot;

  if (!screenshot) {
    const batch = extractBatchScreenshots(value);
    if (batch) {
      return {
        content: [
          { type: 'text', text: safeJson(batch.metadata) },
          ...batch.screenshots.map(imageContentBlock),
        ],
        fallbackContent: [{ type: 'text', text: safeJson(value) }],
      };
    }
  }

  if (!screenshot) {
    const content = [{ type: 'text' as const, text: safeJson(value) }];
    return { content, fallbackContent: content };
  }

  let metadata: unknown;
  if (directScreenshot) {
    metadata = { meta: screenshot.meta };
  } else {
    metadata = { ...(value as Record<string, unknown>), screenshot: { meta: screenshot.meta } };
  }

  return {
    content: [{ type: 'text', text: safeJson(metadata) }, imageContentBlock(screenshot)],
    fallbackContent: [{ type: 'text', text: safeJson(value) }],
  };
}

function pairingCodeFromEvent(event: QoderPublicEvent): string | null {
  if (event.type !== 'agent.custom_tool_use' || event.name !== QODER_TOOL_NAME) return null;
  if (!isRecord(event.input) || event.input.action !== 'pair') return null;
  const payload = isRecord(event.input.payload)
    ? event.input.payload
    : isRecord(event.input.data)
      ? event.input.data
      : null;
  return payload && typeof payload.code === 'string' ? payload.code : null;
}

function qoderErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // A non-JSON proxy response is summarized by status below.
  }
  return `Qoder API request failed with HTTP ${status}`;
}

export class QoderApiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    baseUrl = DEFAULT_QODER_API_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== 'https:' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    ) {
      throw new Error('Qoder API base URL must use https:// (localhost may use http:// for tests)');
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      const message = qoderErrorMessage(response.status, body);
      throw new QoderApiError(
        response.status === 401 ? `${message}\n${qoderAuthenticationHint()}` : message,
        response.status,
      );
    }
    return response;
  }

  async listSessions(createdAfter: string, signal?: AbortSignal): Promise<QoderSession[]> {
    const query = new URLSearchParams({
      limit: String(MAX_RECENT_SESSIONS),
      order: 'desc',
      'created_at[gte]': createdAfter,
    });
    const response = await this.request(`/api/v1/cloud/sessions?${query}`, { signal });
    const body = (await response.json()) as QoderListResponse<QoderSession>;
    return Array.isArray(body.data)
      ? body.data.filter(session => typeof session.id === 'string')
      : [];
  }

  async listCustomToolEvents(
    sessionId: string,
    createdAfter: string,
    signal?: AbortSignal,
  ): Promise<QoderPublicEvent[]> {
    const query = new URLSearchParams({
      limit: String(MAX_RECENT_TOOL_EVENTS),
      order: 'desc',
      types: 'agent.custom_tool_use',
      'created_at[gte]': createdAfter,
    });
    const response = await this.request(
      `/api/v1/cloud/sessions/${encodeURIComponent(sessionId)}/events?${query}`,
      { signal },
    );
    const body = (await response.json()) as QoderListResponse<QoderPublicEvent>;
    return Array.isArray(body.data) ? body.data : [];
  }

  async findPairingRequest(
    pairingCode: string,
    createdAfter: string,
    signal?: AbortSignal,
  ): Promise<QoderPairingRequest | null> {
    const sessions = await this.listSessions(createdAfter, signal);
    for (const session of sessions) {
      const events = await this.listCustomToolEvents(session.id, createdAfter, signal);
      const event = events.find(candidate => pairingCodeFromEvent(candidate) === pairingCode);
      if (event?.id) return { sessionId: session.id, event: { ...event, id: event.id } };
    }
    return null;
  }

  async sendCustomToolResult(
    sessionId: string,
    customToolUseId: string,
    content: QoderContentBlock[],
    isError = false,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const response = await this.request(
      `/api/v1/cloud/sessions/${encodeURIComponent(sessionId)}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          events: [
            {
              type: 'user.custom_tool_result',
              custom_tool_use_id: customToolUseId,
              content,
              is_error: isError,
            },
          ],
        }),
      },
    );
    const body = (await response.json()) as QoderSendResponse;
    return body.data?.[0]?.id;
  }

  async streamEvents(
    sessionId: string,
    lastEventId: string | undefined,
    signal: AbortSignal,
    onFrame: (frame: QoderSseFrame) => Promise<void>,
    onOpen?: () => void,
  ): Promise<void> {
    const response = await this.request(
      `/api/v1/cloud/sessions/${encodeURIComponent(sessionId)}/events/stream`,
      {
        headers: {
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
        signal,
      },
    );
    if (!response.body) throw new Error('Qoder event stream returned no response body');
    onOpen?.();
    await parseQoderSse(response.body, onFrame);
  }
}

export async function parseQoderSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: QoderSseFrame) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frameLines: string[] = [];

  const dispatch = async () => {
    if (frameLines.length === 0) return;
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frameLines) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    frameLines = [];
    if (data.length === 0) return;
    const parsed = JSON.parse(data.join('\n')) as QoderPublicEvent;
    await onFrame({ ...(id ? { id } : {}), ...(event ? { event } : {}), data: parsed });
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line === '') await dispatch();
      else frameLines.push(line);
    }
    if (done) break;
  }
  if (buffer) frameLines.push(buffer.replace(/\r$/, ''));
  await dispatch();
}

interface CachedToolResult extends FormattedQoderResult {
  isError: boolean;
}

export interface QoderConnectorOptions {
  endpoint: QoderConnectorEndpoint;
  identity: ConnectorIdentity;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  failFast?: boolean;
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  invokeAction?: (
    action: string,
    payload: Record<string, unknown>,
    options: { browser?: string; timeoutSec: number },
  ) => Promise<unknown>;
  onConnected?: () => void;
  onInitialConnectionFailed?: (message: string) => void;
  onStateChange?: (change: CloudConnectorStateChange) => void;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toolInput(event: QoderPublicEvent): {
  action: string;
  payload: Record<string, unknown>;
  browser?: string;
  timeoutSec?: number;
} {
  if (!isRecord(event.input) || typeof event.input.action !== 'string') {
    throw new Error('Qoder mearl tool input requires a string action');
  }
  const browser = typeof event.input.browser === 'string' ? event.input.browser : undefined;
  const timeoutSec =
    typeof event.input.timeoutSec === 'number' && Number.isFinite(event.input.timeoutSec)
      ? event.input.timeoutSec
      : undefined;
  const payloadValue = event.input.payload ?? event.input.data ?? {};
  if (!isRecord(payloadValue)) {
    throw new Error('Qoder mearl tool input payload must be an object');
  }
  return {
    action: event.input.action,
    payload: payloadValue,
    ...(browser ? { browser } : {}),
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
  };
}

export class QoderConnector {
  private readonly api: QoderApiClient;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly invokeAction: NonNullable<QoderConnectorOptions['invokeAction']>;
  private readonly reconnectInterval: number;
  private readonly maxReconnectAttempts: number;
  private abortController: AbortController | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private connected = false;
  private sessionId: string | null = null;
  private lastEventId: string | undefined;
  private readonly cachedResults = new Map<string, CachedToolResult>();

  constructor(private readonly options: QoderConnectorOptions) {
    const token = resolveQoderPersonalAccessToken({ token: options.token });
    if (!token) {
      throw new Error(`Qoder authentication is required.\n${qoderAuthenticationHint()}`);
    }
    this.api = new QoderApiClient(
      token,
      options.apiBaseUrl ?? DEFAULT_QODER_API_BASE_URL,
      options.fetchImpl,
    );
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.invokeAction = options.invokeAction ?? (async () => { throw new Error('Qoder connector requires an invokeAction host'); });
    this.reconnectInterval = options.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? -1;
  }

  connect(): void {
    if (this.running) return;
    this.running = true;
    this.options.onStateChange?.({ state: 'connecting' });
    this.abortController = new AbortController();
    void this.run(this.abortController.signal);
  }

  disconnect(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (!this.sessionId) {
          const pairing = await this.findPairing(signal);
          await this.completePairing(pairing, signal);
        }
        const sessionId = this.sessionId!;
        await this.api.streamEvents(
          sessionId,
          this.lastEventId,
          signal,
          async frame => this.handleFrame(sessionId, frame, signal),
          () => {
            this.reconnectAttempts = 0;
            this.options.onStateChange?.({ state: 'connected' });
          },
        );
        if (!signal.aborted) throw new Error('Qoder event stream ended');
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!this.connected && error instanceof QoderPairingExpiredError) {
          this.running = false;
          this.options.onStateChange?.({ state: 'failed', reason: message });
          if (this.options.onInitialConnectionFailed) {
            this.options.onInitialConnectionFailed(message);
          } else {
            console.error(`[CloudConnector] Qoder connection error: ${message}`);
          }
          return;
        }
        if (!this.connected && this.options.failFast) {
          this.options.onStateChange?.({ state: 'failed', reason: message });
          this.options.onInitialConnectionFailed?.(message);
          this.running = false;
          return;
        }
        this.reconnectAttempts += 1;
        if (
          this.maxReconnectAttempts !== -1 &&
          this.reconnectAttempts > this.maxReconnectAttempts
        ) {
          console.error(
            `[CloudConnector] Qoder max reconnect attempts (${this.maxReconnectAttempts}) reached`,
          );
          this.options.onStateChange?.({
            state: 'failed',
            reason: message,
            reconnectAttempt: this.reconnectAttempts,
          });
          this.running = false;
          return;
        }
        console.error(`[CloudConnector] Qoder connection error: ${message}`);
        this.options.onStateChange?.({
          state: 'reconnecting',
          reason: message,
          reconnectAttempt: this.reconnectAttempts,
          retryInMs: this.reconnectInterval,
        });
        try {
          await this.sleep(this.reconnectInterval, signal);
        } catch {
          return;
        }
      }
    }
  }

  private async findPairing(signal: AbortSignal): Promise<QoderPairingRequest> {
    const createdAt = this.options.endpoint.createdAt ?? this.now();
    const createdAfter = new Date(createdAt - DEFAULT_DISCOVERY_WINDOW_MS).toISOString();
    const pairing = await this.api.findPairingRequest(
      this.options.endpoint.pairingCode,
      createdAfter,
      signal,
    );
    if (!pairing) {
      throw new Error(
        'Qoder pairing request was not found. Ask the Agent to call the mearl tool with action "pair" and the code from this URL.',
      );
    }
    return pairing;
  }

  private async completePairing(pairing: QoderPairingRequest, signal: AbortSignal): Promise<void> {
    if (!this.connected) {
      let resultEventId: string | undefined;
      try {
        resultEventId = await this.api.sendCustomToolResult(
          pairing.sessionId,
          pairing.event.id,
          [
            {
              type: 'text',
              text: safeJson({
                connected: true,
                connectorId: this.options.identity.connectorId,
                name: this.options.identity.name,
              }),
            },
          ],
          false,
          signal,
        );
      } catch (error) {
        if (isPendingActionNotFound(error)) throw new QoderPairingExpiredError();
        throw error;
      }
      this.lastEventId = resultEventId ?? pairing.event.id;
      this.sessionId = pairing.sessionId;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.options.onStateChange?.({ state: 'connected' });
      this.options.onConnected?.();
      console.log(`[CloudConnector] Connected to Qoder session ${pairing.sessionId}`);
    }
  }

  private async handleFrame(
    sessionId: string,
    frame: QoderSseFrame,
    signal: AbortSignal,
  ): Promise<void> {
    this.reconnectAttempts = 0;
    this.options.onStateChange?.({ state: 'connected', heartbeat: true });
    const event = frame.data;
    const eventId = event.id ?? frame.id;
    if (event.type !== 'agent.custom_tool_use' || event.name !== QODER_TOOL_NAME || !eventId) {
      if (eventId) this.lastEventId = eventId;
      return;
    }

    const cached = this.cachedResults.get(eventId) ?? (await this.executeTool(event));
    this.rememberResult(eventId, cached);
    try {
      this.lastEventId =
        (await this.api.sendCustomToolResult(
          sessionId,
          eventId,
          cached.content,
          cached.isError,
          signal,
        )) ?? eventId;
    } catch (error) {
      if (
        error instanceof QoderApiError &&
        error.status === 400 &&
        cached.content !== cached.fallbackContent
      ) {
        this.lastEventId =
          (await this.api.sendCustomToolResult(
            sessionId,
            eventId,
            cached.fallbackContent,
            cached.isError,
            signal,
          )) ?? eventId;
        return;
      }
      if (error instanceof QoderApiError && error.status === 404) {
        this.lastEventId = eventId;
        return;
      }
      throw error;
    }
  }

  private async executeTool(event: QoderPublicEvent): Promise<CachedToolResult> {
    try {
      const input = toolInput(event);
      if (input.action === 'pair') {
        throw new Error('This pairing request does not match the active connector');
      }
      const result = await this.invokeAction(input.action, input.payload, {
        browser: input.browser,
        timeoutSec: input.timeoutSec ?? resolveActionTimeoutSec(input.action, input.payload, 15),
      });
      return { ...formatQoderToolResult(result), isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const content = [{ type: 'text' as const, text: safeJson({ error: message }) }];
      return { content, fallbackContent: content, isError: true };
    }
  }

  private rememberResult(eventId: string, result: CachedToolResult): void {
    this.cachedResults.set(eventId, result);
    while (this.cachedResults.size > MAX_CACHED_RESULTS) {
      const oldest = this.cachedResults.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cachedResults.delete(oldest);
    }
  }
}
