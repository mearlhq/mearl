import fs from 'node:fs';
import path from 'node:path';
import { executableNames, findExecutable, isExecutable } from '@mearl/daemon-core';

export type GlobalPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'volta';
export type PackageOperation = 'install' | 'update' | 'uninstall';

export interface PackageManagerInstallation {
  manager: GlobalPackageManager;
  command: string;
  /** Directory containing globally installed package executables. */
  binDirectory?: string;
}

export interface GlobalPackageCommand {
  manager: GlobalPackageManager;
  command: string;
  args: string[];
}

export interface DetectedGlobalPackage extends PackageManagerInstallation {
  packageName: string;
  packageRoot: string;
  executable: string;
}

export interface PackageDetectionOptions {
  /** Include npm global links when selecting packages for explicit removal. */
  includeLinked?: boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
  realpathSync?: (filePath: string) => string;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/\/+$/, '');
}

function firstExisting(
  candidates: string[],
  existsSync: (filePath: string) => boolean,
): string | undefined {
  return candidates.find(candidate => existsSync(candidate));
}

function fallbackCommand(name: GlobalPackageManager, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return name;
  if (name === 'bun' || name === 'volta') return `${name}.exe`;
  return `${name}.cmd`;
}

export function resolvePackageManagerInstallation(
  packageRoot: string,
  packageName: string,
  options: PackageDetectionOptions = {},
): PackageManagerInstallation | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? (candidate => isExecutable(candidate, platform));
  const processExecPath = options.processExecPath ?? process.execPath;
  const normalizedRoot = normalizePath(path.resolve(packageRoot));
  const lowerRoot = normalizedRoot.toLowerCase();
  const lowerPackageName = packageName.toLowerCase();

  const pnpmGlobalRoot = /\/global\/\d+\/(?:\.pnpm\/.*\/)?node_modules\//.exec(lowerRoot);
  if (pnpmGlobalRoot && lowerRoot.endsWith(`/node_modules/${lowerPackageName}`)) {
    const pnpmHome = normalizedRoot.slice(0, pnpmGlobalRoot.index);
    const command =
      firstExisting(
        [
          ...executableNames('pnpm', platform).map(name => path.join(pnpmHome, name)),
          ...executableNames('pnpm', platform).map(name =>
            path.join(path.dirname(processExecPath), name),
          ),
        ],
        existsSync,
      ) ?? fallbackCommand('pnpm', platform);
    return { manager: 'pnpm', command, binDirectory: pnpmHome };
  }

  const bunMarker = `/.bun/install/global/node_modules/${lowerPackageName}`;
  if (lowerRoot.endsWith(bunMarker)) {
    const bunHome = normalizedRoot.slice(0, lowerRoot.indexOf('/.bun/'));
    const command =
      firstExisting(
        executableNames('bun', platform).map(name => path.join(bunHome, '.bun', 'bin', name)),
        existsSync,
      ) ?? fallbackCommand('bun', platform);
    return {
      manager: 'bun',
      command,
      binDirectory: path.join(bunHome, '.bun', 'bin'),
    };
  }

  if (
    (lowerRoot.includes('/.config/yarn/global/node_modules/') ||
      lowerRoot.includes('/.yarn/global/node_modules/') ||
      lowerRoot.includes('/yarn/global/node_modules/') ||
      lowerRoot.includes('/yarn/data/global/node_modules/')) &&
    lowerRoot.endsWith(`/node_modules/${lowerPackageName}`)
  ) {
    const layout = [
      { marker: '/.config/yarn/global/', binSegments: ['.yarn', 'bin'] },
      { marker: '/.yarn/global/', binSegments: ['.yarn', 'bin'] },
      { marker: '/yarn/data/global/', binSegments: ['yarn', 'bin'] },
      { marker: '/yarn/global/', binSegments: ['yarn', 'bin'] },
    ].find(candidate => lowerRoot.includes(candidate.marker))!;
    const prefix = normalizedRoot.slice(0, lowerRoot.indexOf(layout.marker));
    const binDirectory = path.join(prefix, ...layout.binSegments);
    const command =
      firstExisting(
        [
          ...executableNames('yarn', platform).map(name => path.join(binDirectory, name)),
          ...executableNames('yarn', platform).map(name =>
            path.join(path.dirname(processExecPath), name),
          ),
        ],
        existsSync,
      ) ??
      findExecutable('yarn', { env, existsSync, platform }) ??
      fallbackCommand('yarn', platform);
    return { manager: 'yarn', command, binDirectory };
  }

  if (
    lowerRoot.includes('/.volta/tools/image/packages/') &&
    lowerRoot.endsWith(`/lib/node_modules/${lowerPackageName}`)
  ) {
    const voltaHome = normalizedRoot.slice(0, lowerRoot.indexOf('/.volta/'));
    const command =
      firstExisting(
        executableNames('volta', platform).map(name => path.join(voltaHome, '.volta', 'bin', name)),
        existsSync,
      ) ?? fallbackCommand('volta', platform);
    return {
      manager: 'volta',
      command,
      binDirectory: path.join(voltaHome, '.volta', 'bin'),
    };
  }

  const npmMarker = `/lib/node_modules/${lowerPackageName}`;
  if (lowerRoot.endsWith(npmMarker)) {
    const prefix = normalizedRoot.slice(0, lowerRoot.length - npmMarker.length);
    const command =
      firstExisting(
        [
          ...executableNames('npm', platform).map(name => path.join(prefix, 'bin', name)),
          ...executableNames('npm', platform).map(name =>
            path.join(path.dirname(processExecPath), name),
          ),
        ],
        existsSync,
      ) ?? fallbackCommand('npm', platform);
    return { manager: 'npm', command, binDirectory: path.join(prefix, 'bin') };
  }

  if (platform === 'win32' && env.APPDATA) {
    const npmRoot = normalizePath(path.join(env.APPDATA, 'npm', 'node_modules', packageName));
    if (lowerRoot === npmRoot.toLowerCase()) {
      const binDirectory = path.join(env.APPDATA, 'npm');
      const command =
        firstExisting(
          [
            ...executableNames('npm', platform).map(name => path.join(binDirectory, name)),
            ...executableNames('npm', platform).map(name =>
              path.join(path.dirname(processExecPath), name),
            ),
          ],
          existsSync,
        ) ?? fallbackCommand('npm', platform);
      return { manager: 'npm', command, binDirectory };
    }
  }

  return null;
}

