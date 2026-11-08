const tabQuickSimulationUpdateQueues = new Map<number, Promise<unknown>>();

export function isQuickSimulationUpdatePending(tabId: number): boolean {
  return tabQuickSimulationUpdateQueues.has(tabId);
}

export async function waitForQuickSimulationUpdate(tabId: number): Promise<void> {
  let pending = tabQuickSimulationUpdateQueues.get(tabId);
  while (pending) {
    await pending.catch(() => {});
    const next = tabQuickSimulationUpdateQueues.get(tabId);
    if (next === pending) return;
    pending = next;
  }
}

/** 客户端与设备快捷操作共享同一条 per-tab 队列，保证每次操作读取到前一操作的最终状态。 */
export function runSerializedQuickSimulationUpdate<T>(
  tabId: number,
  update: () => Promise<T>,
): Promise<T> {
  const previous = tabQuickSimulationUpdateQueues.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(update);
  tabQuickSimulationUpdateQueues.set(tabId, current);
  void current
    .finally(() => {
      if (tabQuickSimulationUpdateQueues.get(tabId) === current) {
        tabQuickSimulationUpdateQueues.delete(tabId);
      }
    })
    .catch(() => {});
  return current;
}
