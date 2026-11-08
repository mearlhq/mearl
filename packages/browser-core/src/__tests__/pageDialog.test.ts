import { describe, expect, it, vi } from 'vitest';
import { PageDialogState, pageDialogSnapshot } from '../pageDialog';

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('native page dialog state', () => {
  it.each([
    [undefined, 'Guest'],
    ['', ''],
    ['Alice', 'Alice'],
  ])('accepts a prompt with input %s as %s', async (promptText, expected) => {
    const state = new PageDialogState();
    state.opened({ type: 'prompt', message: 'Name?', defaultPrompt: 'Guest' });
    const send = vi.fn(async () => {});
    await state.press({ dialogId: state.info()!.id, key: 'Enter', ...(promptText !== undefined ? { promptText } : {}) }, send);
    expect(send).toHaveBeenCalledWith({ accept: true, promptText: expected });
  });

  it('requires an explicit replacement for a truncated prompt default', async () => {
    const state = new PageDialogState();
    state.opened({ type: 'prompt', message: 'Name?', defaultPrompt: 'x'.repeat(65537) });
    const send = vi.fn(async () => {});
    const dialogId = state.info()!.id;
    await expect(state.press({ dialogId, key: 'Enter' }, send)).rejects.toThrow('default was truncated');
    expect(send).not.toHaveBeenCalled();
    await state.press({ dialogId, key: 'Enter', promptText: '' }, send);
    expect(send).toHaveBeenCalledWith({ accept: true, promptText: '' });
  });

  it('bounds stored modal strings as well as compact receipts', () => {
    const dialogs = new PageDialogState();
    dialogs.opened({ type: 'prompt', message: 'x'.repeat(100000), defaultPrompt: 'y'.repeat(100000) });
    expect(dialogs.info(100000)?.message).toHaveLength(65536);
    expect(dialogs.info(100000)?.defaultPrompt).toHaveLength(65536);
    expect(dialogs.info(100000)?.truncated).toBe(true);
  });
  it('interrupts an endless eval without leaving the target locked after dismissal', async () => {
    const state = new PageDialogState();
    const fallback = vi.fn();
    const work = state.execute(async () => {
      try { await state.command(() => new Promise(() => {})); }
      catch {
        state.assertCanDispatch();
        fallback();
      }
    });
    const rejected = expect(work).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
    await tick();
    state.opened({ type: 'confirm', message: 'Continue?' });
    await rejected;
    await tick();
    expect(fallback).not.toHaveBeenCalled();
    state.closed();
    await expect(state.execute(async () => 2)).resolves.toBe(2);
    expect(state.busy).toBe(false);
  });

  it('cleans a work registration when opening wins before its handler starts', async () => {
    const state = new PageDialogState();
    const work = state.execute(async () => 1);
    state.opened({ type: 'alert', message: 'Hello' });
    await expect(work).rejects.toMatchObject({ code: 'DIALOG_PENDING' });
    state.closed();
    expect(state.busy).toBe(false);
  });

  it('keeps an explicit handling hold through Closed and does not clear a new dialog on ack', async () => {
    const state = new PageDialogState();
    const idle = vi.fn(); state.onIdle = idle;
    state.opened({ type: 'prompt', message: 'Name?', defaultPrompt: 'Old' });
    const id = state.info()!.id;
    let acknowledge!: () => void;
    const press = state.press({ key: 'Enter', dialogId: id, promptText: 'New' }, async params => {
      expect(params).toEqual({ accept: true, promptText: 'New' });
      state.closed();
      expect(idle).not.toHaveBeenCalled();
      await new Promise<void>(resolve => { acknowledge = resolve; });
    });
    await expect(state.press({ key: 'Enter', dialogId: id }, async () => {})).rejects.toThrow();
    state.opened({ type: 'confirm', message: 'Another?' });
    acknowledge(); await press;
    expect(state.info()!.message).toBe('Another?');
    expect(state.info()!.id).not.toBe(id);
    await expect(state.press({ key: 'Escape', dialogId: id }, async () => {})).rejects.toThrow('stale');
  });

  it('bounds receipts and exposes larger message only when a snapshot asks for it', () => {
    const state = new PageDialogState();
    expect(pageDialogSnapshot(state)).toBeUndefined();
    state.opened({ type: 'confirm', message: 'x'.repeat(500) });
    expect(state.info()!.message).toHaveLength(240);
    expect(state.info()!.truncated).toBe(true);
    expect(pageDialogSnapshot(state, 'viewport', 600)?.dialog.message).toHaveLength(500);
  });

  it('rejects stale IDs after reset and ordinary key combinations for native handling', async () => {
    const state = new PageDialogState();
    state.opened({ type: 'alert', message: 'A' }); const id = state.info()!.id;
    state.invalidate(); state.opened({ type: 'alert', message: 'B' });
    const send = vi.fn();
    await expect(state.press({ key: 'Enter', dialogId: id }, send)).rejects.toThrow('stale');
    await expect(state.press({ key: 'Space', dialogId: state.info()!.id }, send)).rejects.toThrow('Enter/Escape');
    expect(send).not.toHaveBeenCalled();
  });
});
