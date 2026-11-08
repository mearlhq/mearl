import type { AgentInstalledSkill } from '@mearl/browser-core/agentSkills';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type * as acp from '@agentclientprotocol/sdk';
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
} from '@mearl/agent-runtime';
import {
  AgentExecutableResolver,
  executableFileCandidates,
  probeAgentExecutable,
  qoderExecutableCandidatePaths,
  type AgentExecutableResolution,
} from '@mearl/agent-runtime/execution';
import { agentSpawnCommand, createAgentChildEnv } from '@mearl/agent-runtime/execution';

export { qoderExecutableCandidatePaths } from '@mearl/agent-runtime/execution';

interface PendingPermission {
  providerSessionId: string;
  resolve: (response: acp.RequestPermissionResponse) => void;
}

interface ActiveTurn {
  id: string;
  assistantItemId: string;
  assistantText: string;
  reasoningItemId: string;
  reasoningText: string;
  reasoningStarted: boolean;
  planItemId: string;
  toolTitles: Map<string, string>;
}

interface QoderSessionState extends AgentProviderSessionOptions {
  cwd: string;
  instructionsSent: boolean;
  model?: AgentChatModelInfo;
  activeTurn?: ActiveTurn;
}

interface QoderHistoryCapture {
  providerSessionId: string;
  events: AgentProviderEvent[];
  messageEvents: Map<string, AgentProviderEvent>;
  toolEvents: Map<string, AgentProviderEvent>;
  lastAnonymousMessage?: { role: string; key: string };
  nextId: number;
  planEvent?: AgentProviderEvent;
}

const PROBE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MODEL_CHARS = 256;
const QODER_NOT_FOUND_ERROR = 'Qoder CLI was not found. Install Qoder CLI or set MEARL_QODER_PATH.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentText(content: acp.ContentBlock): string | null {
  return content.type === 'text' ? content.text : null;
}

function planText(entries: acp.PlanEntry[]): string {
  return entries
    .map(entry => {
      const marker =
        entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '→' : '•';
      return `${marker} ${entry.content}`;
    })
    .join('\n');
}

export function qoderModelInfo(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): AgentChatModelInfo | undefined {
  const modelOption = configOptions?.find(
    option => option.category === 'model' && option.type === 'select',
  );
  if (!modelOption || typeof modelOption.currentValue !== 'string') return undefined;
  const id = modelOption.currentValue.trim().slice(0, MAX_MODEL_CHARS);
  if (!id) return undefined;
  const options = modelOption.options.flatMap(option =>
    'options' in option ? option.options : [option],
  );
  const displayName = options
    .find(option => option.value === modelOption.currentValue)
    ?.name.trim()
    .slice(0, MAX_MODEL_CHARS);
  return {
    id,
    ...(displayName && displayName !== id ? { displayName } : {}),
  };
}

export function parseQoderSkillsList(
  output: string,
  cwd: string,
  home: string = os.homedir(),
): AgentInstalledSkill[] {
  const skills: AgentInstalledSkill[] = [];
  let current:
    | {
        name: string;
        builtIn: boolean;
        path?: string;
      }
    | undefined;
  const finish = (): void => {
    if (!current) return;
    const skillPath = current.path || (current.builtIn ? 'bundled' : '');
    const relativeToCwd =
      skillPath && path.isAbsolute(skillPath) ? path.relative(cwd, skillPath) : '';
    const inProject =
      Boolean(relativeToCwd) &&
      relativeToCwd !== '..' &&
      !relativeToCwd.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeToCwd);
    skills.push({
      name: current.name,
      path: skillPath,
      scope: current.builtIn ? 'built-in' : cwd !== home && inProject ? 'project' : 'global',
    });
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    const heading = /^(\S+)\s+\[(Enabled|Disabled)\](?:\s+\[Built-in\])?\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      finish();
      current = {
        name: heading[1],
        builtIn: line.includes('[Built-in]'),
      };
      continue;
    }
    if (!current) continue;
    const skillPath = /^\s+Location:\s*(.*)$/.exec(line)?.[1];
    if (skillPath !== undefined) current.path = skillPath;
  }
  finish();
  return skills;
}

