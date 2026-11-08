import { AGENT_CHAT_ALLOW_NEW_TABS_SERVER_TIMING_KEY } from '../../shared/constants';
import type {
  AgentChatTabDetachmentResult,
  AgentChatTabBinding,
  AgentChatTabBindingSnapshot,
  AgentChatTabRegistrationResult,
  DetachedAgentChatTabBinding,
  RemovedAgentChatTabBinding,
} from '../../shared/agentChatTabBindings';
import { startRequestCollection } from './backgroundRequestCollector';
import { markTabControlled } from './agentHandlers/controlledTabs';
import { AGENT_CHAT_ALLOW_NEW_TABS_DNR_RULE_ID } from './utils/dnr';

const STORAGE_KEY = 'agentChatTabBindingsV1';

export type {
  AgentChatTabDetachmentResult,
  AgentChatTabBinding,
  AgentChatTabBindingSnapshot,
  AgentChatTabRegistrationResult,
  DetachedAgentChatTabBinding,
  RemovedAgentChatTabBinding,
} from '../../shared/agentChatTabBindings';

let fallbackBindings: Record<string, AgentChatTabBinding> = {};
let bindingQueue: Promise<void> = Promise.resolve();
let observersInstalled = false;

function validTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function cloneBindings(
  bindings: Record<string, AgentChatTabBinding>,
): Record<string, AgentChatTabBinding> {
  return Object.fromEntries(
    Object.entries(bindings).map(([tabId, binding]) => [tabId, { ...binding }]),
  );
}

async function readBindings(): Promise<Record<string, AgentChatTabBinding>> {
  if (!chrome.storage?.session) return cloneBindings(fallbackBindings);
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  fallbackBindings =
    !value || typeof value !== 'object' || Array.isArray(value)
      ? {}
      : cloneBindings(value as Record<string, AgentChatTabBinding>);
  return cloneBindings(fallbackBindings);
}

async function writeBindings(bindings: Record<string, AgentChatTabBinding>): Promise<void> {
  fallbackBindings = cloneBindings(bindings);
  if (chrome.storage?.session) {
    await chrome.storage.session.set({ [STORAGE_KEY]: bindings });
  }
}

async function syncAllowNewTabsRule(bindings: Record<string, AgentChatTabBinding>): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const tabIds = Object.keys(bindings).map(Number).filter(validTabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [AGENT_CHAT_ALLOW_NEW_TABS_DNR_RULE_ID],
    ...(tabIds.length > 0
      ? {
          addRules: [
            {
              id: AGENT_CHAT_ALLOW_NEW_TABS_DNR_RULE_ID,
              priority: 110,
              action: {
                type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
                responseHeaders: [
                  {
                    header: 'server-timing',
                    operation: 'append' as chrome.declarativeNetRequest.HeaderOperation,
                    value: `${AGENT_CHAT_ALLOW_NEW_TABS_SERVER_TIMING_KEY};desc="1"`,
                  },
                ],
              },
              condition: {
                resourceTypes: [
                  'main_frame',
                  'sub_frame',
                ] as chrome.declarativeNetRequest.ResourceType[],
                tabIds,
              },
            },
          ],
        }
      : {}),
  });
}

async function setCurrentDocumentPolicy(tabId: number, enabled: boolean): Promise<void> {
  if (!chrome.scripting?.executeScript) return;
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: allowNewTabs => {
        window.__MEARL_AGENT_CHAT_ALLOW_NEW_TABS__ = allowNewTabs;
      },
      args: [enabled],
    })
    .catch(() => {});
}

async function broadcastSnapshot(
  bindings: Record<string, AgentChatTabBinding>,
  change: {
    detached?: DetachedAgentChatTabBinding;
    removed?: RemovedAgentChatTabBinding;
  } = {},
): Promise<void> {
  await chrome.runtime
    .sendMessage({
      action: 'agentChatTabBindingsChanged',
      data: {
        bindings: cloneBindings(bindings),
        ...change,
      },
    })
    .catch(() => {});
}

