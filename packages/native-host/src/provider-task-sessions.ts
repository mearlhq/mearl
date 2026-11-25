import {
  selectMatchingTab,
  isProviderTaskExtensionAction,
  PROVIDER_TASK_EXTENSION_ACTIONS,
  parseSessionManageParams,
  resolveSessionManageId,
  type ControlSessionInfo,
  type ProviderTaskExtensionAction,
} from '@mearl/browser-core';
import type { JsonObject } from '@mearl/provider';
import { AsyncLocalStorage } from 'node:async_hooks';
import { browserConnectionIdentity, type BrowserRecord } from './browser-registry.js';
import { assertBrowserRequestDeadline } from './control-session.js';
import { ControlSessionManager } from './control-session-manager.js';
import type { ProviderTaskExtensionLifecycle } from './provider-task-extension.js';

export interface ProviderTaskRoutes {
  open: (browser: BrowserRecord, options: JsonObject, deadline?: number) => Promise<string>;
  findExtension: (
    target: BrowserRecord,
    tabId: number,
    deadline?: number,
  ) => Promise<BrowserRecord | undefined>;
  reserveExtensionPage: (
    target: BrowserRecord,
    extension: BrowserRecord,
    tabId: number,
    deadline?: number,
  ) => Promise<void>;
  authorizeOpen: (
    target: BrowserRecord,
    extension: BrowserRecord,
    url: string,
    origin: string,
    deadline?: number,
  ) => Promise<void>;
  invokeExtension: (
    target: BrowserRecord,
    extension: BrowserRecord,
    action: ProviderTaskExtensionAction,
    data: Record<string, any>,
    origin: string,
    deadline?: number,
  ) => Promise<any>;
  updateExtension: (
    target: BrowserRecord,
    extension: BrowserRecord,
    operation: ProviderTaskExtensionLifecycle,
    deadline?: number,
  ) => Promise<void>;
}
interface Dependencies extends ProviderTaskRoutes {
  browsers: () => BrowserRecord[];
  request: (
    browser: BrowserRecord,
    action: string,
    data: Record<string, any>,
    origin: string,
    deadline?: number,
  ) => Promise<any>;
  notify: () => void;
}
interface Task {
  browser: BrowserRecord;
  target: BrowserRecord;
  sessionId: string;
  manager: ControlSessionManager;
  info: NonNullable<ControlSessionInfo['task']>;
  controlling: boolean;
}

const PROVIDER_TASK_LIFECYCLE_ACTIONS = ['tab_list', 'tab_open', 'tab_close', 'get_capabilities'];

/** The Mearl session owns scheduling and artifacts. The Provider owns the native task. */
export class ProviderTaskSessions {
  private readonly sessions = new Map<string, Task>();
  private readonly context = new AsyncLocalStorage<{ origin: string; deadline?: number }>();
  constructor(private readonly dependencies: Dependencies) {}

  private state(task: Task): ControlSessionInfo {
    return { ...task.manager.registry.info(task.sessionId), task: task.info };
  }

  reap(): void {
    const browsers = this.dependencies.browsers();
    for (const [id, task] of this.sessions) {
      if (
        browsers.some(
          browser =>
            browser.browserId === task.target.browserId &&
            browserConnectionIdentity(browser) === browserConnectionIdentity(task.target),
        )
      )
        continue;
      this.sessions.delete(id);
      void task.manager.registry
        .waitForIdle(id)
        .then(() => task.manager.artifacts.dispose())
        .catch(() => {});
    }
  }

  list(): ControlSessionInfo[] {
    return [...this.sessions.values()].map(task => this.state(task));
  }

  find(sessionId: string): ControlSessionInfo | undefined {
    const task = this.sessions.get(sessionId);
    return task && this.state(task);
  }

  async userControl(sessionId: string, operation: 'handoff' | 'resume' | 'release') {
    const task = this.require(sessionId);
    return (
      await this.invoke(
        task.browser,
        'session_manage',
        { operation: operation === 'release' ? 'end' : operation },
        sessionId,
        'local',
      )
    ).session;
  }

  private require(sessionId: string): Task {
    const task = this.sessions.get(sessionId);
    if (!task) throw new Error('CONTROL_SESSION_NOT_FOUND');
    return task;
  }

  private pauseOnNativeHandoff(task: Task | undefined, error: unknown): void {
    if (
      !task ||
      !(error instanceof Error) ||
      !error.message.startsWith('EXTERNAL_CONTROL_PAUSED:') ||
      task.manager.registry.info(task.sessionId).status !== 'active'
    )
      return;
    task.manager.registry.handoff(task.sessionId, error.message);
    this.dependencies.notify();
  }

