import { describe, expect, it } from 'vitest';
import {
  isConnectorEndpoint,
  parseConnectorEndpoint,
  requireConnectorEndpoint,
} from '../endpoint.js';

describe('connector endpoint', () => {
  it.each(['ws://localhost:8080/ws?token=test', 'wss://cloud.example/ws?token=test'])(
    'keeps native WebSocket endpoint %s unchanged',
    serverUrl => {
      expect(parseConnectorEndpoint(serverUrl)).toEqual({
        serverUrl,
        transportUrl: serverUrl,
        scheme: serverUrl.startsWith('wss:') ? 'wss' : 'ws',
      });
    },
  );

  it('retains a plugin URI without interpreting its private pairing data', () => {
    const serverUrl = 'sample://pair/opaque?created=1786723200000';
    expect(parseConnectorEndpoint(serverUrl)).toEqual({ serverUrl, transportUrl: serverUrl, scheme: 'sample' });
  });
  it.each(['', 'https://cloud.example/ws', 'file:///tmp/x', 'javascript:alert(1)', 'sample://user:pass@pair/x', 'sample://pair/x#fragment', 'not-a-url'])(
    'rejects unsupported endpoint %j', serverUrl => expect(isConnectorEndpoint(serverUrl)).toBe(false),
  );

  it('throws a useful error for programmatic callers', () => {
    expect(() => requireConnectorEndpoint('https://cloud.example/ws')).toThrow(
      'serverUrl must be a valid connector URL without credentials or a fragment',
    );
  });
});
