import { describe, expect, it } from 'vitest';
import { normalizePluginToolboxContribution } from '../pluginRegistry';

const toolbox = {
  version: 1,
  title: 'Tool',
  page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['read'] },
};

describe('plugin toolbox icon metadata', () => {
  it.each([
    'wrench',
    'https://example.com/tool.svg',
    'http://example.com/tool.png',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="blue" d="M0 0h4v4"/></svg>',
    'data:image/png;base64,aGVsbG8=',
  ])('preserves a valid icon source during registration: %s', icon => {
    expect(normalizePluginToolboxContribution({ ...toolbox, icon: ` ${icon} ` })?.icon).toBe(icon);
  });
  it.each([
    'javascript:alert(1)',
    'file:///tmp/a.svg',
    'https://user:secret@example.com/icon.png',
    '<div>not svg</div>',
    'x'.repeat(32769),
  ])('rejects unsupported icon metadata', icon => {
    expect(() => normalizePluginToolboxContribution({ ...toolbox, icon })).toThrow('toolbox.icon');
  });
});
