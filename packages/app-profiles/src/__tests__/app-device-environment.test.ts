import { describe, expect, it, vi } from 'vitest';
import { changeAppDeviceEnvironment, type AppDeviceChanges, type AppDeviceEnvironmentHost } from '../environment/app-device.js';

function fixture() {
  type Values = { device: string | null; app: string | null };
  const state: Values = { device: null, app: null }, revision = { device: 0, app: 0 };
  let saved: AppDeviceChanges<Values> = {};
  const read = vi.fn(async () => ({
    device: { revision: revision.device, value: state.device, fingerprint: JSON.stringify(state.device) },
    app: { revision: revision.app, value: state.app, fingerprint: JSON.stringify(state.app) },
  }));
  const save = vi.fn(async (next: AppDeviceChanges<Values>) => { saved = structuredClone(next); });
  const host: AppDeviceEnvironmentHost<Values> = { read, save, matchesRestored: (_key, baseline, current) => baseline === current };
  const effect = vi.fn(async (key: 'device' | 'app', value: string | null) => { state[key] = value; revision[key]++; });
  const change = (keys: Array<'device' | 'app'>, run: () => Promise<unknown>, restore = false) =>
    changeAppDeviceEnvironment('owner', keys, saved, host, run, restore);
  return { state, revision, host, read, save, effect, change, saved: () => saved };
}

describe('coupled App/device changes', () => {
  it('claims both before effects, retains separate baselines and restores one while keeping the other', async () => {
    const f = fixture();
    await f.change(['device', 'app'], async () => {
      expect(f.saved().device?.phase).toBe('pending'); expect(f.saved().app?.phase).toBe('pending');
      await f.effect('device', 'phone'); await f.effect('app', 'reader');
    });
    await f.change(['device'], async () => {
      // A real device handler also updates the App's derived safe area/appearance.
      await f.effect('device', 'tablet'); f.revision.app++;
    });
    expect(f.saved().device?.baseline.value).toBeNull(); expect(f.saved().app?.baseline.value).toBeNull();
    expect(f.saved().app?.applied?.revision).toBe(f.revision.app);
    await f.change(['app'], () => f.effect('app', null), true);
    expect(f.saved().app).toBeUndefined(); expect(f.state.device).toBe('tablet');
    await f.change(['device'], () => f.effect('device', null), true);
    expect(f.saved()).toEqual({});
  });

  it.each(['device', 'app'] as const)('rejects later %s writes before mutating either component', async key => {
    const f = fixture();
    await f.change(['device', 'app'], async () => { await f.effect('device', 'phone'); await f.effect('app', 'reader'); });
    f.revision[key]++;
    const effect = vi.fn();
    await expect(f.change(['app'], effect, true)).rejects.toThrow('STATE_CONFLICT');
    expect(effect).not.toHaveBeenCalled(); expect(f.saved()[key]?.phase).toBe('conflict');
  });

  it('retains every affected pending component after an unknown shared-field transition', async () => {
    const f = fixture(); await f.change(['device'], () => f.effect('device', 'phone'));
    await expect(f.change(['app'], async () => {
      f.revision.device++; throw new Error('receipt lost');
    })).rejects.toThrow('receipt lost');
    expect(f.saved().device?.phase).toBe('pending'); expect(f.saved().app?.phase).toBe('pending');
    const effect = vi.fn(); await expect(f.change(['device'], effect, true)).rejects.toThrow('UNCONFIRMED');
    expect(effect).not.toHaveBeenCalled();
  });

  it('keeps restoration pending unless the removed intent is actually restored', async () => {
    const f = fixture(); await f.change(['app'], () => f.effect('app', 'reader'));
    await expect(f.change(['app'], async () => {}, true)).rejects.toThrow('RESTORE_UNCONFIRMED');
    expect(f.saved().app?.phase).toBe('restoring');
  });

  it('never claims an absent component merely because a group is being released', async () => {
    const f = fixture(); await f.change(['device'], () => f.effect('device', 'phone'));
    await f.change(['device', 'app'], async () => {
      expect(f.saved().app).toBeUndefined(); await f.effect('device', null);
    }, true);
    expect(f.saved()).toEqual({});
    f.save.mockClear(); const effect = vi.fn();
    await f.change(['device', 'app'], effect, true);
    expect(effect).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
});
