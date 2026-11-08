import {
  PluginPageRuntimeHost,
  type PluginPageHostAdapter,
  type PluginPageNativeCall,
  type PluginPageInstance,
  type PluginPageFrame,
  type PluginPagePort,
  type PluginPageTarget,
} from '@mearl/browser-core';
import {
  ensureDir,
  hashKey,
  keyedConfigFile,
  listRecordFiles,
  readRecord,
  removeRecordIfPid,
  writeRecord,
} from '@mearl/daemon-core';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { CdpSession } from './cdp-session.js';
import type { CdpChildSession } from './client.js';
import { readCdpFrameEntries } from './frame-tree.js';
import { resolveCdpDeviceShellPageEndpoint } from './device-shell.js';

type Listeners = Parameters<PluginPageHostAdapter['listen']>[0];
interface Document {
  contextId: number;
  documentId: string;
}
interface Target {
  tabId: number;
  targetId: string;
  client: CdpChildSession;
  parent: Awaited<ReturnType<CdpSession['getBrowserClient']>>;
  mainFrameId: string;
  mainTarget: boolean;
  frames: Map<string, string>;
  documents: Map<string, Document>;
  worlds: Map<string, { contextId: number; documentId: string; frameId: string }>;
  dispose: () => void;
}

/** Session values belong to one browser lifetime; persistent activation rules outlive it. */
export function pruneCdpSessionStorage(storageFile: string, currentIdentity?: string): void {
  for (const file of listRecordFiles(`${storageFile}.d`)) {
    if (!/^session-[a-f0-9]{16}\.json$/.test(basename(file))) continue;
    const saved = readRecord(file);
    if (saved && (currentIdentity === undefined || saved.identity !== currentIdentity))
      removeRecordIfPid(file, saved.pid);
  }
}

/** Port-shaped bridge keeps the document runtime independent of Chrome extension APIs. */
export function installCdpPluginPageBridge(binding: string): void {
  const root = globalThis as any;
  if (root.__mearlPluginPageBridge === binding) return;
  root.__mearlPluginPageDisconnect?.();
  root.__mearlPluginPageBridge = binding;
  const ports = new Map<string, any>();
  root.__mearlPluginPageDisconnect = () => {
    for (const port of [...ports.values()]) port.disconnect();
  };
  root.__mearlPluginPageReceive = (id: string, message: any) => ports.get(id)?.receive(message);
  root.__mearlPluginPageConnect = (name: string) => {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), value =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const messages = new Set<(message: any) => void>(),
      disconnected = new Set<() => void>();
    let closed = false,
      touched = Date.now();
    const post = (message: unknown) => root[binding](JSON.stringify(message));
    const disconnect = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      ports.delete(id);
      try {
        post({ type: 'disconnect', id });
      } catch {
        /* The CDP connection may have ended. */
      }
      for (const listener of disconnected) listener();
    };
    const timer = setInterval(() => {
      if (Date.now() - touched > 30000) disconnect();
    }, 1000);
    ports.set(id, {
      disconnect,
      receive(message: any) {
        touched = Date.now();
        if (message.type === 'disconnect') {
          disconnect();
          return;
        }
        for (const listener of messages) listener(message);
      },
    });
    queueMicrotask(() => {
      if (!closed) post({ type: 'connect', id, name });
    });
    return {
      postMessage: (message: unknown) => {
        if (!closed) post({ type: 'message', id, message });
      },
      disconnect,
      onMessage: { addListener: (listener: (message: any) => void) => messages.add(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnected.add(listener) },
    };
  };
}

class CdpPageAdapter implements PluginPageHostAdapter {
  readonly session;
  readonly persistent;
  private listeners?: Listeners;
  private readonly binding = `__mearlPluginPage_${randomUUID().replaceAll('-', '')}`;
  private readonly targets = new Map<string, Promise<Target>>();
  private readonly ports = new Map<
    string,
    { target: Target; contextId: number; message: (value: any) => void; disconnect: () => void }
  >();
  private stopped = false;
  private storage?: Promise<{
    identity: string;
    session: Record<string, any>;
    persistent: Record<string, any>;
  }>;

