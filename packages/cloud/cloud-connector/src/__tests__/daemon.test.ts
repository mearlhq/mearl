import { describe, expect, it } from 'vitest';
import { formatConnectorStatus, resolveConnectorHealth, type ConnectorRecord } from '../daemon.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function record(overrides: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    pid: process.pid,
    serverUrl: 'wss://cloud.example/ws?token=secret',
    startedAt: '2026-08-27T11:00:00.000Z',
    ...overrides,
  };
}

describe('cloud connector daemon status', () => {
  it.each(['reconnecting', 'failed', 'connected'] as const)(
    'offers Server recovery only for an unhealthy WebSocket connector: %s',
    connectionState => {
      const fields = { connectionState, lastHeartbeatAt: '2026-08-27T11:00:00.000Z' };
      const lines = formatConnectorStatus(record(fields), NOW).join('\n');
      expect(lines).toContain('on the Agent machine, run mearl-cloud-server status');
      expect(lines).not.toContain('token=secret');

      const qoderLines = formatConnectorStatus(
        record({ ...fields, serverUrl: 'qoder://pair/pairing-code-1234' }),
        NOW,
      ).join('\n');
      expect(qoderLines).not.toContain('mearl-cloud-server status');
    },
  );

  it('reports a connected connector with a recent heartbeat as healthy', () => {
    const current = record({
      connectionState: 'connected',
      connectedAt: '2026-08-27T11:30:00.000Z',
      lastHeartbeatAt: '2026-08-27T11:59:30.000Z',
    });

    expect(resolveConnectorHealth(current, NOW)).toBe('healthy');
    expect(formatConnectorStatus(current, NOW)).toContain('  status:     healthy');
    expect(formatConnectorStatus(current, NOW).join('\n')).not.toContain('next step:');
  });

  it('marks a WebSocket connector with a stale heartbeat as degraded', () => {
    expect(
      resolveConnectorHealth(
        record({
          connectionState: 'connected',
          connectedAt: '2026-08-27T11:30:00.000Z',
          lastHeartbeatAt: '2026-08-27T11:58:00.000Z',
        }),
        NOW,
      ),
    ).toBe('degraded');
  });

  it.each(['WS://cloud.example/ws', 'WSS://cloud.example/ws'])('checks stale heartbeats for %s', serverUrl => {
    const stale = record({ serverUrl, connectionState: 'connected', lastHeartbeatAt: '2026-08-27T11:00:00.000Z' });
    expect(resolveConnectorHealth(stale, NOW)).toBe('degraded');
    expect(formatConnectorStatus(stale, NOW).join('\n')).toContain('mearl-cloud-server status');
  });

  it('shows retry diagnostics and redacts endpoint tokens', () => {
    const lines = formatConnectorStatus(
      record({
        connectionState: 'reconnecting',
        lastError: 'Unexpected server response: 502',
        reconnectAttempt: 4,
        nextRetryAt: '2026-08-27T12:00:08.000Z',
      }),
      NOW,
    );

    expect(lines).toContain('  status:     reconnecting');
    expect(lines).toContain('  last error: Unexpected server response: 502');
    expect(lines).toContain('  retry:      attempt 4');
    expect(lines.join('\n')).toContain('token=redacted');
    expect(lines.join('\n')).not.toContain('token=secret');
  });

  it('keeps legacy live records visible with an unknown health state', () => {
    const legacy = record();
    expect(resolveConnectorHealth(legacy, NOW)).toBe('unknown');
    expect(formatConnectorStatus(legacy, NOW)).toContain(
      '  note:       restart to enable health reporting',
    );
  });
});
