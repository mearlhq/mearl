import { describe, expect, it, vi } from 'vitest';
import { referenceLinksPlugin } from '../reference-links.mjs';

const root = new URL('../../../../../', import.meta.url);
const visitor = referenceLinksPlugin('/mearl/').element;

describe('compiled reference links', () => {
  it.each([
    ['../mcp-server/README.md#配置', '/mearl/reference/mcp.html#%E9%85%8D%E7%BD%AE'],
    ['README.en.md', '/mearl/en/reference/cli-sdk.html'],
    [
      '../../docs/browser-bundles.en.md#page-runtimes',
      'https://github.com/mearlhq/mearl/blob/main/docs/browser-bundles.en.md#page-runtimes',
    ],
    [
      '../../skills/mearl/SKILL.md',
      'https://github.com/mearlhq/mearl/blob/main/skills/mearl/SKILL.md',
    ],
    ['../../skills', 'https://github.com/mearlhq/mearl/tree/main/skills'],
  ])('resolves %s relative to the source file', (href, expected) => {
    const setProperty = vi.fn();
    const node = { properties: { href } };
    visitor.visit(node, { fileURL: new URL('packages/client/README.md', root), setProperty });
    expect(setProperty).toHaveBeenCalledWith(node, 'href', expected);
  });

  it.each(['#setup', 'https://example.com/'])('preserves %s', href => {
    const setProperty = vi.fn();
    visitor.visit(
      { properties: { href } },
      { fileURL: new URL('packages/client/README.en.md', root), setProperty },
    );
    expect(setProperty).not.toHaveBeenCalled();
  });
});
