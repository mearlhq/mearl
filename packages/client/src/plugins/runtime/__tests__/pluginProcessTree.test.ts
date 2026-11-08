import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProcessGroupAlive } from '@mearl/daemon-core';
import { stopPluginProcessTree } from '../pluginProcessTree.js';

vi.mock('@mearl/daemon-core', () => ({ isProcessGroupAlive: vi.fn() }));

describe.skipIf(process.platform === 'win32')('owned process group termination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(isProcessGroupAlive).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for live descendants after the kernel accepts SIGKILL', async () => {
    vi.mocked(isProcessGroupAlive).mockReturnValueOnce(true).mockReturnValue(false);
    const stopped = vi.fn();
    const pending = stopPluginProcessTree(42).then(stopped);
    await Promise.resolve();
    expect(process.kill).toHaveBeenCalledWith(-42, 'SIGKILL');
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('fails cleanup if execution cannot be confirmed stopped within its deadline', async () => {
    vi.mocked(isProcessGroupAlive).mockReturnValue(true);
    const rejected = expect(stopPluginProcessTree(42)).rejects.toThrow('Unable to confirm');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
  });

  it('accepts an already absent group without probing another process', async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });
    await expect(stopPluginProcessTree(42)).resolves.toBeUndefined();
    expect(isProcessGroupAlive).not.toHaveBeenCalled();
  });

  it('preserves signal permission failures', async () => {
    const error = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    vi.mocked(process.kill).mockImplementation(() => {
      throw error;
    });
    await expect(stopPluginProcessTree(42)).rejects.toBe(error);
    expect(isProcessGroupAlive).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN])('rejects an invalid group before sending a signal: %s', async pid => {
    await expect(stopPluginProcessTree(pid)).rejects.toThrow('Invalid plugin process group');
    expect(process.kill).not.toHaveBeenCalled();
  });
});
