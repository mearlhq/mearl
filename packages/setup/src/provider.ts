import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  listInstalledProviders,
  validateInstalledProviderManifest,
  registerProviderPackage,
  stopProvider,
  readLiveProvider,
  readProviderStart,
  uninstallProvider,
  type InstalledProviderManifest,
} from '@mearl/provider/host';
import {
  buildGlobalPackageCommand,
  resolveInvokingPackageManager,
  resolvePackageManagerInstallation,
  type PackageManagerInstallation,
} from './packageManager.js';
import { packageRegistryEnvironment } from './npmRegistry.js';
import {
  isProcessOwnerAlive,
  processIdentity,
  prependCommandPath,
  runCommand,
  type CommandRunner,
} from '@mearl/daemon-core';

interface ProviderPackageSpec {
  packageName: string;
  target: string;
}

export interface ProviderSetupDependencies {
  existsSync?: (filePath: string) => boolean;
  listProviders?: typeof listInstalledProviders;
  registerPackage?: typeof registerProviderPackage;
  resolveInvokingManager?: (env: NodeJS.ProcessEnv) => PackageManagerInstallation;
  resolvePackageManager?: typeof resolvePackageManagerInstallation;
  resolvePackageRoot?: (
    installation: PackageManagerInstallation,
    packageName: string,
    runner: CommandRunner,
    env: NodeJS.ProcessEnv,
  ) => Promise<string>;
  runCommand?: CommandRunner;
  stopProvider?: (providerId: string) => void | boolean | Promise<void | boolean>;
  unregisterProvider?: typeof uninstallProvider;
}

export interface ProviderSetupResult {
  manifest: InstalledProviderManifest;
  manager: PackageManagerInstallation['manager'];
}

/** A registry record alone does not prove that the package still exists. */
export function inspectProviderPackage(manifest: InstalledProviderManifest): boolean {
  if (validateInstalledProviderManifest(manifest)) return false;
  try {
    const file = join(manifest.packageRoot, 'package.json');
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    const provider = metadata.mearl?.provider;
    return metadata.name === manifest.packageName && metadata.version === manifest.version &&
      provider?.providerId === manifest.providerId && provider.protocolVersion === manifest.protocolVersion &&
      typeof provider.entry === 'string' && resolve(manifest.packageRoot, provider.entry) === manifest.entryPath;
  } catch { return false; }
}

