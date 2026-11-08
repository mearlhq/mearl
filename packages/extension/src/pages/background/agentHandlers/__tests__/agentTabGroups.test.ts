import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTabsToNamedGroup,
  getAgentGroupWindowId,
  groupAgentNavigationTarget,
  groupOpenedAgentTab,
  handoffAgentTabGroups,
  resumeAgentTabGroups,
} from '../agentTabGroups';

const USER_GROUP = 'agentUserTabGroup';

describe('agent tab presentation', () => {
  let tabs: Map<number, chrome.tabs.Tab>;
  let groups: Map<number, chrome.tabGroups.TabGroup>;

  function addTab(id: number, windowId = 1, active = false, groupId = -1) {
    const tab = { id, windowId, active, groupId } as chrome.tabs.Tab;
    tabs.set(id, tab);
    return tab;
  }

  beforeEach(() => {
    tabs = new Map();
    groups = new Map();
    addTab(1, 1, true);
    addTab(2);
    addTab(3);
    let nextGroup = 100;
    chrome.tabs = {
      get: vi.fn(async id => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('Tab closed');
        return { ...tab };
      }),
      query: vi.fn(async ({ windowId, groupId }) =>
        [...tabs.values()].filter(
          tab =>
            (windowId === undefined || tab.windowId === windowId) &&
            (groupId === undefined || tab.groupId === groupId),
        ),
      ),
      group: vi.fn(async ({ tabIds, groupId, createProperties }) => {
        const id = groupId ?? nextGroup++;
        if (!groups.has(id)) {
          groups.set(id, {
            id,
            title: '',
            collapsed: false,
            windowId: createProperties?.windowId ?? 1,
          } as chrome.tabGroups.TabGroup);
        }
        const previous = tabIds.map((tabId: number) => tabs.get(tabId)!.groupId);
        for (const tabId of tabIds) {
          const tab = tabs.get(tabId)!;
          if (tab.windowId !== groups.get(id)!.windowId) throw new Error('Different windows');
          tab.groupId = id;
        }
        for (const oldId of previous) {
          if (![...tabs.values()].some(tab => tab.groupId === oldId)) groups.delete(oldId);
        }
        return id;
      }),
      move: vi.fn(async (ids, { windowId }) => {
        const previous = ids.map((id: number) => tabs.get(id)!.groupId);
        const moved = ids.map((id: number) => {
          const tab = tabs.get(id)!;
          Object.assign(tab, { windowId, groupId: -1, active: false });
          return { ...tab };
        });
        for (const oldId of previous) {
          if (![...tabs.values()].some(tab => tab.groupId === oldId)) groups.delete(oldId);
        }
        return moved;
      }),
      update: vi.fn(async (id, update) => {
        const tab = tabs.get(id)!;
        if (update.active) {
          for (const other of tabs.values()) {
            if (other.windowId === tab.windowId) other.active = false;
          }
        }
        Object.assign(tab, update);
        return { ...tab };
      }),
    } as any;
    chrome.tabGroups = {
      TAB_GROUP_ID_NONE: -1,
      get: vi.fn(async id => groups.get(id)),
      query: vi.fn(async ({ title, windowId }) =>
        [...groups.values()].filter(
          group =>
            (title === undefined || group.title === title) &&
            (windowId === undefined || group.windowId === windowId),
        ),
      ),
      move: vi.fn(async (id, { windowId }) => {
        groups.get(id)!.windowId = windowId;
        for (const tab of tabs.values()) {
          if (tab.groupId === id) tab.windowId = windowId;
        }
        return groups.get(id);
      }),
      update: vi.fn(async (id, update) => {
        if (update.collapsed && [...tabs.values()].some(tab => tab.active && tab.groupId === id)) {
          throw new Error('Cannot collapse the active tab');
        }
        Object.assign(groups.get(id)!, update);
        return groups.get(id);
      }),
    } as any;
  });

  it('shares one collapsed Mearl group for concurrent background opens', async () => {
    await Promise.all([groupOpenedAgentTab(2), groupOpenedAgentTab(3)]);
    expect(groups.size).toBe(1);
    expect(tabs.get(2)!.groupId).toBe(tabs.get(3)!.groupId);
    expect([...groups.values()][0]).toMatchObject({ title: 'Mearl', collapsed: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('collects new pages from different windows into one group and skips closed tabs', async () => {
    addTab(4, 2, true);
    addTab(5, 2);
    await addTabsToNamedGroup([2, 5, 99], 'Mearl', true);
    expect([...groups.values()]).toMatchObject([{ title: 'Mearl', windowId: 1, collapsed: true }]);
    expect(tabs.get(5)!.windowId).toBe(1);
    expect(chrome.tabs.move).toHaveBeenCalledWith([5], { windowId: 1, index: -1 });
  });

  it('preserves explicit group names and their existing presentation', async () => {
    await groupOpenedAgentTab(2, ' My task ');
    await chrome.tabGroups.update(100, { collapsed: true });
    await groupOpenedAgentTab(3, 'My task', true);
    expect(groups.get(100)).toMatchObject({ title: 'My task', collapsed: true });
    expect(groups.size).toBe(1);
  });

  it('requires an exact title even when Chrome title queries match patterns', async () => {
    groups.set(50, { id: 50, title: 'Other task', windowId: 1 } as chrome.tabGroups.TabGroup);
    vi.mocked(chrome.tabGroups.query).mockResolvedValueOnce([...groups.values()]);
    await groupOpenedAgentTab(2, '*');
    expect(tabs.get(2)!.groupId).toBe(100);
    expect(groups.get(100)!.title).toBe('*');
  });

  it('moves handed off pages into a shared expanded group and folds them on return', async () => {
    await addTabsToNamedGroup([2, 3], 'Mearl', true);
    await handoffAgentTabGroups([2, 3]);
    expect(groups.get(tabs.get(2)!.groupId)).toMatchObject({ title: USER_GROUP, collapsed: false });
    await chrome.tabs.update(2, { active: true });
    await resumeAgentTabGroups([2, 3]);
    const returnedGroup = tabs.get(2)!.groupId;
    expect(tabs.get(3)!.groupId).toBe(returnedGroup);
    expect(tabs.get(1)!.active).toBe(true);
    expect(groups.get(returnedGroup)!.collapsed).toBe(true);
  });

  it('does not regroup unrelated pages or pages manually moved before returning control', async () => {
    await groupOpenedAgentTab(2, 'My task');
    await handoffAgentTabGroups([1, 2, 99]);
    await resumeAgentTabGroups([1, 2, 99]);
    expect(tabs.get(1)!.groupId).toBe(-1);
    expect(groups.get(tabs.get(2)!.groupId)!.title).toBe('My task');
  });

  it('keeps a group the user is viewing expanded when a background page joins', async () => {
    await groupOpenedAgentTab(2);
    await chrome.tabGroups.update(100, { collapsed: false });
    await chrome.tabs.update(2, { active: true });
    await groupOpenedAgentTab(3);
    expect(groups.get(100)!.collapsed).toBe(false);
    expect(tabs.get(2)!.active).toBe(true);
  });

  it('keeps the only available page visible without creating extra tabs', async () => {
    tabs.delete(2);
    tabs.delete(3);
    await groupOpenedAgentTab(1);
    expect(groups.get(100)!.collapsed).toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('groups page-created targets and restores a non-agent tab when they become active', async () => {
    await groupOpenedAgentTab(2);
    await chrome.tabs.update(3, { active: true });
    await groupAgentNavigationTarget({ sourceTabId: 2, tabId: 3 } as any);
    expect(tabs.get(3)!.groupId).toBe(100);
    expect(groups.get(100)!.collapsed).toBe(true);
    expect(tabs.get(1)!.active).toBe(true);
    await handoffAgentTabGroups([2]);
    addTab(4);
    await groupAgentNavigationTarget({ sourceTabId: 2, tabId: 4 } as any);
    expect(tabs.get(4)!.groupId).toBe(tabs.get(2)!.groupId);
    expect(groups.get(tabs.get(4)!.groupId)!.collapsed).toBe(false);
  });

  it('leaves pages from ordinary openers alone and tolerates group API failures', async () => {
    await groupAgentNavigationTarget({ sourceTabId: 1, tabId: 3 } as any);
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    vi.mocked(chrome.tabGroups.query).mockRejectedValueOnce(new Error('Group unavailable'));
    await expect(groupOpenedAgentTab(2)).resolves.toBeUndefined();
    await groupOpenedAgentTab(3);
    expect(groups.get(tabs.get(3)!.groupId)!.title).toBe('Mearl');
  });

  it('keeps a foreground child visible when the user has expanded its Mearl group', async () => {
    await groupOpenedAgentTab(2);
    await chrome.tabGroups.update(100, { collapsed: false });
    await chrome.tabs.update(3, { active: true });
    vi.mocked(chrome.tabs.update).mockClear();

    await groupAgentNavigationTarget({ sourceTabId: 2, tabId: 3 } as any);

    expect(tabs.get(3)!.groupId).toBe(100);
    expect(tabs.get(3)!.active).toBe(true);
    expect(groups.get(100)!.collapsed).toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('keeps one pair of groups in the same window even when only the user group remains', async () => {
    await groupOpenedAgentTab(2);
    await handoffAgentTabGroups([2]);
    addTab(4, 2, true);
    addTab(5, 2);

    expect(await getAgentGroupWindowId()).toBe(1);
    await groupOpenedAgentTab(5);

    expect(tabs.get(5)!.windowId).toBe(1);
    expect([...groups.values()]).toMatchObject([
      { title: USER_GROUP, windowId: 1, collapsed: false },
      { title: 'Mearl', windowId: 1, collapsed: true },
    ]);
  });

  it('merges duplicate managed groups across windows while preserving both roles', async () => {
    await groupOpenedAgentTab(2);
    addTab(4, 2, true);
    addTab(5, 2, false, 200);
    addTab(6, 2, false, 201);
    groups.set(200, { id: 200, title: 'Mearl', windowId: 2, collapsed: true } as any);
    groups.set(201, { id: 201, title: USER_GROUP, windowId: 2, collapsed: false } as any);

    await groupOpenedAgentTab(3);

    expect([...groups.values()]).toMatchObject([
      { id: 100, title: 'Mearl', windowId: 1 },
      { id: 201, title: USER_GROUP, windowId: 1, collapsed: false },
    ]);
    expect(tabs.get(5)!.groupId).toBe(100);
    expect(tabs.get(6)!.windowId).toBe(1);
    expect(tabs.get(4)!.windowId).toBe(2);
  });

  it('moves page-created windows into the existing work window', async () => {
    await groupOpenedAgentTab(2);
    addTab(4, 2, true);
    await groupAgentNavigationTarget({ sourceTabId: 2, tabId: 4 } as any);
    expect(tabs.get(4)!.windowId).toBe(1);
    expect(tabs.get(4)!.groupId).toBe(tabs.get(2)!.groupId);
  });

  it('chooses a new existing window after the managed groups have closed', async () => {
    await groupOpenedAgentTab(2);
    tabs.delete(2);
    groups.clear();
    expect(await getAgentGroupWindowId()).toBeUndefined();
    addTab(4, 2, true);
    addTab(5, 2);
    await groupOpenedAgentTab(5);
    expect(await getAgentGroupWindowId()).toBe(2);
  });

  it('serializes concurrent tasks from different windows into the same group', async () => {
    addTab(4, 2, true);
    addTab(5, 2);
    await Promise.all([groupOpenedAgentTab(2), groupOpenedAgentTab(5)]);
    expect(groups.size).toBe(1);
    expect(tabs.get(5)!.windowId).toBe(tabs.get(2)!.windowId);
    expect(tabs.get(5)!.groupId).toBe(tabs.get(2)!.groupId);
  });

  it('collects only the child opened by an agent action from an ordinary user page', async () => {
    await groupOpenedAgentTab(2);
    addTab(4, 2, true);
    addTab(5, 2);
    await groupAgentNavigationTarget({ sourceTabId: 4, tabId: 5 }, true);
    expect(tabs.get(4)!.windowId).toBe(2);
    expect(tabs.get(4)!.groupId).toBe(-1);
    expect(tabs.get(5)!.windowId).toBe(1);
    expect(tabs.get(5)!.groupId).toBe(tabs.get(2)!.groupId);
  });

  it('creates each role in the selected window even when another window is current', async () => {
    addTab(4, 2, true);
    addTab(5, 2);
    await groupOpenedAgentTab(5);
    await handoffAgentTabGroups([5]);
    expect(chrome.tabs.group).toHaveBeenNthCalledWith(1, {
      tabIds: [5],
      createProperties: { windowId: 2 },
    });
    expect(chrome.tabs.group).toHaveBeenNthCalledWith(2, {
      tabIds: [5],
      createProperties: { windowId: 2 },
    });
    expect(await getAgentGroupWindowId()).toBe(2);
  });

  it('keeps the selected work window when a duplicate group has a lower random ID', async () => {
    await groupOpenedAgentTab(2);
    addTab(4, 2, true);
    addTab(5, 2, false, 10);
    groups.set(10, { id: 10, title: 'Mearl', windowId: 2, collapsed: true } as any);
    expect(await getAgentGroupWindowId()).toBe(1);
    await groupOpenedAgentTab(3);
    expect(tabs.get(5)!.windowId).toBe(1);
    expect(groups.size).toBe(1);
  });

  it('preserves Chrome privacy boundaries when choosing and merging managed groups', async () => {
    await groupOpenedAgentTab(2);
    addTab(4, 2, true).incognito = true;
    addTab(5, 2).incognito = true;
    await groupOpenedAgentTab(5);

    expect(await getAgentGroupWindowId(false)).toBe(1);
    expect(await getAgentGroupWindowId(true)).toBe(2);
    expect(tabs.get(5)!.windowId).toBe(2);
    expect(tabs.get(5)!.groupId).not.toBe(tabs.get(2)!.groupId);
    expect(chrome.tabs.move).not.toHaveBeenCalled();
  });
});
