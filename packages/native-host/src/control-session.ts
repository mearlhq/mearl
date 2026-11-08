import { randomBytes } from 'node:crypto';
import {
  validateActionBatch,
  type ControlSessionInfo,
  type BrowserReleaseParams,
} from '@mearl/browser-core';

const BROWSER_QUEUE = -1;

/** Resource ownership survives individual CLI connections; queues serialize shared pages. */
export class ControlSessionRegistry {
  private sessions = new Map<string, ControlSessionInfo>();
  private owners = new Map<number, string>();
  private queues = new Map<number, Promise<void>>();
  private pending = new Map<string | undefined, Set<Promise<unknown>>>();
  private browserReleasing = false;
  private resuming = new Set<string>();

  constructor(private browserId: () => string) {}

  private createSessionId(): string {
    while (true) {
      const id = `s_${randomBytes(6).toString('base64url')}`;
      if (!this.sessions.has(id)) return id;
    }
  }

  create(transport: ControlSessionInfo['transport']): ControlSessionInfo {
    if (this.browserReleasing) throw new Error('BROWSER_CONTROL_RELEASING');
    const record: ControlSessionInfo = {
      sessionId: this.createSessionId(),
      browserId: this.browserId(),
      transport,
      status: 'active',
      tabs: [],
      generation: 1,
    };
    this.sessions.set(record.sessionId, record);
    return this.info(record.sessionId);
  }

  info(id: string): ControlSessionInfo {
    const record = this.require(id);
    return { ...record, tabs: record.tabs.map(tab => ({ ...tab })) };
  }

  state(id: string): Omit<ControlSessionInfo, 'tabs'> {
    const { tabs: _tabs, ...state } = this.require(id);
    return state;
  }

  find(id: string): ControlSessionInfo | undefined {
    const record = this.sessions.get(id);
    return record?.browserId === this.browserId() ? this.info(id) : undefined;
  }

  list(): ControlSessionInfo[] {
    return [...this.sessions.values()]
      .filter(record => record.status !== 'released')
      .map(record => this.info(record.sessionId));
  }

  private require(id: string): ControlSessionInfo {
    const record = this.sessions.get(id);
    if (!record || record.browserId !== this.browserId())
      throw new Error('CONTROL_SESSION_NOT_FOUND');
    return record;
  }

  private assertActive(id: string, generation?: number): ControlSessionInfo {
    const record = this.require(id);
    if (
      record.status !== 'active' ||
      (generation !== undefined && generation !== record.generation)
    ) {
      throw new Error(
        `CONTROL_SESSION_PAUSED: ${record.status}; inspect the page after the user returns control`,
      );
    }
    return record;
  }

  claim(id: string, tabId: number, source: 'created' | 'attached'): void {
    const record = this.require(id);
    const owner = this.owners.get(tabId);
    if (owner && owner !== id) throw new Error('TAB_CONTROLLED_BY_SESSION');
    if (!record.tabs.some(tab => tab.tabId === tabId)) record.tabs.push({ tabId, source });
    this.owners.set(tabId, id);
  }

  blockedTabs(id?: string): number[] {
    return [...this.owners].filter(([, owner]) => owner !== id).map(([tab]) => tab);
  }

  assertBrowserRelease(): void {
    if (this.list().length)
      throw new Error('ACTIVE_CONTROL_SESSIONS: release the owning session first');
  }

  async releaseBrowser<T>(operation: () => Promise<T>): Promise<T> {
    this.assertBrowserRelease();
    if (this.browserReleasing) throw new Error('BROWSER_CONTROL_RELEASING');
    this.browserReleasing = true;
    try {
      await Promise.allSettled([...this.pending.values()].flatMap(operations => [...operations]));
      return await operation();
    } finally {
      this.browserReleasing = false;
    }
  }