export function buildGlobalPackageCommand(
  installation: PackageManagerInstallation,
  operation: PackageOperation,
  packages: string[],
  targetSelector = 'latest',
): GlobalPackageCommand {
  const targets =
    operation === 'uninstall'
      ? packages
      : packages.map(packageName => `${packageName}@${targetSelector}`);
  let args: string[];
  switch (installation.manager) {
    case 'npm':
      args =
        operation === 'uninstall' ? ['uninstall', '-g', ...targets] : ['install', '-g', ...targets];
      break;
    case 'pnpm':
      args = operation === 'uninstall' ? ['remove', '-g', ...targets] : ['add', '-g', ...targets];
      break;
    case 'yarn':
      args =
        operation === 'uninstall'
          ? ['global', 'remove', ...targets]
          : ['global', 'add', ...targets];
      break;
    case 'bun':
      args = operation === 'uninstall' ? ['remove', '-g', ...targets] : ['add', '-g', ...targets];
      break;
    case 'volta':
      args = operation === 'uninstall' ? ['uninstall', ...targets] : ['install', ...targets];
      break;
  }
  return { manager: installation.manager, command: installation.command, args };
}

export function resolveInvokingPackageManager(
  options: {
    env?: NodeJS.ProcessEnv;
    existsSync?: (filePath: string) => boolean;
    platform?: NodeJS.Platform;
    processExecPath?: string;
  } = {},
): PackageManagerInstallation {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const platform = options.platform ?? process.platform;
  const processExecPath = options.processExecPath ?? process.execPath;
  const userAgent = (env.npm_config_user_agent ?? '').toLowerCase();
  const manager: GlobalPackageManager = userAgent.startsWith('pnpm/')
    ? 'pnpm'
    : userAgent.startsWith('yarn/')
      ? 'yarn'
      : userAgent.startsWith('bun/')
        ? 'bun'
        : 'npm';
  const sibling = firstExisting(
    executableNames(manager, platform).map(name => path.join(path.dirname(processExecPath), name)),
    existsSync,
  );
  return { manager, command: sibling ?? fallbackCommand(manager, platform) };
}

