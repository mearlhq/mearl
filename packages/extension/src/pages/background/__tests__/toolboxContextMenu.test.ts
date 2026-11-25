import type { ToolboxDisplayMode, ToolboxToolsListResult } from '@mearl/browser-core';
import { beforeEach, expect, it, vi } from 'vitest';
import { initializeToolboxContextMenu } from '../toolboxContextMenu';

vi.mock('../../../shared/i18n', () => ({
  loadMessages: vi.fn(async (language: string) => ({
    toolboxTitle: { message: language === 'en' ? 'Toolbox' : '工具箱' },
  })),
}));

const parent = 'toolboxOpenInTab';
const menuId = (name: string) => `${parent}:plugin:${name}`;
const tool = (name: string, displayMode?: ToolboxDisplayMode) => ({
  id: `plugin:${name}`,
  plugin: name,
  title: name,
  order: 100,
  displayMode,
});
const items = new Map<string, chrome.contextMenus.CreateProperties>();
let language: string;

beforeEach(() => {
  language = 'zh_CN';
  items.clear();
  items.set('scanQrCode', { id: 'scanQrCode', contexts: ['page'] });
  chrome.runtime.onInstalled = {
    addListener: vi.fn(),
  } as unknown as typeof chrome.runtime.onInstalled;
  chrome.runtime.onStartup = { addListener: vi.fn() } as unknown as typeof chrome.runtime.onStartup;
  chrome.runtime.getURL = path => `chrome-extension://mearl/${path}`;
  chrome.storage.sync = {
    get: vi.fn(async () => ({ language })),
  } as unknown as typeof chrome.storage.sync;
  chrome.windows = {
    WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener: vi.fn() },
  } as unknown as typeof chrome.windows;
  chrome.contextMenus = {
    create: vi.fn((item: chrome.contextMenus.CreateProperties, done: () => void) => {
      items.set(item.id!, item);
      done();
      return item.id;
    }),
    remove: vi.fn((id: string, done: () => void) => {
      for (const [itemId, item] of items) {
        if (id === itemId || id === item.parentId) items.delete(itemId);
      }
      done();
    }),
    onClicked: { addListener: vi.fn() },
  } as unknown as typeof chrome.contextMenus;
  chrome.tabs = { create: vi.fn().mockResolvedValue({}) } as unknown as typeof chrome.tabs;
});

it('lists every eligible installed tool on the extension icon and opens the selected tool', async () => {
  const tools = [
    { ...tool('my_notes', 'tab'), locales: { zh_CN: { title: '笔记' } } },
    tool('legacy'),
    ...Array.from({ length: 7 }, (_, index) => tool(`tool-${index}`, 'both')),
    tool('small', 'popup'),
  ];
  initializeToolboxContextMenu(async () => ({ tools }));
  vi.mocked(chrome.runtime.onStartup.addListener).mock.calls[0][0]();

  await vi.waitFor(() => expect(items.size).toBe(11));
  expect(items.get(parent)).toEqual({ id: parent, title: '工具箱', contexts: ['action'] });
  expect(items.get(menuId('my_notes'))).toMatchObject({
    title: '笔记',
    parentId: parent,
    contexts: ['action'],
  });
  expect(items.has(menuId('legacy'))).toBe(true);
  expect(items.has(menuId('tool-6'))).toBe(true);
  expect(items.has(menuId('small'))).toBe(false);

  const click = vi.mocked(chrome.contextMenus.onClicked.addListener).mock.calls[0][0];
  const context = { pageUrl: 'https://example.com', editable: false };
  click({ ...context, menuItemId: parent });
  click({ ...context, menuItemId: 'scanQrCode' });
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  click({ ...context, menuItemId: menuId('my_notes') });
  expect(chrome.tabs.create).toHaveBeenCalledWith({
    url: 'chrome-extension://mearl/plugin/index.html#my_notes',
    active: true,
  });
});

it('replaces stale menu entries after an install and removes the submenu when no eligible tools remain', async () => {
  items.set(parent, { id: parent, title: '旧工具箱' });
  items.set(menuId('old'), { id: menuId('old'), parentId: parent });
  const readTools = vi.fn<() => Promise<ToolboxToolsListResult>>();
  const { listTools, refresh } = initializeToolboxContextMenu(readTools);
  const result = { tools: [tool('notes', 'tab')] };
  readTools.mockResolvedValueOnce(result);
  await expect(listTools()).resolves.toBe(result);
  await vi.waitFor(() => expect(items.has(menuId('notes'))).toBe(true));
  expect(items.has(menuId('old'))).toBe(false);

  readTools.mockRejectedValueOnce(new Error('Native host disconnected'));
  await expect(listTools()).rejects.toThrow('Native host disconnected');
  expect(items.has(menuId('notes'))).toBe(true);

  readTools.mockResolvedValueOnce({ tools: [tool('notes', 'popup')] });
  refresh();
  await vi.waitFor(() => expect([...items.keys()]).toEqual(['scanQrCode']));
});

it('keeps the newer registry results when an earlier request finishes late', async () => {
  const previous = Promise.withResolvers<ToolboxToolsListResult>();
  const readTools = vi
    .fn<() => Promise<ToolboxToolsListResult>>()
    .mockReturnValueOnce(previous.promise)
    .mockResolvedValueOnce({ tools: [tool('new', 'both')] });
  const { listTools } = initializeToolboxContextMenu(readTools);
  const firstRequest = listTools();
  language = 'en';
  await listTools();
  await vi.waitFor(() => expect(items.get(parent)?.title).toBe('Toolbox'));

  previous.resolve({ tools: [tool('old', 'both')] });
  await firstRequest;
  expect([...items.keys()]).toEqual(['scanQrCode', parent, menuId('new')]);
});
