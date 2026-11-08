import { describe, expect, it } from 'vitest';
import { parseCloudConnectorArgs } from '../cli.js';

describe('parseCloudConnectorArgs', () => {
  it('parses a bare endpoint as a foreground connector', () => {
    expect(
      parseCloudConnectorArgs([
        'wss://cloud.example.com/ws?token=test',
        '--heartbeat=20',
        '--fail-fast',
      ]),
    ).toMatchObject({
      command: null,
      foreground: true,
      options: {
        failFast: true,
        heartbeatInterval: 20,
        serverUrl: 'wss://cloud.example.com/ws?token=test',
      },
    });
  });

  it('parses a background start and canonicalizes daemon options', () => {
    expect(
      parseCloudConnectorArgs([
        'start',
        'qoder://pair/pairing-code-1234',
        '--reconnect',
        '2500',
        '--name',
        'worker-a',
      ]),
    ).toMatchObject({
      command: 'start',
      daemonArgs: ['--reconnect', '2500', '--name', 'worker-a'],
      foreground: false,
      serverUrl: 'qoder://pair/pairing-code-1234',
    });
  });

  it('accepts the daemon child foreground form', () => {
    expect(
      parseCloudConnectorArgs([
        '--foreground',
        'ws://localhost:8080/ws',
        '--connector-id',
        'local-a',
      ]),
    ).toMatchObject({
      command: null,
      foreground: true,
      options: { connectorId: 'local-a' },
    });
  });

  it('rejects typo commands instead of starting a connector', () => {
    expect(() => parseCloudConnectorArgs(['strat', 'wss://cloud.example.com/ws'])).toThrow(
      'Unknown command',
    );
  });

  it('strictly validates options and numeric values', () => {
    expect(() => parseCloudConnectorArgs(['start', 'ws://localhost', '--name'])).toThrow(
      'argument missing',
    );
    expect(() =>
      parseCloudConnectorArgs(['start', 'ws://localhost', '--reconnect', '5000ms']),
    ).toThrow('reconnect must');
    expect(() => parseCloudConnectorArgs(['list', '--fail-fast'])).toThrow(
      'not available for list',
    );
  });

  it('supports stopping by pid', () => {
    expect(parseCloudConnectorArgs(['stop', '12345'])).toMatchObject({
      command: 'stop',
      stopAll: false,
      stopPid: 12345,
    });
    expect(() => parseCloudConnectorArgs(['stop', '0'])).toThrow('positive pid');
    expect(() => parseCloudConnectorArgs(['stop', '123x'])).toThrow('positive pid');
  });

  it('supports stop --all and rejects ambiguous stop targets', () => {
    expect(parseCloudConnectorArgs(['stop', '--all'])).toMatchObject({
      command: 'stop',
      stopAll: true,
    });
    expect(() => parseCloudConnectorArgs(['stop', 'ws://localhost', '--all'])).toThrow(
      'either a server-url, pid, or --all',
    );
    expect(() => parseCloudConnectorArgs(['stop', '12345', '--all'])).toThrow(
      'either a server-url, pid, or --all',
    );
  });

  it('parses help and version without requiring an endpoint', () => {
    expect(parseCloudConnectorArgs(['--help'])).toMatchObject({ help: true });
    expect(parseCloudConnectorArgs(['--version'])).toMatchObject({ version: true });
  });
});
