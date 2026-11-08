import { SETUP_VERSION } from './setupVersion.js';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { listPluginNames } from '@mearl/client/plugin';
import { listInstalledProviders } from '@mearl/provider/host';
import { runGlobalMearlSkillOperation } from './skills.js';
import {
  buildGlobalPackageCommand,
  detectGlobalPackage,
  resolveInvokingPackageManager,
  resolvePackageManagerInstallation,
  type DetectedGlobalPackage,
  type GlobalPackageCommand,
  type PackageManagerInstallation,
  type PackageOperation,
  type PackageDetectionOptions,
} from './packageManager.js';
import {
  MEARL_PROFILES,
  detectMearlProfiles,
  type DetectedMearlProfiles,
  type MearlProfile,
} from './profiles.js';
import { uninstallNativeHostArtifacts } from './nativeHost.js';
import {
  executableNames,
  prependCommandPath,
  runCommand,
  withOwnedCommands,
  type CommandResult,
  type CommandRunner,
} from '@mearl/daemon-core';
import { readInstallationManagement, setupManagementCommand, setupRuntimeCompatible } from '@mearl/daemon-core/installation';
import { claimPresetInstallation } from './presetInstallationLease.js';
import { isMearlReleaseLine, mearlPackageSelector } from './version.js';
import {
  installManagedPlugins,
  uninstallManagedPlugins,
} from './managedPlugins.js';
import { uninstallPlugin } from './plugin.js';
import { uninstallProviderPackage } from './provider.js';
import { packageRegistryEnvironment } from './npmRegistry.js';
import { cleanupUninstalledRuntime } from './runtimeCleanup.js';
import { prepareSetupPreset } from './setupPreset.js';
import { prepareBrowserSetupPreset } from './browserPreset.js';
import type { PresetInstallStatus, StagedPresetInstallation } from './preset.js';

export type MearlLifecycleOperation = 'install' | 'update' | 'uninstall';
const LEGACY_CLOUD_CLIENT = '@mearl/cloud-client';
const UNIFIED_CLIENT = '@mearl/client';
const PROFILE_ORDER: MearlProfile[] = ['local', 'cloud', 'mcp'];
const CLIENT_PROFILES: MearlProfile[] = ['local', 'cloud'];

function autoUpdateClientInstallation(env: NodeJS.ProcessEnv): PackageManagerInstallation | null {
  const root = env.MEARL_AUTO_UPDATE_CLIENT_ROOT;
  if (!root) return null;
  try {
    const packageRoot = fs.realpathSync(root);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as {
      name?: unknown;
    };
    if (manifest.name !== UNIFIED_CLIENT) return null;
    return resolvePackageManagerInstallation(packageRoot, UNIFIED_CLIENT, { env });
  } catch {
    return null;
  }
}

function autoUpdateProfiles(env: NodeJS.ProcessEnv): MearlProfile[] | undefined {
  const value = env.MEARL_AUTO_UPDATE_PROFILES;
  if (value === undefined) return undefined;
  const requested = value.split(',');
  if (
    requested.length === 0 ||
    new Set(requested).size !== requested.length ||
    requested.some(profile => !PROFILE_ORDER.includes(profile as MearlProfile))
  ) {
    throw new Error('Invalid automatic update profiles');
  }
  return PROFILE_ORDER.filter(profile => requested.includes(profile));
}

