import { describe, it, expect } from 'vitest';
import {
  isHeartbeatMessage,
  isCloudMessage,
  isCloudResponse,
  isAgentHelloMessage,
  isConnectorHelloMessage,
  resolveCloudConnectorSelector,
  type HeartbeatMessage,
  type CloudMessage,
  type CloudResponse,
} from '../index';

describe('resolveCloudConnectorSelector', () => {
  const connectors = [
    { connectorId: 'edge-backup', name: 'Backup node' },
    { connectorId: 'node-a', name: 'Edge' },
    { connectorId: 'node-b', name: 'Edge lab' },
  ];

  it('prioritizes exact ids and names over partial matches', () => {
    expect(resolveCloudConnectorSelector(connectors, 'node-a')).toEqual({
      status: 'matched',
      connector: connectors[1],
    });
    expect(resolveCloudConnectorSelector(connectors, 'edge')).toEqual({
      status: 'matched',
      connector: connectors[1],
    });
  });

  it('distinguishes ambiguous, empty, and missing selectors', () => {
    expect(resolveCloudConnectorSelector(connectors, 'node')).toEqual({ status: 'ambiguous' });
    expect(resolveCloudConnectorSelector(connectors, '  ')).toEqual({ status: 'not_found' });
    expect(resolveCloudConnectorSelector(connectors, 'safari')).toEqual({ status: 'not_found' });
  });
});

describe('connection hello guards', () => {
  it('recognizes explicit agent and connector roles', () => {
    expect(isAgentHelloMessage({ type: 'agent_hello' })).toBe(true);
    expect(
      isConnectorHelloMessage({
        type: 'connector_hello',
        connectorId: 'node-a',
        name: 'Browser node',
        version: '2.1.0',
      }),
    ).toBe(true);
    expect(
      isConnectorHelloMessage({ type: 'connector_hello', connectorId: '', name: 'Browser node' }),
    ).toBe(false);
  });
});

describe('isHeartbeatMessage', () => {
  it('accepts ping and pong frames', () => {
    expect(isHeartbeatMessage({ type: 'ping', timestamp: 1 } satisfies HeartbeatMessage)).toBe(
      true,
    );
    expect(isHeartbeatMessage({ type: 'pong', timestamp: 1 } satisfies HeartbeatMessage)).toBe(
      true,
    );
  });

  it('rejects other shapes', () => {
    expect(isHeartbeatMessage({ type: 'data' })).toBe(false);
    // 谓词以真值判定语义使用（if (isHeartbeatMessage(x))），null/undefined 入参回落为假值而非字面 false。
    expect(isHeartbeatMessage(null)).toBeFalsy();
    expect(isHeartbeatMessage(undefined)).toBeFalsy();
  });
});

describe('isCloudMessage', () => {
  it('accepts a message with string id and action', () => {
    const msg: CloudMessage = {
      id: 'm1',
      action: 'get_requests',
      data: {},
      timeoutSec: 60,
    };
    expect(isCloudMessage(msg)).toBe(true);
  });

  it('rejects messages missing id or action', () => {
    expect(isCloudMessage({ id: 'm1' })).toBe(false);
    expect(isCloudMessage({ action: 'x', data: {} })).toBe(false);
    expect(isCloudMessage({ id: 1, action: 'x' })).toBe(false); // id must be a string
    expect(isCloudMessage({ id: 'm1', action: 'x', connector: {} })).toBe(false);
    expect(isCloudMessage({ id: 'm1', action: 'x', browser: 1 })).toBe(false);
    expect(isCloudMessage(null)).toBeFalsy();
  });

  it('does not confuse a heartbeat for a cloud message', () => {
    expect(isCloudMessage({ type: 'ping', timestamp: 1 })).toBe(false);
  });
});

describe('isCloudResponse', () => {
  it('accepts a response with string id and boolean success', () => {
    const res: CloudResponse = { id: 'm1', success: true, data: { ok: 1 } };
    expect(isCloudResponse(res)).toBe(true);
    expect(isCloudResponse({ id: 'm1', success: false, error: 'boom' })).toBe(true);
  });

  it('rejects responses with a non-boolean success or missing id', () => {
    expect(isCloudResponse({ id: 'm1', success: 'yes' })).toBe(false);
    expect(isCloudResponse({ success: true })).toBe(false);
    expect(isCloudResponse(null)).toBeFalsy();
  });
});
