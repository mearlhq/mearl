import { installPluginPageRuntime } from './pluginPageRuntime.js';
import {
  isPluginPageInstanceId,
  isPluginPageMatchPattern,
  matchesPluginPageURL,
  isPluginPageInvalidation,
  isPluginPageUnavailable,
  pluginPageUnavailable,
  PLUGIN_PAGE_LEASE_MS,
} from './pluginPages.js';
import type {
  PluginPageActivation,
  PluginPageFrame,
  PluginPageInstance,
  PluginPageRuntime,
  PluginPageTarget,
} from './pluginPages.js';

export type PluginPageNativeCall = (action: string, data: Record<string, unknown>) => Promise<any>;
interface RecordState {
  instance: PluginPageInstance;
  runtime: PluginPageRuntime;
  frame: PluginPageFrame;
  input: Record<string, unknown>;
  token: string;
  accepted: number;
  pending: Array<{ sequence: number; name: string; payload: unknown }>;
  expires: number;
  activationGeneration?: number;
}
interface Rule extends PluginPageActivation {
  allowedMatches: string[];
}
const SESSION_KEY = 'pluginPageHost.v1';
const RULE_KEY = 'pluginPageActivations.v1';
const LEASE_KEY = 'pluginPageLeases.v1';

export interface PluginPagePort {
  name: string;
  sender?: { tab?: { id?: number }; frameId?: string | number; documentId?: string };
  postMessage(message: any): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: any) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
export interface PluginPageNavigationDetails {
  tabId: number;
  frameId: string | number;
  documentId?: string;
  url: string;
  mainFrame?: boolean;
}
export interface PluginPageHostAdapter {
  session: {
    get(keys: string[]): Promise<Record<string, any>>;
    set(values: Record<string, any>): Promise<void>;
  };
  persistent: {
    get(keys: string[]): Promise<Record<string, any>>;
    set(values: Record<string, any>): Promise<void>;
  };
  resolve(
    tabId: number,
    frame: PluginPageFrame,
    expectedDocumentId?: string,
  ): Promise<Omit<PluginPageTarget, 'browserSessionId'>>;
  execute(instance: PluginPageInstance, code: string, timeoutMs?: number): Promise<any>;
  reconnect?(instance: PluginPageInstance): Promise<boolean>;
  tabs(): Promise<number[]>;
  listen(listeners: {
    connect: (port: PluginPagePort) => void;
    committed: (details: PluginPageNavigationDetails) => void;
    completed: (details: { tabId: number }) => void;
    navigation: (details: PluginPageNavigationDetails) => void;
    removed: (tabId: number) => void;
    reset: () => Promise<void>;
  }): () => void;
}

export class PluginPageRuntimeHost {
  private readonly records = new Map<string, RecordState>();
  private readonly ports = new Map<string, { port: PluginPagePort; epoch: string }>();
  private readonly pumping = new Set<string>();
  private readonly synchronizing = new Map<string, Promise<boolean>>();
  private readonly activating = new Map<string, Promise<unknown>>();
  private readonly activationPending = new Set<string>();
  private readonly rules = new Map<string, Rule>();
  private readonly transfers = new Map<
    string,
    {
      instanceId: string;
      bytes: number;
      sha256: string;
      chunks: Uint8Array[];
      received: number;
      updatedAt: number;
    }
  >();
  private readonly results = new Map<
    string,
    { instanceId: string; bytes: Uint8Array; sha256: string; updatedAt: number }
  >();
  private readonly generations = new Map<string, number>();
  private writes = Promise.resolve();
  private leasesDirty = false;
  private sessionId = '';
  private ready: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private ticking?: Promise<void>;

  private readonly unlisten: () => void;
  constructor(
    private readonly native: PluginPageNativeCall,
    private readonly adapter: PluginPageHostAdapter,
  ) {
    this.ready = this.load();
    this.unlisten = adapter.listen({
      connect: this.connect,
      committed: this.committed,
      completed: this.completed,
      navigation: this.navigation,
      removed: this.removed,
      reset: this.reset,
    });
    this.timer = setInterval(() => {
      void this.saveLeases().catch(() => {});
      void this.tick().catch(() => {});
    }, 5000);
    void this.ready
      .then(() => this.tick())
      .catch(error => console.warn('[plugin-page] Startup reconciliation failed', error));
  }

