import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QoderApiClient,
  QoderApiError,
  QoderConnector,
  formatQoderToolResult,
  parseQoderSse,
  type QoderSseFrame,
} from '../connector.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Qoder result formatting', () => {
  it('returns ordinary Mearl results as JSON text', () => {
    const formatted = formatQoderToolResult({ tabs: [{ id: 1 }] });

    expect(formatted.content).toEqual([{ type: 'text', text: '{"tabs":[{"id":1}]}' }]);
    expect(formatted.fallbackContent).toBe(formatted.content);
  });

  it('returns screenshots as an image block with metadata and a lossless text fallback', () => {
    const result = {
      meta: {
        format: 'png' as const,
        width: 120,
        height: 80,
        size: 3,
        url: 'https://example.com',
        title: 'Example',
      },
      data: 'aW1n',
    };

    const formatted = formatQoderToolResult(result);

    expect(formatted.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ meta: result.meta }),
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
      },
    ]);
    expect(formatted.fallbackContent).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
  });

  it('returns run_actions screenshots as ordered image blocks without base64 in metadata', () => {
    const firstScreenshot = {
      meta: { format: 'png' as const, width: 120, height: 80, size: 3 },
      data: 'Zmlyc3Q=',
    };
    const secondScreenshot = {
      meta: { format: 'jpeg' as const, width: 60, height: 40, size: 4 },
      data: 'c2Vjb25k',
    };
    const result = {
      results: [
        { step: 0, action: 'page_scroll', success: true, data: { moved: true } },
        { step: 1, action: 'page_screenshot', success: true, data: firstScreenshot },
        { step: 2, action: 'page_screenshot', success: true, data: secondScreenshot },
      ],
      completedSteps: 3,
      totalSteps: 3,
    };

    const formatted = formatQoderToolResult(result);

    expect(formatted.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          ...result,
          results: [
            result.results[0],
            {
              ...result.results[1],
              data: { meta: firstScreenshot.meta, imageContentIndex: 1 },
            },
            {
              ...result.results[2],
              data: { meta: secondScreenshot.meta, imageContentIndex: 2 },
            },
          ],
        }),
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: firstScreenshot.data },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: secondScreenshot.data },
      },
    ]);
    expect(formatted.fallbackContent).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
  });
});

describe('Qoder SSE parsing', () => {
  it('handles comments, CRLF, chunk boundaries, and multiline data', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': heartbeat\r\n\r\nid: evt_1\r\nevent: agent.custom'));
        controller.enqueue(
          encoder.encode(
            '_tool_use\r\ndata: {"id":\r\ndata: "evt_1","type":"agent.custom_tool_use"}\r\n\r\n',
          ),
        );
        controller.close();
      },
    });
    const frames: QoderSseFrame[] = [];

    await parseQoderSse(body, async frame => {
      frames.push(frame);
    });

    expect(frames).toEqual([
      {
        id: 'evt_1',
        event: 'agent.custom_tool_use',
        data: { id: 'evt_1', type: 'agent.custom_tool_use' },
      },
    ]);
  });
});