function readPackageName(
  packageRoot: string,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string,
): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function findPackageRoot(
  entryPath: string,
  packageName: string,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string,
): string | null {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 12; depth += 1) {
    if (readPackageName(current, readFileSync) === packageName) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function packageRootFromWrapper(
  executable: string,
  packageName: string,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string,
): string | null {
  try {
    const content = readFileSync(executable, 'utf8').slice(0, 32_000).replaceAll('\\', '/');
    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const packageSuffix = `node_modules/${escapedName}`;
    const wrapperDirectory = path.dirname(executable);
    const candidates: string[] = [];

    // npm and pnpm wrappers resolve their entry point relative to the bin
    // directory. Preserve the complete relative prefix because pnpm places
    // packages below global/<version>/.pnpm rather than bin/node_modules.
    const relativePattern = new RegExp(
      `(?:\\$basedir|%~?dp0%?)/([^"'\\r\\n]*?${packageSuffix})(?=/|["'\\s])`,
      'gi',
    );
    for (const match of content.matchAll(relativePattern)) {
      candidates.push(path.resolve(wrapperDirectory, match[1].replaceAll('/', path.sep)));
    }

    // Some package managers emit an absolute package entry in the wrapper.
    const absolutePattern = new RegExp(
      `((?:[A-Za-z]:)?/[^"'\\r\\n:]*?${packageSuffix})(?=/|["'\\s:])`,
      'gi',
    );
    for (const match of content.matchAll(absolutePattern)) {
      candidates.push(path.resolve(match[1].replaceAll('/', path.sep)));
    }

    for (const candidate of new Set(candidates)) {
      if (readPackageName(candidate, readFileSync) === packageName) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

export function detectCliPackage(
  packageName: string,
  binNames: string[],
  options: PackageDetectionOptions = {},
): Pick<DetectedGlobalPackage, 'packageName' | 'packageRoot' | 'executable'> | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? (candidate => isExecutable(candidate, platform));
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const realpathSync = options.realpathSync ?? fs.realpathSync;
  const processExecPath = options.processExecPath ?? process.execPath;
  const extraDirectories = [path.dirname(processExecPath)];

  for (const binName of binNames) {
    const executable = findExecutable(binName, {
      env,
      existsSync,
      platform,
      extraDirectories,
    });
    if (!executable) continue;

    let packageRoot: string | null = null;
    try {
      packageRoot = findPackageRoot(realpathSync(executable), packageName, readFileSync);
    } catch {
      // Windows package-manager wrappers are regular files rather than symlinks.
    }
    packageRoot ??= packageRootFromWrapper(executable, packageName, readFileSync);
    if (!packageRoot) continue;

    return { packageName, packageRoot, executable };
  }
  return null;
}

export function detectGlobalPackage(
  packageName: string,
  binNames: string[],
  options: PackageDetectionOptions = {},
): DetectedGlobalPackage | null {
  for (const binName of binNames) {
    const cli = detectCliPackage(packageName, [binName], options);
    if (!cli) continue;
    let installation = resolvePackageManagerInstallation(cli.packageRoot, packageName, options);
    if (!installation && options.includeLinked) {
      const linkedRoot = path.resolve(
        path.dirname(cli.executable),
        '../lib/node_modules',
        packageName,
      );
      try {
        // A global package link must resolve to the package owning this CLI;
        // an arbitrary executable symlink does not establish npm ownership.
        if ((options.realpathSync ?? fs.realpathSync)(linkedRoot) === cli.packageRoot) {
          installation = resolvePackageManagerInstallation(linkedRoot, packageName, options);
        }
      } catch {
        // The global package registration may be absent or a stale symlink.
      }
    }
    if (!installation) continue;
    return {
      ...cli,
      ...installation,
      binDirectory: path.dirname(cli.executable),
    };
  }
  return null;
}
