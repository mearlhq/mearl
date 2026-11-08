const activeSpmOverlayTabs = new Set<number>();

export function isSpmOverlayEnabled(tabId: number): boolean {
  return activeSpmOverlayTabs.has(tabId);
}

export function setSpmOverlayEnabled(tabId: number, enabled: boolean): void {
  if (enabled) {
    activeSpmOverlayTabs.add(tabId);
    return;
  }
  activeSpmOverlayTabs.delete(tabId);
}

export function clearSpmOverlayState(tabId: number): void {
  activeSpmOverlayTabs.delete(tabId);
}

/** 新 frame 的视觉运行时就绪后，恢复当前 tab 的全量 SPM 高亮。 */
export async function restoreSpmOverlayForFrame(tabId: number, frameId: number): Promise<boolean> {
  if (!isSpmOverlayEnabled(tabId)) return false;

  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { action: 'toggleSpmOverlay', enabled: true },
      { frameId },
    );
    return response?.success === true;
  } catch {
    return false;
  }
}