async function commitBindings(
  mutate: (bindings: Record<string, AgentChatTabBinding>) => {
    changed: boolean;
    detached?: DetachedAgentChatTabBinding;
    removed?: RemovedAgentChatTabBinding;
  },
): Promise<
  AgentChatTabBindingSnapshot & {
    detached?: DetachedAgentChatTabBinding;
    removed?: RemovedAgentChatTabBinding;
  }
> {
  let result: AgentChatTabBindingSnapshot & {
    detached?: DetachedAgentChatTabBinding;
    removed?: RemovedAgentChatTabBinding;
  } = {
    bindings: {},
  };
  bindingQueue = bindingQueue
    .catch(() => {})
    .then(async () => {
      const bindings = await readBindings();
      const mutation = mutate(bindings);
      if (mutation.changed) {
        await writeBindings(bindings);
        await syncAllowNewTabsRule(bindings).catch(error => {
          console.warn('[Agent Chat] Failed to update related-tab navigation rule:', error);
        });
        await broadcastSnapshot(bindings, {
          ...(mutation.detached ? { detached: mutation.detached } : {}),
          ...(mutation.removed ? { removed: mutation.removed } : {}),
        });
      }
      result = {
        bindings: cloneBindings(bindings),
        ...(mutation.detached ? { detached: mutation.detached } : {}),
        ...(mutation.removed ? { removed: mutation.removed } : {}),
      };
    });
  await bindingQueue;
  return result;
}

export async function getAgentChatTabBindings(): Promise<AgentChatTabBindingSnapshot> {
  await bindingQueue.catch(() => {});
  return { bindings: await readBindings() };
}

export async function registerAgentChatTab(
  ownerTabId: number,
  tabId: number,
  sessionId: string,
): Promise<AgentChatTabRegistrationResult> {
  if (!validTabId(ownerTabId) || !validTabId(tabId)) {
    throw new Error('ownerTabId and tabId must be non-negative integers');
  }
  if (!sessionId) throw new Error('sessionId is required');
  let conflict: AgentChatTabBinding | undefined;
  const snapshot = await commitBindings(bindings => {
    const ownerBinding = bindings[String(ownerTabId)];
    if (ownerBinding && ownerBinding.ownerTabId !== ownerTabId) {
      conflict = { ...ownerBinding };
      return { changed: false };
    }
    const existing = bindings[String(tabId)];
    if (existing && existing.ownerTabId !== ownerTabId) {
      conflict = { ...existing };
      return { changed: false };
    }

    let changed = false;
    for (const binding of Object.values(bindings)) {
      if (binding.ownerTabId === ownerTabId && binding.sessionId !== sessionId) {
        binding.sessionId = sessionId;
        changed = true;
      }
    }
    if (!existing || existing.ownerTabId !== ownerTabId || existing.sessionId !== sessionId) {
      bindings[String(tabId)] = { ownerTabId, sessionId };
      changed = true;
    }
    return { changed };
  });
  await setCurrentDocumentPolicy(tabId, true);
  return {
    ...snapshot,
    ...(conflict ? { conflict } : {}),
  };
}

export async function bindAgentChatTabFromSource(
  sourceTabId: number,
  tabId: number,
): Promise<AgentChatTabBinding | null> {
  if (!validTabId(sourceTabId) || !validTabId(tabId) || sourceTabId === tabId) return null;
  let bound: AgentChatTabBinding | null = null;
  await commitBindings(bindings => {
    const source = bindings[String(sourceTabId)];
    if (!source) return { changed: false };
    const existing = bindings[String(tabId)];
    if (existing && existing.ownerTabId !== source.ownerTabId) {
      return { changed: false };
    }
    if (existing?.sessionId === source.sessionId) return { changed: false };
    bound = { ...source };
    bindings[String(tabId)] = { ...source };
    return { changed: true };
  });
  if (bound) await setCurrentDocumentPolicy(tabId, true);
  return bound;
}

