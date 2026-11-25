import {
  isProviderTaskExtensionAction,
  normalizeControlSource,
  PROVIDER_TASK_SESSION_VERSION,
  requireReadyProviderEnhancementTarget,
  type ProviderTaskExtensionAction,
} from '@mearl/browser-core';
import { readProviderControlHost } from '@mearl/provider/host';
import {
  browserConnectionIdentity,
  listRegisteredBrowsers,
  type BrowserRecord,
} from './browser-registry.js';
import type { ControlSessionRegistry } from './control-session.js';
import { requestBrowserSocket } from './browser-socket-request.js';
import { providerRequestTimeoutMs } from './provider-request-timeout.js';
import type { ExtensionBrowserProvider } from './builtin-providers/extension.js';
import { NATIVE_HOST_VERSION } from './version.js';

export type ProviderTaskExtensionLifecycle =
  | { operation: 'deactivate' }
  | { operation: 'cleanup'; preserveEnvironment: boolean; returningToAgent: boolean };

type Operation =
  | { operation: 'identify' }
  | { operation: 'reserve' }
  | { operation: 'authorize_open'; url: string }
  | ProviderTaskExtensionLifecycle
  | { operation: 'invoke'; action: ProviderTaskExtensionAction; data: Record<string, unknown> };

function callExtension(
  token: string,
  extension: BrowserRecord,
  task: BrowserRecord,
  tabId: number | undefined,
  operation: Operation,
  origin: string,
  deadline?: number,
) {
  return requestBrowserSocket(
    extension.socketPath,
    '__provider_task_extension',
    operation,
    NATIVE_HOST_VERSION,
    providerRequestTimeoutMs(
      operation.operation === 'invoke'
        ? operation.action
        : operation.operation === 'authorize_open'
          ? 'tab_open'
          : 'page_frames',
      operation.operation === 'invoke' ? operation.data : {},
      deadline,
    ),
    undefined,
    undefined,
    {
      providerControlToken: token,
      providerTarget: task.browserId,
      providerSourceIdentity: browserConnectionIdentity(task),
      providerPageId: tabId,
      controlSource: origin,
      deadline,
    },
  );
}