  private async abandon(target: BrowserRecord, origin: string, error: unknown): Promise<void> {
    const deadline = Date.now() + 5000;
    if (target.details?.taskSessionCreated === true) {
      try {
        await this.dependencies.request(
          target,
          'browser_control',
          { operation: 'finish', keepTabIds: [] },
          origin,
          deadline,
        );
        return;
      } catch {
        const reference = target.references?.[0];
        if (reference && error instanceof Error)
          error.message += ` (native task ${reference.kind} ${reference.id} may still be open)`;
      }
    }
    await this.dependencies
      .request(target, 'browser_instances', { operation: 'detach' }, origin, deadline)
      .catch(() => {});
  }

  private async open(
    browser: BrowserRecord,
    options: JsonObject,
    origin: string,
    deadline?: number,
  ): Promise<Task> {
    if (browser.status !== 'connected') throw new Error('Provider browser is not connected');
    const targetId = await this.dependencies.open(browser, options, deadline);
    const target = this.dependencies
      .browsers()
      .find(
        item =>
          item.browserId === targetId &&
          item.details?.taskSessionScope === 'session' &&
          item.provider?.id === browser.provider?.id &&
          item.details.taskSessionBrowserId === browser.providerBrowserId,
      );
    if (!target) throw new Error('Provider did not publish its task session target');
    let activeTask: Task | undefined;
    const request = async (action: string, data: Record<string, any> = {}) => {
      const ctx = this.context.getStore();
      try {
        return await this.dependencies.request(
          target,
          action,
          data,
          ctx?.origin ?? origin,
          ctx?.deadline,
        );
      } catch (error) {
        this.pauseOnNativeHandoff(activeTask, error);
        throw error;
      }
    };
    try {
      const { tabs } = await this.dependencies.request(target, 'tab_list', {}, origin, deadline);
      if (!Array.isArray(tabs)) throw new Error('Provider did not return its task pages');
      const tabId = tabs.find(tab => Number.isSafeInteger(tab.tabId))?.tabId;
      const extension =
        tabId === undefined
          ? undefined
          : await this.dependencies.findExtension(target, tabId, deadline);
      if (extension) {
        for (const tab of tabs)
          if (Number.isSafeInteger(tab.tabId))
            await this.dependencies.reserveExtensionPage(target, extension, tab.tabId, deadline);
      }
      assertBrowserRequestDeadline(deadline);
      const invokePage = async (action: string, data: Record<string, any>) => {
        if (!extension || !isProviderTaskExtensionAction(action)) return request(action, data);
        const ctx = this.context.getStore();
        try {
          return await this.dependencies.invokeExtension(
            target,
            extension,
            action,
            data,
            ctx?.origin ?? origin,
            ctx?.deadline,
          );
        } catch (error) {
          this.pauseOnNativeHandoff(activeTask, error);
          throw error;
        }
      };
      const manager: ControlSessionManager = new ControlSessionManager({
        browserId: () => browser.browserId,
        transport: () => 'provider',
        supportsTabClose: () => true,
        invoke: async (action, payload) => {
          const {
            __mearlControlSource: _origin,
            __mearlBlockedTabIds: _blocked,
            ...data
          } = payload;
          if (action === 'tab_open') {
            if (extension) {
              if (data.emulation !== undefined || data.appProfile !== undefined)
                throw new Error('Set device or App emulation after opening the task page');
              const ctx = this.context.getStore();
              await this.dependencies.authorizeOpen(
                target,
                extension,
                data.url,
                ctx?.origin ?? origin,
                ctx?.deadline,
              );
            }
            if (data.reuse !== 'never') {
              const { tabs: current }: { tabs: Array<{ tabId: number; url?: string }> } =
                await request('tab_list');
              const match = selectMatchingTab(current, data.url, data.match);
              if (match) {
                if (extension)
                  await this.dependencies.reserveExtensionPage(
                    target,
                    extension,
                    match.tabId,
                    this.context.getStore()?.deadline,
                  );
                return { ...match, opened: false, reused: true };
              }
              if (data.reuse === 'require') throw new Error('No matching page in the task');
            }
            const { match: _match, closeExisting: _close, ...open } = data;
            const result = await request(action, { ...open, reuse: 'never' });
            if (extension && Number.isSafeInteger(result.tabId)) {
              manager.registry.claim(
                session.sessionId,
                result.tabId,
                result.opened ? 'created' : 'attached',
              );
              await this.dependencies.reserveExtensionPage(
                target,
                extension,
                result.tabId,
                this.context.getStore()?.deadline,
              );
            }
            return result;
          }
          if (
            extension &&
            !isProviderTaskExtensionAction(action) &&
            !PROVIDER_TASK_LIFECYCLE_ACTIONS.includes(action)
          )
            throw new Error(`${action} is unavailable on the extension task route`);
          if (extension && action === 'set_app_profile' && data.networkControl !== undefined)
            throw new Error(
              'Browser-wide network control is unavailable on the extension task route',
            );
          const result = await invokePage(action, data);
          if (extension && action === 'get_capabilities')
            return {
              ...result,
              actions: [
                ...new Set([
                  ...result.actions.filter((name: string) =>
                    PROVIDER_TASK_LIFECYCLE_ACTIONS.includes(name),
                  ),
                  ...PROVIDER_TASK_EXTENSION_ACTIONS,
                ]),
              ],
            };
          return result;
        },
        deactivate: async () => {
          if (extension) {
            await manager.registry.waitForIdle(session.sessionId);
            await this.dependencies.updateExtension(
              target,
              extension,
              { operation: 'deactivate' },
              this.context.getStore()?.deadline,
            );
          }
          await request('browser_control', { operation: 'handoff' });
        },
        cleanup: async (tabs, _transport, preserve, returning) => {
          if (returning) await request('browser_control', { operation: 'resume' });
          if (extension) {
            await this.dependencies.updateExtension(
              target,
              extension,
              {
                operation: 'cleanup',
                preserveEnvironment: preserve,
                returningToAgent: returning === true,
              },
              this.context.getStore()?.deadline,
            );
            return;
          }
          if (!preserve) {
            for (const tabId of tabs) {
              for (const [action, data] of [
                ['set_app_profile', { tabId, enabled: false, networkControl: null }],
                ['set_device_emulation', { tabId, enabled: false }],
                ['set_timezone', { tabId, timezone: '' }],
              ] as const) {
                if (!target.capabilities?.actions.includes(action)) continue;
                const result = await invokePage(action, data);
                if (result?.success === false)
                  throw new Error(result.error ?? 'Task environment cleanup failed');
              }
            }
          }
        },
        finishTask: async closeTabIds => {
          const { tabs: current } = await request('tab_list');
          await request('browser_control', {
            operation: 'finish',
            keepTabIds: current
              .map((tab: { tabId: number }) => tab.tabId)
              .filter((id: number) => !closeTabIds.includes(id)),
          });
        },
        download: async () => {
          throw new Error('File download is unavailable on this task route');
        },
        notify: this.dependencies.notify,
      });
      const session = manager.registry.create('provider');
      if (target.details?.taskSessionCreated === true) {
        for (const page of tabs) {
          if (Number.isSafeInteger(page.tabId) && page.tabId >= 0)
            manager.registry.claim(session.sessionId, page.tabId, 'created');
        }
      }
      const task: Task = {
        browser,
        target,
        sessionId: session.sessionId,
        manager,
        info: {
          reference: target.references?.[0],
          pageTransport: extension ? 'extension' : 'provider',
        },
        controlling: false,
      };
      activeTask = task;
      this.sessions.set(task.sessionId, task);
      this.dependencies.notify();
      return task;
    } catch (error) {
      await this.abandon(target, origin, error);
      throw error;
    }
  }

