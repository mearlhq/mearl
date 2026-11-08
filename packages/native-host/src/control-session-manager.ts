import {
  runActionBatch,
  validateRequiredActionTabId,
  type BrowserReleaseParams,
  type ControlSessionInfo,
  type PageDownloadParams,
} from '@mearl/browser-core';
import { ControlSessionRegistry } from './control-session.js';
import { BrowserArtifactStore } from './browser-artifacts.js';

interface Dependencies {
  browserId: () => string;
  transport: () => ControlSessionInfo['transport'];
  invoke: (action: string, data: any, transport: ControlSessionInfo['transport']) => Promise<any>;
  deactivate?: (tabs: number[], transport: ControlSessionInfo['transport']) => Promise<void>;
  cleanup: (
    tabs: number[],
    transport: ControlSessionInfo['transport'],
    preserveEnvironment: boolean,
    returningToAgent?: boolean,
  ) => Promise<void>;
  download: (
    data: PageDownloadParams,
    transport: ControlSessionInfo['transport'],
    origin: string,
  ) => Promise<{
    filename: string;
    filePath: string;
    action: unknown;
    owned?: boolean;
    directory?: string;
  }>;
  notify: () => void;
}

export class ControlSessionManager {
  readonly registry: ControlSessionRegistry;
  readonly artifacts = new BrowserArtifactStore();
  private activityQueues = new Map<string, Promise<unknown>>();

