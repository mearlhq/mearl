import { describe, expect, it, vi } from 'vitest';
import {
  applyEnvironmentChange, restoreEnvironmentChange,
  type EnvironmentChange, type EnvironmentChangeHost,
} from '../environment/changes.js';

function fixture() {
  let value = { preset: 'desktop' }, revision = 1, external = '';
  let stored: EnvironmentChange<typeof value> | undefined;
  const read = vi.fn(async () => ({ revision, fingerprint: JSON.stringify(value) + external, value: { ...value } }));
  const save = vi.fn(async (change: EnvironmentChange<typeof value>) => { stored = structuredClone(change); });
  const write = vi.fn(async (next: string) => { value = { preset: next }; revision++; });
  const host: EnvironmentChangeHost<typeof value> = {
    read, save,
    restore: async baseline => write(baseline.preset),
    matchesRestored: (baseline, current) => baseline.fingerprint === current.fingerprint,
  };
  return {
    host, write, read, save,
    stored: () => stored!,
    drift: (coordinated: boolean) => { if (coordinated) revision++; else external = ':external'; },
  };
}

describe('owned environment changes', () => {
  it('retains the original baseline across updates and restores only its component', async () => {
    const f = fixture();
    await applyEnvironmentChange('binding', 'device', undefined, f.host, () => f.write('phone'));
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.write.mock.invocationCallOrder[0]!);
    await applyEnvironmentChange('binding', 'device', f.stored(), f.host, () => f.write('tablet'));
    expect(f.stored().baseline.value).toEqual({ preset: 'desktop' });
    expect(f.stored().component).toBe('device');
    expect(await restoreEnvironmentChange('binding', f.stored(), f.host)).toEqual({ restored: true });
    expect((await f.read()).value).toEqual({ preset: 'desktop' });
  });

  it.each([true, false])('preserves later coordinated/external changes (%s)', async coordinated => {
    const f = fixture();
    await applyEnvironmentChange('binding', 'device', undefined, f.host, () => f.write('phone'));
    f.drift(coordinated);
    expect(await restoreEnvironmentChange('binding', f.stored(), f.host)).toEqual({ restored: false, reason: 'changed' });
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.stored().phase).toBe('conflict');
  });

  it('does not write again after another actor changed the component', async () => {
    const f = fixture();
    await applyEnvironmentChange('binding', 'device', undefined, f.host, () => f.write('phone'));
    f.drift(true);
    await expect(applyEnvironmentChange('binding', 'device', f.stored(), f.host, () => f.write('tablet'))).rejects.toThrow('ENVIRONMENT_STATE_CONFLICT');
    expect(f.write).toHaveBeenCalledOnce();
  });

  it('retains a pending baseline after an effect fails and refuses blind replay or cleanup', async () => {
    const f = fixture();
    await expect(applyEnvironmentChange('binding', 'app', undefined, f.host, async () => {
      await f.write('partial');
      throw new Error('receipt lost');
    })).rejects.toThrow('receipt lost');
    expect(f.stored().phase).toBe('pending');
    expect(f.stored().baseline.value).toEqual({ preset: 'desktop' });
    await expect(applyEnvironmentChange('binding', 'app', f.stored(), f.host, () => f.write('retry'))).rejects.toThrow('ENVIRONMENT_UNCONFIRMED');
    expect(await restoreEnvironmentChange('binding', f.stored(), f.host)).toEqual({ restored: false, reason: 'unconfirmed' });
    expect(f.write).toHaveBeenCalledOnce();
  });

  it('does not start an effect when the recovery record cannot be saved', async () => {
    const f = fixture();
    f.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(applyEnvironmentChange('binding', 'device', undefined, f.host, () => f.write('phone'))).rejects.toThrow('storage unavailable');
    expect(f.write).not.toHaveBeenCalled();
  });

  it('keeps restoring state when restoration fails or cannot be confirmed', async () => {
    const f = fixture();
    await applyEnvironmentChange('binding', 'timezone', undefined, f.host, () => f.write('Paris'));
    f.host.restore = async () => { throw new Error('detached'); };
    await expect(restoreEnvironmentChange('binding', f.stored(), f.host)).rejects.toThrow('detached');
    expect(f.stored().phase).toBe('restoring');
    expect(f.stored().baseline.value).toEqual({ preset: 'desktop' });
  });

  it('rejects a different owner before reading or changing the environment', async () => {
    const f = fixture();
    await applyEnvironmentChange('binding', 'device', undefined, f.host, () => f.write('phone'));
    const reads = f.read.mock.calls.length;
    await expect(restoreEnvironmentChange('other', f.stored(), f.host)).rejects.toThrow('ENVIRONMENT_OWNER_CONFLICT');
    expect(f.read).toHaveBeenCalledTimes(reads);
    expect(f.write).toHaveBeenCalledOnce();
  });
});