  async invoke(
    browser: BrowserRecord,
    action: string,
    data: Record<string, any>,
    sessionId: string | undefined,
    origin: string,
    deadline?: number,
  ) {
    return this.context.run({ origin, deadline }, async () => {
      const command = action === 'session_manage' ? parseSessionManageParams(data) : undefined;
      if (
        (command?.operation === 'new' && sessionId) ||
        (sessionId === 'new' &&
          (command || !['tab_open', 'page_snapshot', 'page_screenshot'].includes(action)))
      )
        throw new Error('Invalid request to create a task session');
      const created = command?.operation === 'new' || sessionId === 'new';
      const id = command ? resolveSessionManageId(command, sessionId) : sessionId;
      if (!created && !id)
        throw new Error('Select or create a Provider task session with --session');
      const task = created
        ? await this.open(
            browser,
            command?.operation === 'new' ? (command.providerOptions ?? {}) : {},
            origin,
            deadline,
          )
        : this.require(id!);
      if (task.browser.browserId !== browser.browserId)
        throw new Error('CONTROL_SESSION_NOT_FOUND: task session belongs to another browser');
      if (command?.operation === 'new') return { session: this.state(task) };
      if (command) {
        if (command.operation === 'end' && command.keepArtifactIds?.length)
          throw new Error('Save artifacts before ending a Provider task session');
        if (task.controlling) throw new Error('Task control operation is in progress');
        task.controlling = true;
        try {
          const result = await task.manager.manageSession(
            command,
            task.sessionId,
            'provider',
            deadline,
          );
          if (command.operation === 'end') this.sessions.delete(task.sessionId);
          return { session: { ...result.session, task: task.info } };
        } catch (error) {
          this.pauseOnNativeHandoff(task, error);
          throw error;
        } finally {
          task.controlling = false;
        }
      }
      try {
        const { session, ...result } = await task.manager.invoke(
          action,
          data,
          task.sessionId,
          undefined,
          origin,
          deadline,
        );
        return { ...result, session: { ...session, task: task.info } };
      } catch (error) {
        if (created) {
          await this.abandon(task.target, origin, error);
          await task.manager.artifacts.dispose();
          this.sessions.delete(task.sessionId);
          this.dependencies.notify();
        }
        throw error;
      }
    });
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async task => {
        await task.manager.registry.waitForIdle(task.sessionId);
        await task.manager.artifacts.dispose();
      }),
    );
  }
}
