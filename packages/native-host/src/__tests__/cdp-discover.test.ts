import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpSession } from '../cdp-backend/cdp-session.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temporaryUserDataDir(activeEndpoint?: { port: number; browserWsPath: string }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-cdp-discover-'));
  if (activeEndpoint) {
    fs.writeFileSync(
      path.join(directory, 'DevToolsActivePort'),
      `${activeEndpoint.port}\n${activeEndpoint.browserWsPath}\n`,
    );
  }
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function startCdpServer(
  options: {
    httpDiscovery?: boolean;
    approvalMode?: boolean;
    rejectApproval?: boolean;
    discoveryStatus?: number;
  } = {},
): Promise<{
  port: number;
  browserWsPath: string;
  connectionCount: () => number;
}> {
  const browserWsPath = options.approvalMode ? '/devtools/browser' : '/devtools/browser/live';
  let port = 0;
  let connectionCount = 0;
  const server = http.createServer((request, response) => {
    if (options.httpDiscovery && request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}${browserWsPath}` }),
      );
      return;
    }
    response.writeHead(options.discoveryStatus ?? 404);
    response.end();
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== browserWsPath) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (options.rejectApproval) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, webSocket => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });
  webSocketServer.on('connection', webSocket => {
    connectionCount += 1;
    webSocket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      webSocket.send(JSON.stringify({ id: request.id, result: { targetInfos: [] } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  port = address.port;
  cleanups.push(async () => {
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>(resolve => webSocketServer.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { port, browserWsPath, connectionCount: () => connectionCount };
}

function trackSession(session: CdpSession): CdpSession {
  cleanups.push(() => session.close());
  return session;
}

function denyDiscoveryFile(userDataDir: string, code: 'EPERM' | 'EACCES'): string {
  const discoveryPath = path.join(userDataDir, 'DevToolsActivePort');
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === discoveryPath)
      throw Object.assign(new Error(`${code}: permission denied, open '${discoveryPath}'`), {
        code,
      });
    return readFileSync(...args);
  });
  return discoveryPath;
}

describe('CDP availability', () => {
  it('does not treat a stale DevToolsActivePort file as a connected browser', async () => {
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    await new Promise<void>(resolve => probe.close(() => resolve()));

    const session = trackSession(
      new CdpSession({
        port: address.port,
        userDataDir: temporaryUserDataDir({
          port: address.port,
          browserWsPath: '/devtools/browser/stale',
        }),
      }),
    );

    await expect(session.probeAvailability()).resolves.toMatchObject({
      available: false,
      error: expect.stringMatching(/.+/),
    });
  });

  it('accepts a live browser WebSocket when HTTP discovery is unavailable', async () => {
    const endpoint = await startCdpServer();
    const session = trackSession(
      new CdpSession({
        port: endpoint.port,
        userDataDir: temporaryUserDataDir(endpoint),
      }),
    );

    await expect(Promise.all([session.isAvailable(), session.isAvailable()])).resolves.toEqual([
      true,
      true,
    ]);
    await expect(session.isAvailable()).resolves.toBe(true);
    expect(session.hasActiveConnections()).toBe(true);
    expect(endpoint.connectionCount()).toBe(1);
  });

  it('falls back to HTTP discovery when the active-port file is absent', async () => {
    const endpoint = await startCdpServer({ httpDiscovery: true });
    const session = trackSession(
      new CdpSession({
        port: endpoint.port,
        userDataDir: temporaryUserDataDir(),
      }),
    );

    await expect(session.isAvailable()).resolves.toBe(true);
  });

  it('connects to the approval endpoint on the configured port without a discovery file', async () => {
    const endpoint = await startCdpServer({ approvalMode: true });
    const session = trackSession(
      new CdpSession({ port: endpoint.port, userDataDir: temporaryUserDataDir() }),
    );

    await expect(Promise.all([session.isAvailable(), session.isAvailable()])).resolves.toEqual([
      true,
      true,
    ]);
    expect(endpoint.connectionCount()).toBe(1);
  });

  it('uses Chrome approval when the discovery file cannot be read', async () => {
    const endpoint = await startCdpServer({ approvalMode: true });
    const userDataDir = temporaryUserDataDir(endpoint);
    denyDiscoveryFile(userDataDir, 'EPERM');
    const session = trackSession(new CdpSession({ port: endpoint.port, userDataDir }));

    await expect(session.probeAvailability()).resolves.toEqual({ available: true });
    expect(endpoint.connectionCount()).toBe(1);
  });

  it('reports file access and approval rejection instead of hiding them behind a missing port', async () => {
    const endpoint = await startCdpServer({ approvalMode: true, rejectApproval: true });
    const userDataDir = temporaryUserDataDir(endpoint);
    const discoveryPath = denyDiscoveryFile(userDataDir, 'EACCES');
    const session = trackSession(new CdpSession({ port: endpoint.port, userDataDir }));

    const probe = await session.probeAvailability();
    expect(probe.available).toBe(false);
    expect(probe.error).toContain('status 403');
    expect(probe.error).toContain('Allow the remote debugging connection in Chrome');
    expect(probe.error).toContain(`EACCES: permission denied, open '${discoveryPath}'`);
    expect(endpoint.connectionCount()).toBe(0);
  });

  it('does not request approval when HTTP discovery fails with another status', async () => {
    const endpoint = await startCdpServer({ approvalMode: true, discoveryStatus: 503 });
    const session = trackSession(
      new CdpSession({ port: endpoint.port, userDataDir: temporaryUserDataDir() }),
    );

    await expect(session.probeAvailability()).resolves.toEqual({
      available: false,
      error: 'CDP HTTP discovery returned status 503',
    });
    expect(endpoint.connectionCount()).toBe(0);
  });

  it('keeps an explicitly configured endpoint authoritative', async () => {
    const endpoint = await startCdpServer({ approvalMode: true });
    const session = trackSession(
      new CdpSession({
        port: endpoint.port,
        userDataDir: temporaryUserDataDir(),
        endpointUrl: `ws://127.0.0.1:${endpoint.port}/devtools/browser/explicit`,
      }),
    );

    await expect(session.probeAvailability()).resolves.toMatchObject({
      available: false,
      error: expect.stringContaining('status 404'),
    });
    expect(endpoint.connectionCount()).toBe(0);
  });

  it('preserves the discovery file error if HTTP discovery also fails', async () => {
    const endpoint = await startCdpServer({ discoveryStatus: 503 });
    const userDataDir = temporaryUserDataDir(endpoint);
    const discoveryPath = denyDiscoveryFile(userDataDir, 'EPERM');
    const session = trackSession(new CdpSession({ port: endpoint.port, userDataDir }));

    const probe = await session.probeAvailability();
    expect(probe.available).toBe(false);
    expect(probe.error).toContain(`EPERM: permission denied, open '${discoveryPath}'`);
    expect(probe.error).toContain('CDP HTTP discovery returned status 503');
  });
});
