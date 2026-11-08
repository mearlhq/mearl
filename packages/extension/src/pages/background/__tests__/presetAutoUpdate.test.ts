import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initializePresetAutoUpdate } from '../presetAutoUpdate';
import { PRESET_AUTO_UPDATE_KEY } from '../../../shared/presetAutoUpdate';
import { PRESET_UPDATE_INTERVAL_MS, PRESET_UPDATE_RETRY_MS } from '@mearl/preset/installation';
let records: Record<string, any>;
let alarm: (input: { name: string }) => void;
let granted: () => void;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); records = {};
  Object.assign(chrome, {
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn(listener => { alarm = listener; }) } },
    permissions: { onAdded: { addListener: vi.fn(listener => { granted = listener; }) } },
    storage: { local: { get: vi.fn(async key => ({ [key]: records[key] })), set: vi.fn(async patch => { Object.assign(records, patch); }) } },
  });
});
afterEach(() => vi.useRealTimers());
describe('persistent preset update scheduling', () => {
  it('checks startup once, coalesces parallel triggers and throttles worker restarts', async () => {
    const update = vi.fn(async () => ({ status: 'current' as const }));
    const check = initializePresetAutoUpdate(update);
    await Promise.all([check(), check()]);
    expect(update).toHaveBeenCalledTimes(1);
    await initializePresetAutoUpdate(update)();
    expect(update).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + PRESET_UPDATE_INTERVAL_MS);
    alarm({ name: 'unrelated' }); await check();
    expect(update).toHaveBeenCalledTimes(2);
    expect(chrome.alarms.create).toHaveBeenCalledWith('mearl-preset-update', { periodInMinutes: 60 });
  });
  it('retains failed results and retries after an hour instead of on each worker wake', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: 'updated' });
    const check = initializePresetAutoUpdate(update); await check();
    expect(records[PRESET_AUTO_UPDATE_KEY]).toMatchObject({ status: 'failed', error: 'offline' });
    await check(); expect(update).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + PRESET_UPDATE_RETRY_MS); await check();
    expect(update).toHaveBeenCalledTimes(2);
    expect(records[PRESET_AUTO_UPDATE_KEY].status).toBe('updated');
  });
  it('rechecks a blocked update after the user grants permissions', async () => {
    const update = vi.fn().mockResolvedValueOnce({ status: 'permission-required' }).mockResolvedValue({ status: 'updated' });
    const check = initializePresetAutoUpdate(update); await check();
    granted(); await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await check(); expect(records[PRESET_AUTO_UPDATE_KEY].status).toBe('updated');
    granted(); await check(); expect(update).toHaveBeenCalledTimes(2);
  });
});
