import type { PluginModelDiagnostic, PluginModelOption } from '@mearl/browser-core/pluginModels';
import type { AgentInstalledSkill, AgentInstalledSkillScope } from '@mearl/browser-core/agentSkills';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentChatImageInput,
  AgentChatModelInfo,
  AgentChatProviderDescriptor,
} from '@mearl/browser-core/agentChat';
import type {
  AgentProvider,
  AgentProviderEvent,
  AgentProviderListSessionsOptions,
  AgentProviderListSessionsResult,
  AgentProviderResumeResult,
  AgentProviderSessionOptions,
  AgentProviderTurnOptions,
} from './provider.js';
import {
  agentExecutableCandidatePaths,
  AgentExecutableResolver,
  executableFileCandidates,
  probeAgentExecutable,
  type AgentExecutableResolution,
} from './executable-resolver.js';
import { agentSpawnCommand, createAgentChildEnv } from './process-env.js';

/** config/read uses null for absent options; thread config overrides must contain TOML values. */
function configOverride(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(configOverride);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== null && field !== undefined)
        .map(([key, field]) => [key, configOverride(field)]),
    );
  return value;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodexMessage {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_MODEL_CHARS = 256;
const MAX_VERSION_OUTPUT_CHARS = 1_024;
const CODEX_NOT_FOUND_ERROR =
  'Codex was not found. Install @openai/codex, install the Codex App, or set MEARL_CODEX_PATH.';
const CODEX_VERSION_PATTERN =
  /^(?:codex-cli\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

interface CodexExecutableCandidateOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  readdirSync?: typeof import('node:fs').readdirSync;
}

interface ParsedCodexVersion {
  core: [number, number, number];
  prerelease: string[];
}

export function normalizeCodexVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_VERSION_OUTPUT_CHARS) return null;
  const match = CODEX_VERSION_PATTERN.exec(value.trim());
  return match?.[1] ?? null;
}

function parsedCodexVersion(value: string): ParsedCodexVersion | null {
  const normalized = normalizeCodexVersion(value);
  if (!normalized) return null;
  const withoutBuild = normalized.split('+', 1)[0]!;
  const prereleaseSeparator = withoutBuild.indexOf('-');
  const coreValue =
    prereleaseSeparator === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseSeparator);
  const prereleaseValue =
    prereleaseSeparator === -1 ? undefined : withoutBuild.slice(prereleaseSeparator + 1);
  const core = coreValue?.split('.').map(Number);
  if (
    core?.length !== 3 ||
    core.some(component => !Number.isSafeInteger(component) || component < 0)
  ) {
    return null;
  }
  return {
    core: core as [number, number, number],
    prerelease: prereleaseValue ? prereleaseValue.split('.') : [],
  };
}

export function compareCodexVersions(leftValue: string, rightValue: string): number {
  const left = parsedCodexVersion(leftValue);
  const right = parsedCodexVersion(rightValue);
  if (!left || !right) return leftValue.localeCompare(rightValue, undefined, { numeric: true });
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      if (leftIdentifier === rightIdentifier) return 0;
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

export function codexAppExecutableCandidatePaths(
  options: Pick<CodexExecutableCandidateOptions, 'env' | 'homedir' | 'platform'> = {},
): string[] {
  const env = options.env ?? process.env;
  const home = (options.homedir ?? os.homedir)();
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    return ['/Applications', path.join(home, 'Applications')].flatMap(root =>
      ['ChatGPT.app', 'Codex.app'].flatMap(app => {
        const resources = path.join(root, app, 'Contents', 'Resources');
        return [
          path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
          path.join(resources, 'codex'),
        ];
      }),
    );
  }
  if (platform === 'win32') {
    const localPrograms = path.join(
      env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      'Programs',
    );
    const roots = [localPrograms, env.ProgramFiles, env['ProgramFiles(x86)']].filter(
      (root): root is string => typeof root === 'string' && root.length > 0,
    );
    return roots.flatMap(root =>
      ['ChatGPT', 'Codex'].map(app => path.join(root, app, 'resources', 'codex.exe')),
    );
  }
  return [];
}

