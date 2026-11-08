import { describe, expect, it } from 'vitest';
import { parseCloudServerArgs } from '../cli.js';

describe('parseCloudServerArgs', () => {
  it('defaults to a background start', () => {
    expect(parseCloudServerArgs([])).toMatchObject({
      command: 'start',
      daemonArgs: [],
      foreground: false,
      options: {},
    });
  });

  it('strictly parses start options and canonicalizes daemon arguments', () => {
    expect(
      parseCloudServerArgs([
        'start',
        '--port=9000',
        '--agent-port',
        '9001',
        '--heartbeat',
        '45',
        '--allow-remote-agent',
      ]),
    ).toMatchObject({
      command: 'start',
      daemonArgs: [
        '--port',
        '9000',
        '--agent-port',
        '9001',
        '--heartbeat',
        '45',
        '--allow-remote-agent',
      ],
      options: {
        agentPort: 9001,
        allowRemoteAgent: true,
        heartbeatTimeout: 45,
        port: 9000,
      },
    });
  });

  it('accepts the hidden foreground daemon form without an explicit command', () => {
    expect(parseCloudServerArgs(['--foreground', '--port', '9000'])).toMatchObject({
      command: 'start',
      foreground: true,
      options: { port: 9000 },
    });
  });

  it('rejects command typos, unknown options, missing values, and partial integers', () => {
    expect(() => parseCloudServerArgs(['stats'])).toThrow('Unknown command');
    expect(() => parseCloudServerArgs(['start', '--unknown'])).toThrow('unknown option');
    expect(() => parseCloudServerArgs(['start', '--port'])).toThrow('argument missing');
    expect(() => parseCloudServerArgs(['start', '--port', '8080abc'])).toThrow('port must');
  });

  it('rejects start-only options on management commands', () => {
    expect(() => parseCloudServerArgs(['status', '--port', '9000'])).toThrow(
      'not available for status',
    );
    expect(() => parseCloudServerArgs(['restart', '--foreground'])).toThrow(
      'only available for start',
    );
  });

  it('parses help and version without running a command', () => {
    expect(parseCloudServerArgs(['--help'])).toMatchObject({ help: true });
    expect(parseCloudServerArgs(['--version'])).toMatchObject({ version: true });
  });
});
