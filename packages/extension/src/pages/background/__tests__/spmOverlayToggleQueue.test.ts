import { expect, it, vi } from 'vitest';
import { enqueueSpmOverlayToggle } from '../spmOverlayToggleQueue';

it('delivers close and reopen operations in order for the same tab', async () => {
  let finishClose!: () => void;
  const closeGate = new Promise<void>(resolve => {
    finishClose = resolve;
  });
  const calls: string[] = [];

  const close = enqueueSpmOverlayToggle(11, async () => {
    calls.push('close:start');
    await closeGate;
    calls.push('close:end');
    return false;
  });
  const reopenTask = vi.fn(async () => {
    calls.push('open');
    return true;
  });
  const reopen = enqueueSpmOverlayToggle(11, reopenTask);

  await Promise.resolve();
  expect(reopenTask).not.toHaveBeenCalled();
  finishClose();

  await expect(close).resolves.toBe(false);
  await expect(reopen).resolves.toBe(true);
  expect(calls).toEqual(['close:start', 'close:end', 'open']);
});

it('does not serialize independent tabs behind each other', async () => {
  let finishFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {
    finishFirst = resolve;
  });
  const second = vi.fn(async () => true);

  const firstPromise = enqueueSpmOverlayToggle(21, async () => {
    await firstGate;
  });
  const secondPromise = enqueueSpmOverlayToggle(22, second);

  await expect(secondPromise).resolves.toBe(true);
  expect(second).toHaveBeenCalledOnce();
  finishFirst();
  await firstPromise;
});