export async function findProviderTaskExtension(
  token: string,
  task: BrowserRecord,
  tabId: number,
  deadline?: number,
) {
  const probes = listRegisteredBrowsers().filter(browser => browser.transport === 'extension');
  const probeDeadline = Math.min(deadline ?? Infinity, Date.now() + 3000);
  const results = await Promise.all(
    probes.map(async browser => {
      try {
        if (
          await callExtension(
            token,
            browser,
            task,
            tabId,
            { operation: 'identify' },
            'local',
            probeDeadline,
          )
        )
          return browser;
      } catch {
        // An old extension, disabled Agent service or incompatible profile simply isn't a route.
      }
      return undefined;
    }),
  );
  const matches = results.filter(browser => browser !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

function requireExtension(extension: BrowserRecord) {
  const connected = listRegisteredBrowsers().some(
    browser =>
      browser.browserId === extension.browserId &&
      browserConnectionIdentity(browser) === browserConnectionIdentity(extension),
  );
  if (!connected)
    throw new Error('CONTROL_SESSION_TRANSPORT_UNAVAILABLE: the task extension disconnected');
}

export async function authorizeProviderTaskOpen(
  token: string,
  task: BrowserRecord,
  extension: BrowserRecord,
  url: string,
  origin: string,
  deadline?: number,
) {
  requireExtension(extension);
  const result = await callExtension(
    token,
    extension,
    task,
    undefined,
    { operation: 'authorize_open', url },
    origin,
    deadline,
  );
  if (result?.authorized !== true) throw new Error('The extension did not authorize the task URL');
}

export async function reserveProviderTaskPage(
  token: string,
  task: BrowserRecord,
  extension: BrowserRecord,
  tabId: number,
  deadline?: number,
) {
  requireExtension(extension);
  await callExtension(token, extension, task, tabId, { operation: 'reserve' }, 'local', deadline);
}

export async function updateProviderTaskExtension(
  token: string,
  task: BrowserRecord,
  extension: BrowserRecord,
  operation: ProviderTaskExtensionLifecycle,
  deadline?: number,
) {
  const connected = listRegisteredBrowsers().some(
    browser =>
      browser.browserId === extension.browserId &&
      browserConnectionIdentity(browser) === browserConnectionIdentity(extension),
  );
  if (connected)
    await callExtension(token, extension, task, undefined, operation, 'local', deadline);
}

export function invokeProviderTaskExtension(
  token: string,
  task: BrowserRecord,
  extension: BrowserRecord,
  action: ProviderTaskExtensionAction,
  data: Record<string, unknown>,
  origin: string,
  deadline?: number,
) {
  if (!Number.isSafeInteger(data.tabId) || Number(data.tabId) < 0)
    throw new Error('A task tabId is required');
  requireExtension(extension);
  return callExtension(
    token,
    extension,
    task,
    Number(data.tabId),
    { operation: 'invoke', action, data },
    origin,
    deadline,
  );
}

interface TaskExtensionRequest {
  data?: Operation;
  providerControlToken?: string;
  providerTarget?: string;
  providerSourceIdentity?: string;
  providerPageId?: number;
  controlSessionId?: string;
  controlSource?: string;
  deadline?: number;
}

interface Binding {
  sessionId: string;
  sourceIdentity: string;
  hostToken: string;
  cleaned?: boolean;
  release?: Promise<unknown>;
}

/** Project native-owned task pages into the ordinary extension registry. */
export class ProviderTaskExtension {
  private readonly bindings = new Map<string, Binding>();

  constructor(
    private readonly extension: ExtensionBrowserProvider,
    private readonly registry: ControlSessionRegistry,
  ) {}

  async prune(taskId?: string): Promise<void> {
    if (!this.bindings.size) return;
    const token = readProviderControlHost()?.token;
    const entries = listRegisteredBrowsers();
    await Promise.all(
      [...this.bindings].map(([id, binding]) => {
        if (taskId !== undefined && id !== taskId) return;
        if (
          binding.hostToken === token &&
          entries.some(
            item =>
              item.browserId === id &&
              item.details?.taskSessionScope === 'session' &&
              browserConnectionIdentity(item) === binding.sourceIdentity,
          )
        )
          return;
        binding.release ??= this.registry
          .release(binding.sessionId, { closeCreatedTabs: false }, async tabs => {
            if (!binding.cleaned && tabs.length && this.extension.connected)
              await this.extension.cleanup(tabs, true).catch(() => {});
          })
          .finally(() => this.bindings.delete(id));
        return binding.release;
      }),
    );
  }

  async dispatch(request: TaskExtensionRequest) {
    if (request.providerTarget) await this.prune(request.providerTarget);
    const host = readProviderControlHost();
    const task = listRegisteredBrowsers().find(
      browser =>
        browser.browserId === request.providerTarget &&
        browser.transport === 'provider' &&
        browser.details?.taskSessionScope === 'session',
    );
    if (
      !host?.ready ||
      host.taskSessionProtocolVersion !== PROVIDER_TASK_SESSION_VERSION ||
      !host.token ||
      host.token !== request.providerControlToken ||
      !task?.providerBrowserId ||
      browserConnectionIdentity(task) !== request.providerSourceIdentity ||
      request.controlSessionId !== undefined
    )
      throw new Error('Invalid Provider task extension request');
    const origin = normalizeControlSource(request.controlSource);
    const operation = request.data;
    const extension = this.extension;
    const timeout = (action: string, data: Record<string, unknown> = {}) =>
      providerRequestTimeoutMs(action, data, request.deadline);
    if (operation?.operation === 'authorize_open') {
      if (
        request.providerPageId !== undefined ||
        typeof operation.url !== 'string' ||
        !operation.url
      )
        throw new Error('A task URL is required');
      return extension.request(
        '__provider_task_authorize_open',
        { url: operation.url },
        timeout('tab_open'),
        true,
        origin,
      );
    }
    let binding = this.bindings.get(task.browserId);
    if (operation?.operation === 'deactivate' || operation?.operation === 'cleanup') {
      if (request.providerPageId !== undefined)
        throw new Error('Invalid Provider task lifecycle request');
      if (!binding) return;
      await this.registry.waitForIdle(binding.sessionId);
      const tabs = this.registry.info(binding.sessionId).tabs.map(tab => tab.tabId);
      if (operation.operation === 'deactivate') await extension.deactivate(tabs);
      else {
        await extension.cleanup(tabs, operation.preserveEnvironment, operation.returningToAgent);
        binding.cleaned = !operation.returningToAgent;
      }
      return;
    }
    if (!Number.isSafeInteger(request.providerPageId) || Number(request.providerPageId) < 0)
      throw new Error('A task tabId is required');
    const tabId = Number(request.providerPageId);
    const nativeTarget = async () =>
      requireReadyProviderEnhancementTarget(
        await requestBrowserSocket(
          task.socketPath,
          '__provider_enhancement_target',
          { tabId },
          NATIVE_HOST_VERSION,
          timeout('page_frames'),
          task.providerBrowserId,
          undefined,
          { deadline: request.deadline },
        ),
        tabId,
      );
    const target = await nativeTarget();
    if (!target.targetId) {
      if (operation?.operation === 'identify') return null;
      throw new Error('Task target identity is unavailable');
    }
    const mapTarget = () =>
      extension.request(
        '__provider_task_target',
        { targetId: target.targetId },
        timeout('page_frames'),
        true,
        origin,
      ) as Promise<{ tabId: number } | null>;
    const mapped = await mapTarget();
    if (operation?.operation === 'identify') return mapped;
    if (
      operation?.operation !== 'reserve' &&
      (operation?.operation !== 'invoke' ||
        !isProviderTaskExtensionAction(operation.action) ||
        operation.data?.tabId !== tabId ||
        Object.keys(operation.data).some(key => key.startsWith('__mearl')))
    )
      throw new Error('Invalid Provider task page operation');
    if (!Number.isSafeInteger(mapped?.tabId))
      throw new Error('PAGE_IDENTITY_CHANGED: no matching task page in the extension');
    binding ??= this.bindings.get(task.browserId);
    if (!binding) {
      binding = {
        sessionId: this.registry.create('extension', { internal: true }).sessionId,
        sourceIdentity: request.providerSourceIdentity!,
        hostToken: host.token,
      };
      this.bindings.set(task.browserId, binding);
    }
    const data = {
      ...(operation.operation === 'invoke' ? operation.data : {}),
      tabId: mapped!.tabId,
    };
    const sessionId = binding.sessionId;
    return this.registry.run(
      sessionId,
      operation.operation === 'invoke' ? operation.action : 'page_frames',
      data,
      async () => {
        if (
          (await nativeTarget()).targetId !== target.targetId ||
          (await mapTarget())?.tabId !== data.tabId
        )
          throw new Error('PAGE_IDENTITY_CHANGED: task page changed before dispatch');
        const claim = () => this.registry.claim(sessionId, data.tabId, 'attached');
        if (operation.operation === 'reserve') return claim();
        let result: any;
        try {
          result = await extension.request(
            operation.action,
            { ...data, __mearlExpectedTargetId: target.targetId },
            timeout(operation.action, data),
            true,
            origin,
          );
        } catch (error) {
          if (!(error instanceof Error && error.message.startsWith('PAGE_IDENTITY_CHANGED:')))
            claim();
          throw error;
        }
        claim();
        // Extension tab IDs are local to the extension connection. The owner inventories task tabs.
        if (result?.tabId !== undefined) result.tabId = tabId;
        if (result?.observation?.openedTabs) result.observation.openedTabs = [];
        return result;
      },
      'extension',
      request.deadline,
    );
  }
}
