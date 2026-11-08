import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BUFFER_SIZE } from '@mearl/cloud-types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({ ok: true }) }));

vi.mock('@mearl/client/local', () => ({
  invoke,
}));

import { CloudConnector } from '../index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CloudConnector', () => {
  it('forwards the cloud action timeout to the local socket client', async () => {
    const connector = new CloudConnector({
      serverUrl: 'ws://localhost:8080',
      connectorId: 'node-a',
      connectorName: 'Browser node',
    });
    const send = vi.fn();
    (connector as any).ws = { readyState: 1, send };

    await (connector as any).handleCloudMessage({
      id: 'request-1',
      action: 'browser_launch',
      data: { name: 'account-a' },
      browser: 'control',
      timeoutSec: 90,
    });

    expect(invoke).toHaveBeenCalledWith(
      'browser_launch',
      { name: 'account-a' },
      { browser: 'control', timeoutSec: 90, controlSource: 'remote' },
    );
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      id: 'request-1',
      success: true,
    });
  });

  it('identifies the browser-side machine before receiving routed actions', () => {
    const connector = new CloudConnector({
      serverUrl: 'ws://localhost:8080',
      connectorId: 'node-a',
      connectorName: 'Browser node',
    });
    const send = vi.fn();
    (connector as any).ws = { readyState: 1, send };

    (connector as any).sendConnectorHello();

    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      type: 'connector_hello',
      connectorId: 'node-a',
      name: 'Browser node',
    });
  });

  it('returns a small error instead of sending an oversized response', () => {
    const connector = new CloudConnector({
      serverUrl: 'ws://localhost:8080',
      connectorId: 'node-a',
      connectorName: 'Browser node',
    });
    const send = vi.fn();
    (connector as any).ws = { readyState: 1, send };

    (connector as any).sendResponse({
      id: 'large-screenshot',
      success: true,
      data: 'x'.repeat(MAX_BUFFER_SIZE),
    });

    expect(send).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(send.mock.calls[0][0])).toBeLessThan(MAX_BUFFER_SIZE);
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      id: 'large-screenshot',
      success: false,
    });
  });

  it('stops reconnecting when the server replaces it with a newer connector', () => {
    const onSuperseded = vi.fn();
    const connector = new CloudConnector({
      serverUrl: 'ws://localhost:8080',
      connectorId: 'node-a',
      connectorName: 'Browser node',
      onSuperseded,
    });
    const reconnect = vi.spyOn(connector as any, 'tryReconnect');

    (connector as any).handleClose(
      1000,
      'Connector replaced by a newer connection',
      'ws://localhost:8080',
    );

    expect(onSuperseded).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('reports reconnect health details after a transient disconnect', () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const connector = new CloudConnector({
      serverUrl: 'ws://localhost:8080',
      connectorId: 'node-a',
      connectorName: 'Browser node',
      onStateChange,
    });

    (connector as any).handleClose(1006, 'network lost', 'ws://localhost:8080');

    expect(onStateChange).toHaveBeenLastCalledWith({
      state: 'reconnecting',
      reason: 'network lost',
      reconnectAttempt: 1,
      retryInMs: 1000,
    });
    connector.disconnect();
  });
});