  private async withActivity<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.activityQueues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.activityQueues.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.activityQueues.get(id) === pending) this.activityQueues.delete(id);
    }
  }

  constructor(private dependencies: Dependencies) {
    this.registry = new ControlSessionRegistry(dependencies.browserId);
  }

  private async closeTabs(
    tabs: number[],
    transport: ControlSessionInfo['transport'],
    sessionId: string,
  ): Promise<void> {
    for (const tabId of tabs) {
      try {
        const result = await this.dependencies.invoke('tab_close', { tabId }, transport);
        this.registry.recordResult(sessionId, 'tab_close', result, { tabId });
      } catch (error) {
        const current = await this.dependencies.invoke('tab_list', {}, transport);
        if (
          !Array.isArray(current.tabs) ||
          current.tabs.some((tab: any) => (tab.tabId ?? tab.id) === tabId)
        )
          throw error;
        this.registry.recordResult(sessionId, 'tab_close', {}, { tabId });
      }
    }
  }

  async userControl(
    id: string,
    operation: 'handoff' | 'resume' | 'release',
    reason?: string,
  ): Promise<ControlSessionInfo> {
    if (operation === 'release') {
      await this.invoke('browser_release', {}, id);
      return this.registry.info(id);
    }
    if (operation === 'resume') await this.activityQueues.get(id)?.catch(() => {});
    const current = this.registry.info(id);
    const info =
      operation === 'resume'
        ? await this.registry.resume(id, () =>
            this.dependencies.cleanup(
              current.tabs.map(tab => tab.tabId),
              current.transport,
              true,
              true,
            ),
          )
        : current.status === 'user'
          ? current
          : this.registry.handoff(id, reason);
    this.dependencies.notify();
    if (operation === 'handoff') {
      await this.withActivity(id, async () => {
        await this.dependencies.deactivate?.(
          this.registry.info(id).tabs.map(tab => tab.tabId),
          current.transport,
        );
      });
      return this.registry.info(id);
    }
    return info;
  }

  async invoke(
    action: string,
    data: any,
    sessionId?: string,
    requestedTransport?: 'cdp',
    origin = 'local',
  ): Promise<any> {
    if (
      data &&
      (Object.keys(data).some(key => key.startsWith('__mearl')) ||
        (data.actions ?? []).some((step: any) =>
          Object.keys(step.data ?? {}).some(key => key.startsWith('__mearl')),
        ))
    )
      throw new Error('Internal session fields are reserved');
    validateRequiredActionTabId(action, data);
    const created = sessionId === 'new';
    if (sessionId === 'new') {
      if (!['tab_open', 'page_snapshot', 'page_screenshot'].includes(action))
        throw new Error('A new session requires tab_open, page_snapshot or page_screenshot');
      sessionId = this.registry.create(
        requestedTransport ?? this.dependencies.transport(),
      ).sessionId;
    }
    const info = sessionId ? this.registry.info(sessionId) : undefined;
    const transport = info?.transport ?? requestedTransport ?? this.dependencies.transport();
    if (requestedTransport && transport !== requestedTransport)
      throw new Error('A session cannot change transport');
    if (action === 'browser_control') {
      if (!sessionId || !['handoff', 'resume'].includes(data.operation))
        throw new Error('browser_control requires --session and handoff/resume');
      if (data.operation === 'resume')
        return { session: await this.userControl(sessionId, 'resume') };
      if (data.tabId !== undefined && !info!.tabs.some(tab => tab.tabId === data.tabId))
        throw new Error('TAB_NOT_IN_CONTROL_SESSION');
      return { session: await this.userControl(sessionId, 'handoff', data.reason) };
    }
    if (action === 'browser_release' && sessionId) {
      const params = data as BrowserReleaseParams;
      await this.registry.release(sessionId, params, async (tabs, close) => {
        await this.dependencies.cleanup(tabs, transport, params.preserveEnvironment !== false);
        await this.closeTabs(close, transport, sessionId!);
        await this.artifacts.release(sessionId!, params.keepArtifactIds);
      });
      this.dependencies.notify();
      return {
        released: true,
        hadActiveControl: true,
        transports: [transport],
        affectedTabIds: info!.tabs.map(tab => tab.tabId),
        session: this.registry.state(sessionId),
      };
    }
    if (action === 'browser_release' || action === 'browser_close')
      this.registry.assertBrowserRelease();
    if ((action === 'browser_release' || action === 'browser_close') && !sessionId) {
      return this.registry.releaseBrowser(() => this.dependencies.invoke(action, data, transport));
    }
    const performStep = async (name: string, payload: any, batch = false): Promise<any> => {
      if (name === 'tab_open') {
        if (sessionId && payload.closeExisting) {
          await this.closeTabs(
            this.registry
              .info(sessionId)
              .tabs.filter(tab => tab.source === 'created')
              .map(tab => tab.tabId),
            transport,
            sessionId,
          );
          payload = { ...payload, closeExisting: false };
        }
        payload = { ...payload, __mearlBlockedTabIds: this.registry.blockedTabs(sessionId) };
      }
      if (name === 'page_upload' && payload.files) {
        if (payload.filePaths) throw new Error('Use files or filePaths, not both');
        payload = {
          ...payload,
          filePaths: payload.files.map((file: any) =>
            this.artifacts.resolve(file.artifactId, sessionId),
          ),
        };
        delete payload.files;
      }
      if (batch) {
        if (transport === 'provider') {
          const result = await this.dependencies.invoke(
            name,
            { ...payload, __mearlControlSource: origin },
            transport,
          );
          if (sessionId) this.registry.recordResult(sessionId, name, result, payload);
          if (result?.action?.success === false) return { ...result.action, success: false };
          if (result?.success === false) return { ...result, success: false };
          return { success: true, data: result };
        }
        const result = await this.dependencies.invoke(
          'run_actions',
          {
            tabId: payload.tabId,
            actions: [{ action: name, data: payload }],
            __mearlControlSource: origin,
          },
          transport,
        );
        const outcome = result.results?.[0] ?? {
          success: false,
          error: result.error ?? 'Batch step returned no result',
          stage: result.stage,
          attempt: result.attempt,
        };
        if (sessionId && outcome.success)
          this.registry.recordResult(sessionId, name, outcome.data, payload);
        return outcome;
      }
      const result = await this.dependencies.invoke(
        name,
        { ...payload, __mearlControlSource: origin },
        transport,
      );
      if (sessionId) this.registry.recordResult(sessionId, name, result, payload);
      return result;
    };
    const invokeStep = (name: string, payload: any, batch = false): Promise<any> => {
      if (sessionId && name === 'tab_open') {
        // Opening includes pre-navigation activation; handoff waits for its result and owned tab ID.
        return this.withActivity(sessionId, async () => {
          this.registry.assertStep(sessionId, info!.generation);
          return performStep(name, payload, batch);
        });
      }
      return performStep(name, payload, batch);
    };
    let result: any;
    try {
      result = await this.registry.run(
        sessionId,
        action,
        data,
        async () => {
          if (transport === 'extension' && this.dependencies.transport() !== 'extension') {
            throw new Error('CONTROL_SESSION_TRANSPORT_UNAVAILABLE: extension is disconnected');
          }
          if (action.startsWith('__artifact_')) {
            const store = this.artifacts;
            switch (action) {
              case '__artifact_init':
                return {
                  artifact: await store.create(data.filename, sessionId),
                  browserId: this.dependencies.browserId(),
                };
              case '__artifact_write':
                return store.write(data.artifactId, data.offset, data.base64, sessionId);
              case '__artifact_complete':
                return store.complete(data.artifactId, data.bytes, sessionId);
              case '__artifact_read':
                return store.read(data.artifactId, data.offset, sessionId);
              case '__artifact_remove':
                await store.remove(data.artifactId, sessionId);
                return { removed: true };
              default:
                throw new Error('Unknown artifact operation');
            }
          }
          if (action === 'page_download') {
            const downloaded = await this.dependencies.download(data, transport, origin);
            try {
              if (sessionId)
                this.registry.recordResult(sessionId, 'page_click', downloaded.action, data);
              const artifact = await this.artifacts.importFile(
                downloaded.filename,
                downloaded.filePath,
                sessionId,
              );
              return {
                download: { ...artifact, browserId: this.dependencies.browserId() },
                action: downloaded.action,
              };
            } finally {
              if (downloaded.owned) {
                const { rm, rmdir } = await import('node:fs/promises');
                await rm(downloaded.filePath, { force: true });
                if (downloaded.directory) await rmdir(downloaded.directory).catch(() => {});
              }
            }
          }
          if (action === 'run_actions' && sessionId) {
            return runActionBatch(data, (name, payload) => invokeStep(name, payload, true), {
              beforeStep: () => this.registry.assertStep(sessionId!, info!.generation),
            });
          }
          return invokeStep(action, data);
        },
        transport,
      );
    } catch (error) {
      if (created && sessionId)
        await this.registry.release(sessionId, {}, async tabs => {
          await this.dependencies.cleanup(tabs, transport, true);
          await this.artifacts.release(sessionId!);
        });
      this.dependencies.notify();
      throw error;
    }
    if (sessionId && action === 'tab_list' && Array.isArray(result.tabs)) {
      const blocked = new Set(this.registry.blockedTabs(sessionId));
      result = {
        ...result,
        tabs: result.tabs.filter((tab: any) => !blocked.has(tab.tabId ?? tab.id)),
      };
      result.count = result.tabs.length;
    }
    if (sessionId) {
      this.dependencies.notify();
      return { ...result, session: this.registry.state(sessionId) };
    }
    return result;
  }
}
