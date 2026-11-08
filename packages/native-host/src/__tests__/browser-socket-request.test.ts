import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestBrowserSocket } from '../browser-socket-request.js';

const cleanupDirectories: string[] = [];

function testSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mearl-browser-manager-${process.pid}-${Date.now()}`;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-browser-manager-'));
  cleanupDirectories.push(directory);
  return path.join(directory, 'browser.sock');
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('requestBrowserSocket', () => {
  it('preserves an absolute deadline and private routing scope across another socket hop', async () => {
    const socketPath = testSocketPath();
    const deadline = Date.now() + 4000;
    let received: any;
    const server = net.createServer(socket => socket.once('data', chunk => {
      received = JSON.parse(chunk.toString());
      socket.end(JSON.stringify({ id: received.id, success: true, data: {} }) + '\n');
    }));
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      await requestBrowserSocket(socketPath, '__provider_enhancement', { operation: 'probe', tabId: 7 }, 'test', 60_000,
        undefined, undefined, { deadline, providerTarget: 'provider:test:a', providerControlToken: 'proof', providerSourceIdentity: 'epoch', providerPageId: 11 });
      expect(received).toMatchObject({ deadline, providerTarget: 'provider:test:a', providerControlToken: 'proof', providerSourceIdentity: 'epoch', providerPageId: 11 });
      expect(received.data).toEqual({ operation: 'probe', tabId: 7 });
      await expect(requestBrowserSocket(socketPath, 'browser_launch', {}, 'test', 60_000,
        undefined, undefined, { deadline: Date.now() - 1 })).rejects.toThrow('deadline');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('forwards a manager call deadline without exposing it as a Provider option', async () => {
    const socketPath = testSocketPath();
    let request: any;
    const server = net.createServer(socket =>
      socket.once('data', chunk => {
        request = JSON.parse(chunk.toString());
        socket.end(JSON.stringify({ id: request.id, success: true, data: {} }) + '\n');
      }),
    );
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      const before = Date.now();
      await requestBrowserSocket(
        socketPath,
        'browser_close',
        {},
        'test',
        1_080_000,
        undefined,
        undefined,
        { providerTarget: 'provider:test:a' },
      );
      expect(request.deadline).toBeGreaterThanOrEqual(before + 1_080_000);
      expect(request.deadline).toBeLessThanOrEqual(Date.now() + 1_080_000);
      expect(request.data).toEqual({});
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('forwards a browser action and resolves its matching response', async () => {
    const socketPath = testSocketPath();
    const server = net.createServer(socket => {
      socket.once('data', chunk => {
        const request = JSON.parse(chunk.toString().trim());
        expect(request).toMatchObject({
          action: 'browser_release',
          data: {},
          version: '2.10.0',
          controlSource: 'local',
        });
        socket.end(
          `${JSON.stringify({ id: request.id, success: true, data: { detached: true } })}\n`,
        );
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    await expect(
      requestBrowserSocket(socketPath, 'browser_release', {}, '2.10.0'),
    ).resolves.toEqual({ detached: true });

    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('surfaces an error returned by the target browser', async () => {
    const socketPath = testSocketPath();
    const server = net.createServer(socket => {
      socket.once('data', chunk => {
        const request = JSON.parse(chunk.toString().trim());
        socket.end(
          `${JSON.stringify({ id: request.id, success: false, error: 'release failed' })}\n`,
        );
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    await expect(requestBrowserSocket(socketPath, 'browser_release', {}, '2.10.0')).rejects.toThrow(
      'release failed',
    );

    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});
