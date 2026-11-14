import { randomUUID } from 'node:crypto';
import {
  PAGE_UPLOAD_FILE_TRANSFER_TIMEOUT_MS,
  PAGE_UPLOAD_TRANSFER_MAX_BYTES,
  PageActionPreconditionError,
  runActionBatch,
  validateRequiredActionTabId,
  type BrowserReleaseParams,
  type ControlSessionInfo,
  type PageDownloadParams,
  type PageUploadChunkRequest,
  type PageUploadTransfer,
  type SessionManageParams,
} from '@mearl/browser-core';
import { assertBrowserRequestDeadline, ControlSessionRegistry } from './control-session.js';
import { BrowserArtifactStore } from './browser-artifacts.js';
import { PageRecordings, type OpenRecording } from './page-recordings.js';
import { toTimeoutMs } from './builtin-providers/action-timeout.js';

interface Dependencies {
  browserId: () => string;
  transport: () => ControlSessionInfo['transport'];
  invoke: (
    action: string,
    data: any,
    transport: ControlSessionInfo['transport'],
    deadline?: number,
    trustedUpload?: true,
  ) => Promise<any>;
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
  openRecording?: OpenRecording;
  supportsUploadTransfer?: () => boolean;
}

export class ControlSessionManager {
  readonly registry: ControlSessionRegistry;
  readonly artifacts = new BrowserArtifactStore();
  private recordings?: PageRecordings;
  private activityQueues = new Map<string, Promise<unknown>>();
  private uploads = new Map<
    string,
    { tabId: number; sessionId?: string; artifactIds: string[]; deadline?: number }
  >();

