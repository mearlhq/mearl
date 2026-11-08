import { describe, expect, it, vi } from 'vitest';
import { smartGroupTabs, closeMearlTabs, groupTabs, summarizeTabs, removeGroup, closeGroup } from '../../browser-tab-manager/scripts/tabs.mjs';

const tabs = [
  { id: 1, windowId: 10, title: 'Project spec', url: 'https://docs.example.com/spec?token=private', pinned: false },
  { id: 2, windowId: 10, title: 'Project issue', url: 'https://issues.example.com/123', pinned: false, controlled: true },
  { id: 3, windowId: 11, title: 'Other window', url: 'https://docs.example.com/other', pinned: false },
  { id: 4, windowId: 10, title: 'Pinned', url: 'https://docs.example.com/pinned', pinned: true },
  { id: 5, windowId: 10, title: 'Toolbox', url: 'chrome-extension://abc/tool', controlled: true },
];
const groupedTabs = [
  { ...tabs[0], groupId: 41, groupTitle: 'Project', groupColor: 'orange' },
  { ...tabs[1], groupId: 41, groupTitle: 'Project', groupColor: 'orange' },
  ...tabs.slice(2),
];

describe('browser tab manager', () => {
  it('uses one temporary Agent result and applies a validated group', async () => {
    const invoke = vi.fn(async (action, input) => {
      if (action === 'tab_list') return { tabs };
      if (action === 'tab_group') return { groupId: 41 };
      throw new Error(action);
    });
    const model = vi.fn(async request => {
      expect(request.prompt).not.toContain('token=private');
      expect(request.prompt).not.toContain('Pinned');
      expect(request.prompt).not.toContain('Other window');
      expect(request).toMatchObject({ provider: 'codex', mode: 'agent', permissions: 'read-only', model: 'gpt-6-luna', reasoningEffort: 'low', outputSchema: { type: 'object' } });
      return { output: { groups: [{ title: 'Project', tabIds: [1, 2] }] } };
    });
    await expect(smartGroupTabs({}, invoke, () => {}, model)).resolves.toMatchObject({ groupedTabs: 2, failed: [] });
    expect(model).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('tab_group', { tabIds: [1, 2], title: 'Project' });
  });

  it('skips the Agent when no window has two eligible tabs', async () => {
    const invoke = vi.fn(async () => ({ tabs: [tabs[0], tabs[2], tabs[3], tabs[4]] }));
    await expect(smartGroupTabs({}, invoke)).resolves.toMatchObject({ groupedTabs: 0, reason: 'not-enough-tabs' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects Agent groups spanning windows before changing tabs', async () => {
    const invoke = vi.fn(async action => ({ tabs }));
    await expect(groupTabs({ groups: [{ title: 'Mixed', tabIds: [1, 3] }] }, invoke)).rejects.toThrow('spans windows');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('closes only controlled web tabs', async () => {
    const invoke = vi.fn(async action => action === 'tab_list' ? { tabs } : { success: true });
    await expect(summarizeTabs({}, invoke)).resolves.toEqual({ count: 5, mearlCount: 1, groups: [] });
    await expect(closeMearlTabs({}, invoke)).resolves.toMatchObject({ closed: [2], closedCount: 1 });
    expect(invoke).toHaveBeenCalledWith('tab_close', { tabId: 2 });
    expect(invoke).not.toHaveBeenCalledWith('tab_close', { tabId: 5 });
  });

  it('lists groups and removes one while keeping its tabs', async () => {
    const invoke = vi.fn(async action => action === 'tab_list' ? { tabs: groupedTabs } : { ungrouped: true });
    await expect(summarizeTabs({}, invoke)).resolves.toMatchObject({
      groups: [{ groupId: 41, windowId: 10, title: 'Project', color: 'orange', tabIds: [1, 2] }],
    });
    await expect(removeGroup({ groupId: 41, windowId: 10, title: 'Project', tabIds: [1, 2] }, invoke)).resolves.toEqual({
      groupId: 41,
      ungroupedTabs: 2,
    });
    expect(invoke).toHaveBeenCalledWith('tab_group', { tabIds: [1, 2], ungroup: true });
    expect(invoke).not.toHaveBeenCalledWith('tab_close', expect.anything());
  });

  it('rejects a changed group before modifying tabs', async () => {
    const invoke = vi.fn(async () => ({ tabs: groupedTabs }));
    await expect(removeGroup({ groupId: 41, windowId: 10, title: 'Old title', tabIds: [1, 2] }, invoke)).rejects.toThrow('changed');
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(removeGroup({ groupId: 41, windowId: 10, title: 'Project', tabIds: [1] }, invoke)).rejects.toThrow('changed');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('closes every tab in a group and reports partial failures', async () => {
    const invoke = vi.fn(async (action, input) => {
      if (action === 'tab_list') return { tabs: groupedTabs };
      if (action === 'tab_close' && input.tabId === 2) throw new Error('Cannot close tab');
      return { success: true };
    });
    await expect(closeGroup({ groupId: 41, windowId: 10, title: 'Project', tabIds: [1, 2] }, invoke)).resolves.toEqual({
      groupId: 41,
      closedCount: 1,
      failed: [{ tabId: 2, error: 'Cannot close tab' }],
    });
    expect(invoke).toHaveBeenCalledWith('tab_close', { tabId: 1 });
    expect(invoke).toHaveBeenCalledWith('tab_close', { tabId: 2 });
  });
});
