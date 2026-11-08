import { describe, expect, it, vi } from 'vitest';

import { runSerializedQuickSimulationUpdate, waitForQuickSimulationUpdate } from '../quickSimulationUpdateQueue';

describe('quick simulation update queue', () => {
  it('serializes client and device work for the same tab', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const first = runSerializedQuickSimulationUpdate(7, async () => {
      events.push('client:start');
      await firstGate;
      events.push('client:end');
    });
    const second = runSerializedQuickSimulationUpdate(7, async () => {
      events.push('device:start');
      events.push('device:end');
    });

    const panel = waitForQuickSimulationUpdate(7).then(() => events.push('panel'));
    await vi.waitFor(() => expect(events).toEqual(['client:start']));
    releaseFirst();
    await Promise.all([first, second, panel]);

    expect(events).toEqual(['client:start', 'client:end', 'device:start', 'device:end', 'panel']);
  });

  it('allows different tabs to update independently', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const second = vi.fn();

    const first = runSerializedQuickSimulationUpdate(8, () => firstGate);
    await runSerializedQuickSimulationUpdate(9, async () => second());

    expect(second).toHaveBeenCalledOnce();
    releaseFirst();
    await first;
  });

  it('continues the queue after a failed update', async () => {
    const failure = runSerializedQuickSimulationUpdate(10, async () => {
      throw new Error('failed');
    });
    const next = runSerializedQuickSimulationUpdate(10, async () => 'ready');

    await expect(failure).rejects.toThrow('failed');
    await expect(next).resolves.toBe('ready');
  });
});
