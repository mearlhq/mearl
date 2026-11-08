import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { CdpClient } from '../client.js';

it('retains earlier main-world contexts independently per CDP session and releases them on lifecycle events', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const port = (server.address() as { port: number }).port;
  const client = await CdpClient.connect(`ws://127.0.0.1:${port}`);
  const [peer] = await connected;
  const created = (sessionId: string, id: number, isDefault = true) => peer.send(JSON.stringify({ sessionId, method: 'Runtime.executionContextCreated', params: { context: { id, auxData: { frameId: 'root', isDefault } } } }));
  try {
    created('page-a', 11); created('page-b', 21); created('page-a', 12, false);
    const first = client.createChildSession('page-a'), second = client.createChildSession('page-b');
    await vi.waitFor(() => expect(first.getDefaultExecutionContexts().get('root')).toBe(11));
    expect(second.getDefaultExecutionContexts().get('root')).toBe(21);
    (first.getDefaultExecutionContexts() as Map<string, number>).clear();
    expect(first.getDefaultExecutionContexts().get('root')).toBe(11);
    peer.send(JSON.stringify({ sessionId: 'page-a', method: 'Runtime.executionContextDestroyed', params: { executionContextId: 11 } }));
    await vi.waitFor(() => expect(first.getDefaultExecutionContexts().size).toBe(0));
    expect(second.getDefaultExecutionContexts().get('root')).toBe(21);
    peer.send(JSON.stringify({ sessionId: 'page-b', method: 'Runtime.executionContextsCleared', params: {} }));
    await vi.waitFor(() => expect(second.getDefaultExecutionContexts().size).toBe(0));
    created('page-a', 31);
    await vi.waitFor(() => expect(first.getDefaultExecutionContexts().get('root')).toBe(31));
    peer.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'page-a' } }));
    await vi.waitFor(() => expect(first.getDefaultExecutionContexts().size).toBe(0));
    created('page-a', 41);
    await vi.waitFor(() => expect(first.getDefaultExecutionContexts().get('root')).toBe(41));
    client.close(); expect(first.getDefaultExecutionContexts().size).toBe(0);
  } finally { client.close(); peer.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