  readUploadChunk({ id, tabId, fileIndex, offset }: PageUploadChunkRequest) {
    const upload = this.uploads.get(id);
    const artifactId = upload && Number.isSafeInteger(fileIndex) && upload.artifactIds[fileIndex];
    if (!upload || upload.tabId !== tabId || !artifactId)
      throw new Error('Unknown page upload transfer');
    assertBrowserRequestDeadline(upload.deadline);
    return this.artifacts.read(artifactId, offset, upload.sessionId);
  }

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
    if (dependencies.openRecording)
      this.recordings = new PageRecordings(
        this.artifacts,
        dependencies.openRecording,
        dependencies.browserId,
      );
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
      return this.endSession(id);
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
    if (operation === 'handoff') {
      await this.withActivity(id, async () => {
        const tabIds = this.registry.info(id).tabs.map(tab => tab.tabId);
        await this.recordings?.discard(current.transport, { tabIds });
        this.dependencies.notify();
        await this.dependencies.deactivate?.(tabIds, current.transport);
      });
      return this.registry.info(id);
    }
    this.dependencies.notify();
    return info;
  }

  async manageSession(
    data: SessionManageParams,
    sessionId?: string,
    requestedTransport?: ControlSessionInfo['transport'],
    deadline?: number,
  ): Promise<{ session: ControlSessionInfo }> {
    assertBrowserRequestDeadline(deadline);
    if (data.operation === 'new') {
      if (sessionId) throw new Error('session_manage new does not accept a session id');
      const session = this.registry.create(requestedTransport ?? this.dependencies.transport());
      this.dependencies.notify();
      return { session };
    }
    if (!sessionId || sessionId === 'new')
      throw new Error('Specify an existing sessionId or --session <id>');
    const session = this.registry.info(sessionId);
    if (requestedTransport && session.transport !== requestedTransport)
      throw new Error('A session cannot change transport');
    if (data.operation === 'end') return { session: await this.endSession(sessionId, data) };
    return {
      session: await this.userControl(
        sessionId,
        data.operation,
        data.operation === 'handoff' ? data.reason : undefined,
      ),
    };
  }

  async releaseBrowser<T>(release: () => Promise<T>): Promise<T> {
    return this.registry.releaseBrowser(async () => {
      await this.recordings?.discard('extension', {});
      await this.recordings?.discard('cdp', {});
      return release();
    });
  }

  private async endSession(
    id: string,
    params: BrowserReleaseParams = {},
  ): Promise<ControlSessionInfo> {
    const { transport } = this.registry.info(id);
    const session = await this.registry.release(id, params, async (tabs, close) => {
      await this.recordings?.discard(transport, { sessionId: id });
      await this.recordings?.discard(transport, { tabIds: tabs });
      await this.dependencies.cleanup(tabs, transport, params.preserveEnvironment !== false);
      await this.closeTabs(close, transport, id);
      await this.artifacts.release(id, params.keepArtifactIds);
    });
    this.dependencies.notify();
    return session;
  }

  async invoke(
    action: string,
    data: any,
    sessionId?: string,
    requestedTransport?: 'cdp',
    origin = 'local',
    deadline?: number,
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
    let recording: ReturnType<PageRecordings['resolve']> | undefined;
    if (action === 'page_record') {
      if (origin !== 'local' || !this.recordings)
        throw new Error('Page recording is available on local Chrome connections');
      if (data.operation === 'stop' || data.operation === 'status') {
        recording = this.recordings.resolve(data.recordingId, sessionId, transport);
        if (data.operation === 'status') {
          // A status query must be able to observe a stop that's draining the same tab.
          assertBrowserRequestDeadline(deadline);
          const status = await this.recordings.status(recording);
          return sessionId ? { ...status, session: this.registry.state(sessionId) } : status;
        }
        data = { ...data, tabId: recording.tabId };
      } else if (
        data.operation !== 'start' ||
        !Number.isSafeInteger(data.tabId) ||
        data.tabId < 0
      ) {
        throw new Error(
          'page_record requires start with a tabId, or status/stop with a recordingId',
        );
      }
    }
    const dispatch = (name: string, payload: any, trustedUpload?: true) => {
      assertBrowserRequestDeadline(deadline);
      if (trustedUpload)
        return this.dependencies.invoke(name, payload, transport, deadline, trustedUpload);
      return deadline === undefined
        ? this.dependencies.invoke(name, payload, transport)
        : this.dependencies.invoke(name, payload, transport, deadline);
    };
    const dispatchStep = async (
      name: string,
      payload: any,
      batch: boolean,
      trustedUpload?: true,
    ): Promise<any> => {
      assertBrowserRequestDeadline(deadline);
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
      if (batch) {
        if (transport === 'provider') {
          const result = await dispatch(name, { ...payload, __mearlControlSource: origin });
          if (sessionId) this.registry.recordResult(sessionId, name, result, payload);
          if (result?.action?.success === false) return { ...result.action, success: false };
          if (result?.success === false) return { ...result, success: false };
          return { success: true, data: result };
        }
        const result = await dispatch(
          'run_actions',
          {
            tabId: payload.tabId,
            actions: [{ action: name, data: payload }],
            __mearlControlSource: origin,
          },
          trustedUpload,
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
      const result = await dispatch(
        name,
        { ...payload, __mearlControlSource: origin },
        trustedUpload,
      );
      if (name === 'tab_close' && typeof payload.tabId === 'number')
        await this.recordings?.discard(transport, { tabIds: [payload.tabId] });
      if (sessionId) this.registry.recordResult(sessionId, name, result, payload);
      return result;
    };
    const performStep = async (name: string, payload: any, batch = false): Promise<any> => {
      if (name !== 'page_upload') return dispatchStep(name, payload, batch);
      if (Object.hasOwn(payload, 'stagedUpload'))
        throw new PageActionPreconditionError('Page upload references are internal to native-host');
      if (payload.files === undefined) return dispatchStep(name, payload, batch);
      if (payload.filePaths !== undefined)
        throw new PageActionPreconditionError('Use files or filePaths, not both');
      if (!Array.isArray(payload.files) || !payload.files.length)
        throw new PageActionPreconditionError('files must contain at least one file');
      const { files, ...request } = payload;
      const artifactIds: string[] = files.map((file: any) => file?.artifactId);
      if (transport !== 'extension' || !this.dependencies.supportsUploadTransfer?.()) {
        return dispatchStep(
          name,
          { ...request, filePaths: artifactIds.map(id => this.artifacts.resolve(id, sessionId)) },
          batch,
        );
      }

      const stagedUpload: PageUploadTransfer = {
        id: randomUUID(),
        deadline: Math.min(
          deadline ?? Infinity,
          Date.now() + toTimeoutMs(name, request) + PAGE_UPLOAD_FILE_TRANSFER_TIMEOUT_MS,
        ),
        files: artifactIds.map(id => {
          const { filename, bytes } = this.artifacts.describe(id, sessionId);
          return { filename, bytes };
        }),
      };
      const bytes = stagedUpload.files.reduce((sum, file) => sum + file.bytes, 0);
      if (bytes > PAGE_UPLOAD_TRANSFER_MAX_BYTES)
        throw new PageActionPreconditionError(
          'files exceed the 256 MiB Chrome extension upload limit',
        );
      this.uploads.set(stagedUpload.id, {
        tabId: request.tabId,
        sessionId,
        artifactIds,
        deadline: stagedUpload.deadline,
      });
      try {
        return await dispatchStep(name, { ...request, stagedUpload }, batch, true);
      } finally {
        this.uploads.delete(stagedUpload.id);
      }
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
          if (action === 'page_record') {
            const recordings = this.recordings!;
            if (recording)
              return recordings.stop(recordings.resolve(recording.id, sessionId, transport));
            const start = () => recordings.start(data.tabId, transport, sessionId, data, deadline);
            return sessionId
              ? this.withActivity(sessionId, () => {
                  this.registry.assertStep(sessionId, info!.generation);
                  return start();
                })
              : start();
          }
          if (action === 'run_actions' && sessionId) {
            return runActionBatch(data, (name, payload) => invokeStep(name, payload, true), {
              beforeStep: () => this.registry.assertStep(sessionId!, info!.generation),
            });
          }
          return invokeStep(action, data);
        },
        transport,
        deadline,
      );
      if (created && deadline !== undefined && Date.now() >= deadline) {
        throw new Error('Browser request deadline exceeded before returning the control session');
      }
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