  constructor(
    private readonly cdp: CdpSession,
    private readonly storageFile: string,
  ) {
    const store = (area: 'session' | 'persistent') => ({
      get: async (keys: string[]) => {
        const state = await this.load();
        const values: Record<string, any> = {};
        for (const key of keys) {
          if (!Object.hasOwn(state[area], key)) {
            const saved = readRecord(this.storagePath(area, key));
            state[area][key] =
              area === 'persistent' || saved?.identity === state.identity
                ? saved?.value
                : undefined;
          }
          values[key] = state[area][key];
        }
        return structuredClone(values);
      },
      set: async (values: Record<string, any>) => {
        const state = await this.load();
        ensureDir(`${this.storageFile}.d`);
        for (const [key, value] of Object.entries(values)) {
          const snapshot = structuredClone(value);
          writeRecord(this.storagePath(area, key), {
            pid: process.pid,
            identity: state.identity,
            value: snapshot,
          });
          state[area][key] = snapshot;
        }
      },
    });
    this.session = store('session');
    this.persistent = store('persistent');
  }

  private storagePath(area: 'session' | 'persistent', key: string): string {
    return join(`${this.storageFile}.d`, `${area}-${hashKey(key)}.json`);
  }

  private load() {
    return (this.storage ??= (async () => {
      const identity = await this.cdp.browserSessionIdentity();
      pruneCdpSessionStorage(this.storageFile, identity);
      return {
        identity,
        session: {} as Record<string, any>,
        persistent: {} as Record<string, any>,
      };
    })());
  }

  listen(listeners: Listeners): () => void {
    this.listeners = listeners;
    const removeConnected = this.cdp.onBrowserConnected(() => {
      void this.watchBrowser().catch(() => {});
    });
    void this.watchBrowser().catch(() => {});
    return () => {
      this.stopped = true;
      this.listeners = undefined;
      removeConnected();
      this.removeDestroyed?.();
      for (const port of this.ports.values()) port.disconnect();
      for (const target of this.targets.values())
        void target.then(value => value.dispose()).catch(() => {});
      this.targets.clear();
    };
  }

  private watchedBrowser?: Awaited<ReturnType<CdpSession['getBrowserClient']>>;
  private removeDestroyed?: () => void;
  private async watchBrowser() {
    const browser = await this.cdp.getBrowserClient();
    if (this.stopped || browser === this.watchedBrowser) return;
    this.removeDestroyed?.();
    this.watchedBrowser = browser;
    const state = await this.load();
    if (state.identity !== browser.identity) {
      for (const target of this.targets.values())
        void target.then(value => value.dispose()).catch(() => {});
      this.targets.clear();
      state.identity = browser.identity;
      state.session = {};
      await this.listeners?.reset();
    }
    if (this.stopped || browser !== this.watchedBrowser) return;
    const removeDestroyed = browser.on('Target.targetDestroyed', ({ targetId }) => {
      const pending = this.targets.get(targetId);
      if (!pending) return;
      this.targets.delete(targetId);
      void pending
        .then(target => {
          target.dispose();
          if (target.mainTarget) this.listeners?.removed(target.tabId);
          else
            this.listeners?.committed({
              tabId: target.tabId,
              frameId: target.mainFrameId,
              documentId: `departed:${randomUUID()}`,
              url: '',
            });
        })
        .catch(() => {});
    });
    const changed = ({ targetInfo }: any) => {
      if (targetInfo?.type !== 'page' || !/^https?:/.test(targetInfo.url)) return;
      void this.cdp
        .ensureTargetRegistered(targetInfo.targetId)
        .then(tabId => this.listeners?.completed({ tabId }))
        .catch(() => {});
    };
    const removeCreated = browser.on('Target.targetCreated', changed);
    const removeChanged = browser.on('Target.targetInfoChanged', changed);
    this.removeDestroyed = () => {
      removeDestroyed();
      removeCreated();
      removeChanged();
    };
    await browser.sendCommand('Target.setDiscoverTargets', { discover: true });
  }

