import { t } from '../../panel/utils/i18n';

const AGENT_GROUP_TITLE = 'Mearl';
let groupQueue: Promise<void> = Promise.resolve();
const workWindowIds = new Map<boolean, number>();

function userGroupTitle(): string {
  return t('agentUserTabGroup');
}

async function getAgentGroups(incognito?: boolean): Promise<chrome.tabGroups.TabGroup[]> {
  const groups = await chrome.tabGroups.query({});
  const managed = groups
    .filter(group => group.title === AGENT_GROUP_TITLE || group.title === userGroupTitle())
    .sort((a, b) => a.id - b.id);
  if (incognito === undefined) return managed;
  const matching: chrome.tabGroups.TabGroup[] = [];
  for (const group of managed) {
    const [tab] = await chrome.tabs.query({ groupId: group.id });
    if (Boolean(tab?.incognito) === incognito) matching.push(group);
  }
  return matching;
}

function selectWorkWindow(
  groups: chrome.tabGroups.TabGroup[],
  incognito: boolean,
): number | undefined {
  const selected =
    groups.find(group => group.windowId === workWindowIds.get(incognito)) ??
    groups.find(group => group.title === AGENT_GROUP_TITLE) ??
    groups[0];
  if (selected) workWindowIds.set(incognito, selected.windowId);
  else workWindowIds.delete(incognito);
  return selected?.windowId;
}

export async function getAgentGroupWindowId(incognito = false): Promise<number | undefined> {
  if (!chrome.tabGroups?.query) return undefined;
  try {
    return selectWorkWindow(await getAgentGroups(incognito), incognito);
  } catch {
    return undefined;
  }
}

async function setGroupCollapsed(
  groupId: number,
  windowId: number,
  tabIds: number[],
  collapsed: boolean,
): Promise<void> {
  if (collapsed) {
    const tabs = await chrome.tabs.query({ windowId });
    const active = tabs.find(tab => tab.active);
    if (active?.groupId === groupId) {
      // Keep a page the user is already viewing open. A newly presented
      // automation page can yield to another tab before its group folds.
      if (!tabIds.includes(active.id!)) return;
      const outside =
        tabs.find(tab => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) ??
        tabs.find(tab => tab.groupId !== groupId);
      if (outside?.id === undefined) return;
      await chrome.tabs.update(outside.id, { active: true });
    }
  }
  await chrome.tabGroups.update(groupId, { collapsed });
}

/** Both managed groups share one window; duplicate groups contribute their tabs to the survivor. */
async function groupManagedTabs(
  tabs: chrome.tabs.Tab[],
  title: string,
  collapsed?: boolean,
): Promise<void> {
  const incognito = Boolean(tabs[0].incognito);
  const groups = await getAgentGroups(incognito);
  const windowId = selectWorkWindow(groups, incognito) ?? tabs[0].windowId;
  workWindowIds.set(incognito, windowId);
  for (const groupTitle of [AGENT_GROUP_TITLE, userGroupTitle()]) {
    const matches = (await getAgentGroups(incognito)).filter(group => group.title === groupTitle);
    const existing = matches.find(group => group.windowId === windowId) ?? matches[0];
    if (existing && existing.windowId !== windowId) {
      await chrome.tabGroups.move(existing.id, { windowId, index: -1 });
    }
    const joining = new Set(groupTitle === title ? tabs.map(tab => tab.id!) : []);
    for (const duplicate of matches) {
      if (duplicate.id === existing?.id) continue;
      for (const tab of await chrome.tabs.query({ groupId: duplicate.id })) {
        if (tab.id !== undefined) joining.add(tab.id);
      }
    }
    let groupId = existing?.id;
    if (joining.size > 0) {
      const tabIds = [...joining];
      const moving: number[] = [];
      for (const tabId of tabIds) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== windowId) moving.push(tabId);
      }
      if (moving.length) await chrome.tabs.move(moving, { windowId, index: -1 });
      groupId = await chrome.tabs.group({
        tabIds,
        ...(existing ? { groupId: existing.id } : { createProperties: { windowId } }),
      });
      if (!existing) await chrome.tabGroups.update(groupId, { title: groupTitle });
    }
    if (groupId !== undefined && groupTitle === title && collapsed !== undefined) {
      await setGroupCollapsed(
        groupId,
        windowId,
        tabs.map(tab => tab.id!),
        collapsed,
      );
    }
  }
}

