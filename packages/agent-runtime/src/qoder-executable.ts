import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentExecutableCandidatePaths } from './executable-resolver.js';

function qoderManagedExecutableCandidates(
  home: string,
  readdirSync: typeof fs.readdirSync = fs.readdirSync,
): string[] {
  const directory = path.join(home, '.qoder', 'bin', 'qodercli');
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.startsWith('qodercli-'))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map(entry => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

interface QoderExecutableCandidateOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  readdirSync?: typeof fs.readdirSync;
}

export function qoderExecutableCandidatePaths(
  options: QoderExecutableCandidateOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const home = (options.homedir ?? os.homedir)();
  const platform = options.platform ?? process.platform;
  const executableNames = platform === 'win32' ? ['qodercli.exe', 'qodercli.cmd'] : ['qodercli'];
  return agentExecutableCandidatePaths({
    executableNames,
    configuredPath: env.MEARL_QODER_PATH,
    env,
    extraUserCandidates: [
      ...qoderManagedExecutableCandidates(home, options.readdirSync),
      ...executableNames.map(name => path.join(home, '.qoder', 'bin', name)),
    ],
    home,
    platform,
    processExecPath: options.processExecPath,
    readdirSync: options.readdirSync,
  });
}
