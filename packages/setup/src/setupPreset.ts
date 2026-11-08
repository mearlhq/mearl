import { PresetInstaller, type StagedPresetInstallation } from './preset.js';

/** Preserve the accepted installation and resume its exact resources before Skill operations. */
export async function prepareSetupPreset(
  options: { source?: string; fallbackSource?: string; env?: NodeJS.ProcessEnv },
  dependencies: { installer?: PresetInstaller } = {},
): Promise<StagedPresetInstallation | undefined> {
  const installer = dependencies.installer ?? new PresetInstaller({ directory: (options.env ?? process.env).MEARL_CAPABILITY_DIR, connectedExtensionsOnly: true });
  if (options.source) return installer.stage(options.source);
  const current = await installer.store.current();
  if (current.receipt) return { revision: current.receipt.revision, activate: () => installer.resume(current.receipt!.revision) };
  if (current.activation) return;
  if (options.fallbackSource) return installer.stage(options.fallbackSource);
}
