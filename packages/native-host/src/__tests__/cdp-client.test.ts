import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { CdpClient } from '../cdp-backend/client.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('CdpClient', () => {
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
