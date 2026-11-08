import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentChatStatus } from '@mearl/browser-core';
import {
  AgentExecutableResolver,
  executableFileCandidates,
  qoderExecutableCandidatePaths,
} from '@mearl/agent-runtime/execution';
import {
  executableNames,
  findExecutable,
  keyedDir,
  npmExecEnvironment,
  prependCommandPath,
  prependNodePath,
  resolveSpawnCommand,
  runCommand,
  type CommandRunner,
} from '@mearl/daemon-core';
import type { AgentCapabilityFactory } from '../capability-hooks.js';
import type { AgentProviderLoader } from './manager.js';

const require = createRequire(import.meta.url);
const QODER_ADAPTER = '@mearl/plugin-qoder@3.0.0-beta.9';
const QODER_RUNTIME = 'node_modules/@mearl/plugin-qoder/dist/capability/runtime.cjs';
const AGENT_PROGRAMS = {
  codex: { executable: 'codex', packageName: '@openai/codex' },
  qoder: { executable: 'qodercli', packageName: '@qoder-ai/qodercli' },
};
type ManagedProviderId = keyof typeof AGENT_PROGRAMS;

function canInstall(id: string): id is ManagedProviderId {
  return (
    Object.hasOwn(AGENT_PROGRAMS, id) &&
    !(id === 'qoder' && process.platform === 'win32' && process.arch === 'arm64')
  );
}

export class ManagedAgentPrograms {
  private readonly installing = new Map<ManagedProviderId, Promise<AgentChatStatus>>();
  private qoderLogin?: Promise<string | null>;

  constructor(
    private readonly directory = keyedDir('agent-programs'),
    private readonly run: CommandRunner = runCommand,
    private readonly spawnLogin: typeof spawn = spawn,
  ) {}

  addToExecutableSearch(env: NodeJS.ProcessEnv = process.env): void {
    const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
    const current = (env[key] || '').split(path.delimiter).filter(Boolean);
    const managed = Object.keys(AGENT_PROGRAMS).map(id =>
      path.join(this.directory, id, 'node_modules', '.bin'),
    );
    env[key] = [...new Set([...current, ...managed])].join(path.delimiter);
  }

  qoderLoader(
    context: Parameters<AgentCapabilityFactory>[0],
  ): (AgentProviderLoader & { revision: string }) | undefined {
    const runtime = path.join(this.directory, 'qoder-adapter', QODER_RUNTIME);
    if (!existsSync(runtime)) return undefined;
    return {
      id: 'qoder',
      revision: runtime,
      load: async () => {
        const factory = require(runtime) as () => { agent: AgentCapabilityFactory };
        return factory().agent(context);
      },
    };
  }

  describe(status: AgentChatStatus): AgentChatStatus {
    const providers = status.providers.map(provider => {
      if (!canInstall(provider.id)) return provider;
      const command = this.executableFiles(provider.id)
        .map(file => path.join(this.directory, provider.id, file))
        .find(existsSync);
      const quotedCommand =
        command &&
        (process.platform === 'win32'
          ? `& '${command.replaceAll("'", "''")}'`
          : `'${command.replaceAll("'", "'\\''")}'`);
      const loginCommand =
        quotedCommand && (provider.id === 'codex' ? `${quotedCommand} login` : quotedCommand);
      return {
        ...provider,
        setup: { ...provider.setup, canInstall: true, ...(loginCommand ? { loginCommand } : {}) },
      };
    });
    if (canInstall('qoder') && !providers.some(provider => provider.id === 'qoder')) {
      providers.push({
        id: 'qoder',
        name: 'Qoder',
        available: false,
        capabilities: {
          streaming: false,
          resume: false,
          listSessions: false,
          refreshHistory: false,
          imageInput: false,
          interrupt: false,
          requests: false,
        },
        setup: { canInstall: true, docsUrl: 'https://docs.qoder.com/cli/quickstart' },
      });
    }
    return { ...status, providers };
  }

  install(id: unknown, status: () => Promise<AgentChatStatus>): Promise<AgentChatStatus> {
    if (typeof id !== 'string' || !canInstall(id)) throw new Error('Unsupported Agent installation');
    const active = this.installing.get(id);
    if (active) return active;
    const pending = this.installMissing(id, status).finally(() => this.installing.delete(id));
    this.installing.set(id, pending);
    return pending;
  }