function releaseAgentChatTabBinding(
  bindings: Record<string, AgentChatTabBinding>,
  tabId: number,
): RemovedAgentChatTabBinding | null {
  const existing = bindings[String(tabId)];
  if (!existing) return null;

  delete bindings[String(tabId)];
  const remainingTabIds = Object.entries(bindings)
    .flatMap(([candidateTabId, binding]) =>
      binding.ownerTabId === existing.ownerTabId ? [Number(candidateTabId)] : [],
    )
    .sort((left, right) => left - right);
  const newOwnerTabId =
    existing.ownerTabId === tabId && remainingTabIds.length > 0 ? remainingTabIds[0] : undefined;
  if (newOwnerTabId !== undefined) {
    for (const binding of Object.values(bindings)) {
      if (binding.ownerTabId === existing.ownerTabId) binding.ownerTabId = newOwnerTabId;
    }
  }
  return {
    tabId,
    ...existing,
    remainingTabIds,
    ...(newOwnerTabId !== undefined ? { newOwnerTabId } : {}),
  };
}

export async function removeAgentChatTab(
  tabId: number,
): Promise<RemovedAgentChatTabBinding | null> {
  if (!validTabId(tabId)) return null;
  const result = await commitBindings(bindings => {
    const removed = releaseAgentChatTabBinding(bindings, tabId);
    if (!removed) return { changed: false };
    return { changed: true, removed };
  });
  return result.removed ?? null;
}

export async function detachAgentChatTab(tabId: number): Promise<AgentChatTabDetachmentResult> {
  if (!validTabId(tabId)) throw new Error('tabId must be a non-negative integer');
  const result = await commitBindings(bindings => {
    const detached = releaseAgentChatTabBinding(bindings, tabId);
    if (!detached) return { changed: false };
    return {
      changed: true,
      detached,
    };
  });
  await setCurrentDocumentPolicy(tabId, false);
  return {
    bindings: result.bindings,
    ...(result.detached ? { detached: result.detached } : {}),
  };
}

async function prepareRelatedTab(tabId: number): Promise<void> {
  await markTabControlled(tabId).catch(() => {});
  await startRequestCollection(tabId).catch(error => {
    console.warn(`[Agent Chat] Failed to collect requests for related tab ${tabId}:`, error);
  });
}

async function discoverRelatedTab(sourceTabId: number, tabId: number): Promise<void> {
  const binding = await bindAgentChatTabFromSource(sourceTabId, tabId);
  if (binding) await prepareRelatedTab(tabId);
}

async function restoreCurrentDocumentPolicy(tabId: number): Promise<void> {
  await bindingQueue.catch(() => {});
  if (fallbackBindings[String(tabId)]) await setCurrentDocumentPolicy(tabId, true);
}

export function installAgentChatTabBindingObservers(
  onConversationEmpty?: (removed: RemovedAgentChatTabBinding) => void | Promise<void>,
): void {
  if (observersInstalled) return;
  observersInstalled = true;

  chrome.tabs.onRemoved.addListener(tabId => {
    void removeAgentChatTab(tabId)
      .then(removed => {
        if (removed && removed.remainingTabIds.length === 0) {
          void onConversationEmpty?.(removed);
        }
      })
      .catch(error => {
        console.warn('[Agent Chat] Failed to release a related tab:', error);
      });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.status === 'complete') {
      void restoreCurrentDocumentPolicy(tabId).catch(error => {
        console.warn('[Agent Chat] Failed to restore related-tab navigation policy:', error);
      });
    }
  });

  chrome.webNavigation?.onCreatedNavigationTarget.addListener(details => {
    void discoverRelatedTab(details.sourceTabId, details.tabId).catch(error => {
      console.warn('[Agent Chat] Failed to bind a related navigation target:', error);
    });
  });

  void getAgentChatTabBindings()
    .then(async ({ bindings }) => {
      await syncAllowNewTabsRule(bindings);
      await Promise.all(
        Object.keys(bindings)
          .map(Number)
          .filter(validTabId)
          .map(tabId => setCurrentDocumentPolicy(tabId, true)),
      );
    })
    .catch(error => {
      console.warn('[Agent Chat] Failed to restore related-tab navigation rule:', error);
    });
}
