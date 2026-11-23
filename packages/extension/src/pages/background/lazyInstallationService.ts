import type { createInstallationService as CreateInstallationService } from './installationService';

type InstallationService = ReturnType<typeof CreateInstallationService>;

/** Keeps installation behavior available without evaluating its orchestration on every worker wake. */
export function createLazyInstallationService(
  bridge: () => {
    supportsPresetInstallation(timeoutMs: number): Promise<boolean>;
    requestNativeHost(
      action: string,
      data: Record<string, unknown>,
      timeoutMs: number,
    ): Promise<any>;
  },
): InstallationService {
  let service: Promise<InstallationService> | undefined;
  const load = () => {
    if (!service) {
      service = Promise.all([import('./installationService'), import('./nativeInstallationClient')])
        .then(([installation, native]) =>
          installation.createInstallationService({
            native: native.createNativeInstallationClient(bridge),
          }),
        )
        .catch(error => {
          service = undefined;
          throw error;
        });
    }
    return service;
  };

  return {
    installedPresets: (...args) => load().then(value => value.installedPresets(...args)),
    canInstallPresets: (...args) => load().then(value => value.canInstallPresets(...args)),
    openPresetSelector: (...args) => load().then(value => value.openPresetSelector(...args)),
    installDefaultForGuide: (...args) =>
      load().then(value => value.installDefaultForGuide(...args)),
    autoUpdate: (...args) => load().then(value => value.autoUpdate(...args)),
    native: (...args) => load().then(value => value.native(...args)),
    website: (...args) => load().then(value => value.website(...args)),
    external: (...args) => load().then(value => value.external(...args)),
    internal: (...args) => load().then(value => value.internal(...args)),
  };
}