describe('Qoder API client', () => {
  it.each([401, 403, 500])(
    'adds credential recovery only to authentication failures: HTTP %s',
    async status => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse({ message: 'Request rejected' }, status),
      );
      const api = new QoderApiClient('private-pat-value', 'https://api.qoder.com', fetchImpl);
      const error = await api.listSessions('2026-08-14T00:00:00.000Z').catch(error => error);

      expect(error).toBeInstanceOf(QoderApiError);
      expect(error.status).toBe(status);
      expect(error.message).toContain('Request rejected');
      expect(error.message.includes('Configure QODER_PERSONAL_ACCESS_TOKEN')).toBe(status === 401);
      expect(error.message).not.toContain('private-pat-value');
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('discovers the matching pairing request across recent sessions', async () => {
    const abortController = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer pat_test');
      expect(init?.signal).toBe(abortController.signal);
      if (url.pathname === '/api/v1/cloud/sessions') {
        expect(url.searchParams.get('limit')).toBe('100');
        expect(url.searchParams.has('statuses')).toBe(false);
        return jsonResponse({ data: [{ id: 'sess_new' }, { id: 'sess_match' }] });
      }
      if (url.pathname.includes('sess_new')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({
        data: [
          {
            id: 'evt_pair',
            type: 'agent.custom_tool_use',
            name: 'mearl',
            input: { action: 'pair', payload: { code: 'pairing-code-1234' } },
          },
        ],
      });
    });
    const api = new QoderApiClient('pat_test', 'https://api.qoder.com', fetchImpl);

    await expect(
      api.findPairingRequest(
        'pairing-code-1234',
        '2026-08-14T00:00:00.000Z',
        abortController.signal,
      ),
    ).resolves.toEqual({
      sessionId: 'sess_match',
      event: {
        id: 'evt_pair',
        type: 'agent.custom_tool_use',
        name: 'mearl',
        input: { action: 'pair', payload: { code: 'pairing-code-1234' } },
      },
    });
  });

  it('posts a user.custom_tool_result event', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        events: [
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: 'evt_tool',
            content: [{ type: 'text', text: '{"ok":true}' }],
            is_error: false,
          },
        ],
      });
      return jsonResponse({ data: [{ id: 'evt_result' }] });
    });
    const api = new QoderApiClient('pat_test', 'https://api.qoder.com', fetchImpl);

    await expect(
      api.sendCustomToolResult('sess_1', 'evt_tool', [{ type: 'text', text: '{"ok":true}' }]),
    ).resolves.toBe('evt_result');
  });
});

