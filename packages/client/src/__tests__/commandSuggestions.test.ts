import { describe, expect, it } from 'vitest';
import {
  commandInput,
  findCommandSuggestions,
  formatCommandSuggestions,
} from '../commandSuggestions.js';
import { COMMANDS } from '../commands.js';

describe('command suggestions', () => {
  it.each([
    ['page_fill', 'page_type', '"clearFirst":true'],
    ['page_select', 'page_click', '"role":"option"'],
    ['page_reload', 'page_navigate', '"refresh":true'],
    ['tab_activate', 'tab_open', '"reuse":"require","active":true'],
  ])('recommends a suitable canonical invocation for %s', (input, action, payload) => {
    const suggestions = findCommandSuggestions([input, '--help'], COMMANDS);
    expect(suggestions.map(item => item.command.name)).toEqual([action]);
    expect(formatCommandSuggestions('mearl', suggestions)[0]).toContain(`mearl ${action} --payload`);
    expect(formatCommandSuggestions('mearl', suggestions)[0]).toContain(payload);
    expect(COMMANDS.some(command => command.name === input)).toBe(false);
  });
  it('uses semantic aliases before edit-distance fallbacks', () => {
    const suggestions = findCommandSuggestions(['tab', 'new'], COMMANDS);

    expect(suggestions[0]).toMatchObject({ command: { name: 'tab_open' }, score: 1 });
    expect(suggestions.map(item => item.command.name)).toEqual(['tab_open']);
  });

  it('corrects misspelled canonical actions', () => {
    expect(findCommandSuggestions(['tab_opne'], COMMANDS).map(item => item.command.name)).toEqual([
      'tab_open',
    ]);
    expect(findCommandSuggestions(['page_clikc'], COMMANDS).map(item => item.command.name)).toEqual(
      ['page_click'],
    );
  });

  it('normalizes separators and uses a useful command prefix when extra input follows', () => {
    expect(findCommandSuggestions(['tab-open'], COMMANDS)[0]).toMatchObject({
      command: { name: 'tab_open' },
      score: 1,
    });
    expect(
      findCommandSuggestions(['tab', 'new', 'https://example.com'], COMMANDS)[0],
    ).toMatchObject({ command: { name: 'tab_open' }, score: 1 });
  });

  it('does not recommend unrelated commands', () => {
    expect(findCommandSuggestions(['totally-unrelated'], COMMANDS)).toEqual([]);
  });

  it('formats existing command examples for immediate retry', () => {
    const suggestions = findCommandSuggestions(['tab', 'new'], COMMANDS, 1);

    expect(commandInput(['tab', 'new', '--help'])).toBe('tab new');
    expect(formatCommandSuggestions('mearl', suggestions)).toEqual([
      '  mearl tab_open --payload \'{"url":"https://example.com"}\'\n' +
        '    打开或按 URL 规则复用 Tab，并等待新页面加载完成',
    ]);
  });
});