  loginQoder(onSignedIn: () => void): Promise<string | null> {
    this.qoderLogin ??= this.startQoderLogin(onSignedIn).catch(error => {
      this.qoderLogin = undefined;
      throw error;
    });
    return this.qoderLogin;
  }

  private async startQoderLogin(onSignedIn: () => void): Promise<string | null> {
    const env = prependNodePath({ ...process.env });
    this.addToExecutableSearch(env);
    const home = homedir();
    const { executable, error } = await new AgentExecutableResolver({
      candidates: () => executableFileCandidates(qoderExecutableCandidatePaths({ env })),
      probe: async command => {
        const failed = 'Qoder CLI version check failed';
        const result = await this.run(command, ['--version'], { env, capture: true, timeoutMs: 5_000 })
          .catch(() => null);
        return result?.code === 0 ? null : failed;
      },
      notFoundError: 'Qoder CLI was not found',
      unusableError: 'Qoder CLI could not be started',
    }).resolve();
    if (error !== null) throw new Error(error);
    const launch = resolveSpawnCommand(executable, ['login']);
    const child = this.spawnLogin(launch.command, launch.args, {
      cwd: home,
      env: { ...env, BROWSER: 'www-browser' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      let timer = setTimeout(() => child.kill(), 15_000);
      let url: string | undefined;
      lines.on('line', line => {
        if (url) return;
        const value = line.trim();
        if (!value.startsWith('https://qoder.com/device/')) return;
        url = value;
        clearTimeout(timer);
        timer = setTimeout(() => child.kill(), 300_000);
        resolve(url);
      });
      child.once('error', () => reject(new Error('Qoder CLI could not start browser sign-in')));
      child.once('close', code => {
        clearTimeout(timer);
        lines.close();
        this.qoderLogin = undefined;
        if (code === 0) {
          onSignedIn();
          resolve(null);
        } else {
          reject(new Error('Qoder CLI could not complete browser sign-in'));
        }
      });
    });
  }

  private async installMissing(
    id: ManagedProviderId,
    status: () => Promise<AgentChatStatus>,
  ): Promise<AgentChatStatus> {
    let current = await status();
    if (id === 'qoder' && !current.providers.some(provider => provider.id === id)) {
      await this.installPackage('qoder-adapter', QODER_ADAPTER, [QODER_RUNTIME], true);
      current = await status();
    }
    const provider = current.providers.find(candidate => candidate.id === id);
    if (provider?.available) return this.describe(current);
    if (!provider || provider.acceptsNewSessions === false) throw new Error('Agent runtime is unavailable');

    await this.installPackage(id, AGENT_PROGRAMS[id].packageName, this.executableFiles(id), false);
    current = await status();
    if (!current.providers.some(candidate => candidate.id === id && candidate.available)) {
      throw new Error('Agent CLI was installed but could not be started');
    }
    return this.describe(current);
  }

  private executableFiles(id: ManagedProviderId): string[] {
    return executableNames(AGENT_PROGRAMS[id].executable).map(name =>
      path.join('node_modules', '.bin', name),
    );
  }

  private async installPackage(
    name: string,
    spec: string,
    expectedFiles: string[],
    ignoreScripts: boolean,
  ): Promise<void> {
    const destination = path.join(this.directory, name);
    const installed = () => expectedFiles.some(file => existsSync(path.join(destination, file)));
    if (installed()) return;
    const env = npmExecEnvironment(prependNodePath());
    const npm = findExecutable('npm', { env });
    if (!npm) throw new Error('npm is required to install Agent programs');

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(this.directory, `.${name}-`));
    try {
      const result = await this.run(
        npm,
        [
          'install',
          '--prefix', staging,
          '--global=false',
          '--no-save',
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '--registry=https://registry.npmjs.org',
          ...(ignoreScripts ? ['--ignore-scripts'] : []),
          spec,
        ],
        { cwd: staging, env: prependCommandPath(npm, env), capture: true, timeoutMs: 180_000 },
      );
      if (result.code !== 0 || !expectedFiles.some(file => existsSync(path.join(staging, file)))) {
        throw new Error(`Could not install ${spec} through npm`);
      }
      try {
        await rename(staging, destination);
      } catch (error) {
        if (!installed()) throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
