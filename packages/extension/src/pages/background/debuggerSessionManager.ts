export interface DebuggerLeaseOptions {
  consumer: string;
  domains?: readonly string[];
  domainParams?: Readonly<Record<string, Record<string, unknown>>>;
  onInvalidated?: (reason?: string) => void;
}

export interface DebuggerLease {
  readonly tabId: number;
  readonly consumer: string;
  readonly generation: number;
  release(): Promise<void>;
}

interface LeaseRecord {
  consumer: string;
  domains: string[];
  onInvalidated?: (reason?: string) => void;
}

interface DebuggerSessionState {
  attached: boolean;
  generation: number;
  nextLeaseId: number;
  leases: Map<number, LeaseRecord>;
  domainRefs: Map<string, number>;
  /** frameId → MAIN world executionContextId，随 Runtime 事件更新。 */
  frameExecutionContexts: Map<string, { id: number; sessionId?: string }>;
  queue: Promise<void>;
}

const sessionStates = new Map<number, DebuggerSessionState>();
// 同一 tab 主动释放后可以重建状态，代次在状态重建后也必须唯一。
let sessionGeneration = 0;

export interface SessionKeepAliveProvider {
  shouldKeepAttached(tabId: number): boolean;
}

/**
 * 会话级 override（设备模拟、时区等）登记方。这类 override 随 debugger session 存亡，
 * 但它们不靠长持有 lease 来维持（lease 即用即还）；该接口让 detachIfUnused 知道
 * 哪些 tab 虽无活跃 lease 但仍需保持 attach。
 */
let sessionKeepAliveProvider: SessionKeepAliveProvider | null = null;

export function registerSessionKeepAliveProvider(provider: SessionKeepAliveProvider): void {
  sessionKeepAliveProvider = provider;
}

function getSessionState(tabId: number): DebuggerSessionState {
  let state = sessionStates.get(tabId);
  if (!state) {
    state = {
      attached: false,
      generation: 0,
      nextLeaseId: 1,
      leases: new Map(),
      domainRefs: new Map(),
      frameExecutionContexts: new Map(),
      queue: Promise.resolve(),
    };
    sessionStates.set(tabId, state);
  }
  return state;
}

async function runExclusive<T>(
  state: DebuggerSessionState,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = state.queue;
  let unlock!: () => void;
  state.queue = new Promise<void>(resolve => {
    unlock = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

async function detachIfUnused(tabId: number, state: DebuggerSessionState): Promise<void> {
  if (!state.attached || state.leases.size > 0) return;
  if (sessionKeepAliveProvider?.shouldKeepAttached(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // tab 或 debugger session 可能已经被浏览器关闭
  }
  state.attached = false;
}

async function releaseDomains(
  tabId: number,
  state: DebuggerSessionState,
  domains: readonly string[],
): Promise<void> {
  for (const domain of [...domains].reverse()) {
    const count = state.domainRefs.get(domain) ?? 0;
    if (count > 1) {
      state.domainRefs.set(domain, count - 1);
      continue;
    }
    state.domainRefs.delete(domain);
    if (!state.attached) continue;
    await chrome.debugger.sendCommand({ tabId }, `${domain}.disable`, {}).catch(() => {
      // session 失效时由 onDetach 统一清理状态
    });
  }
}

/**
 * 错误是否表示「CDP session 已不在」。
 *
 * acquireDebuggerLease 只能保证「获取那一刻 session 活着」，它与后续 sendCommand 之间的窗口
 * 消除不了（跨 site 导航、DevTools 挤占随时可能断开）。调用方据此区分「重试一次就能好」
 * 和真正的失败（如 tab 已关闭）。
 */
export function isDebuggerSessionGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not attached|Detached while handling command|target closed/i.test(message);
}

export async function acquireDebuggerLease(
  tabId: number,
  options: DebuggerLeaseOptions,
): Promise<DebuggerLease> {
  const state = getSessionState(tabId);

  return runExclusive(state, async () => {
    if (!state.attached) {
      const generationBeforeAttach = state.generation;
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (attachError) {
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: 'void 0',
          });
        } catch {
          throw attachError;
        }
      }
      if (sessionStates.get(tabId) !== state || state.generation !== generationBeforeAttach) {
        await chrome.debugger.detach({ tabId }).catch(() => {});
        throw new Error(`Debugger session for tab ${tabId} became unavailable while attaching`);
      }
      state.attached = true;
      state.generation = ++sessionGeneration;
    }

    const generation = state.generation;
    const leaseId = state.nextLeaseId++;
    const domains = Array.from(new Set(options.domains ?? []));
    const record: LeaseRecord = {
      consumer: options.consumer,
      domains: [],
      onInvalidated: options.onInvalidated,
    };
    state.leases.set(leaseId, record);

    try {
      for (const domain of domains) {
        const count = state.domainRefs.get(domain) ?? 0;
        if (count === 0) {
          await chrome.debugger.sendCommand(
            { tabId },
            `${domain}.enable`,
            options.domainParams?.[domain] ?? {},
          );
          if (!state.attached || state.generation !== generation) {
            throw new Error(`Debugger session for tab ${tabId} was detached`);
          }
        }
        state.domainRefs.set(domain, count + 1);
        record.domains.push(domain);
      }
    } catch (error) {
      state.leases.delete(leaseId);
      await releaseDomains(tabId, state, record.domains);
      await detachIfUnused(tabId, state);
      throw error;
    }

    let released = false;
    return {
      tabId,
      consumer: options.consumer,
      generation,
      release: async () => {
        if (released) return;
        released = true;

        const current = sessionStates.get(tabId);
        if (!current || current.generation !== generation) return;
        await runExclusive(current, async () => {
          const activeRecord = current.leases.get(leaseId);
          if (!activeRecord) return;
          current.leases.delete(leaseId);
          await releaseDomains(tabId, current, activeRecord.domains);
          await detachIfUnused(tabId, current);
        });
      },
    };
  });
}