describe('Qoder connector', () => {
  it('pairs once, streams tool calls, and dispatches them through the local client adapter', async () => {
    const encoder = new TextEncoder();
    const postedBodies: Array<Record<string, unknown>> = [];
    const invokeAction = vi.fn().mockResolvedValue({ tabs: [{ id: 7 }] });
    const onConnected = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/cloud/sessions') {
        return jsonResponse({ data: [{ id: 'sess_1' }] });
      }
      if (url.pathname === '/api/v1/cloud/sessions/sess_1/events' && !init?.method) {
        return jsonResponse({
          data: [
            {
              id: 'evt_pair',
              type: 'agent.custom_tool_use',
              name: 'mearl',
              input: { action: 'pair', payload: { code: 'pairing-code-1234' } },
            },
          ],
        });
      }
      if (url.pathname.endsWith('/events/stream')) {
        expect(new Headers(init?.headers).get('Last-Event-ID')).toBe('evt_pair_result');
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'id: evt_tool\nevent: agent.custom_tool_use\ndata: {"id":"evt_tool","type":"agent.custom_tool_use","name":"mearl","input":{"action":"tab_list","payload":{},"browser":"work"}}\n\n',
              ),
            );
            signal?.addEventListener('abort', () => {
              controller.error(new Error('aborted'));
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url.pathname === '/api/v1/cloud/sessions/sess_1/events' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        postedBodies.push(body);
        const useId = (body.events as Array<{ custom_tool_use_id: string }>)[0]!.custom_tool_use_id;
        return jsonResponse({ data: [{ id: `${useId}_result` }] });
      }
      throw new Error(`Unexpected Qoder request: ${url}`);
    });
    const connector = new QoderConnector({
      endpoint: {
        serverUrl: 'qoder://pair/pairing-code-1234?created=1786723200000',
        scheme: 'qoder',
        pairingCode: 'pairing-code-1234',
        createdAt: 1786723200000,
      },
      identity: { connectorId: 'connector-1', name: 'local-browser' },
      token: 'pat_test',
      fetchImpl,
      invokeAction,
      onConnected,
    });

    connector.connect();
    await vi.waitFor(() => expect(postedBodies).toHaveLength(2));
    connector.disconnect();

    expect(onConnected).toHaveBeenCalledOnce();
    expect(invokeAction).toHaveBeenCalledWith(
      'tab_list',
      {},
      {
        browser: 'work',
        timeoutSec: 15,
      },
    );
    expect(postedBodies).toEqual([
      {
        events: [
          expect.objectContaining({
            type: 'user.custom_tool_result',
            custom_tool_use_id: 'evt_pair',
          }),
        ],
      },
      {
        events: [
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: 'evt_tool',
            content: [{ type: 'text', text: '{"tabs":[{"id":7}]}' }],
            is_error: false,
          },
        ],
      },
    ]);
  });

  it('falls back to lossless screenshot text without executing the action twice', async () => {
    const screenshot = {
      meta: { format: 'png' as const, width: 120, height: 80, size: 3 },
      data: 'aW1n',
    };
    const postedContent: unknown[] = [];
    const invokeAction = vi.fn().mockResolvedValue(screenshot);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        events: Array<{ content: unknown }>;
      };
      postedContent.push(body.events[0]!.content);
      if (postedContent.length === 1) {
        return jsonResponse({ message: 'image content is not supported' }, 400);
      }
      return jsonResponse({ data: [{ id: 'evt_tool_result' }] });
    });
    const connector = new QoderConnector({
      endpoint: {
        serverUrl: 'qoder://pair/pairing-code-1234?created=1786723200000',
        scheme: 'qoder',
        pairingCode: 'pairing-code-1234',
        createdAt: 1786723200000,
      },
      identity: { connectorId: 'connector-1', name: 'local-browser' },
      token: 'pat_test',
      fetchImpl,
      invokeAction,
    });
    const handleFrame = (
      connector as unknown as {
        handleFrame: (
          sessionId: string,
          frame: QoderSseFrame,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).handleFrame.bind(connector);

    await handleFrame(
      'sess_1',
      {
        id: 'evt_tool',
        data: {
          id: 'evt_tool',
          type: 'agent.custom_tool_use',
          name: 'mearl',
          input: { action: 'page_screenshot', payload: { tabId: 7 } },
        },
      },
      new AbortController().signal,
    );

    expect(invokeAction).toHaveBeenCalledOnce();
    expect(postedContent).toEqual([
      [
        { type: 'text', text: JSON.stringify({ meta: screenshot.meta }) },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: screenshot.data },
        },
      ],
      [{ type: 'text', text: JSON.stringify(screenshot) }],
    ]);
  });

  it('stops immediately and explains how to recover when the pairing action is no longer pending', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onInitialConnectionFailed = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/cloud/sessions') {
        return jsonResponse({ data: [{ id: 'sess_1' }] });
      }
      if (url.pathname === '/api/v1/cloud/sessions/sess_1/events' && !init?.method) {
        return jsonResponse({
          data: [
            {
              id: 'evt_pair',
              type: 'agent.custom_tool_use',
              name: 'mearl',
              input: { action: 'pair', payload: { code: 'pairing-code-1234' } },
            },
          ],
        });
      }
      if (url.pathname === '/api/v1/cloud/sessions/sess_1/events' && init?.method === 'POST') {
        return jsonResponse({ message: "Pending action 'evt_pair' was not found." }, 404);
      }
      throw new Error(`Unexpected Qoder request: ${url}`);
    });
    const connector = new QoderConnector({
      endpoint: {
        serverUrl: 'qoder://pair/pairing-code-1234?created=1786723200000',
        scheme: 'qoder',
        pairingCode: 'pairing-code-1234',
        createdAt: 1786723200000,
      },
      identity: { connectorId: 'connector-1', name: 'local-browser' },
      token: 'pat_test',
      fetchImpl,
      reconnectInterval: 0,
      sleep,
      onInitialConnectionFailed,
    });

    connector.connect();
    await vi.waitFor(() => expect(onInitialConnectionFailed).toHaveBeenCalledOnce());
    connector.disconnect();

    expect(onInitialConnectionFailed).toHaveBeenCalledWith(
      expect.stringContaining('Generate a new pairing URL'),
    );
    expect(onInitialConnectionFailed).toHaveBeenCalledWith(
      expect.stringContaining('Do not reuse this URL'),
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops pairing retries after the configured maximum', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: 'temporarily unavailable' }, 503));
    const connector = new QoderConnector({
      endpoint: {
        serverUrl: 'qoder://pair/pairing-code-1234?created=1786723200000',
        scheme: 'qoder',
        pairingCode: 'pairing-code-1234',
        createdAt: 1786723200000,
      },
      identity: { connectorId: 'connector-1', name: 'local-browser' },
      token: 'pat_test',
      fetchImpl,
      reconnectInterval: 0,
      maxReconnectAttempts: 1,
      sleep,
    });

    connector.connect();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[CloudConnector] Qoder max reconnect attempts (1) reached',
      ),
    );
    connector.disconnect();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});
