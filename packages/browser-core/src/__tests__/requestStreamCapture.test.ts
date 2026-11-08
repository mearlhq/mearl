import { describe, expect, it } from 'vitest';
import {
  appendRequestStreamCaptureChunk,
  createRequestStreamCapture,
  finishRequestStreamCapture,
  updateRequestStreamCaptureResponse,
} from '../requestStreamCapture.js';

describe('shared request stream capture lifecycle', () => {
  it('redacts secrets and tracks response chunks through completion', () => {
    const capture = createRequestStreamCapture({
      id: 1,
      api: 'fixture.stream',
      namespace: 'sample',
      environment: 'qa-east',
      url: 'https://api.example.test/events?q=fixture',
      method: 'POST',
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
      requestData: '{"query":"hello"}',
      timestampMs: 1_000,
      tabId: 8,
      captureSequence: 2,
    });

    updateRequestStreamCaptureResponse(capture, {
      status: 200,
      statusText: 'OK',
      responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }],
    });
    appendRequestStreamCaptureChunk(capture, { text: 'A' }, 1_100);
    appendRequestStreamCaptureChunk(capture, { text: 'AB' }, 1_160);
    finishRequestStreamCapture(capture, { timestampMs: 1_200 });

    expect(capture.request).toMatchObject({
      namespace: 'sample',
      environment: 'qa-east',
      headers: [{ name: 'Cookie', value: '<redacted>' }],
      postData: { query: 'hello' },
      status: 200,
      statusText: 'OK',
      isSSE: true,
      source: 'requests',
      isPending: false,
      duration: 200,
      responseBody: [
        { data: { text: 'A' }, duration: 0 },
        { data: { text: 'AB' }, duration: 60 },
      ],
    });
  });
});