export function handleDebuggerSessionDetach(
  tabId: number,
  reason?: string,
  expectedGeneration?: number,
): void {
  const state = sessionStates.get(tabId);
  if (!state) return;
  // 并发命令的失败可能晚于另一个消费者的重连，只能使该命令所属的会话失效。
  if (expectedGeneration !== undefined && state.generation !== expectedGeneration) return;

  const records = Array.from(state.leases.values());
  state.attached = false;
  state.generation = ++sessionGeneration;
  state.leases.clear();
  state.domainRefs.clear();
  state.frameExecutionContexts.clear();

  for (const record of records) {
    try {
      record.onInvalidated?.(reason);
    } catch {
      // 一个消费者的清理异常不应阻断其他消费者失效
    }
  }
}

/** 记录 Runtime 上报的 MAIN world，使晚于 Runtime.enable 的 iframe 求值也能可靠定位。 */
export function handleDebuggerSessionEvent(
  tabId: number,
  method: string,
  params: any,
  sessionId?: string,
): void {
  const state = sessionStates.get(tabId);
  if (!state?.attached) return;
  if (method === 'Runtime.executionContextsCleared') {
    for (const [frameId, context] of state.frameExecutionContexts) {
      if (context.sessionId === sessionId) state.frameExecutionContexts.delete(frameId);
    }
    return;
  }
  if (method === 'Runtime.executionContextCreated') {
    const context = params?.context;
    const frameId = context?.auxData?.frameId;
    if (
      typeof frameId === 'string' &&
      typeof context?.id === 'number' &&
      context.auxData?.isDefault === true
    ) {
      state.frameExecutionContexts.set(frameId, { id: context.id, sessionId });
    }
    return;
  }
  if (
    method === 'Runtime.executionContextDestroyed' &&
    typeof params?.executionContextId === 'number'
  ) {
    for (const [frameId, context] of state.frameExecutionContexts) {
      if (context.sessionId === sessionId && context.id === params.executionContextId) {
        state.frameExecutionContexts.delete(frameId);
      }
    }
  }
}

export function getDebuggerFrameExecutionContextId(
  tabId: number,
  frameId: string,
  sessionId?: string,
): number | undefined {
  const context = sessionStates.get(tabId)?.frameExecutionContexts.get(frameId);
  return context?.sessionId === sessionId ? context?.id : undefined;
}

export function invalidateDebuggerFrameExecutionContext(tabId: number, frameId: string): void {
  sessionStates.get(tabId)?.frameExecutionContexts.delete(frameId);
}

/**
 * 在不打断其他 Runtime 消费者的前提下重新枚举 MAIN world execution contexts。
 * 返回 false 表示当前有多个 Runtime lease，调用方应等待自然的 context created 事件。
 */
