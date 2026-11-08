import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudServer } from '../index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('CloudServer request routing', () => {
  function addConnection(
    server: CloudServer,
    ws: { readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> },
    options: {
      id: string;
      fromLocal: boolean;
      connector?: { connectorId: string; name: string; version?: string };
    },
  ): void {
    (server as any).connections.set(ws, {
      ws,
      id: options.id,
      lastHeartbeat: Date.now(),
      connectedAt: Date.now(),
      role: options.fromLocal ? 'agent' : 'connector',
      connector: options.connector,
      fromLocal: options.fromLocal,
      messageBuffer: '',
    });
  }

  it('forwards action timeouts and clears pending state on connector response', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const agent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const connector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, agent, { id: 'agent', fromLocal: true });
    addConnection(server, connector, { id: 'connector', fromLocal: false });

    mutableServer.handleRequest(agent, {
      id: 'request-1',
      action: 'browser_launch',
      data: { name: 'account-a' },
      timeoutSec: 90,
    });

    const forwarded = JSON.parse(connector.send.mock.calls[0][0]);
    expect(forwarded).toMatchObject({
      action: 'browser_launch',
      timeoutSec: 90,
    });
    expect(forwarded.id).not.toBe('request-1');
    expect(mutableServer.pendingRequests.size).toBe(1);

    mutableServer.handleResponse(connector, {
      id: forwarded.id,
      success: true,
      data: { browserId: 'managed:account-a' },
    });

    expect(mutableServer.pendingRequests.size).toBe(0);
    expect(JSON.parse(agent.send.mock.calls[0][0])).toMatchObject({
      id: 'request-1',
      success: true,
    });
  });

  it('preserves the session envelope when forwarding to a connector', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const agent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const connector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    addConnection(server, agent, { id: 'agent', fromLocal: true });
    addConnection(server, connector, { id: 'connector', fromLocal: false });
    (server as any).handleRequest(agent, {
      id: 'scope',
      action: 'page_snapshot',
      data: { tabId: 1 },
      controlSessionId: 'cs_test',
    });
    expect(JSON.parse(connector.send.mock.calls[0]![0])).toMatchObject({
      controlSessionId: 'cs_test',
      data: { tabId: 1 },
    });
  });

  it('never routes a request to an idle connection on the loopback agent listener', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const idleAgent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const requestingAgent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const connector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, idleAgent, { id: 'idle-agent', fromLocal: true });
    addConnection(server, requestingAgent, { id: 'requesting-agent', fromLocal: true });
    addConnection(server, connector, { id: 'connector', fromLocal: false });

    mutableServer.handleRequest(requestingAgent, { id: 'request-2', action: 'get_logs', data: {} });

    expect(idleAgent.send).not.toHaveBeenCalled();
    expect(connector.send).toHaveBeenCalledOnce();
  });

  it('does not expose a transient public connection as a legacy connector', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const probe = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    mutableServer.connections.set(probe, {
      ws: probe,
      id: 'health-probe',
      lastHeartbeat: Date.now(),
      connectedAt: Date.now(),
      role: 'pending',
      fromLocal: false,
      messageBuffer: '',
    });

    expect(mutableServer.getConnectorList()).toMatchObject({ count: 0 });
    vi.advanceTimersByTime(1000);
    expect(mutableServer.getConnectorList()).toMatchObject({
      count: 1,
      connectors: [{ legacy: true }],
    });
  });

  it('isolates identical request ids from concurrent agent clients', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const firstAgent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const secondAgent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const connector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, firstAgent, { id: 'agent-a', fromLocal: true });
    addConnection(server, secondAgent, { id: 'agent-b', fromLocal: true });
    addConnection(server, connector, { id: 'connector', fromLocal: false });

    mutableServer.handleRequest(firstAgent, {
      id: 'same-request-id',
      action: 'get_logs',
      data: {},
    });
    mutableServer.handleRequest(secondAgent, {
      id: 'same-request-id',
      action: 'get_requests',
      data: {},
    });

    const firstForwarded = JSON.parse(connector.send.mock.calls[0][0]);
    const secondForwarded = JSON.parse(connector.send.mock.calls[1][0]);
    expect(firstForwarded.id).not.toBe(secondForwarded.id);

    mutableServer.handleResponse(connector, {
      id: secondForwarded.id,
      success: true,
      data: ['second'],
    });
    mutableServer.handleResponse(connector, {
      id: firstForwarded.id,
      success: true,
      data: ['first'],
    });

    expect(JSON.parse(firstAgent.send.mock.calls[0][0])).toMatchObject({
      id: 'same-request-id',
      data: ['first'],
    });
    expect(JSON.parse(secondAgent.send.mock.calls[0][0])).toMatchObject({
      id: 'same-request-id',
      data: ['second'],
    });
  });

  it('rejects pending requests immediately when their connector disconnects', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const agent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const connector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, agent, { id: 'agent', fromLocal: true });
    addConnection(server, connector, { id: 'connector', fromLocal: false });
    mutableServer.handleRequest(agent, {
      id: 'request-3',
      action: 'get_requests',
      data: {},
      timeoutSec: 90,
    });

    mutableServer.rejectPendingForWs(connector);

    expect(mutableServer.pendingRequests.size).toBe(0);
    expect(JSON.parse(agent.send.mock.calls[0][0])).toMatchObject({
      id: 'request-3',
      success: false,
      error: 'Connector connection closed',
    });
  });

  it('ignores a response from a connector that did not receive the request', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const agent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const connector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const otherConnector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, agent, { id: 'agent', fromLocal: true });
    addConnection(server, connector, { id: 'connector', fromLocal: false });
    addConnection(server, otherConnector, { id: 'other-connector', fromLocal: false });
    mutableServer.handleRequest(agent, {
      id: 'request-4',
      action: 'get_logs',
      data: {},
      connector: 'connector',
    });
    const forwarded = JSON.parse(connector.send.mock.calls[0][0]);

    mutableServer.handleResponse(otherConnector, { id: forwarded.id, success: true, data: [] });

    expect(mutableServer.pendingRequests.size).toBe(1);
    expect(agent.send).not.toHaveBeenCalled();
  });

  it('lists connectors and requires an explicit target when more than one is connected', () => {
    vi.useFakeTimers();
    const server = new CloudServer();
    const agent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const chromeConnector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const edgeConnector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, agent, { id: 'agent', fromLocal: true });
    addConnection(server, chromeConnector, {
      id: 'chrome-connection',
      fromLocal: false,
      connector: { connectorId: 'node-a', name: 'Chrome lab', version: '2.1.0' },
    });
    addConnection(server, edgeConnector, {
      id: 'edge-connection',
      fromLocal: false,
      connector: { connectorId: 'node-b', name: 'Edge lab', version: '2.1.0' },
    });

    mutableServer.handleRequest(agent, { id: 'list-1', action: 'connector_list', data: {} });
    expect(JSON.parse(agent.send.mock.calls[0][0])).toMatchObject({
      id: 'list-1',
      success: true,
      data: {
        count: 2,
        connectors: [
          { connectorId: 'node-a', name: 'Chrome lab' },
          { connectorId: 'node-b', name: 'Edge lab' },
        ],
      },
    });

    mutableServer.handleRequest(agent, { id: 'request-5', action: 'browser_list', data: {} });
    const ambiguousResponse = JSON.parse(agent.send.mock.calls[1][0]);
    expect(ambiguousResponse).toMatchObject({
      id: 'request-5',
      success: false,
    });
    expect(ambiguousResponse.error).toContain('Pass --connector <id|name>');
    expect(ambiguousResponse.error).toContain('Chrome lab [node-a]');
    expect(ambiguousResponse.error).toContain('Edge lab [node-b]');
    expect(ambiguousResponse.error).not.toContain('connector_list');
    expect(chromeConnector.send).not.toHaveBeenCalled();
    expect(edgeConnector.send).not.toHaveBeenCalled();

    mutableServer.handleRequest(agent, {
      id: 'request-6',
      action: 'browser_list',
      data: {},
      connector: 'node-b',
    });
    expect(edgeConnector.send).toHaveBeenCalledOnce();
    expect(chromeConnector.send).not.toHaveBeenCalled();
  });

  it('uses an agent hello to keep a remote agent out of connector routing', () => {
    vi.useFakeTimers();
    const server = new CloudServer({ allowRemoteAgent: true });
    const localAgent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const remoteAgent = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const connector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, localAgent, { id: 'local-agent', fromLocal: true });
    addConnection(server, remoteAgent, { id: 'remote-agent', fromLocal: false });
    addConnection(server, connector, {
      id: 'connector',
      fromLocal: false,
      connector: { connectorId: 'node-a', name: 'Browser node' },
    });

    mutableServer.handleAgentHello(remoteAgent);
    mutableServer.handleRequest(localAgent, { id: 'request-7', action: 'get_logs', data: {} });

    expect(remoteAgent.send).not.toHaveBeenCalled();
    expect(connector.send).toHaveBeenCalledOnce();
  });

  it('replaces an older connection that registers the same connector id', () => {
    const server = new CloudServer();
    const oldConnector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const newConnector = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const mutableServer = server as any;

    addConnection(server, oldConnector, {
      id: 'old',
      fromLocal: false,
      connector: { connectorId: 'node-a', name: 'Old name' },
    });
    addConnection(server, newConnector, { id: 'new', fromLocal: false });

    mutableServer.handleConnectorHello(newConnector, {
      type: 'connector_hello',
      connectorId: 'node-a',
      name: 'Browser node',
      version: '2.1.0',
    });

    expect(oldConnector.close).toHaveBeenCalledWith(
      1000,
      'Connector replaced by a newer connection',
    );
    expect(mutableServer.connections.has(oldConnector)).toBe(false);
    expect(mutableServer.getConnectorList()).toMatchObject({
      count: 1,
      connectors: [{ connectorId: 'node-a', name: 'Browser node' }],
    });
  });

  it('generates URL-safe authentication tokens with sufficient entropy', () => {
    const first = new CloudServer().getToken();
    const second = new CloudServer().getToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first).not.toBe(second);
  });
});
