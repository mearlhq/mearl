import { describe, it, expect } from 'vitest';
import {
  isPresetActive,
  addPresetParams,
  removePresetParams,
  togglePresetInQuery,
  parseParamsInput,
  mergeMissingBuiltinPresets,
  DEFAULT_QUERY_PRESETS as CORE_QUERY_PRESETS,
  type UrlQueryPreset,
} from '../urlQueryPresets';

const DEFAULT_QUERY_PRESETS: UrlQueryPreset[] = [{ id: 'immersiveTitleBar', params: [{ key: 'fullscreen', value: 'true' }] }, { id: 'readerHalfOverlay', params: [{ key: 'overlay', value: 'true' }] }];
const mergePresets = (items: UrlQueryPreset[], seen: string[]) => mergeMissingBuiltinPresets(items, seen, DEFAULT_QUERY_PRESETS);
it('starts without organization query defaults', () => expect(CORE_QUERY_PRESETS).toEqual([]));

const immersive: UrlQueryPreset = {
  id: 'immersiveTitleBar',
  params: [
    { key: 'titleBarHidden', value: '2' },
    { key: 'disableNav', value: 'YES' },
    { key: 'status_bar_transparent', value: 'true' },
    { key: '__webview_options__', value: 'fullscreen=YES' },
  ],
};

describe('urlQueryPresets', () => {
  describe('isPresetActive', () => {
    it('命中任一参数即视为激活', () => {
      expect(isPresetActive('a=1&disableNav=YES', immersive)).toBe(true);
    });

    it('全部参数缺失时为未激活', () => {
      expect(isPresetActive('a=1&b=2', immersive)).toBe(false);
      expect(isPresetActive('', immersive)).toBe(false);
    });

    it('同 key 但值不同不算激活', () => {
      expect(isPresetActive('titleBarHidden=0', immersive)).toBe(false);
    });

    it('比对时对编码后的值解码', () => {
      expect(isPresetActive('__webview_options__=fullscreen%3DYES', immersive)).toBe(true);
    });
  });

  describe('addPresetParams', () => {
    it('空 query 时写入全部参数并编码含 = 的值', () => {
      expect(addPresetParams('', immersive)).toBe(
        'titleBarHidden=2&disableNav=YES&status_bar_transparent=true&__webview_options__=fullscreen%3DYES',
      );
    });

    it('保留已有参数并替换同 key 的旧值', () => {
      const result = addPresetParams('foo=bar&titleBarHidden=0', immersive);
      expect(result).toContain('foo=bar');
      expect(result).toContain('titleBarHidden=2');
      expect(result).not.toContain('titleBarHidden=0');
    });
  });

  describe('removePresetParams', () => {
    it('移除全部相关 key，不论其值，保留无关参数', () => {
      const result = removePresetParams(
        'foo=bar&titleBarHidden=2&disableNav=YES&status_bar_transparent=true&__webview_options__=fullscreen%3DYES',
        immersive,
      );
      expect(result).toBe('foo=bar');
    });

    it('对同 key 不同值也会移除', () => {
      expect(removePresetParams('titleBarHidden=0&foo=bar', immersive)).toBe('foo=bar');
    });
  });

  describe('togglePresetInQuery', () => {
    it('未激活 -> 添加，激活 -> 移除', () => {
      const added = togglePresetInQuery('foo=bar', immersive);
      expect(isPresetActive(added, immersive)).toBe(true);
      const removed = togglePresetInQuery(added, immersive);
      expect(removed).toBe('foo=bar');
    });
  });

  describe('parseParamsInput', () => {
    it('解析标准 query 片段', () => {
      expect(parseParamsInput('a=1&b=2')).toEqual([
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ]);
    });

    it('容忍前导 ? 或 & 及空白', () => {
      expect(parseParamsInput('  &titleBarHidden=2  ')).toEqual([
        { key: 'titleBarHidden', value: '2' },
      ]);
      expect(parseParamsInput('?a=1')).toEqual([{ key: 'a', value: '1' }]);
    });

    it('对编码值解码，值内含 = 按首个 = 拆分', () => {
      expect(parseParamsInput('__webview_options__=fullscreen%3DYES')).toEqual([
        { key: '__webview_options__', value: 'fullscreen=YES' },
      ]);
    });

    it('空输入或纯符号返回空数组', () => {
      expect(parseParamsInput('')).toEqual([]);
      expect(parseParamsInput('  ')).toEqual([]);
      expect(parseParamsInput('&&')).toEqual([]);
    });

    it('自定义预设可与解析/回写闭环', () => {
      const preset: UrlQueryPreset = {
        id: 'custom',
        label: '我的',
        params: parseParamsInput('__webview_options__=fullscreen%3DYES&x=1'),
      };
      const q = addPresetParams('', preset);
      expect(q).toBe('__webview_options__=fullscreen%3DYES&x=1');
      expect(isPresetActive(q, preset)).toBe(true);
    });
  });

  describe('mergeMissingBuiltinPresets', () => {
    const builtinIds = DEFAULT_QUERY_PRESETS.map(p => p.id);

    it('把未见过的内置项补入已存储列表', () => {
      // 老用户：只存了 immersive，且 seen 基线也只有 immersive
      const stored = DEFAULT_QUERY_PRESETS.filter(p => p.id === 'immersiveTitleBar');
      const result = mergePresets(stored, ['immersiveTitleBar']);
      expect(result.changed).toBe(true);
      expect(result.presets.map(p => p.id)).toContain('readerHalfOverlay');
      expect(result.seenIds).toEqual(expect.arrayContaining(builtinIds));
    });

    it('不复活用户已删除的内置项（其 id 已在 seen 基线中）', () => {
      // 老用户删除了 immersive，seen 基线含 immersive
      const result = mergePresets(
        [{ id: 'custom', label: '我的', params: [{ key: 'a', value: '1' }] }],
        ['immersiveTitleBar'],
      );
      expect(result.presets.map(p => p.id)).not.toContain('immersiveTitleBar');
      // 但新内置项仍会补入
      expect(result.presets.map(p => p.id)).toContain('readerHalfOverlay');
    });

    it('已呈现过的内置项不再重复补入', () => {
      const result = mergePresets([], builtinIds);
      expect(result.presets).toEqual([]);
      expect(result.changed).toBe(false);
    });

    it('全新用户（列表已含全部内置项）不产生重复', () => {
      const result = mergePresets(DEFAULT_QUERY_PRESETS, ['immersiveTitleBar']);
      const ids = result.presets.map(p => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining(builtinIds));
    });
  });
});
