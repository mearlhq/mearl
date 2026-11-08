/** Ego may omit tabs.Tab.url even for browser-owned documents. Read the same tab's
 * debugger metadata instead; a failed lookup or ambiguous physical page stays closed. */
export async function getEnhancementTabUrl(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url) return tab.url;
  const targets = (await chrome.debugger.getTargets()).filter(target => target.tabId === tabId && target.type === 'page');
  if (targets.length !== 1 || !targets[0]?.url) throw new Error('Enhancement target URL is unavailable');
  return targets[0].url;
}