  private async load(): Promise<void> {
    const [session, local] = await Promise.all([
      this.adapter.session.get([SESSION_KEY, RULE_KEY, LEASE_KEY]),
      this.adapter.persistent.get([RULE_KEY]),
    ]);
    const stored = session[SESSION_KEY];
    this.sessionId = stored?.browserSessionId ?? crypto.randomUUID();
    for (const record of stored?.records ?? [])
      if (isPluginPageInstanceId(record?.instance?.instanceId)) {
        const lease = session[LEASE_KEY]?.[record.instance.instanceId];
        if (lease?.token === record.token && Number.isFinite(lease.expires))
          record.expires = Math.max(record.expires, lease.expires);
        this.records.set(record.instance.instanceId, record);
      }
    for (const rule of [...(local[RULE_KEY] ?? []), ...(session[RULE_KEY] ?? [])])
      if (typeof rule.installationId === 'string') this.rules.set(rule.plugin, rule);
    for (const [plugin, generation] of Object.entries(stored?.generations ?? {}))
      this.generations.set(plugin, Number(generation));
    await this.save();
  }
  private reset = (): Promise<void> => {
    return (this.ready = this.ready.then(async () => {
      if (this.disposed) return;
      this.sessionId = crypto.randomUUID();
      for (const [plugin, rule] of this.rules) {
        this.generations.set(plugin, (this.generations.get(plugin) ?? 0) + 1);
        if (rule.persistence !== 'persistent') this.rules.delete(plugin);
      }
      await Promise.all([...this.records.values()].map(record => this.remove(record)));
      await this.adapter.session.set({ [RULE_KEY]: [], [LEASE_KEY]: {} });
      await this.save();
      void this.activateAll().catch(error =>
        console.warn('[plugin-page] Activation failed', error),
      );
    }));
  };
  private save(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const snapshot = JSON.parse(
      JSON.stringify({
        browserSessionId: this.sessionId,
        records: [...this.records.values()],
        generations: Object.fromEntries(this.generations),
      }),
    );
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 6 * 1024 * 1024)
      return Promise.reject(new Error('Plugin page session storage exceeds 6 MiB'));
    this.writes = this.writes
      .catch(() => {})
      .then(() =>
        this.disposed ? undefined : this.adapter.session.set({ [SESSION_KEY]: snapshot }),
      );
    return this.writes;
  }

  private saveLeases(): Promise<void> {
    if (!this.leasesDirty || this.disposed) return Promise.resolve();
    this.leasesDirty = false;
    const leases = Object.fromEntries(
      [...this.records].map(([id, record]) => [
        id,
        { token: record.token, expires: record.expires },
      ]),
    );
    this.writes = this.writes
      .catch(() => {})
      .then(() => (this.disposed ? undefined : this.adapter.session.set({ [LEASE_KEY]: leases })))
      .catch(error => {
        this.leasesDirty = true;
        throw error;
      });
    return this.writes;
  }

  private execute(record: RecordState, code: string, timeoutMs?: number): Promise<any> {
    return this.adapter.execute(record.instance, code, timeoutMs);
  }

  private async resolve(
    tabId: unknown,
    frame: unknown = 'business',
    expectedDocumentId?: unknown,
  ): Promise<PluginPageTarget> {
    if (!Number.isSafeInteger(tabId) || Number(tabId) < 0)
      throw new Error('Plugin page requires an explicit tabId');
    if (
      !(
        (typeof frame === 'string' && frame.length > 0 && frame.length <= 256) ||
        (Number.isSafeInteger(frame) && Number(frame) >= 0)
      )
    )
      throw new Error('Invalid plugin page frame selector');
    if (expectedDocumentId !== undefined && typeof expectedDocumentId !== 'string')
      throw new Error('Invalid plugin page document identity');
    const target = await this.adapter.resolve(
      Number(tabId),
      frame as PluginPageFrame,
      expectedDocumentId as string | undefined,
    );
    const url = new URL(target.url);
    if (!['http:', 'https:'].includes(url.protocol) && (url.protocol !== 'file:' || url.hostname || frame !== 'main'))
      throw new Error('Plugin pages require an HTTP(S) document or a main-frame local preview');
    return { ...target, browserSessionId: this.sessionId };
  }

  private async current(record: RecordState): Promise<void> {
    if (this.records.get(record.instance.instanceId) !== record)
      throw new Error('PLUGIN_PAGE_INVALIDATED: Instance was detached');
    let target: PluginPageTarget;
    try {
      target = await this.resolve(
        record.instance.target.tabId,
        record.frame,
        record.instance.target.documentId,
      );
    } catch (error) {
      if (isPluginPageInvalidation(error)) throw error;
      throw pluginPageUnavailable(error);
    }
    if (this.records.get(record.instance.instanceId) !== record)
      throw new Error('PLUGIN_PAGE_INVALIDATED: Instance was detached');
    this.assertActivation(record.instance.plugin, record.activationGeneration, target.url);
    if (
      target.frameId !== record.instance.target.frameId ||
      !matchesPluginPageURL(record.runtime.matches, target.url)
    )
      throw new Error('PLUGIN_PAGE_INVALIDATED: Page target or allowed URL changed');
    record.instance.target.url = target.url;
  }
  private async remove(record: RecordState, notify = true): Promise<void> {
    if (!this.records.delete(record.instance.instanceId)) return;
    this.leasesDirty = true;
    for (const [id, transfer] of this.transfers)
      if (transfer.instanceId === record.instance.instanceId) this.transfers.delete(id);
    for (const [id, result] of this.results)
      if (result.instanceId === record.instance.instanceId) this.results.delete(id);
    const connected = this.ports.get(record.instance.instanceId);
    this.ports.delete(record.instance.instanceId);
    try {
      connected?.port.postMessage({ type: 'dispose' });
    } catch {
      /* The document may already be gone. */
    }
    connected?.port.disconnect();
    try {
      await this.execute(
        record,
        `globalThis.__mearlPluginPageInstances?.get(${JSON.stringify(record.instance.instanceId)})?.dispose()`,
      );
    } catch {
      /* A departed document needs no script cleanup. */
    }
    await this.save();
    if (notify)
      void this.native('plugin_page_event', {
        plugin: record.instance.plugin,
        input: {
          instanceId: record.instance.instanceId,
          kind: 'invalidated',
          target: record.instance.target,
        },
      }).catch(() => {});
  }

  async handle(data: Record<string, any>): Promise<any> {
    await this.ready;
    if (this.disposed) throw new Error('Plugin page host is unavailable');
    if (data.operation === 'result_chunk' || data.operation === 'result_release') {
      const result = this.results.get(data.resultId);
      const record = this.records.get(data.instanceId);
      if (
        !record ||
        !result ||
        result.instanceId !== data.instanceId ||
        record.instance.target.tabId !== data.tabId
      )
        throw new Error('Plugin page result was not found');
      await this.current(record);
      if (data.operation === 'result_release') {
        this.results.delete(data.resultId);
        return { released: true };
      }
      const chunks = Math.ceil(result.bytes.length / (192 * 1024));
      if (!Number.isSafeInteger(data.index) || data.index < 0 || data.index >= chunks)
        throw new Error('Invalid plugin page result chunk');
      result.updatedAt = Date.now();
      const part = result.bytes.subarray(data.index * 192 * 1024, (data.index + 1) * 192 * 1024);
      let binary = '';
      for (let offset = 0; offset < part.length; offset += 8192)
        binary += String.fromCharCode(...part.subarray(offset, offset + 8192));
      return {
        resultId: data.resultId,
        index: data.index,
        bytes: result.bytes.length,
        chunks,
        sha256: result.sha256,
        data: btoa(binary),
      };
    }
    if (String(data.operation).startsWith('message_')) {
      const record = this.records.get(data.instanceId);
      if (
        !record ||
        record.instance.target.tabId !== data.tabId ||
        !/^[a-f0-9-]{36}$/i.test(data.transferId)
      )
        throw new Error('Invalid page message transfer');
      await this.current(record);
      if (data.operation === 'message_abort') {
        this.transfers.delete(data.transferId);
        return { aborted: true };
      }
      if (data.operation === 'message_begin') {
        const reserved = [...this.transfers.values()].reduce((sum, value) => sum + value.bytes, 0);
        if (
          !Number.isSafeInteger(data.bytes) ||
          data.bytes < 1 ||
          data.bytes > 24 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(data.sha256) ||
          this.transfers.has(data.transferId) ||
          this.transfers.size >= 8 ||
          reserved + data.bytes > 32 * 1024 * 1024
        )
          throw new Error('Page message transfer exceeds its resource limits');
        this.transfers.set(data.transferId, {
          instanceId: data.instanceId,
          bytes: data.bytes,
          sha256: data.sha256,
          chunks: [],
          received: 0,
          updatedAt: Date.now(),
        });
        return { accepted: true };
      }
      const transfer = this.transfers.get(data.transferId);
      if (!transfer || transfer.instanceId !== data.instanceId)
        throw new Error('Page message transfer was not found');
      if (data.operation === 'message_chunk') {
        if (
          data.index !== transfer.chunks.length ||
          typeof data.data !== 'string' ||
          data.data.length > 256 * 1024
        )
          throw new Error('Invalid page message chunk');
        const chunk = Uint8Array.from(atob(data.data), value => value.charCodeAt(0));
        if (!chunk.length || transfer.received + chunk.length > transfer.bytes)
          throw new Error('Page message size mismatch');
        transfer.chunks.push(chunk);
        transfer.received += chunk.length;
        transfer.updatedAt = Date.now();
        return { accepted: true };
      }
      if (data.operation !== 'message_commit')
        throw new Error('Unknown page message transfer operation');
      this.transfers.delete(data.transferId);
      if (transfer.received !== transfer.bytes) throw new Error('Page message is incomplete');
      const bytes = new Uint8Array(transfer.bytes);
      let offset = 0;
      for (const chunk of transfer.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value =>
        value.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== transfer.sha256) throw new Error('Page message integrity check failed');
      return this.handle({
        operation: 'send',
        instanceId: data.instanceId,
        tabId: data.tabId,
        requestId: data.requestId,
        timeoutSec: data.timeoutSec,
        message: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      });
    }
    switch (data.operation) {
      case 'session':
        return { browserSessionId: this.sessionId };
      case 'resolve':
        return this.resolve(data.tabId, data.frame ?? 'business', data.expectedDocumentId);
      case 'activation':
        return this.activation(data);
      case 'attach': {
        const instance = data.instance as PluginPageInstance;
        if (
          !instance ||
          !isPluginPageInstanceId(instance.instanceId) ||
          !instance.host?.hostId ||
          !instance.host.epoch ||
          !/^[a-z][a-z0-9_-]*$/.test(instance.plugin) ||
          !data.runtime?.code ||
          !Array.isArray(data.runtime.matches)
        )
          throw new Error('Invalid plugin page attachment');
        if (this.records.size >= 32) throw new Error('Too many active plugin page instances');
        const target = await this.resolve(
          instance.target.tabId,
          data.frame ?? 'business',
          instance.target.documentId,
        );
        if (
          target.browserSessionId !== instance.target.browserSessionId ||
          target.frameId !== instance.target.frameId ||
          !matchesPluginPageURL(data.runtime.matches, target.url)
        )
          throw new Error('PLUGIN_PAGE_INVALIDATED: Page attachment target changed');
        this.assertActivation(instance.plugin, data.activationGeneration, target.url);
        if (new TextEncoder().encode(JSON.stringify(data.input ?? {})).length > 64 * 1024)
          throw new Error('Plugin page input exceeds 64 KiB');
        const record: RecordState = {
          instance: { ...instance, target },
          runtime: data.runtime,
          input: data.input ?? {},
          frame: data.frame ?? 'business',
          token: crypto.randomUUID(),
          accepted: 0,
          pending: [],
          expires: Date.now() + PLUGIN_PAGE_LEASE_MS,
          activationGeneration: data.activationGeneration,
        };
        this.records.set(instance.instanceId, record);
        try {
          await this.save();
          await this.current(record);
          const config = {
            instanceId: instance.instanceId,
            token: record.token,
            identity: instance,
            input: record.input,
            events: record.runtime.events ?? {},
          };
          await this.execute(
            record,
            `(${installPluginPageRuntime.toString()})(${JSON.stringify(config)}, (${record.runtime.code}\n),globalThis.__mearlPluginPageConnect)`,
          );
          await this.current(record);
          return record.instance;
        } catch (error) {
          await this.remove(record, false);
          throw error;
        }
      }
      case 'cancel': {
        const record = this.records.get(data.instanceId);
        if (
          !record ||
          record.instance.target.tabId !== data.tabId ||
          typeof data.requestId !== 'string'
        )
          throw new Error('Plugin page request was not found');
        await this.current(record);
        await this.execute(
          record,
          `globalThis.__mearlPluginPageInstances?.get(${JSON.stringify(data.instanceId)})?.cancel(${JSON.stringify(data.requestId)})`,
        );
        return { cancelled: true };
      }
      case 'detach': {
        const record = this.records.get(data.instanceId);
        if (record) await this.remove(record, false);
        return { detached: true };
      }
      case 'get':
      case 'send': {
        const record = this.records.get(data.instanceId);
        if (!record || record.instance.target.tabId !== data.tabId)
          throw new Error('PLUGIN_PAGE_NOT_FOUND: Plugin page instance was not found');
        if (record.expires <= Date.now()) {
          await this.remove(record);
          throw new Error('PLUGIN_PAGE_INVALIDATED: Plugin page execution lease expired');
        }
        try {
          await this.current(record);
        } catch (error) {
          if (!isPluginPageUnavailable(error)) await this.remove(record);
          throw error;
        }
        record.expires = Date.now() + PLUGIN_PAGE_LEASE_MS;
        this.leasesDirty = true;
        if (data.operation === 'get') {
          if (data.retainManual === true && record.activationGeneration !== undefined) {
            record.activationGeneration = undefined;
            await this.save();
          }
          return record.instance;
        }
        if (
          new TextEncoder().encode(JSON.stringify(data.message ?? null)).length >
          24 * 1024 * 1024
        )
          throw new Error('Plugin page message exceeds 24 MiB');
        const result = await this.execute(
          record,
          `globalThis.__mearlPluginPageInstances?.get(${JSON.stringify(data.instanceId)})?.send(${JSON.stringify(data.message ?? null)},${JSON.stringify(data.requestId ?? null)})`,
          data.timeoutSec === undefined ? undefined : data.timeoutSec * 1000,
        );
        await this.current(record);
        const bytes = new TextEncoder().encode(JSON.stringify(result ?? null));
        if (bytes.length <= 192 * 1024) return { kind: 'value', value: result ?? null };
        if (
          bytes.length > 24 * 1024 * 1024 ||
          this.results.size >= 8 ||
          [...this.results.values()].reduce(
            (total, result) => total + result.bytes.length,
            bytes.length,
          ) >
            32 * 1024 * 1024
        )
          throw new Error('Plugin page results exceed resource limits');
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          value => value.toString(16).padStart(2, '0'),
        ).join('');
        const resultId = crypto.randomUUID();
        this.results.set(resultId, {
          instanceId: data.instanceId,
          bytes,
          sha256,
          updatedAt: Date.now(),
        });
        return {
          kind: 'resource',
          resultId,
          bytes: bytes.length,
          chunks: Math.ceil(bytes.length / (192 * 1024)),
          sha256,
        };
      }
      default:
        throw new Error('Unknown page runtime operation');
    }
  }

  private connect = (port: PluginPagePort): void => {
    if (!port.name.startsWith('mearl-plugin-page:')) return;
    void this.ready
      .then(async () => {
        const [, instanceId, token] = port.name.split(':');
        const record = this.records.get(instanceId);
        if (
          !record ||
          token !== record.token ||
          port.sender?.tab?.id !== record.instance.target.tabId ||
          port.sender?.frameId !== record.instance.target.frameId ||
          port.sender?.documentId !== record.instance.target.documentId ||
          this.disposed
        ) {
          port.disconnect();
          return;
        }
        try {
          await this.current(record);
        } catch {
          port.disconnect();
          await this.remove(record);
          return;
        }
        const previous = this.ports.get(instanceId);
        const connection = { port, epoch: crypto.randomUUID() };
        this.ports.set(instanceId, connection);
        previous?.port.disconnect();
        port.onMessage.addListener(message => {
          if (
            this.ports.get(instanceId) !== connection ||
            message?.epoch !== connection.epoch ||
            message.type !== 'event'
          )
            return;
          let payloadBytes: number;
          try {
            payloadBytes = new TextEncoder().encode(JSON.stringify(message.payload ?? null)).length;
          } catch {
            void this.remove(record).catch(() => {});
            return;
          }
          if (
            !Number.isSafeInteger(message.sequence) ||
            message.sequence < 1 ||
            typeof message.name !== 'string' ||
            !Object.hasOwn(record.runtime.events ?? {}, message.name) ||
            payloadBytes > 32768
          ) {
            void this.remove(record).catch(() => {});
            return;
          }
          if (message.sequence <= record.accepted) {
            port.postMessage({ type: 'accepted', sequence: message.sequence });
            return;
          }
          if (record.pending.some(item => item.sequence === message.sequence)) return;
          if (
            record.pending.length >= 64 ||
            message.sequence !== record.accepted + record.pending.length + 1
          ) {
            void this.remove(record).catch(() => {});
            return;
          }
          record.pending.push({
            sequence: message.sequence,
            name: message.name,
            payload: message.payload,
          });
          void this.save()
            .then(() => this.pump(record))
            .catch(() => this.remove(record))
            .catch(() => {});
        });
        port.onDisconnect.addListener(() => {
          if (this.ports.get(instanceId) === connection) this.ports.delete(instanceId);
        });
        port.postMessage({ type: 'ready', epoch: connection.epoch });
        void this.pump(record);
      })
      .catch(() => port.disconnect());
  };

  private async pump(record: RecordState): Promise<void> {
    const id = record.instance.instanceId;
    if (this.pumping.has(id) || !this.records.has(id)) return;
    this.pumping.add(id);
    try {
      if (!(await this.synchronize(record))) return;
      while (record.pending.length && this.records.has(id)) {
        await this.current(record);
        const event = record.pending[0];
        const result = await this.native('plugin_page_event', {
          plugin: record.instance.plugin,
          input: {
            instanceId: id,
            kind: 'event',
            eventSequence: event.sequence,
            name: event.name,
            payload: event.payload,
          },
        });
        if (this.disposed || this.records.get(id) !== record) return;
        if (result?.error) {
          if (result.error.code === 'PLUGIN_PAGE_QUEUE_FULL') return;
          await this.remove(record);
          return;
        }
        if (result?.accepted !== true)
          throw new Error('Page event host returned no acknowledgement');
        record.accepted = Math.max(record.accepted, event.sequence);
        record.pending = record.pending.filter(pending => pending.sequence !== event.sequence);
        await this.save();
        this.ports.get(id)?.port.postMessage({ type: 'accepted', sequence: event.sequence });
      }
    } catch {
      /* Durable pending events retry after the bridge recovers. */
    } finally {
      this.pumping.delete(id);
    }
  }

  private synchronize(record: RecordState): Promise<boolean> {
    const id = record.instance.instanceId;
    let pending = this.synchronizing.get(id);
    if (!pending) {
      pending = this.syncRecord(record).finally(() => this.synchronizing.delete(id));
      this.synchronizing.set(id, pending);
    }
    return pending;
  }

  private async syncRecord(record: RecordState): Promise<boolean> {
    if (!record.instance.host) {
      await this.remove(record);
      return false;
    }
    const accepted = record.accepted;
    const reply = await this.native('plugin_page_event', {
      plugin: record.instance.plugin,
      input: {
        kind: 'sync',
        browserSessionId: this.sessionId,
        instances: [record.instance],
      },
    });
    if (this.disposed || this.records.get(record.instance.instanceId) !== record) return false;
    if (
      reply?.error ||
      !reply?.host?.hostId ||
      !reply.host.epoch ||
      !Array.isArray(reply.instances)
    )
      throw new Error('Page execution service reconciliation is unavailable');
    const found = reply.instances.find(
      (item: any) => item?.instance?.instanceId === record.instance.instanceId,
    );
    const target = found?.instance?.target;
    if (
      reply.host.hostId !== record.instance.host.hostId ||
      reply.host.epoch !== record.instance.host.epoch ||
      !found ||
      found.instance.installationId !== record.instance.installationId ||
      found.instance.revision !== record.instance.revision ||
      target?.browserSessionId !== this.sessionId ||
      target.documentId !== record.instance.target.documentId ||
      target.frameId !== record.instance.target.frameId ||
      target.tabId !== record.instance.target.tabId ||
      !Number.isSafeInteger(found.lastReceived) ||
      found.lastReceived < accepted
    ) {
      await this.remove(record);
      return false;
    }
    const acknowledged = record.pending.filter(event => event.sequence <= found.lastReceived);
    record.pending = record.pending.filter(event => event.sequence > found.lastReceived);
    record.accepted = Math.max(record.accepted, found.lastReceived);
    if (acknowledged.length || record.accepted !== accepted) await this.save();
    for (const event of acknowledged)
      this.ports
        .get(record.instance.instanceId)
        ?.port.postMessage({ type: 'accepted', sequence: event.sequence });
    return true;
  }

  private assertActivation(plugin: string, generation?: number, url?: string): void {
    if (
      generation !== undefined &&
      (!this.rules.has(plugin) || (this.generations.get(plugin) ?? 0) !== generation)
    )
      throw new Error('PLUGIN_PAGE_INVALIDATED: Activation rule changed');
    const rule = this.rules.get(plugin);
    if (
      generation !== undefined &&
      rule &&
      url &&
      (!matchesPluginPageURL(rule.matches, url) || !matchesPluginPageURL(rule.allowedMatches, url))
    )
      throw new Error('PLUGIN_PAGE_INVALIDATED: Page left its activation URL range');
  }

  private async activation(data: Record<string, any>, preserveManual = false): Promise<unknown> {
    if (!/^[a-z][a-z0-9_-]*$/.test(data.plugin)) throw new Error('Invalid page activation plugin');
    if (data.enabled === undefined) return { activation: this.rules.get(data.plugin) ?? null };
    if (typeof data.enabled !== 'boolean')
      throw new Error('Page activation enabled must be boolean');
    if (data.enabled) {
      if (typeof data.installationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.installationId))
        throw new Error('Page activation requires a plugin installation identity');
      let matches = data.matches ?? data.allowedMatches;
      if (data.matchPatch !== undefined) {
        const patch = data.matchPatch;
        if (
          data.matches !== undefined ||
          !patch ||
          typeof patch !== 'object' ||
          Array.isArray(patch) ||
          Object.keys(patch).some(key => !['add', 'remove'].includes(key)) ||
          !Object.keys(patch).length ||
          [patch.add, patch.remove].some(
            values =>
              values !== undefined &&
              (!Array.isArray(values) ||
                values.length > 64 ||
                !values.every(isPluginPageMatchPattern)),
          )
        )
          throw new Error('Invalid page activation match patch');
        const previous = this.rules.get(data.plugin);
        const updated = new Set(
          previous?.installationId === data.installationId ? previous.matches : [],
        );
        for (const match of patch.remove ?? []) updated.delete(match);
        for (const match of patch.add ?? []) updated.add(match);
        matches = [...updated].sort();
        if (!matches.length)
          return this.activation({ ...data, enabled: false, matchPatch: undefined }, true);
      }
      if (
        !Array.isArray(matches) ||
        !matches.length ||
        matches.length > 64 ||
        !matches.every(match => isPluginPageMatchPattern(match) && !(match.startsWith('file:') && match.includes('*'))) ||
        !Array.isArray(data.allowedMatches) ||
        !data.allowedMatches.every(isPluginPageMatchPattern)
      )
        throw new Error('Invalid page activation URL matches');
      if (data.persistence !== undefined && !['session', 'persistent'].includes(data.persistence))
        throw new Error('Invalid page activation persistence');
      const frame = data.frame ?? 'business';
      if (
        !(
          (typeof frame === 'string' && frame.length > 0 && frame.length <= 256) ||
          (Number.isSafeInteger(frame) && frame >= 0)
        )
      )
        throw new Error('Invalid activation frame');
      if (new TextEncoder().encode(JSON.stringify(data.input ?? {})).length > 64 * 1024)
        throw new Error('Page activation input exceeds 64 KiB');
      const rule: Rule = {
        plugin: data.plugin,
        installationId: data.installationId,
        enabled: true,
        matches,
        allowedMatches: data.allowedMatches,
        persistence: data.persistence ?? 'session',
        frame,
        input: data.input ?? {},
      };
      if (JSON.stringify(rule) === JSON.stringify(this.rules.get(data.plugin)))
        return { activation: rule };
      this.generations.set(data.plugin, (this.generations.get(data.plugin) ?? 0) + 1);
      this.rules.set(data.plugin, rule);
      for (const record of [...this.records.values()])
        if (record.instance.plugin === data.plugin && record.activationGeneration !== undefined) {
          if (
            matchesPluginPageURL(rule.matches, record.instance.target.url) &&
            matchesPluginPageURL(rule.allowedMatches, record.instance.target.url)
          )
            record.activationGeneration = this.generations.get(data.plugin);
          else await this.remove(record);
        }
    } else {
      this.generations.set(data.plugin, (this.generations.get(data.plugin) ?? 0) + 1);
      this.rules.delete(data.plugin);
      for (const record of [...this.records.values()])
        if (
          record.instance.plugin === data.plugin &&
          (!preserveManual || record.activationGeneration !== undefined)
        )
          await this.remove(record);
    }
    await this.save();
    const rules = [...this.rules.values()];
    await Promise.all([
      this.adapter.session.set({
        [RULE_KEY]: rules.filter(rule => rule.persistence === 'session'),
      }),
      this.adapter.persistent.set({
        [RULE_KEY]: rules.filter(rule => rule.persistence === 'persistent'),
      }),
    ]);
    if (data.enabled)
      void this.activateAll().catch(error =>
        console.warn('[plugin-page] Activation failed', error),
      );
    return { activation: this.rules.get(data.plugin) ?? null };
  }

  private async activateAll(): Promise<void> {
    const tabs = await this.adapter.tabs();
    for (const tabId of tabs) await this.activate(tabId);
  }
  private async activate(tabId: number): Promise<void> {
    for (const rule of this.rules.values()) {
      const key = `${rule.plugin}:${tabId}`;
      if (this.activating.has(key)) {
        this.activationPending.add(key);
        continue;
      }
      const generation = this.generations.get(rule.plugin) ?? 0;
      const work = (async () => {
        let target: PluginPageTarget;
        try {
          target = await this.resolve(tabId, rule.frame);
        } catch {
          return;
        }
        if (
          !matchesPluginPageURL(rule.matches, target.url) ||
          !matchesPluginPageURL(rule.allowedMatches, target.url)
        )
          return;
        if (
          [...this.records.values()].some(
            record =>
              record.instance.plugin === rule.plugin &&
              record.instance.target.tabId === tabId &&
              record.instance.target.documentId === target.documentId,
          )
        )
          return;
        const instance = await this.native('plugin_page_call', {
          plugin: rule.plugin,
          input: {
            operation: 'attach',
            tabId,
            frame: rule.frame,
            documentId: target.documentId,
            input: rule.input,
            installationId: rule.installationId,
            activationGeneration: generation,
          },
        });
        if (instance?.error) {
          if (
            ['PLUGIN_PAGE_INSTALLATION_CHANGED', 'PLUGIN_NOT_REGISTERED'].includes(
              instance.error.code,
            ) &&
            (this.generations.get(rule.plugin) ?? 0) === generation &&
            this.rules.get(rule.plugin) === rule
          )
            await this.activation({ plugin: rule.plugin, enabled: false });
          throw new Error(instance.error.message);
        }
        if (
          this.disposed ||
          !this.rules.has(rule.plugin) ||
          (this.generations.get(rule.plugin) ?? 0) !== generation
        ) {
          await this.native('plugin_page_call', {
            plugin: rule.plugin,
            input: { operation: 'detach', instanceId: instance.instanceId },
          });
        }
      })()
        .catch(error => console.warn('[plugin-page] Activation failed', error))
        .finally(() => {
          this.activating.delete(key);
          if (this.activationPending.delete(key) && !this.disposed)
            void this.activate(tabId).catch(() => {});
        });
      this.activating.set(key, work);
      await work;
    }
  }
  private tick(): Promise<void> {
    return (this.ticking ??= this.runTick().finally(() => {
      this.ticking = undefined;
    }));
  }
  private async runTick(): Promise<void> {
    await this.ready;
    if (this.disposed) return;
    for (const [id, transfer] of this.transfers)
      if (Date.now() - transfer.updatedAt > 30000) this.transfers.delete(id);
    for (const [id, result] of this.results)
      if (Date.now() - result.updatedAt > 30000) this.results.delete(id);
    for (const record of [...this.records.values()]) {
      try {
        if (record.expires < Date.now()) throw new Error('Plugin page execution lease expired');
        await this.current(record);
        if (!this.ports.has(record.instance.instanceId) && this.adapter.reconnect) {
          let reconnected: boolean;
          try {
            reconnected = await this.adapter.reconnect(record.instance);
          } catch (error) {
            if (isPluginPageInvalidation(error)) throw error;
            throw pluginPageUnavailable(error);
          }
          if (!reconnected) throw new Error('PLUGIN_PAGE_INVALIDATED: Plugin page runtime ended');
        }
        this.ports.get(record.instance.instanceId)?.port.postMessage({ type: 'ping' });
        try {
          if (await this.synchronize(record)) void this.pump(record);
        } catch {
          /* A bridge outage preserves the lease and pending events for reconciliation. */
        }
      } catch (error) {
        if (!isPluginPageUnavailable(error)) await this.remove(record);
      }
    }
    await this.saveLeases();
    if (!this.disposed && this.rules.size) await this.activateAll();
  }
  private committed = (details: PluginPageNavigationDetails): void => {
    void this.ready
      .then(async () => {
        for (const record of [...this.records.values()])
          if (
            record.instance.target.tabId === details.tabId &&
            (details.mainFrame ||
              details.frameId === 0 ||
              record.instance.target.frameId === details.frameId) &&
            record.instance.target.documentId !== details.documentId
          )
            await this.remove(record);
      })
      .catch(() => {});
  };
  private completed = (details: { tabId: number }): void => {
    void this.ready.then(() => this.activate(details.tabId)).catch(() => {});
  };
  private navigation = (details: PluginPageNavigationDetails): void => {
    void this.ready
      .then(async () => {
        for (const record of [...this.records.values()])
          if (
            record.instance.target.tabId === details.tabId &&
            record.instance.target.frameId === details.frameId &&
            record.instance.target.documentId === details.documentId
          ) {
            try {
              await this.current(record);
              await this.execute(
                record,
                `globalThis.__mearlPluginPageInstances?.get(${JSON.stringify(record.instance.instanceId)})?.send({type:'host:navigation',url:${JSON.stringify(details.url)}})`,
              );
              void this.native('plugin_page_event', {
                plugin: record.instance.plugin,
                input: { instanceId: record.instance.instanceId, kind: 'navigation' },
              }).catch(() => {});
            } catch (error) {
              if (!isPluginPageUnavailable(error)) await this.remove(record);
            }
          }
        await this.activate(details.tabId);
      })
      .catch(() => {});
  };
  private removed = (tabId: number): void => {
    void this.ready
      .then(async () => {
        for (const record of [...this.records.values()])
          if (record.instance.target.tabId === tabId) await this.remove(record);
      })
      .catch(() => {});
  };

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.unlisten();
    for (const connection of this.ports.values()) connection.port.disconnect();
  }
}
