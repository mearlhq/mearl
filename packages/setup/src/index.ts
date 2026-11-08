export {
  buildGlobalPackageCommand,
  detectGlobalPackage,
  resolveInvokingPackageManager,
  resolvePackageManagerInstallation,
} from './packageManager.js';
export {
  BrowserExtensionConflictError,
  extensionArchiveUrl,
  fetchBrowserExtensionRelease,
  findLatestExtensionVersion,
  installMearlBrowserExtension,
  inspectMearlExtensionViaCdp,
  loadUnpackedViaCdp,
  MEARL_EXTENSION_DIRECTORY_NAME,
  MEARL_EXTENSION_DOWNLOAD_PAGE,
  MEARL_EXTENSION_ID,
  MEARL_EXTENSION_REMOTE_CONFIG_URL,
  resolveChromeUserDataDirectory,
  resolveMearlExtensionDirectory,
  updateSetupManagedBrowserExtensionFiles,
} from './browserExtension.js';
export type {
  BrowserExtensionDependencies,
  BrowserExtensionInstallOptions,
  BrowserExtensionInstallResult,
  BrowserExtensionRelease,
  InstalledBrowserExtension,
  SetupManagedBrowserExtensionUpdateOptions,
  SetupManagedBrowserExtensionUpdateResult,
} from './browserExtension.js';
export type {
  DetectedGlobalPackage,
  GlobalPackageCommand,
  GlobalPackageManager,
  PackageManagerInstallation,
  PackageOperation,
  PackageDetectionOptions,
} from './packageManager.js';
export { runMearlLifecycle } from './lifecycle.js';
export type {
  MearlLifecycleDependencies,
  MearlLifecycleOperation,
  MearlLifecycleOptions,
} from './lifecycle.js';
export { MEARL_PROFILES, detectMearlProfiles } from './profiles.js';
export type { DetectedMearlProfiles, MearlProfile, MearlProfileConfig } from './profiles.js';
export {
  MEARL_NATIVE_HOST_NAMES,
  resolveNativeHostDirectory,
  uninstallNativeHostArtifacts,
} from './nativeHost.js';
export { PresetInstaller, PresetInstallationStore, createNodePresetLoader, runPresetCommand } from './preset.js';
export type { PresetInstallReceipt, PresetInstallStatus, PresetInstallerOptions, PresetApplyOptions, StagedPresetInstallation, PresetHostTarget, PresetHostStatus, PresetBrowserHostStatus, PresetComponentHostStatus, PresetComponentStatus } from './preset.js';
export {
  compareMearlReleaseLines,
  compareMearlReleaseVersions,
  isMearlReleaseLine,
  isMearlReleaseVersion,
  isMearlReleaseVersionInLine,
  mearlReleaseLineForVersion,
  parseMearlReleaseLine,
  parseMearlReleaseVersion,
} from './version.js';
export type { MearlReleaseLine, MearlReleaseVersion } from './version.js';
export {
  installProviderPackage,
  inspectProviderPackage,
  parseProviderPackageSpec,
  uninstallProviderPackage,
  updateProviderPackage,
} from './provider.js';
export type { ProviderSetupDependencies, ProviderSetupResult } from './provider.js';
export type {
  NativeHostCleanupDependencies,
  NativeHostCleanupOptions,
  NativeHostIntegrationMode,
} from './nativeHost.js';
