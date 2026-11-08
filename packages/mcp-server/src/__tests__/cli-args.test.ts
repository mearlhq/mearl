import { describe, expect, it } from 'vitest';
import { parseMcpArgs } from '../cliArgs.js';

describe('parseMcpArgs', () => {
  it('keeps an empty argv reserved for the MCP stdio server', async () => {
    await expect(parseMcpArgs([])).resolves.toEqual({ forwardedArgs: [], mode: 'server' });
  });

  it('canonicalizes configure arguments and compatibility aliases', async () => {
    await expect(
      parseMcpArgs([
        '--configure',
        '--extension-id=abcdefghijklmnopqrstuvwxyzabcdef',
        '--global-install',
        '--non-interactive',
      ]),
    ).resolves.toEqual({
      forwardedArgs: [
        '--extension-id',
        'abcdefghijklmnopqrstuvwxyzabcdef',
        '--global-install',
        '--yes',
      ],
      mode: 'configure',
    });
    await expect(
      parseMcpArgs(['--extension-id', 'abcdefghijklmnopqrstuvwxyzabcdef', '--configure']),
    ).resolves.toEqual({
      forwardedArgs: ['--extension-id', 'abcdefghijklmnopqrstuvwxyzabcdef'],
      mode: 'configure',
    });
  });

  it('forwards uninstall confirmation and setup ownership flags', async () => {
    await expect(parseMcpArgs(['uninstall', '--managed-by-setup', '--yes'])).resolves.toEqual({
      forwardedArgs: ['--managed-by-setup', '--yes'],
      mode: 'uninstall',
    });
  });

  it('rejects unknown commands, options, and command-specific option misuse', async () => {
    await expect(parseMcpArgs(['configuree'])).rejects.toThrow('Unknown command');
    await expect(parseMcpArgs(['configure', '--unknown'])).rejects.toThrow('unknown option');
    await expect(parseMcpArgs(['uninstall', '--skip-mcp'])).rejects.toThrow(
      'not available for uninstall',
    );
    await expect(parseMcpArgs(['--configure', '--uninstall'])).rejects.toThrow(
      'cannot be used together',
    );
  });

  it('parses help and version without selecting a lifecycle command', async () => {
    await expect(parseMcpArgs(['--help'])).resolves.toEqual({ forwardedArgs: [], mode: 'help' });
    await expect(parseMcpArgs(['--version'])).resolves.toEqual({
      forwardedArgs: [],
      mode: 'version',
    });
  });
});