function isPermissionResponse(value: unknown): value is acp.RequestPermissionResponse {
  if (!value || typeof value !== 'object') return false;
  const outcome = (value as acp.RequestPermissionResponse).outcome;
  if (!outcome || typeof outcome !== 'object') return false;
  if (outcome.outcome === 'cancelled') return true;
  return outcome.outcome === 'selected' && typeof outcome.optionId === 'string';
}

export function qoderInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'npm install -g @qoder-ai/qodercli'
    : 'curl -fsSL https://qoder.com/install | bash';
}

function sessionOptions(options: AgentProviderSessionOptions): QoderSessionState {
  const cwd = path.resolve(options.cwd || os.homedir());
  return {
    ...options,
    cwd,
    instructionsSent: false,
  };
}

function parsedTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function historyItemId(
  capture: QoderHistoryCapture,
  kind: string,
  sourceId?: string | null,
): string {
  if (sourceId) return `qoder_history_${kind}_${sourceId}`;
  const id = `qoder_history_${kind}_${capture.nextId}`;
  capture.nextId += 1;
  return id;
}

function historyMessageKey(
  capture: QoderHistoryCapture,
  role: string,
  messageId?: string | null,
): string {
  if (messageId) {
    capture.lastAnonymousMessage = undefined;
    return `${role}:${messageId}`;
  }
  if (capture.lastAnonymousMessage?.role === role) return capture.lastAnonymousMessage.key;
  const key = `${role}:anonymous:${capture.nextId}`;
  capture.nextId += 1;
  capture.lastAnonymousMessage = { role, key };
  return key;
}

function captureHistoryMessage(
  capture: QoderHistoryCapture,
  role: 'user' | 'agent' | 'reasoning',
  update: Extract<
    acp.SessionUpdate,
    { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk' }
  >,
): void {
  const text = contentText(update.content);
  const imageCount = update.content.type === 'image' ? 1 : 0;
  if (!text && imageCount === 0) return;

  const key = historyMessageKey(capture, role, update.messageId);
  const existing = capture.messageEvents.get(key);
  if (existing) {
    if (role === 'user') {
      const params = existing.params as { text: string; imageCount?: number };
      if (text) params.text += text;
      if (imageCount > 0) params.imageCount = (params.imageCount || 0) + imageCount;
    } else if (role === 'agent') {
      const params = existing.params as { item: { text: string } };
      if (text) params.item.text += text;
    } else if (text) {
      const params = existing.params as { item: { summary: string[] } };
      params.item.summary[0] = `${params.item.summary[0] || ''}${text}`;
    }
    return;
  }

  const itemId = historyItemId(capture, role, update.messageId);
  const event: AgentProviderEvent =
    role === 'user'
      ? {
          providerSessionId: capture.providerSessionId,
          kind: 'lifecycle',
          method: 'chat/userMessage',
          params: { text: text || '', ...(imageCount > 0 ? { imageCount } : {}) },
        }
      : {
          providerSessionId: capture.providerSessionId,
          kind: 'notification',
          method: 'item/completed',
          params: {
            item: {
              id: itemId,
              type: role === 'agent' ? 'agentMessage' : 'reasoning',
              ...(role === 'agent' ? { text: text || '' } : { summary: [text || ''] }),
            },
          },
        };
  capture.messageEvents.set(key, event);
  capture.events.push(event);
}

function captureHistoryUpdate(capture: QoderHistoryCapture, update: acp.SessionUpdate): void {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      captureHistoryMessage(capture, 'user', update);
      return;
    case 'agent_message_chunk':
      captureHistoryMessage(capture, 'agent', update);
      return;
    case 'agent_thought_chunk':
      captureHistoryMessage(capture, 'reasoning', update);
      return;
    case 'tool_call':
    case 'tool_call_update': {
      capture.lastAnonymousMessage = undefined;
      const completed = update.status === 'completed' || update.status === 'failed';
      const existing = capture.toolEvents.get(update.toolCallId);
      const existingItem = existing
        ? (existing.params as { item: { tool?: string; kind?: acp.ToolKind } }).item
        : undefined;
      const item = {
        id: historyItemId(capture, 'tool', update.toolCallId),
        type: 'dynamicToolCall',
        namespace: 'qoder',
        tool: update.title || existingItem?.tool || update.toolCallId,
        status: update.status || (completed ? 'completed' : 'inProgress'),
        kind: update.kind || existingItem?.kind,
      };
      if (existing) {
        existing.method = completed ? 'item/completed' : 'item/started';
        existing.params = { item };
      } else {
        const event: AgentProviderEvent = {
          providerSessionId: capture.providerSessionId,
          kind: 'notification',
          method: completed ? 'item/completed' : 'item/started',
          params: { item },
        };
        capture.toolEvents.set(update.toolCallId, event);
        capture.events.push(event);
      }
      return;
    }
    case 'plan': {
      capture.lastAnonymousMessage = undefined;
      const item = {
        id: historyItemId(capture, 'plan', 'current'),
        type: 'plan',
        text: planText(update.entries),
      };
      if (capture.planEvent) {
        capture.planEvent.params = { item };
      } else {
        capture.planEvent = {
          providerSessionId: capture.providerSessionId,
          kind: 'notification',
          method: 'item/completed',
          params: { item },
        };
        capture.events.push(capture.planEvent);
      }
      return;
    }
    default:
      capture.lastAnonymousMessage = undefined;
  }
}