function isIdeBundledCodexPath(candidate: string, home: string): boolean {
  const resolvedCandidates = [path.resolve(candidate)];
  try {
    resolvedCandidates.push(fs.realpathSync(candidate));
  } catch {
    // Missing candidates are filtered after discovery.
  }
  return ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].some(directory => {
    const extensionsRoot = `${path.join(home, directory, 'extensions')}${path.sep}`;
    return resolvedCandidates.some(resolved => resolved.startsWith(extensionsRoot));
  });
}

export function codexExecutableCandidatePaths(
  options: CodexExecutableCandidateOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const home = (options.homedir ?? os.homedir)();
  const platform = options.platform ?? process.platform;
  const executableName = platform === 'win32' ? 'codex.cmd' : 'codex';
  return agentExecutableCandidatePaths({
    executableNames: [executableName],
    configuredPath: env.MEARL_CODEX_PATH,
    env,
    home,
    platform,
    processExecPath: options.processExecPath,
    readdirSync: options.readdirSync,
    extraUserCandidates: codexAppExecutableCandidatePaths({
      env,
      homedir: () => home,
      platform,
    }),
  }).filter(
    candidate => candidate === env.MEARL_CODEX_PATH || !isIdeBundledCodexPath(candidate, home),
  );
}

function codexPackageVersion(executable: string): string | null {
  const packageFiles: string[] = [];
  try {
    const resolved = fs.realpathSync(executable);
    if (resolved.split(path.sep).includes('node_modules')) {
      let directory = path.dirname(resolved);
      for (let depth = 0; depth < 6; depth += 1) {
        packageFiles.push(path.join(directory, 'package.json'));
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  } catch {
    // The executable resolver reports inaccessible candidates separately.
  }
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    packageFiles.push(
      path.join(path.dirname(executable), 'node_modules', '@openai', 'codex', 'package.json'),
    );
  }
  for (const packageFile of packageFiles) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === '@openai/codex') {
        const version = normalizeCodexVersion(manifest.version);
        if (version) return version;
      }
    } catch {
      // Continue to other package locations, then fall back to the executable.
    }
  }
  return null;
}

function codexExecutableVersion(executable: string): Promise<string | null> {
  const packageVersion = codexPackageVersion(executable);
  if (packageVersion) return Promise.resolve(packageVersion);
  return new Promise(resolve => {
    let settled = false;
    let output = '';
    const launch = agentSpawnCommand(executable, ['--version']);
    const child = spawn(launch.command, launch.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: createAgentChildEnv(),
    });
    const finish = (version: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(version);
    };
    const capture = (chunk: Buffer): void => {
      const remaining = MAX_VERSION_OUTPUT_CHARS - output.length;
      if (remaining > 0) output += chunk.toString('utf8').slice(0, remaining);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', () => finish(null));
    child.once('exit', code => finish(code === 0 ? normalizeCodexVersion(output) : null));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, PROBE_TIMEOUT_MS);
  });
}

function codexModelInfo(value: unknown): AgentChatModelInfo | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().slice(0, MAX_MODEL_CHARS);
  return id ? { id } : undefined;
}