  async tabs(): Promise<number[]> {
    const browser = await this.cdp.getBrowserClient();
    const { targetInfos = [] } = await browser.sendCommand('Target.getTargets', {});
    return Promise.all(
      targetInfos
        .filter((target: any) => target.type === 'page' && /^https?:/.test(target.url))
        .map((target: any) => this.cdp.ensureTargetRegistered(target.targetId)),
    );
  }

  private target(tabId: number, targetId: string): Promise<Target> {
    const previous = this.targets.get(targetId);
    if (previous)
      return previous.then(target => {
        if (!target.client.closed) return target;
        if (this.targets.get(targetId) === previous) this.targets.delete(targetId);
        target.dispose();
        return this.target(tabId, targetId);
      });
    const pending = this.attachTarget(tabId, targetId);
    this.targets.set(targetId, pending);
    void pending.catch(() => {
      if (this.targets.get(targetId) === pending) this.targets.delete(targetId);
    });
    return pending;
  }

  private async attachTarget(tabId: number, targetId: string): Promise<Target> {
    const parent = await this.cdp.getBrowserClient();
    const page = await this.cdp.getPageSession(tabId);
    const { sessionId } = await parent.sendCommand('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const client = parent.createChildSession(sessionId);
    const disposers: Array<() => void> = [];
    const target: Target = {
      tabId,
      targetId,
      parent,
      client,
      mainFrameId: '',
      mainTarget: page.targetId === targetId,
      frames: new Map(),
      documents: new Map(),
      worlds: new Map(),
      dispose: () => {
        for (const remove of disposers.splice(0)) remove();
        for (const [id, port] of this.ports)
          if (port.target === target) {
            port.disconnect();
            this.ports.delete(id);
          }
        target.documents.clear();
        target.worlds.clear();
        void parent.sendCommand('Target.detachFromTarget', { sessionId }, 3000).catch(() => {});
      },
    };
    const invalidate = (frameId: string) => {
      target.documents.delete(frameId);
      for (const [name, world] of target.worlds)
        if (world.frameId === frameId) target.worlds.delete(name);
      for (const [id, port] of this.ports)
        if (
          port.target === target &&
          ![...target.worlds.values()].some(world => world.contextId === port.contextId)
        ) {
          port.disconnect();
          this.ports.delete(id);
        }
      this.listeners?.committed({
        tabId,
        frameId,
        documentId: `departed:${randomUUID()}`,
        url: target.frames.get(frameId) ?? '',
        mainFrame: target.mainTarget && frameId === target.mainFrameId,
      });
    };
    disposers.push(
      client.on('Runtime.executionContextCreated', ({ context }) => {
        const frameId = context?.auxData?.frameId;
        if (typeof frameId !== 'string' || context.auxData.isDefault !== true) return;
        target.documents.set(frameId, {
          contextId: context.id,
          documentId: typeof context.uniqueId === 'string' ? context.uniqueId : randomUUID(),
        });
        queueMicrotask(() => {
          if (!this.stopped) this.listeners?.completed({ tabId });
        });
      }),
      client.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
        for (const [frameId, document] of target.documents)
          if (document.contextId === executionContextId) invalidate(frameId);
        for (const [name, world] of target.worlds)
          if (world.contextId === executionContextId) target.worlds.delete(name);
        for (const port of this.ports.values())
          if (port.target === target && port.contextId === executionContextId) port.disconnect();
      }),
      client.on('Runtime.executionContextsCleared', () => {
        for (const frameId of [...target.documents.keys()]) invalidate(frameId);
      }),
      client.on('Page.frameNavigated', ({ frame }) => {
        target.frames.set(frame.id, frame.url);
        invalidate(frame.id);
      }),
      client.on('Page.frameDetached', ({ frameId }) => invalidate(frameId)),
      client.on('Page.navigatedWithinDocument', ({ frameId, url }) => {
        target.frames.set(frameId, url);
        const document = target.documents.get(frameId);
        if (document)
          this.listeners?.navigation({ tabId, frameId, documentId: document.documentId, url });
      }),
      client.on('Runtime.bindingCalled', params => {
        void this.receive(target, params).catch(() => {});
      }),
    );
    try {
      const { frameTree } = await client.sendCommand('Page.getFrameTree', {});
      const append = (tree: any) => {
        target.frames.set(tree.frame.id, tree.frame.url);
        for (const child of tree.childFrames ?? []) append(child);
      };
      target.mainFrameId = frameTree.frame.id;
      append(frameTree);
      await client.sendCommand('Page.enable');
      await client.sendCommand('Runtime.addBinding', { name: this.binding });
      await client.sendCommand('Runtime.enable');
      if (this.stopped) throw new Error('CDP page host stopped during attachment');
      return target;
    } catch (error) {
      target.dispose();
      throw error;
    }
  }

  private async documentTarget(tabId: number, frame: PluginPageFrame, expectedDocumentId?: string) {
    const page = await this.cdp.getPageSession(tabId);
    let target = await this.target(tabId, page.targetId);
    let frameId = frame === 'main' || frame === 0 ? target.mainFrameId : frame;
    if (frame === 'business') {
      const endpoint = await resolveCdpDeviceShellPageEndpoint(page);
      frameId =
        endpoint.frameId ??
        (endpoint.client === page.client
          ? target.mainFrameId
          : (await endpoint.client.sendCommand('Page.getFrameTree', {})).frameTree.frame.id);
    }
    if (typeof frameId !== 'string' || !frameId)
      throw new Error('CDP plugin pages require a frame ID from page_frames');
    if (!target.documents.has(frameId)) {
      const entries = await readCdpFrameEntries(page);
      const entry = entries.find(entry => entry.frame.frameId === frameId);
      if (!entry) throw new Error('PLUGIN_PAGE_DOCUMENT_UNAVAILABLE: CDP frame is unavailable');
      target = await this.target(tabId, entry.targetId);
    }
    const document = target.documents.get(frameId);
    if (
      !document ||
      (expectedDocumentId !== undefined && expectedDocumentId !== document.documentId)
    )
      throw new Error('PLUGIN_PAGE_INVALIDATED: CDP document changed');
    const url = target.frames.get(frameId);
    if (!url || (!/^https?:/.test(url) && !(target.targetId === page.targetId && frameId === target.mainFrameId && url.startsWith('file:///'))))
      throw new Error('Plugin pages require an HTTP(S) document or a main-frame local preview');
    return { target, identity: { tabId, frameId, documentId: document.documentId, url } };
  }

  async resolve(
    tabId: number,
    frame: PluginPageFrame,
    expectedDocumentId?: string,
  ): Promise<Omit<PluginPageTarget, 'browserSessionId'>> {
    return (await this.documentTarget(tabId, frame, expectedDocumentId)).identity;
  }

  async execute(instance: PluginPageInstance, code: string, timeoutMs = 30000): Promise<any> {
    const identity = instance.target;
    const { target, identity: current } = await this.documentTarget(
      identity.tabId,
      identity.frameId,
      identity.documentId,
    );
    const key = `${identity.frameId}:${instance.plugin}`;
    let world = target.worlds.get(key);
    if (!world || world.documentId !== current.documentId) {
      const context = await target.client.sendCommand('Page.createIsolatedWorld', {
        frameId: identity.frameId,
        worldName: `mearl-page-${instance.plugin}`,
      });
      world = {
        contextId: context.executionContextId,
        documentId: current.documentId,
        frameId: String(identity.frameId),
      };
      target.worlds.set(key, world);
      try {
        const installed = await target.client.sendCommand('Runtime.evaluate', {
          expression: `(${installCdpPluginPageBridge.toString()})(${JSON.stringify(this.binding)})`,
          contextId: world.contextId,
          returnByValue: true,
        });
        if (installed.exceptionDetails)
          throw new Error(
            installed.exceptionDetails.text ?? 'CDP page bridge could not be installed',
          );
      } catch (error) {
        if (target.worlds.get(key) === world) target.worlds.delete(key);
        throw error;
      }
    }
    const reply = await target.client.sendCommand(
      'Runtime.evaluate',
      {
        expression: `(async () => { try { return { ok: true, value: await (${code}\n) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })()`,
        contextId: world.contextId,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs,
    );
    await this.resolve(identity.tabId, identity.frameId, identity.documentId);
    if (reply.exceptionDetails || reply.result?.value?.ok !== true)
      throw new Error(
        reply.result?.value?.error ?? reply.exceptionDetails?.text ?? 'CDP page returned no result',
      );
    return reply.result.value.value;
  }

  reconnect(instance: PluginPageInstance): Promise<boolean> {
    return this.execute(
      instance,
      `(() => { const instance = globalThis.__mearlPluginPageInstances?.get(${JSON.stringify(instance.instanceId)}); if (!instance) return false; instance.reconnect(); return true; })()`,
    );
  }

  private async receive(target: Target, params: any): Promise<void> {
    if (
      this.stopped ||
      params.name !== this.binding ||
      typeof params.payload !== 'string' ||
      params.payload.length > 128 * 1024
    )
      return;
    const world = [...target.worlds.values()].find(
      world =>
        world.contextId === params.executionContextId &&
        target.documents.get(world.frameId)?.documentId === world.documentId,
    );
    if (!world) return;
    const message = JSON.parse(params.payload);
    if (typeof message.id !== 'string' || message.id.length > 80) return;
    if (message.type !== 'connect') {
      const connection = this.ports.get(message.id);
      if (
        !connection ||
        connection.target !== target ||
        connection.contextId !== params.executionContextId
      )
        return;
      if (message.type === 'disconnect') {
        connection.disconnect();
        this.ports.delete(message.id);
      } else if (message.type === 'message') connection.message(message.message);
      return;
    }
    if (typeof message.name !== 'string' || this.ports.has(message.id) || this.ports.size >= 64)
      return;
    const events = new Set<(value: any) => void>(),
      disconnects = new Set<() => void>();
    let connected = true;
    const connection = {
      target,
      contextId: params.executionContextId,
      message: (value: any) => {
        for (const listener of events) listener(value);
      },
      disconnect: () => {
        if (!connected) return;
        connected = false;
        this.ports.delete(message.id);
        for (const listener of disconnects) listener();
      },
    };
    this.ports.set(message.id, connection);
    const deliver = (value: any) =>
      target.client
        .sendCommand(
          'Runtime.evaluate',
          {
            expression: `globalThis.__mearlPluginPageReceive?.(${JSON.stringify(message.id)},${JSON.stringify(value)})`,
            contextId: params.executionContextId,
            returnByValue: true,
          },
          5000,
        )
        .catch(() => connection.disconnect());
    const port: PluginPagePort = {
      name: message.name,
      sender: { tab: { id: target.tabId }, frameId: world.frameId, documentId: world.documentId },
      postMessage: value => {
        if (connected) void deliver(value);
      },
      disconnect: () => {
        void deliver({ type: 'disconnect' });
        connection.disconnect();
      },
      onMessage: { addListener: listener => events.add(listener) },
      onDisconnect: { addListener: listener => disconnects.add(listener) },
    };
    this.listeners?.connect(port);
  }
}

export class CdpPluginPageHost extends PluginPageRuntimeHost {
  constructor(
    cdp: CdpSession,
    native: PluginPageNativeCall,
    options: { browserId: string; storageFile?: string },
  ) {
    super(
      native,
      new CdpPageAdapter(
        cdp,
        options.storageFile ?? keyedConfigFile('plugin-pages', options.browserId),
      ),
    );
  }
}
