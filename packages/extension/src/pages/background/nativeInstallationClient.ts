import type { InstallationDependencies } from './installationService';

interface Bridge {
  getStatus(): { connected: boolean };
  hasNativeConnection(): boolean;
  supportsPresetInstallation(timeoutMs: number): Promise<boolean>;
  requestNativeHost(action: string, data: Record<string, unknown>, timeoutMs: number): Promise<any>;
}

/** A missing or slow local service does not delay independent browser installation. */
export function createNativeInstallationClient(
  bridge: () => Bridge,
): NonNullable<InstallationDependencies['native']> {
  return {
    capture: async (requireKnownSelection = false) => {
      const target = bridge();
      const wasConnected = requireKnownSelection && target.getStatus().connected;
      const deadline = Date.now() + 1500;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let captured: Awaited<ReturnType<NonNullable<InstallationDependencies['native']>['capture']>>;
      try {
        captured = await Promise.race([
          (async () => {
            if (!(await target.supportsPresetInstallation(1500))) return undefined;
            return target.requestNativeHost(
              'preset_installation',
              { operation: 'inspect' },
              Math.max(1, deadline - Date.now()),
            );
          })(),
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), 1500);
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !/Native host (?:request timeout|has exited|disconnected|is not connected|handshake timed out|disconnected before dispatch)/.test(
            message,
          )
        )
          throw error;
      } finally {
        clearTimeout(timer);
      }
      if (requireKnownSelection && !captured && (wasConnected || target.hasNativeConnection()))
        throw new Error('INSTALLATION_NATIVE_SELECTION_UNAVAILABLE');
      return captured;
    },
    request: (data, timeoutMs) =>
      bridge().requestNativeHost('preset_installation', data, timeoutMs),
  };
}
