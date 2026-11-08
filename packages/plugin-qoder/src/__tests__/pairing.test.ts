import { describe, expect, it, vi } from 'vitest';
import {
  createQoderPairingInfo,
  formatQoderPairingOutput,
  runQoderCloudServerCommand,
} from '../pairing.js';

describe('Qoder pairing', () => {
  it('creates a credential-free connector URL and matching tool input', () => {
    const pairing = createQoderPairingInfo({
      now: () => 1786723200000,
      createCode: () => 'pairing-code-1234',
    });

    expect(pairing).toEqual({
      pairingCode: 'pairing-code-1234',
      createdAt: 1786723200000,
      connectorUrl: 'qoder://pair/pairing-code-1234?created=1786723200000',
      toolInput: { action: 'pair', payload: { code: 'pairing-code-1234' } },
    });
    expect(pairing.connectorUrl).not.toContain('token');
    expect(pairing.connectorUrl).not.toContain('pat');
  });

  it('prints the local connector command before the custom tool request', () => {
    const output = formatQoderPairingOutput(
      createQoderPairingInfo({
        now: () => 1786723200000,
        createCode: () => 'pairing-code-1234',
      }),
    );

    expect(output).toContain(
      'npx @mearl/cloud-connector start "qoder://pair/pairing-code-1234?created=1786723200000"',
    );
    expect(output).toContain('{"action":"pair","payload":{"code":"pairing-code-1234"}}');
    expect(output.indexOf('npx @mearl/cloud-connector')).toBeLessThan(
      output.indexOf('{"action":"pair"'),
    );
  });

  it('uses the existing lifecycle commands without starting a listening service', async () => {
    const stopServer = vi.fn(async () => {});
    const printStatus = vi.fn();
    const printLogs = vi.fn();
    const writeLine = vi.fn();
    const dependencies = {
      createPairing: () =>
        createQoderPairingInfo({
          now: () => 1786723200000,
          createCode: () => 'pairing-code-1234',
        }),
      isServerRunning: () => false,
      stopServer,
      printStatus,
      printLogs,
      writeLine,
    };

    await runQoderCloudServerCommand('start', dependencies);
    await runQoderCloudServerCommand('status', dependencies);
    await runQoderCloudServerCommand('logs', dependencies);

    expect(stopServer).not.toHaveBeenCalled();
    expect(printStatus).toHaveBeenCalledOnce();
    expect(printLogs).toHaveBeenCalledOnce();
    expect(writeLine).toHaveBeenCalledWith(expect.stringContaining('Qoder pairing mode is ready'));
    expect(writeLine).toHaveBeenCalledWith(
      '[CloudServer] Mode: qoder pairing (no listening service)',
    );
  });

  it('stops an existing WebSocket daemon before switching to Qoder pairing', async () => {
    const stopServer = vi.fn(async () => {});

    await runQoderCloudServerCommand('restart', {
      createPairing: () =>
        createQoderPairingInfo({
          now: () => 1786723200000,
          createCode: () => 'pairing-code-1234',
        }),
      isServerRunning: () => true,
      stopServer,
      printStatus: vi.fn(),
      printLogs: vi.fn(),
      writeLine: vi.fn(),
    });

    expect(stopServer).toHaveBeenCalledOnce();
  });

  it('rejects malformed injected pairing values', () => {
    expect(() =>
      createQoderPairingInfo({ createCode: () => 'short', now: () => 1786723200000 }),
    ).toThrow('URL-safe');
    expect(() =>
      createQoderPairingInfo({ createCode: () => 'pairing-code-1234', now: () => 0 }),
    ).toThrow('13-digit');
  });
});
