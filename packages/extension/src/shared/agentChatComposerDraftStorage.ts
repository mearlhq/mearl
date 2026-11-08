const AGENT_CHAT_COMPOSER_DRAFT_PREFIX = 'agentChatSidepanelComposerDraftV1:';

export function agentChatComposerDraftStorageKey(tabId: number): string {
  return `${AGENT_CHAT_COMPOSER_DRAFT_PREFIX}${tabId}`;
}

export function agentChatComposerDraftTabId(key: string): number | null {
  if (!key.startsWith(AGENT_CHAT_COMPOSER_DRAFT_PREFIX)) return null;
  const tabId = Number(key.slice(AGENT_CHAT_COMPOSER_DRAFT_PREFIX.length));
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

export async function removeAgentChatComposerDraft(tabId: number): Promise<void> {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.remove(agentChatComposerDraftStorageKey(tabId));
}

export async function clearAgentChatComposerPageContext(tabId: number): Promise<void> {
  if (!chrome.storage?.session) return;
  const key = agentChatComposerDraftStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const draft = stored[key];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return;
  const value = draft as Record<string, unknown>;
  if (
    !value.selectedElement &&
    (!Array.isArray(value.elementComments) || value.elementComments.length === 0)
  ) {
    return;
  }
  await chrome.storage.session.set({
    [key]: {
      ...value,
      selectedElement: null,
      elementComments: [],
    },
  });
}