  async run<T>(
    id: string | undefined,
    action: string,
    data: any,
    operation: () => Promise<T>,
    transport: ControlSessionInfo['transport'] = 'extension',
  ): Promise<T> {
    if (this.browserReleasing) throw new Error('BROWSER_CONTROL_RELEASING');
    const generation = id ? this.assertActive(id).generation : undefined;
    const tabs = new Set<number>();
    if (typeof data.tabId === 'number') tabs.add(data.tabId);
    for (const tab of data.tabIds ?? []) if (typeof tab === 'number') tabs.add(tab);
    if (typeof data.openerTabId === 'number') tabs.add(data.openerTabId);
    const steps = action === 'run_actions' ? data.actions : [{ action, data }];
    if (action === 'run_actions') {
      validateActionBatch(data);
      for (const step of data.actions ?? []) {
        if (typeof step.data?.tabId === 'number') tabs.add(step.data.tabId);
        for (const tab of step.data?.tabIds ?? []) if (typeof tab === 'number') tabs.add(tab);
        if (typeof step.data?.openerTabId === 'number') tabs.add(step.data.openerTabId);
      }
    }
    const opensPage = steps.some((step: any) => step.action === 'tab_open');
    const changesSharedSettings = steps.some(
      (step: any) =>
        ['set_rule', 'set_cookie'].includes(step.action) ||
        (step.action === 'set_app_profile' &&
          transport !== 'cdp' &&
          step.data?.networkControl !== undefined),
    );
    const assertSharedResources = () => {
      if (
        action === 'run_actions' &&
        !id &&
        this.list().length &&
        steps.some((step: any) => ['tab_open', 'browser_close'].includes(step.action))
      ) {
        throw new Error(
          'ACTIVE_CONTROL_SESSIONS: open pages outside run_actions while sessions are active',
        );
      }
      // Browser-wide settings cannot escape ownership through a batch.
      if (changesSharedSettings && this.list().some(record => record.sessionId !== id)) {
        throw new Error(
          'BROWSER_RESOURCE_CONFLICT: use an isolated browser to change shared settings',
        );
      }
      if (data.closeExisting && !id && this.list().length)
        throw new Error('ACTIVE_CONTROL_SESSIONS');
    };
    assertSharedResources();
    for (const tab of tabs) {
      if (tab < 0) continue;
      const owner = this.owners.get(tab);
      if (owner && owner !== id) throw new Error('TAB_CONTROLLED_BY_SESSION');
    }
    let unlock!: () => void;
    const tail = new Promise<void>(resolve => {
      unlock = resolve;
    });
    // Runtime messages can await events whose acknowledgement needs a call back into the same tab.
    // They keep ownership checks and pending-operation tracking, while the runtime owns ordering.
    const runtimeTransport = action === 'page_runtime';
    const predecessors = runtimeTransport
      ? []
      : [...tabs].map(tab => this.queues.get(tab)).filter(Boolean);
    if (!runtimeTransport && this.queues.has(BROWSER_QUEUE))
      predecessors.push(this.queues.get(BROWSER_QUEUE));
    if (changesSharedSettings || action === 'page_download' || opensPage) {
      predecessors.push(...this.queues.values());
      tabs.add(BROWSER_QUEUE);
    }
    if (!runtimeTransport) for (const tab of tabs) this.queues.set(tab, tail);
    const execute = async () => {
      try {
        await Promise.all(predecessors);
        if (id) this.assertActive(id, generation);
        assertSharedResources();
        for (const tab of tabs) {
          const owner = this.owners.get(tab);
          if (owner && owner !== id) throw new Error('TAB_CONTROLLED_BY_SESSION');
          if (id && tab >= 0) this.claim(id, tab, 'attached');
        }
        return await operation();
      } finally {
        unlock();
        for (const tab of tabs) if (this.queues.get(tab) === tail) this.queues.delete(tab);
      }
    };
    const promise = execute();
    const pending = this.pending.get(id) ?? new Set();
    pending.add(promise);
    this.pending.set(id, pending);
    try {
      return await promise;
    } finally {
      pending.delete(promise);
      if (!pending.size) this.pending.delete(id);
    }
  }

  async waitForIdle(id: string): Promise<void> {
    await Promise.allSettled([...(this.pending.get(id) ?? [])]);
  }

  assertStep(id: string, generation: number): void {
    this.assertActive(id, generation);
  }

  recordResult(id: string, action: string, result: any, data?: any): void {
    if (action === 'tab_open' && typeof result?.tabId === 'number') {
      this.claim(id, result.tabId, result.opened === true ? 'created' : 'attached');
    }
    for (const tab of result?.observation?.openedTabs ?? []) {
      if (typeof tab.tabId === 'number') this.claim(id, tab.tabId, 'created');
    }
    const target = this.require(id).tabs.find(tab => tab.tabId === (result?.tabId ?? data?.tabId));
    if (target && typeof result?.title === 'string') target.title = result.title;
    if (target && typeof result?.url === 'string') target.url = result.url;
    if (action === 'tab_close' && typeof data?.tabId === 'number') {
      this.owners.delete(data.tabId);
      this.require(id).tabs = this.require(id).tabs.filter(tab => tab.tabId !== data.tabId);
    }
    if (action === 'tab_close') {
      for (const tab of this.require(id).tabs) {
        if ((result?.closedTabIds ?? []).includes(tab.tabId)) this.owners.delete(tab.tabId);
      }
    }
  }

  handoff(id: string, reason?: string): ControlSessionInfo {
    const record = this.assertActive(id);
    record.status = 'user';
    record.generation += 1;
    record.reason = reason;
    return this.info(id);
  }

  async resume(
    id: string,
    cleanup: () => Promise<void> = async () => {},
  ): Promise<ControlSessionInfo> {
    const record = this.require(id);
    if (record.status !== 'user') throw new Error('Session is not waiting for the user');
    if (this.resuming.has(id)) throw new Error('CONTROL_SESSION_RESUMING');
    this.resuming.add(id);
    try {
      await this.waitForIdle(id);
      await cleanup();
      record.status = 'active';
      record.reason = undefined;
      record.generation += 1;
      return this.info(id);
    } finally {
      this.resuming.delete(id);
    }
  }

  async release(
    id: string,
    params: BrowserReleaseParams,
    cleanup: (tabs: number[], close: number[]) => Promise<void>,
  ): Promise<ControlSessionInfo> {
    const record = this.require(id);
    if (this.resuming.has(id)) throw new Error('CONTROL_SESSION_RESUMING');
    if (record.status === 'released') return this.info(id);
    if (record.status === 'releasing') throw new Error('CONTROL_SESSION_RELEASING');
    const previous = record.status;
    record.status = 'releasing';
    record.generation += 1;
    await Promise.allSettled([...(this.pending.get(id) ?? [])]);
    const tabs = record.tabs.map(tab => tab.tabId);
    const keep = new Set(params.keepTabIds ?? []);
    const close = params.closeCreatedTabs
      ? record.tabs
          .filter(tab => tab.source === 'created' && !keep.has(tab.tabId))
          .map(tab => tab.tabId)
      : [];
    try {
      await cleanup(tabs, close);
      for (const tab of tabs) if (this.owners.get(tab) === id) this.owners.delete(tab);
      record.status = 'released';
      // Bound completed metadata while retaining active ownership indefinitely.
      const released = [...this.sessions.values()].filter(
        session => session.status === 'released' && session.sessionId !== id,
      );
      for (const old of released.slice(0, Math.max(0, released.length - 99)))
        this.sessions.delete(old.sessionId);
    } catch (error) {
      record.status = previous;
      throw error;
    }
    return this.info(id);
  }
}
