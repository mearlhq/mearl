const toggleQueues = new Map<number, Promise<void>>();

/** 同一 tab 的开关按操作顺序落到各 frame，避免端模拟慢 frame 的关闭消息覆盖再次开启。 */
export function enqueueSpmOverlayToggle<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = toggleQueues.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  toggleQueues.set(tabId, settled);
  void settled.finally(() => {
    if (toggleQueues.get(tabId) === settled) toggleQueues.delete(tabId);
  });
  return current;
}
