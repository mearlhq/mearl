import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isProcessGroupAlive, isProcessOwnerAlive, processIdentity } from './process.js';

export interface CommandProcessOwner { pid: number; processIdentity?: string; group?: number }
export interface CommandLifecycle {
  started(owner: CommandProcessOwner): void;
  finished(owner: CommandProcessOwner): void;
}
const ownedCommands = new AsyncLocalStorage<CommandLifecycle>();
/** Accepted installation commands retain process ownership until their complete process group exits. */
export function withOwnedCommands<T>(lifecycle: CommandLifecycle, operation: () => Promise<T>): Promise<T> {
  const parent = ownedCommands.getStore();
  return ownedCommands.run(parent ? {
    started(owner) { parent.started(owner); lifecycle.started(owner); },
    finished(owner) { try { lifecycle.finished(owner); } finally { parent.finished(owner); } },
  } : lifecycle, operation);
}

export function isCommandProcessAlive(owner: CommandProcessOwner): boolean {
  if (!owner.group || process.platform === 'win32') return isProcessOwnerAlive(owner);
  const identity = processIdentity(owner.pid);
  if (identity && owner.processIdentity && identity !== owner.processIdentity) return false;
  return isProcessGroupAlive(owner.group);
}

async function stopCommandProcess(owner: CommandProcessOwner): Promise<void> {
  if (process.platform === 'win32') {
    if (!isCommandProcessAlive(owner)) return;
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(owner.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject); killer.once('close', () => resolve());
    });
  } else {
    const signal = (value: NodeJS.Signals) => {
      try { process.kill(-(owner.group ?? owner.pid), value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const grace = Date.now() + 250;
    while (isCommandProcessAlive(owner) && Date.now() < grace) await new Promise(resolve => setTimeout(resolve, 20));
    if (isCommandProcessAlive(owner)) signal('SIGKILL');
  }
  const deadline = Date.now() + 2000;
  while (isCommandProcessAlive(owner) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (isCommandProcessAlive(owner)) throw new Error('Command process is still stopping');
}

export interface SpawnCommand {
  command: string;
  args: string[];
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  capture?: boolean;
  /** 显示并捕获输出，同时继承 stdin 以保留安装器交互。 */
  tee?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

const MAX_CAPTURE_LENGTH = 1_000_000;

export function isExecutable(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    fs.accessSync(filePath, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function executableNames(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
}

export interface VersionManagerExecutableCandidateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readdirSync?: typeof fs.readdirSync;
}

export function versionManagerExecutableCandidates(
  home: string,
  names: string[],
  options: VersionManagerExecutableCandidateOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const fnmDefaultRoot = env.XDG_DATA_HOME
    ? path.join(env.XDG_DATA_HOME, 'fnm')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'fnm')
      : platform === 'win32' && env.APPDATA
        ? path.join(env.APPDATA, 'fnm')
        : path.join(home, '.local', 'share', 'fnm');
  const roots = [
    path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'),
    path.join(env.FNM_DIR || fnmDefaultRoot, 'node-versions'),
    path.join(home, '.fnm', 'node-versions'),
  ].filter((root, index, all) => all.indexOf(root) === index);
  return roots.flatMap(root => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
        .flatMap(entry =>
          names.flatMap(name => [
            path.join(root, entry.name, 'bin', name),
            path.join(root, entry.name, 'installation', 'bin', name),
          ]),
        );
    } catch {
      return [];
    }
  });
}

export function resolveSpawnCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandInterpreter: string | undefined = process.env.ComSpec,
): SpawnCommand {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    return {
      command: commandInterpreter || 'cmd.exe',
      args: ['/d', '/s', '/c', executable, ...args],
    };
  }
  return { command: executable, args };
}

export function prependCommandPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(command)) return env;
  return prependPathDirectory(path.dirname(command), env);
}

export function prependNodePath(
  env: NodeJS.ProcessEnv = process.env,
  nodeExecutable: string = process.execPath,
): NodeJS.ProcessEnv {
  return prependPathDirectory(path.dirname(nodeExecutable), env);
}

export function prependPathDirectory(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const inherited = env[pathKey] || '';
  const entries = inherited.split(path.delimiter).filter(Boolean);
  if (entries.includes(directory)) return env;
  return { ...env, [pathKey]: [directory, ...entries].join(path.delimiter) };
}

/** npm exec's package selector belongs to its invocation, not nested package runners. */
export function npmExecEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== 'npm_config_package'),
  );
}

export function findExecutable(
  name: string,
  options: {
    env?: NodeJS.ProcessEnv;
    existsSync?: (filePath: string) => boolean;
    platform?: NodeJS.Platform;
    extraDirectories?: string[];
  } = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? (candidate => isExecutable(candidate, platform));
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const directories = [
    ...(options.extraDirectories ?? []),
    ...(env[pathKey] ?? '').split(path.delimiter).filter(Boolean),
  ];
  for (const directory of directories) {
    for (const executableName of executableNames(name, platform)) {
      const candidate = path.join(directory, executableName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export const runCommand: CommandRunner = (command, args, options: RunCommandOptions = {}) =>
  new Promise((resolve, reject) => {
    const capture = options.capture === true || options.tee === true;
    const lifecycle = ownedCommands.getStore();
    const launch = resolveSpawnCommand(command, args);
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? [options.tee ? 'inherit' : 'ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
      ...(lifecycle && process.platform !== 'win32' ? { detached: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let finalizing = false;
    let timedOut: Error | undefined;
    const owner = lifecycle && child.pid ? { pid: child.pid, processIdentity: processIdentity(child.pid), ...(process.platform !== 'win32' ? { group: child.pid } : {}) } : undefined;
    const append = (current: string, chunk: string): string =>
      options.tee
        ? (current + chunk).slice(-MAX_CAPTURE_LENGTH)
        : current.length >= MAX_CAPTURE_LENGTH
          ? current
          : (current + chunk).slice(0, MAX_CAPTURE_LENGTH);
    const finish = (error?: Error, code = 1): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    };
    const finishOwned = async (error?: Error, code = 1) => {
      if (finalizing || settled) return;
      finalizing = true;
      if (timer) clearTimeout(timer);
      try {
        if (owner && isCommandProcessAlive(owner)) await stopCommandProcess(owner);
        if (owner) lifecycle!.finished(owner);
        finish(error ?? timedOut, code);
      } catch (failure) { finish(failure instanceof Error ? failure : new Error(String(failure))); }
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = new Error(`Command timed out after ${options.timeoutMs}ms`);
            if (lifecycle) void finishOwned(timedOut);
            else { child.kill('SIGTERM'); finish(timedOut); }
          }, options.timeoutMs);

    if (capture) {
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout = append(stdout, chunk);
        if (options.tee) process.stdout.write(chunk);
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = append(stderr, chunk);
        if (options.tee) process.stderr.write(chunk);
      });
    }
    child.once('error', error => lifecycle ? void finishOwned(error) : finish(error));
    child.once('close', code => lifecycle ? void finishOwned(undefined, code ?? 1) : finish(undefined, code ?? 1));
    if (lifecycle && owner) {
      try { lifecycle.started(owner); }
      catch (error) { void finishOwned(error instanceof Error ? error : new Error(String(error))); }
    }
  });
