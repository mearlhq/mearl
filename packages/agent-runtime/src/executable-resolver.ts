import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  agentSpawnCommand,
  createAgentChildEnv,
  versionManagerExecutableCandidates,
} from './process-env.js';

export type AgentExecutableResolution =
  | { executable: string; error: null }
  | { executable: null; error: string };

interface AgentExecutableResolverOptions {
  candidates: () => string[];
  probe: (executable: string) => Promise<string | null>;
  getVersion?: (executable: string) => Promise<string | null>;
  compareVersions?: (left: string, right: string) => number;
  preferred?: (executable: string) => boolean;
  notFoundError: string;
  unusableError: string;
  onFailure?: (executable: string, error: string) => void;
  onSelection?: (executable: string, version: string | null) => void;
}

interface AgentExecutableProbeOptions {
  args: string[];
  timeoutMs: number;
  timeoutError: string;
  startError: (error: Error) => string;
  exitError: (code: number | null) => string;
}

interface AgentExecutableCandidateOptions {
  executableNames: string[];
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  extraUserCandidates?: string[];
  home: string;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  readdirSync?: typeof fs.readdirSync;
}

export function agentExecutableCandidatePaths({
  executableNames,
  configuredPath,
  env = process.env,
  extraUserCandidates = [],
  home,
  platform = process.platform,
  processExecPath = process.execPath,
  readdirSync,
}: AgentExecutableCandidateOptions): string[] {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const pathCandidates = (env[pathKey] || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap(directory => executableNames.map(name => path.join(directory, name)));
  const commonUserDirectories = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.bun', 'bin'),
    ...(platform === 'win32' && env.APPDATA ? [path.join(env.APPDATA, 'npm')] : []),
  ];
  const systemDirectories =
    platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return [
    configuredPath,
    ...executableNames.map(name => path.join(path.dirname(processExecPath), name)),
    ...commonUserDirectories.flatMap(directory =>
      executableNames.map(name => path.join(directory, name)),
    ),
    ...extraUserCandidates,
    ...versionManagerExecutableCandidates(home, executableNames, {
      env,
      platform,
      readdirSync,
    }),
    ...systemDirectories.flatMap(directory =>
      executableNames.map(name => path.join(directory, name)),
    ),
    ...pathCandidates,
  ].filter((candidate): candidate is string => typeof candidate === 'string');
}

export class AgentExecutableResolver {
  private resolvedExecutable: string | null = null;
  private resolutionPromise: Promise<AgentExecutableResolution> | null = null;
  private generation = 0;

  constructor(private readonly options: AgentExecutableResolverOptions) {}

  async resolve(): Promise<AgentExecutableResolution> {
    if (this.resolvedExecutable) {
      if (isExecutableFile(this.resolvedExecutable)) {
        return { executable: this.resolvedExecutable, error: null };
      }
      this.resolvedExecutable = null;
    }
    if (this.resolutionPromise) return this.resolutionPromise;

    const generation = this.generation;
    const resolution = this.probeCandidates(generation);
    this.resolutionPromise = resolution;
    try {
      return await resolution;
    } finally {
      if (this.resolutionPromise === resolution) {
        this.resolutionPromise = null;
      }
    }
  }

  reset(): void {
    this.generation += 1;
    this.resolvedExecutable = null;
    this.resolutionPromise = null;
  }

  private async probeCandidates(generation: number): Promise<AgentExecutableResolution> {
    const candidates = this.options.candidates();
    if (candidates.length === 0) {
      return { executable: null, error: this.options.notFoundError };
    }

    const failures: Array<{ executable: string; error: string }> = [];
    const recordFailure = (executable: string, error: string): void => {
      failures.push({ executable, error });
      this.options.onFailure?.(executable, error);
    };
    const select = (executable: string, version: string | null): AgentExecutableResolution => {
      if (this.generation === generation) {
        this.resolvedExecutable = executable;
        this.options.onSelection?.(executable, version);
      }
      return { executable, error: null };
    };
    const preferredCandidates = this.options.preferred
      ? candidates.filter(executable => this.options.preferred?.(executable))
      : [];
    const automaticCandidates = candidates.filter(
      executable => !preferredCandidates.includes(executable),
    );

    for (const executable of preferredCandidates) {
      const error = await this.options.probe(executable);
      if (error === null) {
        return select(executable, null);
      }
      recordFailure(executable, error);
    }

    const getVersion = this.options.getVersion;
    if (!getVersion) {
      for (const executable of automaticCandidates) {
        const error = await this.options.probe(executable);
        if (error === null) {
          return select(executable, null);
        }
        recordFailure(executable, error);
      }
    } else {
      const inspected = await Promise.all(
        automaticCandidates.map(async (executable, index) => {
          const [error, version] = await Promise.all([
            this.options.probe(executable),
            getVersion(executable).catch(() => null),
          ]);
          return { executable, error, index, version };
        }),
      );
      const usable = inspected.filter(
        (
          candidate,
        ): candidate is typeof candidate & {
          error: null;
        } => candidate.error === null,
      );
      for (const candidate of inspected) {
        if (candidate.error !== null) recordFailure(candidate.executable, candidate.error);
      }
      usable.sort((left, right) => {
        if (left.version && right.version && this.options.compareVersions) {
          const comparison = this.options.compareVersions(left.version, right.version);
          if (comparison !== 0) return -comparison;
        } else if (left.version) {
          return -1;
        } else if (right.version) {
          return 1;
        }
        return left.index - right.index;
      });
      const selected = usable[0];
      if (selected) {
        return select(selected.executable, selected.version);
      }
    }

    const detail = failures
      .map(({ executable, error }) => {
        const compactError = error.replace(/\s+/g, ' ').trim().slice(0, 300);
        return `${executable}: ${compactError}`;
      })
      .join('; ');
    return {
      executable: null,
      error: `${this.options.unusableError} ${detail}`,
    };
  }
}

export function executableFileCandidates(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const executableCandidates: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) executableCandidates.push(candidate);
  }
  return executableCandidates;
}

export function probeAgentExecutable(
  executable: string,
  options: AgentExecutableProbeOptions,
): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false;
    let stderr = '';
    const launch = agentSpawnCommand(executable, options.args);
    const child = spawn(launch.command, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: createAgentChildEnv(),
    });
    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(options.timeoutError);
    }, options.timeoutMs);

    child.stderr?.on('data', chunk => {
      if (stderr.length < 4_000) stderr += chunk.toString('utf8');
    });
    child.once('error', error => finish(options.startError(error)));
    child.once('exit', code => {
      if (code === 0) {
        finish(null);
        return;
      }
      finish(stderr.trim() || options.exitError(code));
    });
  });
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
