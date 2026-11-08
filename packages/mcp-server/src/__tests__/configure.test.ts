import { describe, expect, it, vi } from 'vitest';
import { parseConfigureArgs, shouldUseNpx } from '../configure.js';
import { getMCPServerConfig } from '../mcp-clients.js';

describe('MCP runtime configuration', () => {
  it.each([true, false])('pins npx downloads in servers format %s', useServersFormat => {
    expect(getMCPServerConfig(useServersFormat, true)).toMatchObject({
      command: 'npx',
      args: [
        '-y',
        '--registry=https://registry.npmjs.org/',
        '--@mearl:registry=https://registry.npmjs.org/',
        '@mearl/mcp-server',
      ],
    });
    const directConfig = getMCPServerConfig(useServersFormat, false);
    expect(directConfig.command).toBe('mearl-mcp-server');
    expect(directConfig.args ?? []).toEqual([]);
  });
});

describe('parseConfigureArgs', () => {
  it('accepts setup-managed non-interactive configuration flags', () => {
    expect(
      parseConfigureArgs([
        '--global-install',
        '--yes',
        '--extension-id=abcdefghijklmnopqrstuvwxyzabcdef',
      ]),
    ).toEqual({
      extensionId: 'abcdefghijklmnopqrstuvwxyzabcdef',
      get: false,
      globalInstall: true,
      help: false,
      skipMcp: false,
      yes: true,
    });
  });

  it('accepts the descriptive non-interactive alias', () => {
    expect(parseConfigureArgs(['--non-interactive'])).toEqual({
      extensionId: undefined,
      get: false,
      globalInstall: false,
      help: false,
      skipMcp: false,
      yes: true,
    });
  });

  it('supports spaced option values and rejects unknown options', () => {
    expect(
      parseConfigureArgs(['--extension-id', 'abcdefghijklmnopqrstuvwxyzabcdef']),
    ).toMatchObject({ extensionId: 'abcdefghijklmnopqrstuvwxyzabcdef' });
    expect(() => parseConfigureArgs(['--unknown'])).toThrow('unknown option');
  });
});

describe('shouldUseNpx', () => {
  it('uses the installed global command for setup-managed configuration', () => {
    const detectNpxMode = vi.fn(() => true);

    expect(shouldUseNpx(true, detectNpxMode)).toBe(false);
    expect(detectNpxMode).not.toHaveBeenCalled();
  });

  it('keeps direct npx configuration behavior', () => {
    expect(shouldUseNpx(false, () => true)).toBe(true);
  });
});
