import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNativeInstallationClient } from '../nativeInstallationClient';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('bounds discovery plus inspect by one short deadline and ignores late read-only responses', async () => {
  const requestNativeHost = vi.fn(() => new Promise(() => {}));
  const supportsPresetInstallation = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return true;
  });
  const client = createNativeInstallationClient(
    () => ({ requestNativeHost, supportsPresetInstallation }) as any,
  );
  const capture = client.capture();
  await vi.advanceTimersByTimeAsync(1000);
  expect(requestNativeHost).toHaveBeenCalledWith(
    'preset_installation',
    { operation: 'inspect' },
    500,
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(await capture).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
it('falls back only for absent connections and keeps known local selection corruption actionable', async () => {
  const requestNativeHost = vi.fn().mockRejectedValue(new Error('Invalid preset receipt'));
  const supportsPresetInstallation = vi.fn(async () => true);
  const client = createNativeInstallationClient(() => ({
    requestNativeHost,
    supportsPresetInstallation,
    getStatus: () => ({ connected: false }),
    hasNativeConnection: () => false,
  }));
  await expect(client.capture()).rejects.toThrow('Invalid preset receipt');
  requestNativeHost.mockRejectedValue(new Error('Native host disconnected'));
  expect(await client.capture()).toBeUndefined();
  requestNativeHost.mockRejectedValue(new Error('Native host has exited.'));
  expect(await client.capture()).toBeUndefined();
  supportsPresetInstallation.mockResolvedValue(false);
  requestNativeHost.mockClear();
  expect(await client.capture()).toBeUndefined();
  expect(requestNativeHost).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('requires a known selection for automatic installation when a native connection exists', async () => {
  const requestNativeHost = vi.fn(async () => ({ protocol: 1, selection: null }));
  const supportsPresetInstallation = vi.fn(async () => true);
  let pendingConnection = true;
  const client = createNativeInstallationClient(() => ({
    requestNativeHost,
    supportsPresetInstallation,
    getStatus: () => ({ connected: false }),
    hasNativeConnection: () => pendingConnection,
  }));
  await expect(client.capture(true)).resolves.toEqual({ protocol: 1, selection: null });
  supportsPresetInstallation.mockResolvedValue(false);
  await expect(client.capture(true)).rejects.toThrow('INSTALLATION_NATIVE_SELECTION_UNAVAILABLE');
  await expect(client.capture()).resolves.toBeUndefined();
  pendingConnection = false;
  await expect(client.capture(true)).resolves.toBeUndefined();
});