export class QoderAgentProvider implements AgentProvider {
  readonly id = 'qoder';

  private process: ChildProcessWithoutNullStreams | null = null;
  private sdk: typeof import('@agentclientprotocol/sdk') | undefined;
  private connection: acp.ClientConnection | null = null;
  private context: acp.ClientContext | null = null;
  private initializeResponse: acp.InitializeResponse | null = null;
  private startPromise: Promise<void> | null = null;
  private lifecycle = 0;
  private listeners = new Set<(event: AgentProviderEvent) => void>();
  private sessions = new Map<string, QoderSessionState>();
  private pendingPermissions = new Map<string | number, PendingPermission>();
  private historyCaptures = new Map<string, QoderHistoryCapture>();
  private nextTurnId = 1;
  private readonly executableResolver: AgentExecutableResolver;

  constructor(
    private readonly log: (...args: any[]) => void,
    private readonly clientVersion: string,
  ) {
    this.executableResolver = new AgentExecutableResolver({
      candidates: () => this.resolveExecutableCandidates(),
      probe: executable => this.probeExecutable(executable),
      notFoundError: QODER_NOT_FOUND_ERROR,
      unusableError: 'Qoder CLI candidates were found, but none is usable.',
      onFailure: (executable, error) => {
        this.log('[Qoder] Skipping unusable CLI:', executable, error);
      },
    });
  }

  async getDescriptor(): Promise<AgentChatProviderDescriptor> {
    const { error } = await this.resolveExecutable();
    return {
      id: this.id,
      name: 'Qoder',
      available: error === null,
      capabilities: {
        streaming: true,
        resume: true,
        listSessions: 'runtime',
        refreshHistory: false,
        imageInput: 'runtime',
        interrupt: true,
        requests: true,
      },
      ...(error ? { error } : {}),
      setup: {
        installCommand: qoderInstallCommand(),
        loginCommand: 'qodercli',
        docsUrl: 'https://docs.qoder.com/en/cli/quick-start',
      },
    };
  }

  async prepare(): Promise<void> {
    await this.ensureStarted();
  }

