import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolboxPluginTool } from '@mearl/browser-core';
import { cacheToolboxNavigation, readToolboxNavigationCache } from '../toolboxNavigationCache';

const language = vi.hoisted(() => ({ current: 'en' }));
vi.mock('../../panel/utils/i18n', () => ({ getCurrentLanguage: () => language.current }));

const storageKey = 'mearl.popup.toolbox.navigation';
const tool: ToolboxPluginTool = {
  id: 'plugin:notebook',
  plugin: 'notebook',
  title: 'Workspace Notes',
  icon: 'git-branch',
  order: 100,
  locales: { zh_CN: { title: '工作区笔记' } },
  description: 'Organize workspace notes',
};

describe('toolbox navigation cache', () => {
  beforeEach(() => {
    language.current = 'en';
    window.localStorage.clear();
  });

  it('stores only navigation metadata and restores it synchronously', () => {
    expect(readToolboxNavigationCache()).toEqual([]);
    cacheToolboxNavigation([tool]);
    expect(readToolboxNavigationCache()).toEqual([
      { id: tool.id, title: tool.title, icon: tool.icon },
    ]);
    expect(window.localStorage.getItem(storageKey)).not.toContain('description');
    cacheToolboxNavigation([]);
    expect(readToolboxNavigationCache()).toEqual([]);
  });

  it('keeps localized titles scoped to the current language', () => {
    language.current = 'zh_CN';
    cacheToolboxNavigation([tool]);
    expect(readToolboxNavigationCache()[0].title).toBe('工作区笔记');
    language.current = 'en';
    expect(readToolboxNavigationCache()).toEqual([]);
  });

  it.each(['{', 'null', '{}', '{"language":"en","tools":{}}'])(
    'ignores malformed cache %s',
    cached => {
      window.localStorage.setItem(storageKey, cached);
      expect(readToolboxNavigationCache()).toEqual([]);
    },
  );

  it('ignores invalid entries and accepts tools without a custom icon', () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        language: 'en',
        tools: [
          null,
          {},
          { id: 'builtin:formatter', title: 'Formatter' },
          { id: tool.id, title: 42 },
          { id: tool.id, title: tool.title, icon: {} },
          { id: tool.id, title: tool.title },
        ],
      }),
    );
    expect(readToolboxNavigationCache()).toEqual([{ id: tool.id, title: tool.title }]);
  });

  it('keeps navigation usable when browser storage is unavailable', () => {
    const get = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const set = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      expect(readToolboxNavigationCache()).toEqual([]);
      expect(() => cacheToolboxNavigation([tool])).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
