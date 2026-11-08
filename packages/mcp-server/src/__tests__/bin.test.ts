import { afterEach, describe, expect, it, vi } from 'vitest';

const { configureMain, uninstallMain } = vi.hoisted(() => ({
  configureMain: vi.fn<() => Promise<number>>(),
  uninstallMain: vi.fn<() => Promise<number>>(),
}));

vi.mock('../configure.js', () => ({ main: configureMain }));
vi.mock('../uninstall.js', () => ({ main: uninstallMain }));

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.clearAllMocks();
  vi.resetModules();
});

describe('MCP command bins', () => {
  it('runs configure without depending on the npm bin link path', async () => {
    process.argv[1] = '/tmp/npm/bin/mearl-mcp-configure';
    configureMain.mockResolvedValue(0);

    await import('../configure-bin.js');

    expect(configureMain).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it('runs uninstall without depending on the npm bin link path', async () => {
    process.argv[1] = '/tmp/npm/bin/mearl-mcp-uninstall';
    uninstallMain.mockResolvedValue(0);

    await import('../uninstall-bin.js');

    expect(uninstallMain).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });
});