  onEvent(listener: (event: AgentProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listSessions(
    options: AgentProviderListSessionsOptions,
  ): Promise<AgentProviderListSessionsResult> {
    await this.ensureStarted();
    if (!this.initializeResponse?.agentCapabilities?.sessionCapabilities?.list) {
      throw new Error('This Qoder CLI version cannot list existing ACP sessions');
    }
    const result = await this.withTimeout(
      this.getContext().request(this.sdk!.methods.agent.session.list, {
        cursor: options.cursor ?? null,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      }),
      'Qoder session list',
    );
    return {
      sessions: result.sessions.map(session => {
        const updatedAt = parsedTimestamp(session.updatedAt);
        return {
          providerSessionId: session.sessionId,
          ...(session.title ? { title: session.title } : {}),
          ...(session.cwd ? { cwd: session.cwd } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        };
      }),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listSkills(cwd?: string): Promise<AgentInstalledSkill[]> {
    const resolution = await this.resolveExecutable();
    if (resolution.executable === null) {
      throw new Error(resolution.error);
    }
    const { executable } = resolution;
    const resolvedCwd = cwd || os.homedir();
    const output = await this.runSkillsList(executable, resolvedCwd);
    return parseQoderSkillsList(output, resolvedCwd);
  }

  async startSession(options: AgentProviderSessionOptions): Promise<string> {
    const session = sessionOptions(options);
    await this.ensureStarted();
    const result = await this.withTimeout(
      this.getContext().request(this.sdk!.methods.agent.session.new, {
        cwd: session.cwd,
        mcpServers: [],
      }),
      'Qoder session creation',
    );
    if (!result.sessionId) throw new Error('Qoder did not return a session id');
    const model = qoderModelInfo(result.configOptions);
    if (model) session.model = model;
    this.sessions.set(result.sessionId, session);
    return result.sessionId;
  }

  async resumeSession(
    providerSessionId: string,
    options: AgentProviderSessionOptions,
  ): Promise<AgentProviderResumeResult> {
    const session = sessionOptions(options);
    await this.ensureStarted();
    const capabilities = this.initializeResponse?.agentCapabilities;
    let configOptions: acp.SessionConfigOption[] | null | undefined;
    const historyCapture: QoderHistoryCapture | null = capabilities?.loadSession
      ? {
          providerSessionId,
          events: [],
          messageEvents: new Map(),
          toolEvents: new Map(),
          nextId: 1,
        }
      : null;
    if (historyCapture) this.historyCaptures.set(providerSessionId, historyCapture);
    try {
      if (historyCapture) {
        const result = await this.withTimeout(
          this.getContext().request(this.sdk!.methods.agent.session.load, {
            sessionId: providerSessionId,
            cwd: session.cwd,
            mcpServers: [],
          }),
          'Qoder session load',
        );
        configOptions = result.configOptions;
      } else if (capabilities?.sessionCapabilities?.resume) {
        const result = await this.withTimeout(
          this.getContext().request(this.sdk!.methods.agent.session.resume, {
            sessionId: providerSessionId,
            cwd: session.cwd,
            mcpServers: [],
          }),
          'Qoder session resume',
        );
        configOptions = result.configOptions;
      } else {
        throw new Error('This Qoder CLI version cannot resume an existing ACP session');
      }
    } finally {
      this.historyCaptures.delete(providerSessionId);
    }
    const model = qoderModelInfo(configOptions);
    if (model) session.model = model;
    this.sessions.set(providerSessionId, session);
    return {
      providerSessionId,
      ...(historyCapture ? { history: historyCapture.events, historyComplete: true } : {}),
    };
  }

  getSessionModel(providerSessionId: string): AgentChatModelInfo | undefined {
    const model = this.sessions.get(providerSessionId)?.model;
    return model ? { ...model } : undefined;
  }

  async validateMessageInput(images: AgentChatImageInput[]): Promise<void> {
    if (images.length === 0) return;
    await this.ensureStarted();
    this.assertImageInputSupported();
  }

  async sendMessage(
    providerSessionId: string,
    message: string,
    images: AgentChatImageInput[] = [],
  ): Promise<{ turnId: string }> {
    await this.ensureStarted();
    const session = this.sessions.get(providerSessionId);
    if (!session) throw new Error(`Unknown Qoder session: ${providerSessionId}`);
    if (session.activeTurn) throw new Error('The current Qoder turn has not finished');
    if (images.length > 0) this.assertImageInputSupported();

    const turnId = `qoder_turn_${Date.now()}_${this.nextTurnId++}`;
    const turn: ActiveTurn = {
      id: turnId,
      assistantItemId: `${turnId}_message`,
      assistantText: '',
      reasoningItemId: `${turnId}_reasoning`,
      reasoningText: '',
      reasoningStarted: false,
      planItemId: `${turnId}_plan`,
      toolTitles: new Map(),
    };
    session.activeTurn = turn;

    const prompt =
      !session.instructionsSent && session.developerInstructions
        ? `${session.developerInstructions}\n\nUser request:\n${message}`
        : message;
    const promptContent: acp.ContentBlock[] = [
      ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
      ...images.map(image => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ];
    session.instructionsSent = true;
    this.emit({
      providerSessionId,
      kind: 'notification',
      method: 'turn/started',
      params: { turn: { id: turnId, status: 'inProgress' } },
    });
    void this.runPrompt(providerSessionId, session, turn, promptContent);
    return { turnId };
  }

  async interrupt(providerSessionId: string, _turnId: string): Promise<void> {
    await this.ensureStarted();
    await this.getContext().notify(this.sdk!.methods.agent.session.cancel, {
      sessionId: providerSessionId,
    });
    this.cancelPermissions(providerSessionId);
  }

  async closeSession(providerSessionId: string): Promise<void> {
    const session = this.sessions.get(providerSessionId);
    if (session?.activeTurn && this.context) {
      await this.context
        .notify(this.sdk!.methods.agent.session.cancel, { sessionId: providerSessionId })
        .catch(() => {});
    }
    this.cancelPermissions(providerSessionId);
    this.sessions.delete(providerSessionId);
  }

  respondToRequest(requestId: string | number, result: unknown): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`Unknown Qoder permission request: ${String(requestId)}`);
    if (!isPermissionResponse(result)) {
      throw new Error('Invalid Qoder permission response');
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve(result);
    this.emit({
      providerSessionId: pending.providerSessionId,
      kind: 'notification',
      method: 'serverRequest/resolved',
      params: { requestId },
    });
  }

  dispose(): void {
    this.lifecycle++;
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();
    this.historyCaptures.clear();
    this.sessions.clear();
    const connection = this.connection;
    const child = this.process;
    this.process = null;
    this.connection = null;
    this.context = null;
    this.initializeResponse = null;
    this.startPromise = null;
    this.executableResolver.reset();
    connection?.close(new Error('Qoder provider disposed'));
    if (child && !child.killed) child.kill('SIGTERM');
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed && this.context) return;
    if (this.startPromise) return this.startPromise;

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
    if (lifecycle !== this.lifecycle) throw new Error('Qoder provider disposed during startup');
    if (resolution.executable === null) {
      throw new Error(resolution.error);
    }
    const { executable } = resolution;

    const sdk = await import('@agentclientprotocol/sdk');
    if (lifecycle !== this.lifecycle) throw new Error('Qoder provider disposed during startup');
    this.sdk = sdk;
    const launch = agentSpawnCommand(executable, ['--acp']);
    const child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: createAgentChildEnv(),
    });
    this.process = child;
    child.stderr.on('data', chunk => {
      const message = chunk.toString('utf8').trim();
      if (message) this.log('[Qoder]', message);
    });
    child.once('error', error => this.handleExit(child, error));
    child.once('exit', (code, signal) => {
      this.handleExit(
        child,
        new Error(`Qoder ACP exited (code=${String(code)}, signal=${String(signal)})`),
      );
    });

    const stream = sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const app = sdk
      .client({ name: 'mearl' })
      .onRequest(this.sdk!.methods.client.session.requestPermission, context =>
        this.handlePermissionRequest(context.requestId, context.params),
      )
      .onNotification(this.sdk!.methods.client.session.update, context => {
        this.handleSessionUpdate(context.params);
      });
    const connection = app.connect(stream);
    this.connection = connection;
    this.context = connection.agent;

    try {
      const response = await this.withTimeout(
        connection.agent.request(this.sdk!.methods.agent.initialize, {
          protocolVersion: sdk.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: 'mearl',
            title: 'Mearl',
            version: this.clientVersion,
          },
        }),
        'Qoder ACP initialization',
      );
      if (lifecycle !== this.lifecycle || this.process !== child)
        throw new Error('Qoder provider disposed during startup');
      this.initializeResponse = response;
    } catch (error) {
      if (this.process === child) {
        this.process = null;
        this.connection = null;
        this.context = null;
        this.executableResolver.reset();
      }
      connection.close(error);
      if (!child.killed) child.kill('SIGTERM');
      throw new Error(
        `Qoder ACP failed to initialize. Start "qodercli", enter "/login", and try again: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async runPrompt(
    providerSessionId: string,
    session: QoderSessionState,
    turn: ActiveTurn,
    prompt: acp.ContentBlock[],
  ): Promise<void> {
    try {
      const response = await this.getContext().request(this.sdk!.methods.agent.session.prompt, {
        sessionId: providerSessionId,
        prompt,
      });
      if (turn.reasoningStarted) {
        this.emit({
          providerSessionId,
          kind: 'notification',
          method: 'item/completed',
          params: {
            turnId: turn.id,
            item: {
              id: turn.reasoningItemId,
              type: 'reasoning',
              summary: turn.reasoningText ? [turn.reasoningText] : [],
            },
          },
        });
      }
      if (turn.assistantText) {
        this.emit({
          providerSessionId,
          kind: 'notification',
          method: 'item/completed',
          params: {
            turnId: turn.id,
            item: {
              id: turn.assistantItemId,
              type: 'agentMessage',
              text: turn.assistantText,
            },
          },
        });
      }
      if (response.usage) {
        this.emit({
          providerSessionId,
          kind: 'notification',
          method: 'thread/tokenUsage/updated',
          params: { turnId: turn.id, usage: response.usage },
        });
      }
      this.emit({
        providerSessionId,
        kind: 'notification',
        method: 'turn/completed',
        params: {
          turn: {
            id: turn.id,
            status: response.stopReason === 'cancelled' ? 'cancelled' : 'completed',
            stopReason: response.stopReason,
          },
        },
      });
    } catch (error) {
      this.emit({
        providerSessionId,
        kind: 'error',
        method: 'chat/error',
        params: { turnId: turn.id, message: errorMessage(error) },
      });
      this.emit({
        providerSessionId,
        kind: 'notification',
        method: 'turn/completed',
        params: { turn: { id: turn.id, status: 'failed' } },
      });
    } finally {
      if (session.activeTurn === turn) delete session.activeTurn;
    }
  }

  private handleSessionUpdate(notification: acp.SessionNotification): void {
    const historyCapture = this.historyCaptures.get(notification.sessionId);
    if (historyCapture) {
      captureHistoryUpdate(historyCapture, notification.update);
      return;
    }
    const session = this.sessions.get(notification.sessionId);
    const update = notification.update;
    if (update.sessionUpdate === 'config_option_update') {
      const model = qoderModelInfo(update.configOptions);
      if (session) {
        if (model) session.model = model;
        else delete session.model;
      }
      this.emit({
        providerSessionId: notification.sessionId,
        kind: 'notification',
        method: 'session/model/updated',
        params: { model: model ?? null },
      });
      this.emit({
        providerSessionId: notification.sessionId,
        kind: 'notification',
        method: 'qoder/sessionUpdate',
        params: notification,
      });
      return;
    }
    const turn = session?.activeTurn;
    if (!turn) {
      this.emit({
        providerSessionId: notification.sessionId,
        kind: 'notification',
        method: 'qoder/sessionUpdate',
        params: notification,
      });
      return;
    }

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const delta = contentText(update.content);
        if (!delta) return;
        turn.assistantText += delta;
        this.emit({
          providerSessionId: notification.sessionId,
          kind: 'notification',
          method: 'item/agentMessage/delta',
          params: { turnId: turn.id, itemId: turn.assistantItemId, delta },
        });
        return;
      }
      case 'agent_thought_chunk': {
        const delta = contentText(update.content);
        if (!delta) return;
        if (!turn.reasoningStarted) {
          turn.reasoningStarted = true;
          this.emit({
            providerSessionId: notification.sessionId,
            kind: 'notification',
            method: 'item/started',
            params: {
              turnId: turn.id,
              item: { id: turn.reasoningItemId, type: 'reasoning', summary: [] },
            },
          });
        }
        turn.reasoningText += delta;
        this.emit({
          providerSessionId: notification.sessionId,
          kind: 'notification',
          method: 'item/reasoning/summaryTextDelta',
          params: { turnId: turn.id, itemId: turn.reasoningItemId, delta },
        });
        return;
      }
      case 'tool_call':
        turn.toolTitles.set(update.toolCallId, update.title);
        this.emitToolUpdate(notification.sessionId, turn, update, update.title);
        return;
      case 'tool_call_update': {
        const title = update.title || turn.toolTitles.get(update.toolCallId) || update.toolCallId;
        turn.toolTitles.set(update.toolCallId, title);
        this.emitToolUpdate(notification.sessionId, turn, update, title);
        return;
      }
      case 'plan': {
        const text = planText(update.entries);
        this.emit({
          providerSessionId: notification.sessionId,
          kind: 'notification',
          method: 'item/completed',
          params: {
            turnId: turn.id,
            item: { id: turn.planItemId, type: 'plan', text },
          },
        });
        return;
      }
      case 'usage_update':
        this.emit({
          providerSessionId: notification.sessionId,
          kind: 'notification',
          method: 'thread/tokenUsage/updated',
          params: { turnId: turn.id, usage: update },
        });
        return;
      default:
        this.emit({
          providerSessionId: notification.sessionId,
          kind: 'notification',
          method: 'qoder/sessionUpdate',
          params: { turnId: turn.id, update },
        });
    }
  }

  private emitToolUpdate(
    providerSessionId: string,
    turn: ActiveTurn,
    update: acp.ToolCall | acp.ToolCallUpdate,
    title: string,
  ): void {
    const completed = update.status === 'completed' || update.status === 'failed';
    this.emit({
      providerSessionId,
      kind: 'notification',
      method: completed ? 'item/completed' : 'item/started',
      params: {
        turnId: turn.id,
        item: {
          id: update.toolCallId,
          type: 'dynamicToolCall',
          namespace: 'qoder',
          tool: title,
          status: update.status || (completed ? 'completed' : 'inProgress'),
          kind: update.kind,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content: update.content,
          locations: update.locations,
        },
      },
    });
  }

  private handlePermissionRequest(
    requestId: acp.JsonRpcId,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (requestId === null) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    return new Promise(resolve => {
      this.pendingPermissions.set(requestId, {
        providerSessionId: request.sessionId,
        resolve,
      });
      this.emit({
        providerSessionId: request.sessionId,
        kind: 'request',
        method: 'acp/requestPermission',
        params: request,
        requestId,
      });
    });
  }

  private cancelPermissions(providerSessionId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.providerSessionId !== providerSessionId) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.process = null;
    this.connection?.close(error);
    this.connection = null;
    this.context = null;
    this.initializeResponse = null;
    this.startPromise = null;
    this.executableResolver.reset();
    for (const providerSessionId of this.sessions.keys()) {
      this.cancelPermissions(providerSessionId);
      this.emit({
        providerSessionId,
        kind: 'error',
        method: 'provider/exited',
        params: { message: error.message },
      });
    }
  }

  private getContext(): acp.ClientContext {
    if (!this.context) throw new Error('Qoder ACP is not running');
    return this.context;
  }

  private assertImageInputSupported(): void {
    if (!this.initializeResponse?.agentCapabilities?.promptCapabilities?.image) {
      throw new Error('This Qoder CLI version does not support image prompts');
    }
  }

  private withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${operation} timed out`)),
        REQUEST_TIMEOUT_MS,
      );
      promise.then(
        result => {
          clearTimeout(timer);
          resolve(result);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private probeExecutable(executable: string): Promise<string | null> {
    return probeAgentExecutable(executable, {
      args: ['--version'],
      timeoutMs: PROBE_TIMEOUT_MS,
      timeoutError: 'Timed out while checking Qoder CLI availability.',
      startError: error => `Failed to start Qoder CLI: ${error.message}`,
      exitError: code => `Qoder CLI check exited with code ${String(code)}`,
    });
  }

  private runSkillsList(executable: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const launch = agentSpawnCommand(executable, ['skill', 'list', '--all']);
      const child = spawn(launch.command, launch.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: createAgentChildEnv(),
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('Timed out while listing Qoder skills.'));
      }, REQUEST_TIMEOUT_MS);
      child.stdout.on('data', chunk => {
        if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', chunk => {
        if (stderr.length < 10_000) stderr += chunk.toString('utf8');
      });
      child.once('error', error => finish(error));
      child.once('exit', code => {
        if (code === 0) finish();
        else
          finish(new Error(stderr.trim() || `Qoder skill list exited with code ${String(code)}`));
      });
    });
  }

  private resolveExecutable(): Promise<AgentExecutableResolution> {
    return this.executableResolver.resolve();
  }

  private resolveExecutableCandidates(): string[] {
    return executableFileCandidates(qoderExecutableCandidatePaths());
  }

  private emit(event: AgentProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
