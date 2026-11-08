import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparePausedDebuggerTarget } from '../debuggerTarget.js';

afterEach(() => vi.useRealTimers());

describe('paused renderer preparation', () => {
  it('registers the environment before resuming the renderer', async () => {
    const calls: string[] = [];
    expect(
      await preparePausedDebuggerTarget(
        async () => {
          calls.push('prepare');
          return 'source';
        },
        async () => {
          calls.push('resume');
        },
      ),
    ).toBe('source');
    expect(calls).toEqual(['prepare', 'resume']);
  });

  it('resumes when a command is hung and aborts late preparation', async () => {
    vi.useFakeTimers();
    const resume = vi.fn().mockResolvedValue(undefined);
    let signal!: AbortSignal;
    let release!: () => void;
    const inject = vi.fn();
    const result = preparePausedDebuggerTarget(async current => {
      signal = current;
      await new Promise<void>(resolve => {
        release = resolve;
      });
      current.throwIfAborted();
      inject();
    }, resume);
    const rejected = expect(result).rejects.toThrow('preparation timed out');
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    expect(inject).not.toHaveBeenCalled();
  });

  it('resumes on failure and preserves the preparation error if resuming also fails', async () => {
    const resume = vi.fn().mockRejectedValue(new Error('target closed'));
    await expect(
      preparePausedDebuggerTarget(async () => {
        throw new Error('bootstrap failed');
      }, resume),
    ).rejects.toThrow('bootstrap failed');
    expect(resume).toHaveBeenCalledOnce();
  });

  it('does not return document source when resuming fails', async () => {
    await expect(
      preparePausedDebuggerTarget(
        async () => 'source',
        async () => {
          throw new Error('resume failed');
        },
      ),
    ).rejects.toThrow('resume failed');
  });

  it('bounds a hung resume command', async () => {
    vi.useFakeTimers();
    const result = preparePausedDebuggerTarget(
      async () => 'source',
      () => new Promise(() => {}),
    );
    const rejected = expect(result).rejects.toThrow('resume timed out');
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
