import { afterEach, describe, expect, it, vi } from 'vitest';

const { main } = vi.hoisted(() => ({
  main: vi.fn<() => Promise<number>>(),
}));

vi.mock('../cli.js', () => ({ main }));

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.clearAllMocks();
  vi.resetModules();
});

describe('cloud-server bin', () => {
  it('runs the CLI without depending on the npm bin link path', async () => {
    process.argv[1] = '/tmp/npm/bin/mearl-cloud-server';
    main.mockResolvedValue(0);

    await import('../bin.js');

    expect(main).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });
});
