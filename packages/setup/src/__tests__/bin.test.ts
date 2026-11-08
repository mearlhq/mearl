import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  main: vi.fn().mockResolvedValue(0),
}));

vi.mock('../cli.js', () => ({ main: mocks.main }));

afterEach(() => {
  process.exitCode = undefined;
  vi.resetModules();
  mocks.main.mockClear();
});

describe('setup bin', () => {
  it('runs the CLI main function when loaded as the package entry', async () => {
    await import('../bin.js');

    expect(mocks.main).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });
});