export interface MearlLifecycleOptions {
  presetSource?: string;
  /** Distribution default used only when neither local nor browser selection exists. */
  defaultPresetSource?: string;
  operation: MearlLifecycleOperation;
  cloudMode?: string;
  /** Uninstall every registered CLI plugin and Provider in addition to selected environments. */
  full?: boolean;
  /** @deprecated Use profiles when selecting one or more composable environments. */
  profile?: MearlProfile;
  profiles?: MearlProfile[];
  yes?: boolean;
  targetLine?: string;
  skipSkill?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface MearlLifecycleDependencies {
  readManagement?: typeof readInstallationManagement;
  claimLifecycle?: () => ReturnType<typeof claimPresetInstallation>;
  prepareBrowserPreset?: typeof prepareBrowserSetupPreset;
  preparePreset?: typeof prepareSetupPreset;
  onPresetStatus?: (status: PresetInstallStatus) => void;
  /** Prepare the selected manager after packages are usable and before Skill operations. */
  prepareSkills?: () => Promise<void>;
  cleanupRuntime?: typeof cleanupUninstalledRuntime;
  cleanupNativeHost?: typeof uninstallNativeHostArtifacts;
  confirm?: (message: string) => Promise<boolean>;
  detectPackage?: typeof detectGlobalPackage;
  detectProfiles?: (
    env: NodeJS.ProcessEnv,
    options?: Pick<PackageDetectionOptions, 'includeLinked'>,
  ) => DetectedMearlProfiles;
  existsSync?: (filePath: string) => boolean;
  installManagedPlugins?: typeof installManagedPlugins;
  listPlugins?: typeof listPluginNames;
  listProviders?: typeof listInstalledProviders;
  resolveInvokingManager?: (env: NodeJS.ProcessEnv) => PackageManagerInstallation;
  runCommand?: CommandRunner;
  runSkillOperation?: typeof runGlobalMearlSkillOperation;
  uninstallManagedPlugins?: typeof uninstallManagedPlugins;
  uninstallPlugin?: typeof uninstallPlugin;
  uninstallProvider?: typeof uninstallProviderPackage;
  writeLine?: (line: string) => void;
}

async function confirmInTerminal(message: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return false;
  const readline = createInterface({ input, output });
  try {
    const answer = (await readline.question(`${message} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    readline.close();
  }
}

function siblingExecutable(
  anchor: string,
  name: string,
  existsSync: (filePath: string) => boolean,
): string | null {
  for (const executableName of executableNames(name)) {
    const candidate = path.join(path.dirname(anchor), executableName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function runLifecycleCommand(
  runner: CommandRunner,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
  writeLine: (line: string) => void,
  capture = false,
): Promise<CommandResult | null> {
  try {
    return await runner(command, args, {
      capture,
      env: prependCommandPath(command, env),
    });
  } catch (error) {
    writeLine(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function runPackageOperation(
  installation: PackageManagerInstallation,
  operation: PackageOperation,
  packages: string[],
  targetLine: string | undefined,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  label: string,
  writeLine: (line: string) => void,
): Promise<{ command: GlobalPackageCommand; ok: boolean }> {
  const command = buildGlobalPackageCommand(installation, operation, packages, targetLine);
  writeLine(`${label}: ${command.manager}`);
  const result = await runLifecycleCommand(
    runner,
    command.command,
    command.args,
    operation === 'uninstall'
      ? env
      : packages.reduce((childEnv, name) => packageRegistryEnvironment(name, childEnv), env),
    label,
    writeLine,
  );
  if (!result) return { command, ok: false };
  if (result.code !== 0) {
    writeLine(`${label}: failed (exit ${result.code}).`);
    return { command, ok: false };
  }
  return { command, ok: true };
}

async function runHook(
  profile: MearlProfile,
  operation: MearlLifecycleOperation,
  detected: DetectedGlobalPackage,
  runner: CommandRunner,
  existsSync: (filePath: string) => boolean,
  env: NodeJS.ProcessEnv,
  writeLine: (line: string) => void,
  yes: boolean,
  cloudMode?: MearlLifecycleOptions['cloudMode'],
): Promise<boolean> {
  let executable: string | null;
  let args: string[];
  let hookEnv = env;

  if (profile === 'local' && operation !== 'uninstall') {
    executable = detected.executable;
    args = ['--init', '--mode', 'skills'];
  } else if (profile === 'mcp' && operation === 'uninstall') {
    executable = siblingExecutable(detected.executable, 'mearl-mcp-uninstall', existsSync);
    args = ['--managed-by-setup', ...(yes ? ['--yes'] : [])];
  } else if (profile === 'mcp' && operation === 'install') {
    executable = siblingExecutable(detected.executable, 'mearl-mcp-configure', existsSync);
    args = ['--global-install', ...(yes ? ['--yes'] : [])];
  } else if (profile === 'mcp' && operation === 'update') {
    executable = siblingExecutable(detected.executable, 'mearl-mcp-configure', existsSync);
    args = ['--skip-mcp', '--global-install'];
  } else if (profile === 'cloud') {
    executable = siblingExecutable(detected.executable, 'mearl-cloud-server', existsSync);
    if (!executable) {
      writeLine(`Hook: ${profile} ${operation} command was not found.`);
      return false;
    }

    const requestedMode = operation === 'uninstall' ? 'websocket' : cloudMode;
    const commandEnv = requestedMode ? { ...env, MEARL_CLOUD_MODE: requestedMode } : env;
    hookEnv = commandEnv;
    if (operation === 'uninstall') {
      args = ['stop'];
    } else {
      const status = await runLifecycleCommand(
        runner,
        executable,
        ['status'],
        commandEnv,
        'Hook: cloud status',
        writeLine,
        true,
      );
      if (!status) return false;
      if (status.code !== 0) {
        writeLine(`Hook: cloud status failed (exit ${status.code}).`);
        return false;
      }

      const running = /\[CloudServer\]\s+Status:\s+running\b/.test(status.stdout);
      const pluginMode =
        Boolean(cloudMode && cloudMode !== 'websocket') || /\[CloudServer\]\s+Mode:\s+(?!websocket\b)\S+/.test(status.stdout);
      if (operation === 'update' && !running && !pluginMode) {
        writeLine('Hook: cloud update skipped because cloud-server is not running.');
        return true;
      }
      args = [running && !pluginMode ? 'restart' : 'start'];
    }
  } else {
    return true;
  }

  if (!executable) {
    writeLine(`Hook: ${profile} ${operation} command was not found.`);
    return false;
  }
  const result = await runLifecycleCommand(
    runner,
    executable,
    args,
    hookEnv,
    `Hook: ${profile} ${operation}`,
    writeLine,
  );
  if (!result) return false;
  if (result.code !== 0) {
    writeLine(`Hook: ${profile} ${operation} failed (exit ${result.code}).`);
    return false;
  }
  return true;
}

function selectedProfiles(
  operation: MearlLifecycleOperation,
  requested: MearlProfile[] | undefined,
  detected: DetectedMearlProfiles,
): MearlProfile[] {
  if (requested?.length) {
    const requestedSet = new Set(requested);
    return PROFILE_ORDER.filter(profile => requestedSet.has(profile));
  }
  if (operation === 'install') return ['local'];
  return PROFILE_ORDER.filter(profile => detected.has(profile));
}

function operationVerb(operation: MearlLifecycleOperation): string {
  return operation === 'uninstall' ? 'uninstall' : operation === 'update' ? 'update' : 'install';
}

export async function runMearlLifecycle(
  options: MearlLifecycleOptions,
  dependencies: MearlLifecycleDependencies = {},
): Promise<boolean> {
  if (options.targetLine && !isMearlReleaseLine(options.targetLine)) {
    throw new Error('targetLine must be a valid Mearl release line such as 2.3.x');
  }
  const writeLine = dependencies.writeLine ?? (line => console.error(line));
  let lease: ReturnType<typeof claimPresetInstallation> | undefined;
  try {
    lease = (dependencies.claimLifecycle ?? (() => claimPresetInstallation(path.join(homedir(), '.agents', '.mearl-setup-lifecycle.json'))))();
    const readManagement = () => (dependencies.readManagement ?? readInstallationManagement)({ directory: (options.env ?? process.env).MEARL_CAPABILITY_DIR });
    let acceptedRevision = (await readManagement()).revision;
    let selector = mearlPackageSelector(SETUP_VERSION, options.targetLine);
    const assertManagement = async (expected = acceptedRevision) => {
      const { setup, revision } = await readManagement();
      if (revision !== expected) throw new Error('PRESET_SELECTION_CHANGED: The selected preset changed during setup.');
      if (setup && options.operation !== 'uninstall' && !setupRuntimeCompatible(setup, SETUP_VERSION, options.targetLine)) {
        throw new Error(`SETUP_RUNTIME_CONFLICT: The selected preset requires ${setup.runtime}. Use ${setupManagementCommand(setup)} ${options.operation}.`);
      }
      selector = setup?.runtime ? options.targetLine ?? SETUP_VERSION : mearlPackageSelector(SETUP_VERSION, options.targetLine);
    };
    await assertManagement();
    const runner = dependencies.runCommand ?? runCommand;
    return await withOwnedCommands(lease.lifecycle, () => executeLifecycle(options, {
      ...dependencies,
      runCommand: async (...args) => { await assertManagement(); return runner(...args); },
    }, async revision => { await assertManagement(revision); acceptedRevision = revision; }, () => selector));
  } catch (error) {
    writeLine(`Setup: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally { lease?.release(); }
}

async function executeLifecycle(
  options: MearlLifecycleOptions,
  dependencies: MearlLifecycleDependencies,
  acceptPreset: (revision: string) => Promise<void>,
  packageSelector: () => string,
): Promise<boolean> {
  const env = options.env ?? process.env;
  const writeLine = dependencies.writeLine ?? (line => console.error(line));
  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const runner = dependencies.runCommand ?? runCommand;
  const cleanupNativeHost = dependencies.cleanupNativeHost ?? uninstallNativeHostArtifacts;
  const detectPackage = dependencies.detectPackage ?? detectGlobalPackage;
  const detectProfiles =
    dependencies.detectProfiles ??
    ((childEnv, detectionOptions) => detectMearlProfiles({ env: childEnv, ...detectionOptions }));
  const resolveInvokingManager =
    dependencies.resolveInvokingManager ??
    (childEnv => resolveInvokingPackageManager({ env: childEnv }));
  const runSkill = dependencies.runSkillOperation ?? runGlobalMearlSkillOperation;
  const confirm = dependencies.confirm ?? confirmInTerminal;
  const detectionEnv =
    options.operation === 'update' && env.MEARL_AUTO_UPDATE_SEARCH_PATH !== undefined
      ? { ...env, PATH: env.MEARL_AUTO_UPDATE_SEARCH_PATH }
      : env;
  const detected =
    options.operation === 'uninstall'
      ? detectProfiles(detectionEnv, { includeLinked: true })
      : detectProfiles(detectionEnv);
  const packageDetectionOptions: PackageDetectionOptions = {
    env,
    ...(options.operation === 'uninstall' ? { includeLinked: true } : {}),
  };
  const requestedProfiles =
    options.profiles ??
    (options.profile ? [options.profile] : undefined) ??
    (options.operation === 'update' ? autoUpdateProfiles(env) : undefined);
  const autoUpdateClient =
    options.operation === 'update' ? autoUpdateClientInstallation(env) : null;
  const clientOnly = options.operation === 'update' && env.MEARL_AUTO_UPDATE_CLIENT_ONLY === '1';
  if (clientOnly && !autoUpdateClient) {
    writeLine('A valid global client installation is required for a client-only update.');
    return false;
  }
  const selected = clientOnly
    ? []
    : selectedProfiles(options.operation, requestedProfiles, detected);
  const lifecycleSelected =
    options.operation === 'uninstall'
      ? selected.filter(profile => detected.has(profile))
      : selected;
  let fullPluginNames: string[] = [];
  let fullProviders: ReturnType<typeof listInstalledProviders> = [];

  if (options.operation === 'uninstall' && options.full) {
    try {
      fullPluginNames = (dependencies.listPlugins ?? listPluginNames)();
    } catch (error) {
      writeLine(
        `CLI plugins: unable to list registrations: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    try {
      fullProviders = (dependencies.listProviders ?? listInstalledProviders)();
    } catch (error) {
      writeLine(
        `Providers: unable to list registrations: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  if (
    selected.length === 0 &&
    !autoUpdateClient &&
    !(options.operation === 'uninstall' && options.full)
  ) {
    writeLine('No installed Mearl environment was detected on the current PATH.');
    if (options.operation === 'uninstall') return true;
    writeLine('Run: npx @mearl/setup');
    return false;
  }

  if (options.operation === 'update') {
    const missing = selected.filter(profile => !detected.has(profile));
    if (missing.length > 0) {
      writeLine(`Not installed: ${missing.join(', ')}. Run the install command first.`);
      return false;
    }
  }

  if (options.operation === 'uninstall') {
    if (lifecycleSelected.length === 0 && !options.full) {
      writeLine(`Nothing to uninstall for ${selected.join(', ')}.`);
      return true;
    }
    if (options.full) {
      writeLine(
        `CLI plugins: ${fullPluginNames.length > 0 ? fullPluginNames.join(', ') : 'none detected'}.`,
      );
      writeLine(
        `Providers: ${
          fullProviders.length > 0
            ? fullProviders.map(provider => provider.providerId).join(', ')
            : 'none detected'
        }.`,
      );
    }
    if (
      !options.yes &&
      !(await confirm(
        options.full
          ? `Uninstall ${
              lifecycleSelected.length > 0
                ? `Mearl environments (${lifecycleSelected.join(', ')}) and `
                : ''
            }all CLI plugins and Providers?`
          : `Uninstall Mearl environments: ${lifecycleSelected.join(', ')}?`,
      ))
    ) {
      writeLine('Uninstall cancelled.');
      return false;
    }
  }

  if (lifecycleSelected.length > 0) {
    writeLine(
      `${operationVerb(options.operation)} targets: ${lifecycleSelected
        .map(profile => MEARL_PROFILES[profile].label)
        .join(', ')}`,
    );
  }
  if (autoUpdateClient && lifecycleSelected.length === 0) {
    writeLine('update targets: client CLI');
  }

  const selectedUsesClient =
    autoUpdateClient !== null ||
    lifecycleSelected.some(profile => CLIENT_PROFILES.includes(profile));
  const detectedClientCandidate =
    selectedUsesClient && !autoUpdateClient
      ? detectPackage(UNIFIED_CLIENT, ['mearl'], packageDetectionOptions)
      : null;
  const detectedClient =
    detectedClientCandidate?.packageName === UNIFIED_CLIENT ? detectedClientCandidate : null;
  const preparesPreset = options.operation !== 'uninstall' && !dependencies.prepareSkills && (!options.targetLine || Number(options.targetLine.split('.')[0]) >= 3);
  const selectsInitialPreset = preparesPreset && !options.skipSkill && !env.MEARL_AUTO_UPDATE_CLIENT_ROOT && !env.MEARL_AUTO_UPDATE_PROFILES;
  let stagedPreset: StagedPresetInstallation | undefined;
  if (preparesPreset || (options.operation !== 'uninstall' && options.presetSource && !dependencies.prepareSkills)) {
    try {
      stagedPreset = await (dependencies.preparePreset ?? prepareSetupPreset)({
        source: options.presetSource, env,
      });
      if (stagedPreset) await acceptPreset(stagedPreset.revision);
    } catch (error) {
      writeLine(`Preset preparation: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  let packagesOk = true;
  if (lifecycleSelected.includes('cloud')) {
    const legacyCloudClient = detectPackage(
      LEGACY_CLOUD_CLIENT,
      ['mearl-cloud'],
      packageDetectionOptions,
    );
    if (legacyCloudClient?.packageName === LEGACY_CLOUD_CLIENT) {
      const command = buildGlobalPackageCommand(legacyCloudClient, 'uninstall', [
        LEGACY_CLOUD_CLIENT,
      ]);
      writeLine(`Migration (cloud): removing ${LEGACY_CLOUD_CLIENT}.`);
      const result = await runLifecycleCommand(
        runner,
        command.command,
        command.args,
        env,
        'Migration (cloud)',
        writeLine,
      );
      if (!result || result.code !== 0) {
        if (result) writeLine(`Migration (cloud): failed (exit ${result.code}).`);
        writeLine('Mearl setup incomplete. Review the messages above.');
        return false;
      }
    }
  }
  const remainingClientProfiles =
    selectedUsesClient && options.operation === 'uninstall'
      ? CLIENT_PROFILES.filter(
          profile => detected.has(profile) && !lifecycleSelected.includes(profile),
        )
      : [];

  if (selectedUsesClient && options.operation !== 'uninstall') {
    const clientInstallation =
      autoUpdateClient ??
      detectedClient ??
      detected.get('local') ??
      detected.get('cloud') ??
      resolveInvokingManager(env);
    const sharedClient = await runPackageOperation(
      clientInstallation,
      options.operation,
      [UNIFIED_CLIENT],
      packageSelector(),
      runner,
      env,
      'Packages (shared client)',
      writeLine,
    );
    if (!sharedClient.ok) {
      writeLine('Mearl setup incomplete. Review the messages above.');
      return false;
    }
  }

  for (const profile of lifecycleSelected) {
    const config = MEARL_PROFILES[profile];
    const current = detected.get(profile);
    if (options.operation === 'uninstall' && !current) continue;
    const installation = current ?? resolveInvokingManager(env);

    if (options.operation === 'uninstall' && profile === 'local') {
      const keepsMcp = detected.has('mcp') && !selected.includes('mcp');
      let cleanupOk = false;
      try {
        cleanupOk = cleanupNativeHost({
          mode: keepsMcp ? 'skills' : 'both',
          silent: true,
        });
      } catch (error) {
        writeLine(`Native host: ${error instanceof Error ? error.message : String(error)}`);
      }
      writeLine(`Native host: ${cleanupOk ? 'cleaned.' : 'cleanup failed.'}`);
      if (!cleanupOk) {
        packagesOk = false;
        continue;
      }
    }

    if (
      options.operation === 'uninstall' &&
      !(await runHook(
        profile,
        options.operation,
        current!,
        runner,
        existsSync,
        env,
        writeLine,
        options.yes === true,
        options.cloudMode,
      ))
    ) {
      packagesOk = false;
      continue;
    }

    const packageOperation: PackageOperation = options.operation;
    const packages = config.packages.filter(packageName => packageName !== UNIFIED_CLIENT);
    if (packages.length === 0) {
      continue;
    }
    const packageResult = await runPackageOperation(
      installation,
      packageOperation,
      packages,
      packageSelector(),
      runner,
      env,
      `Packages (${profile})`,
      writeLine,
    );
    if (!packageResult.ok) {
      packagesOk = false;
      continue;
    }

    if (
      options.operation !== 'uninstall' &&
      (profile === 'local' || profile === 'cloud' || profile === 'mcp')
    ) {
      const refreshed =
        detectPackage(config.anchorPackage, config.anchorBins, {
          env: prependCommandPath(packageResult.command.command, env),
        }) ?? current;
      if (
        !refreshed ||
        !(await runHook(
          profile,
          options.operation,
          refreshed,
          runner,
          existsSync,
          env,
          writeLine,
          options.yes === true,
          options.cloudMode,
        ))
      ) {
        packagesOk = false;
      }
    }
  }

  if (selectedUsesClient && options.operation === 'uninstall') {
    if (remainingClientProfiles.length > 0) {
      writeLine(`Packages (shared client): kept for ${remainingClientProfiles.join(', ')}.`);
    } else if (packagesOk && detectedClient) {
      const sharedClient = await runPackageOperation(
        detectedClient,
        'uninstall',
        [UNIFIED_CLIENT],
        undefined,
        runner,
        env,
        'Packages (shared client)',
        writeLine,
      );
      if (!sharedClient.ok) packagesOk = false;
    }
  }

  let fullOk = true;
  if (options.operation === 'uninstall' && options.full) {
    const pendingPlugins = new Set(fullPluginNames);
    const removePlugin = dependencies.uninstallPlugin ?? uninstallPlugin;
    while (pendingPlugins.size > 0) {
      const name = pendingPlugins.values().next().value!;
      pendingPlugins.delete(name);
      try {
        const result = await removePlugin(name, runner);
        for (const removedName of result.unregisteredNames) pendingPlugins.delete(removedName);
        if (result.removed) {
          writeLine(`CLI plugin ${name}: uninstalled.`);
        }
      } catch (error) {
        fullOk = false;
        writeLine(`CLI plugin ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const removeProvider = dependencies.uninstallProvider ?? uninstallProviderPackage;
    for (const provider of fullProviders) {
      try {
        await removeProvider(provider.providerId);
        writeLine(`Provider ${provider.providerId}: uninstalled.`);
      } catch (error) {
        fullOk = false;
        writeLine(
          `Provider ${provider.providerId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (packagesOk && selectsInitialPreset && !stagedPreset && !options.presetSource && lifecycleSelected.some(profile => profile === 'local' || profile === 'mcp')) {
    try { stagedPreset = await (dependencies.prepareBrowserPreset ?? prepareBrowserSetupPreset)({ env, writeLine }); if (stagedPreset) await acceptPreset(stagedPreset.revision); }
    catch (error) { writeLine(`Browser preset: ${error instanceof Error ? error.message : String(error)}`); packagesOk = false; }
  }
  if (packagesOk && selectsInitialPreset && !stagedPreset && options.defaultPresetSource) {
    try { stagedPreset = await (dependencies.preparePreset ?? prepareSetupPreset)({ fallbackSource: options.defaultPresetSource, env }); if (stagedPreset) await acceptPreset(stagedPreset.revision); }
    catch (error) { writeLine(`Default preset: ${error instanceof Error ? error.message : String(error)}`); packagesOk = false; }
  }
  if (packagesOk && options.operation !== 'uninstall' && (stagedPreset || dependencies.prepareSkills)) {
    try {
      if (stagedPreset) {
        const status = await stagedPreset.activate();
        dependencies.onPresetStatus?.(status);
      }
      else await dependencies.prepareSkills!();
    }
    catch (error) { writeLine(`Skill preparation: ${error instanceof Error ? error.message : String(error)}`); packagesOk = false; }
  }
  const selectedUsesSkill = lifecycleSelected.some(profile => MEARL_PROFILES[profile].usesSkill);
  const remainingSkillProfiles = (['local', 'cloud'] as const).filter(
    profile => detected.has(profile) && !lifecycleSelected.includes(profile),
  );
  let runStandaloneSkill = true;
  let skillOk = true;
  if (
    packagesOk &&
    selectedUsesSkill &&
    selectedUsesClient &&
    options.skipSkill !== true &&
    ((options.operation === 'uninstall' && remainingSkillProfiles.length === 0) ||
      (options.operation !== 'uninstall' && options.targetLine === undefined))
  ) {
    try {
      if (options.operation === 'uninstall') {
        const result = await (
          dependencies.uninstallManagedPlugins ?? uninstallManagedPlugins
        )({
          env,
          includeMearlSkill: true,
          runCommand: runner,
          writeLine,
        });
        if (result === 'uninstalled') runStandaloneSkill = false;
        else if (result === 'failed') {
          runStandaloneSkill = false;
          skillOk = false;
        }
      } else {
        const result = await (dependencies.installManagedPlugins ?? installManagedPlugins)(
          {
            env,
            includeMearlSkill: true,
            mearlSkillOperation: options.operation,
            runCommand: runner,
            writeLine,
          },
        );
        if (result === 'installed') runStandaloneSkill = false;
        else if (result === 'failed') {
          runStandaloneSkill = false;
          skillOk = false;
        }
      }
    } catch (error) {
      writeLine(
        `Managed plugin batch: ${error instanceof Error ? error.message : String(error)}; failed.`,
      );
      runStandaloneSkill = false;
      skillOk = false;
    }
  }

  if (packagesOk && skillOk && selectedUsesSkill && options.skipSkill !== true) {
    try {
      if (options.operation === 'uninstall') {
        if (remainingSkillProfiles.length > 0) {
          writeLine(`Skill: kept for ${remainingSkillProfiles.join(', ')}.`);
          writeLine(`Managed plugins: kept for ${remainingSkillProfiles.join(', ')}.`);
        } else if (runStandaloneSkill) {
          skillOk = await runSkill('uninstall', {
            env,
            yes: options.yes,
            writeLine,
            runCommand: runner,
          });
        }
      } else if (runStandaloneSkill) {
        skillOk = await runSkill(options.operation, {
          env,
          yes: options.yes,
          writeLine,
          runCommand: runner,
        });
      }
    } catch (error) {
      writeLine(`Skill: ${error instanceof Error ? error.message : String(error)}`);
      skillOk = false;
    }
  }

  if (packagesOk && skillOk && fullOk) {
    if (
      options.operation === 'uninstall' &&
      options.full &&
      PROFILE_ORDER.every(profile => !detected.has(profile) || lifecycleSelected.includes(profile))
    ) {
      try {
        await (dependencies.cleanupRuntime ?? cleanupUninstalledRuntime)();
        writeLine('Runtime caches: cleaned; user data and browser profiles were retained.');
      } catch (error) {
        writeLine(`Runtime caches: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    writeLine('Mearl setup complete.');
    return true;
  }
  writeLine('Mearl setup incomplete. Review the messages above.');
  return false;
}