async function stopProviderBeforePackageChange(providerId: string): Promise<void> {
  if (readProviderStart(providerId)) throw new Error(`Provider ${providerId} is still starting`);
  const live = readLiveProvider(providerId);
  if (!live) return;
  const owner = { pid: live.pid, processIdentity: processIdentity(live.pid) };
  stopProvider(providerId);
  const deadline = Date.now() + 5000;
  while (isProcessOwnerAlive(owner)) {
    if (Date.now() >= deadline) throw new Error(`Provider ${providerId} did not finish stopping`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (readLiveProvider(providerId) || readProviderStart(providerId))
    throw new Error(`Provider ${providerId} restarted during shutdown`);
}

export function parseProviderPackageSpec(value: string): ProviderPackageSpec {
  const input = value.trim();
  const nameMatch = input.match(
    /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/i,
  );
  if (!nameMatch || !nameMatch[1] || /\s/.test(nameMatch[2] ?? '')) {
    throw new Error(`Provider install requires an npm package name, received: ${value}`);
  }
  return { packageName: nameMatch[1], target: nameMatch[2] || 'latest' };
}

function providerManager(
  env: NodeJS.ProcessEnv,
  dependencies: ProviderSetupDependencies,
  resolvedManager?: PackageManagerInstallation,
): PackageManagerInstallation {
  return (
    resolvedManager ??
    (
      dependencies.resolveInvokingManager ??
      (childEnv => resolveInvokingPackageManager({ env: childEnv }))
    )(env)
  );
}

function outputPath(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

async function resolveGlobalProviderPackageRoot(
  installation: PackageManagerInstallation,
  packageName: string,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  let args: string[];
  let toNodeModules: (value: string) => string;
  switch (installation.manager) {
    case 'npm':
    case 'pnpm':
      args = ['root', '-g'];
      toNodeModules = value => value;
      break;
    case 'yarn':
      args = ['global', 'dir'];
      toNodeModules = value => join(value, 'node_modules');
      break;
    case 'bun':
      args = ['pm', 'bin', '-g'];
      toNodeModules = value => resolve(value, '..', 'install', 'global', 'node_modules');
      break;
    case 'volta':
      throw new Error('Volta cannot manage a Provider package without a binary; use npm or pnpm');
  }
  const result = await runner(installation.command, args, {
    capture: true,
    env: prependCommandPath(installation.command, env),
  });
  const root = outputPath(result.stdout);
  if (result.code !== 0 || !root) {
    throw new Error(`${installation.manager} global package root lookup failed`);
  }
  return join(toNodeModules(root), ...packageName.split('/'));
}

function findRegisteredProvider(
  selector: string,
  listProviders: typeof listInstalledProviders,
): InstalledProviderManifest {
  const providers = listProviders();
  const matches = providers.filter(
    provider => provider.providerId === selector || provider.packageName === selector,
  );
  if (matches.length === 0) throw new Error(`Provider is not registered: ${selector}`);
  if (matches.length > 1) throw new Error(`Provider selector is ambiguous: ${selector}`);
  return matches[0]!;
}

async function runPackageCommand(
  installation: PackageManagerInstallation,
  operation: 'install' | 'update' | 'uninstall',
  packageName: string,
  target: string,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const command = buildGlobalPackageCommand(installation, operation, [packageName], target);
  const commandEnv = operation === 'uninstall' ? env : packageRegistryEnvironment(packageName, env);
  const result = await runner(command.command, command.args, {
    env: prependCommandPath(command.command, commandEnv),
    tee: true,
  });
  if (result.code !== 0) {
    throw new Error(`${packageName} ${operation} failed (exit ${result.code})`);
  }
}

export async function installProviderPackage(
  packageSpec: string,
  dependencies: ProviderSetupDependencies = {},
): Promise<ProviderSetupResult> {
  const { packageName, target } = parseProviderPackageSpec(packageSpec);
  const env = process.env;
  const runner = dependencies.runCommand ?? runCommand;
  const installation = providerManager(env, dependencies);
  const previous = (dependencies.listProviders ?? listInstalledProviders)().filter(provider => provider.packageName === packageName);
  for (const provider of previous) await (dependencies.stopProvider ?? stopProviderBeforePackageChange)(provider.providerId);
  await runPackageCommand(installation, 'install', packageName, target, runner, env);
  const packageRoot = await (dependencies.resolvePackageRoot ?? resolveGlobalProviderPackageRoot)(
    installation,
    packageName,
    runner,
    env,
  );
  if (!(dependencies.existsSync ?? existsSync)(join(packageRoot, 'package.json'))) {
    throw new Error(
      `${packageName} was installed but its package root was not found: ${packageRoot}`,
    );
  }
  const manifest = (dependencies.registerPackage ?? registerProviderPackage)(packageRoot);
  return { manifest, manager: installation.manager };
}

export async function updateProviderPackage(
  selector: string,
  dependencies: ProviderSetupDependencies = {},
): Promise<ProviderSetupResult> {
  const listProviders = dependencies.listProviders ?? listInstalledProviders;
  const current = findRegisteredProvider(selector, listProviders);
  const env = process.env;
  const runner = dependencies.runCommand ?? runCommand;
  const detectedManager =
    (dependencies.resolvePackageManager ?? resolvePackageManagerInstallation)(
      current.packageRoot,
      current.packageName,
    ) ?? undefined;
  const installation = providerManager(env, dependencies, detectedManager);
  await (dependencies.stopProvider ?? stopProviderBeforePackageChange)(current.providerId);
  await runPackageCommand(installation, 'update', current.packageName, 'latest', runner, env);
  const manifest = (dependencies.registerPackage ?? registerProviderPackage)(current.packageRoot);
  return { manifest, manager: installation.manager };
}

export async function uninstallProviderPackage(
  selector: string,
  dependencies: ProviderSetupDependencies = {},
): Promise<ProviderSetupResult> {
  const listProviders = dependencies.listProviders ?? listInstalledProviders;
  const manifest = findRegisteredProvider(selector, listProviders);
  const env = process.env;
  const installation =
    (dependencies.resolvePackageManager ?? resolvePackageManagerInstallation)(
      manifest.packageRoot,
      manifest.packageName,
    ) ?? providerManager(env, dependencies);
  await (dependencies.stopProvider ?? stopProviderBeforePackageChange)(manifest.providerId);
  await runPackageCommand(
    installation,
    'uninstall',
    manifest.packageName,
    'latest',
    dependencies.runCommand ?? runCommand,
    env,
  );
  (dependencies.unregisterProvider ?? uninstallProvider)(manifest.providerId);
  return { manifest, manager: installation.manager };
}