export async function refreshDebuggerExecutionContexts(tabId: number): Promise<boolean> {
  const state = sessionStates.get(tabId);
  if (!state) return false;
  return runExclusive(state, async () => {
    if (!state.attached || (state.domainRefs.get('Runtime') ?? 0) !== 1) return false;
    handleDebuggerSessionEvent(tabId, 'Runtime.executionContextsCleared', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.disable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
    return true;
  });
}

/** Resolve the default JavaScript execution context for a frame. */
export async function resolveDebuggerFrameExecutionContextId(
  tabId: number,
  frameId: string,
  refresh = false,
  sessionId?: string,
): Promise<number> {
  if (!refresh) {
    const cached = getDebuggerFrameExecutionContextId(tabId, frameId, sessionId);
    if (cached !== undefined) return cached;
  } else {
    invalidateDebuggerFrameExecutionContext(tabId, frameId);
  }

  const debugTarget = { tabId, ...(sessionId ? { sessionId } : {}) };
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const seen: string[] = [];
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(listener);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const timeout = setTimeout(
      () =>
        fail(
          `Could not find execution context for frame ${frameId} (seen: ${seen.join(', ') || 'none'})`,
        ),
      3000,
    );

    function listener(
      source: chrome.debugger.Debuggee & { sessionId?: string },
      method: string,
      params: any,
    ): void {
      if (settled || source.tabId !== tabId || source.sessionId !== sessionId) return;
      if (method !== 'Runtime.executionContextCreated') return;
      const context = params.context;
      seen.push(`${context.auxData?.frameId ?? '?'}${context.auxData?.isDefault ? '' : '!'}`);
      if (context.auxData?.frameId !== frameId || !context.auxData?.isDefault) return;
      settled = true;
      cleanup();
      resolve(context.id);
    }

    chrome.debugger.onEvent.addListener(listener);
    const enable = () => chrome.debugger.sendCommand(debugTarget, 'Runtime.enable');
    const enumeration =
      refresh && !sessionId
        ? refreshDebuggerExecutionContexts(tabId).then(refreshed =>
            refreshed ? undefined : enable(),
          )
        : enable();
    enumeration.catch(() => fail(`Failed to enumerate execution contexts for frame ${frameId}`));
  });
}

export function cleanupDebuggerSession(tabId: number): void {
  handleDebuggerSessionDetach(tabId, 'target_closed');
  sessionStates.delete(tabId);
}

export function hasActiveDebuggerLeases(tabId: number): boolean {
  return (sessionStates.get(tabId)?.leases.size ?? 0) > 0;
}

/** 返回当前仍附加或持有 lease 的标签页，用于浏览器级控制释放。 */
export function listActiveDebuggerTabIds(): number[] {
  return Array.from(sessionStates.entries())
    .filter(([, state]) => state.attached || state.leases.size > 0)
    .map(([tabId]) => tabId);
}

/**
 * 主动释放指定标签页的共享 debugger session。
 *
 * 与单个 lease.release() 不同，这会让所有消费者同时失效，供浏览器级控制清理
 * 在保留标签页的前提下交还浏览器控制权。
 */
export async function releaseDebuggerSession(
  tabId: number,
  reason = 'browser_release',
): Promise<boolean> {
  const state = sessionStates.get(tabId);
  if (!state) return false;

  return runExclusive(state, async () => {
    const hadActiveSession = state.attached || state.leases.size > 0;
    if (!hadActiveSession) {
      sessionStates.delete(tabId);
      return false;
    }

    if (state.attached) {
      await chrome.debugger.detach({ tabId }).catch(() => {
        // Chrome 可能已先行断开；下面仍需同步清理所有消费者状态。
      });
    }

    if (sessionStates.get(tabId) === state && (state.attached || state.leases.size > 0)) {
      handleDebuggerSessionDetach(tabId, reason);
    }
    sessionStates.delete(tabId);
    return true;
  });
}

export function getDebuggerSessionDebugState(tabId: number): {
  attached: boolean;
  generation: number;
  consumers: string[];
  domainRefs: Record<string, number>;
} | null {
  const state = sessionStates.get(tabId);
  if (!state) return null;
  return {
    attached: state.attached,
    generation: state.generation,
    consumers: Array.from(state.leases.values(), lease => lease.consumer),
    domainRefs: Object.fromEntries(state.domainRefs),
  };
}
