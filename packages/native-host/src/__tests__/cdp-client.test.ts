import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { CdpClient } from '../cdp-backend/client.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('CdpClient', () => {
  it('routes native transport replies and child events, and rejects pending work on disconnect', async () => {
    let receive!: (message: string) => void;
    let disconnect!: () => void;
    const sent: any[] = [];
    const unsubscribe = vi.fn();
    const close = vi.fn();
    const client = CdpClient.fromTransport({
      identity: 'ego:9',
      close,
      subscribe(onMessage, onClose) {
        receive = onMessage;
        disconnect = onClose;
        return unsubscribe;
      },
      send(raw) {
        sent.push(JSON.parse(raw));
      },
    });
    const child = client.createChildSession('page-a');
    const event = vi.fn();
    child.on('Page.loadEventFired', event);
    receive(JSON.stringify({ sessionId: 'page-b', method: 'Page.loadEventFired', params: {} }));
    expect(event).not.toHaveBeenCalled();
    receive(
      JSON.stringify({
        sessionId: 'page-a',
        method: 'Page.loadEventFired',
        params: { timestamp: 1 },
      }),
    );
    expect(event).toHaveBeenCalledWith({ timestamp: 1 });
    const command = child.sendCommand('Page.enable');
    expect(sent[0].sessionId).toBe('page-a');
    receive(JSON.stringify({ id: sent[0].id, sessionId: 'page-a', result: { ready: true } }));
    await expect(command).resolves.toEqual({ ready: true });
    const pending = child.sendCommand('Runtime.enable');
    const rejected = expect(pending).rejects.toThrow(/closed/);
    disconnect();
    await rejected;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(client.closed).toBe(true);
  });

  it('preserves signed endpoint query parameters', async () => {
    const server = http.createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    let requestedPath = '';
    server.on('upgrade', (request, socket, head) => {
      requestedPath = request.url ?? '';
      webSocketServer.handleUpgrade(request, socket, head, ws => {
        ws.on('message', raw => {
          const requestMessage = JSON.parse(raw.toString()) as { id: number };
          ws.send(JSON.stringify({ id: requestMessage.id, result: { product: 'Chrome/Test' } }));
        });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>(resolve => {
          webSocketServer.close(() => server.close(() => resolve()));
        }),
    );

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const client = await CdpClient.connect(
      `ws://127.0.0.1:${address.port}/devtools/browser/test?token=signed-value`,
    );
    cleanups.push(async () => client.close());
    const version = await client.sendCommand('Browser.getVersion');

    expect(requestedPath).toBe('/devtools/browser/test?token=signed-value');
    expect(version).toEqual({ product: 'Chrome/Test' });
  });
});