/** Group creation is serialized so concurrent tasks share the same managed groups. */
export function addTabsToNamedGroup(
  tabIds: number[],
  title: string,
  collapsed?: boolean,
): Promise<void> {
  groupQueue = groupQueue
    .catch(() => {})
    .then(async () => {
      if (!chrome.tabGroups?.query || !chrome.tabs.group) return;
      const tabs: chrome.tabs.Tab[] = [];
      for (const tabId of tabIds) {
        const tab = await chrome.tabs.get(tabId).catch(() => undefined);
        if (tab) tabs.push(tab);
      }
      if (tabs.length === 0) return;
      if (title === AGENT_GROUP_TITLE || title === userGroupTitle()) {
        try {
          for (const incognito of new Set(tabs.map(tab => Boolean(tab.incognito)))) {
            await groupManagedTabs(
              tabs.filter(tab => Boolean(tab.incognito) === incognito),
              title,
              collapsed,
            );
          }
        } catch (error) {
          console.warn('[AgentBridge] Failed to organize agent tabs:', error);
        }
        return;
      }
      const windows = new Map<number, number[]>();
      for (const tab of tabs) {
        const ids = windows.get(tab.windowId) ?? [];
        ids.push(tab.id!);
        windows.set(tab.windowId, ids);
      }
      for (const [windowId, ids] of windows) {
        try {
          const groups = await chrome.tabGroups.query({ title, windowId });
          const existing = groups.find(group => group.title === title);
          const groupId = await chrome.tabs.group({
            tabIds: ids,
            ...(existing ? { groupId: existing.id } : { createProperties: { windowId } }),
          });
          if (!existing) await chrome.tabGroups.update(groupId, { title });
          if (collapsed !== undefined) await setGroupCollapsed(groupId, windowId, ids, collapsed);
        } catch (error) {
          console.warn('[AgentBridge] Failed to organize agent tabs:', error);
        }
      }
    });
  return groupQueue;
}

export function groupOpenedAgentTab(
  tabId: number,
  group?: string,
  foreground = false,
): Promise<void> {
  return addTabsToNamedGroup(
    [tabId],
    group?.trim() ?? (foreground ? userGroupTitle() : AGENT_GROUP_TITLE),
    group === undefined ? !foreground : undefined,
  );
}

export async function handoffAgentTabGroups(tabIds: number[]): Promise<void> {
  if (!chrome.tabGroups?.query) return;
  try {
    const managed: number[] = [];
    const groupIds = new Set((await getAgentGroups()).map(group => group.id));
    for (const tabId of tabIds) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab && groupIds.has(tab.groupId)) managed.push(tabId);
    }
    await addTabsToNamedGroup(managed, userGroupTitle(), false);
  } catch (error) {
    console.warn('[AgentBridge] Failed to present agent tab groups:', error);
  }
}

export async function resumeAgentTabGroups(tabIds: number[]): Promise<void> {
  if (!chrome.tabGroups?.query) return;
  try {
    const groups = await chrome.tabGroups.query({ title: userGroupTitle() });
    const groupIds = new Set(
      groups.filter(group => group.title === userGroupTitle()).map(group => group.id),
    );
    const returning: number[] = [];
    for (const tabId of tabIds) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab && groupIds.has(tab.groupId)) returning.push(tabId);
    }
    await addTabsToNamedGroup(returning, AGENT_GROUP_TITLE, true);
  } catch (error) {
    console.warn('[AgentBridge] Failed to restore agent tab groups:', error);
  }
}

/** Page-created tabs inherit the presentation of their Mearl opener. */
export async function groupAgentNavigationTarget(
  details: Pick<chrome.webNavigation.WebNavigationSourceCallbackDetails, 'sourceTabId' | 'tabId'>,
  fromAgentAction = false,
): Promise<void> {
  if (!chrome.tabGroups?.get) return;
  try {
    const opener = await chrome.tabs.get(details.sourceTabId);
    const group = opener.groupId < 0 ? undefined : await chrome.tabGroups.get(opener.groupId);
    if (group?.title === AGENT_GROUP_TITLE) {
      await addTabsToNamedGroup([details.tabId], AGENT_GROUP_TITLE, group.collapsed);
    } else if (group?.title === userGroupTitle()) {
      await groupOpenedAgentTab(details.tabId, undefined, true);
    } else if (fromAgentAction) {
      await groupOpenedAgentTab(details.tabId);
    }
  } catch (error) {
    console.warn('[AgentBridge] Failed to group opened page:', error);
  }
}
