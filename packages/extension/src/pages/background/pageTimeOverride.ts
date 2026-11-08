const PAGE_TIME_OFFSET_STORAGE_PREFIX = 'pageTimeOffsetV1:';
const fallbackOverridesByTab = new Map<number, PageTimeOverride>();

export interface PageTimeOverride {
  offsetMs: number | null;
  revision: number;
}

const timeOffsetStorageKey = (tabId: number): string =>
  `${PAGE_TIME_OFFSET_STORAGE_PREFIX}${tabId}`;

const normalizeTimeOverride = (value: unknown): PageTimeOverride | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { offsetMs: value, revision: 0 };
  }
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const offsetMs = candidate.offsetMs;
  const revision = candidate.revision;
  if (offsetMs !== null && (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs))) {
    return null;
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return null;
  }
  return { offsetMs, revision } as PageTimeOverride;
};

const readTimeOverride = async (tabId: number): Promise<PageTimeOverride | null> => {
  if (!chrome.storage?.session) return fallbackOverridesByTab.get(tabId) ?? null;
  const key = timeOffsetStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return normalizeTimeOverride(stored[key]);
};

const writeTimeOverride = async (tabId: number, override: PageTimeOverride): Promise<void> => {
  fallbackOverridesByTab.set(tabId, override);
  if (chrome.storage?.session) {
    await chrome.storage.session.set({ [timeOffsetStorageKey(tabId)]: override });
  }
};

const removeTimeOverride = async (tabId: number): Promise<void> => {
  fallbackOverridesByTab.delete(tabId);
  if (chrome.storage?.session) {
    await chrome.storage.session.remove(timeOffsetStorageKey(tabId));
  }
};

export const sendTimeOverrideForTab = async (
  tabId: number,
  override: PageTimeOverride,
): Promise<void> => {
  await chrome.tabs.sendMessage(tabId, { action: 'pageTimeOverride', ...override }).catch(() => {});
};

const nextRevision = async (tabId: number): Promise<number> => {
  const current = await readTimeOverride(tabId);
  return (current?.revision ?? 0) + 1;
};

/** 让页面时钟从指定时刻起正常走时，并记录偏移供导航后的新文档重放。 */
export async function enableTimeForTab(
  tabId: number,
  targetEpochMs: number,
  notify = true,
): Promise<PageTimeOverride> {
  if (!Number.isFinite(targetEpochMs)) throw new Error('Invalid custom time');
  const override = {
    offsetMs: targetEpochMs - Date.now(),
    revision: await nextRevision(tabId),
  };
  await writeTimeOverride(tabId, override);
  if (notify) await sendTimeOverrideForTab(tabId, override);
  return override;
}

/** 恢复原生 Date，并停止在后续导航中注入时间偏移。 */
export async function disableTimeForTab(tabId: number, notify = true): Promise<PageTimeOverride> {
  const override = { offsetMs: null, revision: await nextRevision(tabId) };
  await writeTimeOverride(tabId, override);
  if (notify) await sendTimeOverrideForTab(tabId, override);
  return override;
}

export const getTimeOverrideForTab = (tabId: number): Promise<PageTimeOverride | null> =>
  readTimeOverride(tabId);

export const cleanupTimeForTab = (tabId: number): Promise<void> => removeTimeOverride(tabId);