function fullAccessWithApprovals() {
  return {
    sandbox: 'danger-full-access',
    approvalPolicy: 'untrusted',
  } as const;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function codexSkillScope(value: unknown): AgentInstalledSkillScope {
  if (value === 'user') return 'global';
  if (value === 'repo') return 'project';
  if (value === 'system' || value === 'admin') return value;
  return 'unknown';
}

function userMessageText(item: any): string {
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .flatMap((part: any) =>
      part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n');
}

function userMessageImageCount(item: any): number {
  if (!Array.isArray(item?.content)) return 0;
  return item.content.filter((part: any) => part?.type === 'image' || part?.type === 'localImage')
    .length;
}

function threadHistoryEvents(thread: any): AgentProviderEvent[] {
  if (!Array.isArray(thread?.turns)) return [];
  const events: AgentProviderEvent[] = [];
  for (const turn of thread.turns.slice(-100)) {
    if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue;
    const timestamp = timestampMs(turn.completedAt ?? turn.startedAt);
    for (const item of turn.items) {
      if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') continue;
      if (item.type === 'userMessage') {
        const text = userMessageText(item);
        const imageCount = userMessageImageCount(item);
        if (text || imageCount > 0) {
          events.push({
            kind: 'lifecycle',
            method: 'chat/userMessage',
            params: { text, ...(imageCount > 0 ? { imageCount } : {}) },
            ...(timestamp !== undefined ? { timestamp } : {}),
          });
        }
        continue;
      }
      events.push({
        kind: 'notification',
        method: 'item/completed',
        params: { turnId: turn.id, item },
        ...(timestamp !== undefined ? { timestamp } : {}),
      });
    }
  }
  return events;
}

export function codexThreadUrl(providerSessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(providerSessionId)) {
    throw new Error('Codex returned an invalid thread id');
  }
  return `codex://threads/${providerSessionId}`;
}

export function codexWorkspaceUrl(directory: string): string {
  return `codex://threads/new?path=${encodeURIComponent(directory)}`;
}

export function externalOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

function openExternalUrl(url: string): Promise<void> {
  const { command, args } = externalOpenCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', error => {
      reject(new Error(`Unable to open Codex App: ${error.message}`));
    });
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error('Unable to open Codex App. Make sure it is installed.'));
    });
  });
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = 'codex';

  private process: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private lifecycle = 0;
  private modelRuntime?: PluginModelDiagnostic['runtime'];
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private listeners = new Set<(event: AgentProviderEvent) => void>();
  private knownThreadIds = new Set<string>();
  private sessionModels = new Map<string, AgentChatModelInfo>();
  private readonly executableResolver: AgentExecutableResolver;

  constructor(
    private readonly log: (...args: any[]) => void,
    private readonly clientVersion: string,
    private readonly mearlSocketPath?: string,
  ) {
    this.executableResolver = new AgentExecutableResolver({
      candidates: () => this.resolveExecutableCandidates(),
      probe: executable => this.probeExecutable(executable),
      getVersion: executable => this.readExecutableVersion(executable),
      compareVersions: compareCodexVersions,
      preferred: executable => executable === process.env.MEARL_CODEX_PATH,
      notFoundError: CODEX_NOT_FOUND_ERROR,
      unusableError: 'Codex candidates were found, but none supports app-server.',
      onFailure: (executable, error) => {
        this.log('[Codex] Skipping unusable runtime:', executable, error);
      },
      onSelection: (executable, version) => {
        this.modelRuntime = {
          executable,
          ...(version ? { version } : {}),
          selection: executable === process.env.MEARL_CODEX_PATH ? 'explicit' : 'automatic',
          started: false,
        };
        this.modelDiagnostic({ runtime: this.modelRuntime });
        this.log(
          '[Codex] Selected runtime:',
          executable,
          version
            ? `(version ${version})`
            : executable === process.env.MEARL_CODEX_PATH
              ? '(explicitly configured)'
              : '(version unavailable)',
        );
      },
    });
  }

  async getDescriptor(): Promise<AgentChatProviderDescriptor> {
    const { error } = await this.resolveExecutable();
    return {
      id: this.id,
      name: 'Codex',
      available: error === null,
      capabilities: {
        streaming: true,
        resume: true,
        listSessions: true,
        refreshHistory: true,
        imageInput: true,
        interrupt: true,
        requests: true,
      },
      ...(error ? { error } : {}),
      setup: {
        installCommand: 'npm install -g @openai/codex',
        loginCommand: 'codex login',
        docsUrl: 'https://developers.openai.com/codex/cli',
      },
    };
  }

  async prepare(): Promise<void> {
    await this.ensureStarted();
  }

  async listModels(): Promise<PluginModelOption[]> {
    await this.ensureStarted();
    const models = new Map<string, PluginModelOption>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const result = await this.request('model/list', {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result?.data)) throw new Error('Invalid Codex model list');
      for (const value of result.data) {
        const id = value?.model ?? value?.id;
        if (value?.hidden || typeof id !== 'string' || !id || id.length > 256 || models.has(id))
          continue;
        const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
        const reasoningEfforts = Array.isArray(value.supportedReasoningEfforts)
          ? efforts.filter(effort =>
              value.supportedReasoningEfforts.some(
                (option: any) => option?.reasoningEffort === effort,
              ),
            )
          : undefined;
        models.set(id, {
          id,
          displayName: typeof value.displayName === 'string' ? value.displayName.slice(0, 256) : id,
          ...(typeof value.description === 'string'
            ? { description: value.description.slice(0, 2000) }
            : {}),
          isDefault: value.isDefault === true,
          ...(reasoningEfforts ? { reasoningEfforts } : {}),
          ...(efforts.includes(value.defaultReasoningEffort)
            ? { defaultReasoningEffort: value.defaultReasoningEffort }
            : {}),
        });
        if (models.size >= 200) break;
      }
      if (!result.nextCursor || models.size >= 200) break;
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor))
        throw new Error('Invalid Codex model cursor');
      cursor = result.nextCursor;
      cursors.add(result.nextCursor);
    }
    return [...models.values()];
  }

  onEvent(listener: (event: AgentProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listSessions(
    options: AgentProviderListSessionsOptions,
  ): Promise<AgentProviderListSessionsResult> {
    await this.ensureStarted();
    const result = await this.request('thread/list', {
      cursor: options.cursor ?? null,
      limit: options.limit,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const sessions = Array.isArray(result?.data)
      ? result.data.flatMap((thread: any) => {
          if (!thread || typeof thread.id !== 'string') return [];
          const title =
            typeof thread.name === 'string' && thread.name.trim()
              ? thread.name.trim()
              : typeof thread.preview === 'string' && thread.preview.trim()
                ? thread.preview.trim()
                : undefined;
          const cwd = typeof thread.cwd === 'string' ? thread.cwd : undefined;
          const updatedAt = timestampMs(thread.recencyAt ?? thread.updatedAt);
          const ephemeral = typeof thread.ephemeral === 'boolean' ? thread.ephemeral : undefined;
          return [
            {
              providerSessionId: thread.id,
              ...(title ? { title } : {}),
              ...(cwd ? { cwd } : {}),
              ...(updatedAt !== undefined ? { updatedAt } : {}),
              ...(ephemeral !== undefined ? { ephemeral } : {}),
            },
          ];
        })
      : [];
    return {
      sessions,
      ...(typeof result?.nextCursor === 'string' ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listSkills(cwd?: string): Promise<AgentInstalledSkill[]> {
    await this.ensureStarted();
    const result = await this.request('skills/list', {
      cwds: [cwd || os.homedir()],
      forceReload: true,
    });
    if (!Array.isArray(result?.data)) return [];
    return result.data.flatMap((entry: any) =>
      Array.isArray(entry?.skills)
        ? entry.skills.flatMap((skill: any) => {
            if (!skill || typeof skill.name !== 'string' || typeof skill.path !== 'string') {
              return [];
            }
            return [
              {
                name: skill.name,
                path: skill.path,
                scope: codexSkillScope(skill.scope),
              },
            ];
          })
        : [],
    );
  }

  async startSession(options: AgentProviderSessionOptions): Promise<string> {
    await this.ensureStarted();
    const cwd = options.cwd || process.env.MEARL_AGENT_CWD || os.homedir();
    const config = options.modelExecution ? await this.modelExecutionConfig() : undefined;
    const result = await this.request('thread/start', {
      ...(config ? { config } : {}),
      cwd,
      ...(options.modelId ? { model: options.modelId } : {}),
      ...(options.readOnly
        ? { sandbox: 'read-only', approvalPolicy: 'never' }
        : fullAccessWithApprovals()),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('Codex did not return a thread id');
    }
    if (options.modelExecution) this.modelDiagnostic({ threadRestrictionsAccepted: true });
    this.knownThreadIds.add(threadId);
    const model = codexModelInfo(result?.model);
    if (model) this.sessionModels.set(threadId, model);
    return threadId;
  }

  private async modelExecutionConfig(): Promise<Record<string, unknown>> {
    const result = await this.request('config/read', { includeLayers: false });
    const config = result?.config;
    if (!config || typeof config !== 'object')
      throw new Error('Codex cannot report its effective execution configuration');
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const store = config.cli_auth_credentials_store;
    this.modelDiagnostic({
      configuration: {
        source: process.env.CODEX_HOME ? 'environment' : 'default',
        home,
        filePresent: fs.existsSync(path.join(home, 'config.toml')),
        ...(typeof config.model_provider === 'string'
          ? { baseProvider: config.model_provider }
          : {}),
        ...(typeof store === 'string'
          ? {
              credentialStore: ['file', 'keyring', 'auto', 'ephemeral'].includes(store)
                ? (store as 'file' | 'keyring' | 'auto' | 'ephemeral')
                : 'unknown',
            }
          : {}),
      },
    });
    const mcp = config.mcp_servers ?? {};
    const apps = config.apps ?? {};
    if (
      typeof mcp !== 'object' ||
      Array.isArray(mcp) ||
      typeof apps !== 'object' ||
      Array.isArray(apps)
    )
      throw new Error('Invalid Codex model tool configuration');
    return configOverride({
      mcp_servers: Object.fromEntries(
        Object.keys(mcp).map(name => [name, { ...mcp[name], enabled: false }]),
      ),
      apps: Object.fromEntries(
        ['_default', ...Object.keys(apps)].map(name => [
          name,
          { ...(apps[name] ?? {}), enabled: false },
        ]),
      ),
      web_search: 'disabled',
      features: {
        apps: false,
        plugins: false,
        hooks: false,
        codex_hooks: false,
        plugin_hooks: false,
        multi_agent: false,
        multi_agent_v2: false,
        collab: false,
        computer_use: false,
        browser_use: false,
        image_generation: false,
        imagegenext: false,
        memory_tool: false,
        memories: false,
        skill_search: false,
      },
    }) as Record<string, unknown>;
  }

  async resumeSession(
    providerSessionId: string,
    options: AgentProviderSessionOptions,
  ): Promise<AgentProviderResumeResult> {
    await this.ensureStarted();
    const result = await this.request('thread/resume', {
      threadId: providerSessionId,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...fullAccessWithApprovals(),
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('Codex did not return a resumed thread id');
    }
    this.knownThreadIds.add(threadId);
    const model = codexModelInfo(result?.model);
    if (model) this.sessionModels.set(threadId, model);
    return {
      providerSessionId: threadId,
      history: threadHistoryEvents(result.thread),
      historyComplete: true,
    };
  }

  getSessionModel(providerSessionId: string): AgentChatModelInfo | undefined {
    const model = this.sessionModels.get(providerSessionId);
    return model ? { ...model } : undefined;
  }

  async sendMessage(
    providerSessionId: string,
    message: string,
    images: AgentChatImageInput[] = [],
    options: AgentProviderTurnOptions = {},
  ): Promise<{ turnId: string }> {
    await this.ensureStarted();
    const result = await this.request('turn/start', {
      threadId: providerSessionId,
      input: [
        ...(message ? [{ type: 'text', text: message, text_elements: [] }] : []),
        ...images.map(image => ({
          type: 'image',
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
      summary: options.reasoningSummary ?? 'detailed',
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      ...(options.modelExecution
        ? { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
        : {}),
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
    });
    const turnId = result?.turn?.id;
    if (typeof turnId !== 'string' || !turnId) {
      throw new Error('Codex did not return a turn id');
    }
    if (options.modelExecution) this.modelDiagnostic({ turnRestrictionsAccepted: true });
    return { turnId };
  }

  async interrupt(providerSessionId: string, turnId: string): Promise<void> {
    await this.ensureStarted();
    await this.request('turn/interrupt', { threadId: providerSessionId, turnId });
  }

  async closeSession(providerSessionId: string): Promise<void> {
    this.knownThreadIds.delete(providerSessionId);
    this.sessionModels.delete(providerSessionId);
    if (!this.initialized) return;
    void this.request('thread/unsubscribe', { threadId: providerSessionId }).catch(error => {
      this.log('[Codex] Unable to unsubscribe thread:', String(error));
    });
  }

  openSession(providerSessionId: string): Promise<void> {
    return openExternalUrl(codexThreadUrl(providerSessionId));
  }

  openWorkspace(cwd: string): Promise<void> {
    return openExternalUrl(codexWorkspaceUrl(cwd));
  }

  respondToRequest(requestId: string | number, result: unknown): void {
    this.write({ id: requestId, result });
  }

  dispose(): void {
    this.lifecycle++;
    this.rejectPending(new Error('Codex provider disposed'));
    const child = this.process;
    this.process = null;
    this.initialized = false;
    this.startPromise = null;
    this.sessionModels.clear();
    this.executableResolver.reset();
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed && this.initialized) return;
    if (this.startPromise) return this.startPromise;

    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    const pending = this.start();
    this.startPromise = pending;
    try {
      await pending;
    } catch (error) {
      if (this.startPromise === pending) this.startPromise = null;
      throw error;
    }
  }

  private async start(): Promise<void> {
    const lifecycle = this.lifecycle;
    const resolution = await this.resolveExecutable();
    if (lifecycle !== this.lifecycle) throw new Error('Codex provider disposed during startup');
    if (resolution.executable === null) {
      throw new Error(resolution.error);
    }
    const { executable } = resolution;

    const launch = agentSpawnCommand(executable, ['app-server', '--listen', 'stdio://']);
    const childEnv = createAgentChildEnv();
    if (this.mearlSocketPath) childEnv.MEARL_SOCKET_PATH = this.mearlSocketPath;
    const child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv,
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => this.handleLine(line));
    child.stderr.on('data', chunk => {
      const message = chunk.toString('utf8').trim();
      if (message) this.log('[Codex]', message);
    });
    child.once('error', error => this.handleExit(child, error));
    child.once('exit', (code, signal) => {
      this.handleExit(
        child,
        new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)})`),
      );
    });

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'mearl',
          title: 'Mearl',
          version: this.clientVersion,
        },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: 'initialized', params: {} });
      this.initialized = true;
      if (this.modelRuntime) {
        this.modelRuntime = { ...this.modelRuntime, started: true };
        this.modelDiagnostic({ runtime: this.modelRuntime });
      }
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      this.handleExit(child, startupError);
      if (!child.killed) child.kill('SIGTERM');
      throw startupError;
    }
  }

  private handleLine(line: string): void {
    let message: CodexMessage;
    try {
      message = JSON.parse(line) as CodexMessage;
    } catch {
      this.log('[Codex] Invalid JSONL message:', line);
      return;
    }

    if (message.method) {
      const isRequest = message.id !== undefined;
      const providerSessionId = this.extractThreadId(message.params);
      if (!isRequest && providerSessionId && message.method === 'thread/settings/updated') {
        const model = codexModelInfo(message.params?.threadSettings?.model);
        if (model) {
          this.sessionModels.set(providerSessionId, model);
          this.emit({
            providerSessionId,
            kind: 'notification',
            method: 'session/model/updated',
            params: { model },
          });
        }
      } else if (!isRequest && providerSessionId && message.method === 'model/rerouted') {
        const model = codexModelInfo(message.params?.toModel);
        if (model) {
          this.emit({
            providerSessionId,
            kind: 'notification',
            method: 'session/activeModel/updated',
            params: { model },
          });
        }
      }
      this.emit({
        providerSessionId,
        kind: isRequest ? 'request' : message.method === 'error' ? 'error' : 'notification',
        method: message.method,
        params: message.params ?? {},
        ...(isRequest ? { requestId: message.id } : {}),
      });
      return;
    }

    if (typeof message.id !== 'number') return;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `Codex error ${message.error.code ?? ''}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: CodexMessage): void {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error('Codex app-server is not running');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.process = null;
    this.initialized = false;
    this.startPromise = null;
    this.executableResolver.reset();
    this.rejectPending(error);
    for (const providerSessionId of this.knownThreadIds) {
      this.emit({
        providerSessionId,
        kind: 'error',
        method: 'provider/exited',
        params: { message: error.message },
      });
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private modelDiagnostic(metadata: PluginModelDiagnostic): void {
    this.emit({ kind: 'notification', method: 'provider/model/diagnostic', params: metadata });
  }

  private emit(event: AgentProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private extractThreadId(params: any): string | undefined {
    const candidates = [
      params?.threadId,
      params?.conversationId,
      params?.thread?.id,
      params?.turn?.threadId,
    ];
    return candidates.find(value => typeof value === 'string');
  }

  private probeExecutable(executable: string): Promise<string | null> {
    return probeAgentExecutable(executable, {
      args: ['app-server', '--help'],
      timeoutMs: PROBE_TIMEOUT_MS,
      timeoutError: 'Timed out while checking Codex app-server availability.',
      startError: error => `Failed to start Codex: ${error.message}`,
      exitError: code => `Codex app-server check exited with code ${String(code)}`,
    });
  }

  private readExecutableVersion(executable: string): Promise<string | null> {
    return codexExecutableVersion(executable);
  }

  private resolveExecutable(): Promise<AgentExecutableResolution> {
    return this.executableResolver.resolve();
  }

  private resolveExecutableCandidates(): string[] {
    return executableFileCandidates(codexExecutableCandidatePaths());
  }
}
