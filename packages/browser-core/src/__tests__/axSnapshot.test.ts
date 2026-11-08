import { describe, expect, it } from 'vitest';
import {
  filterSnapshotTree,
  filterSnapshotTreeByQuery,
  formatSnapshotNode,
  formatSnapshotWithLimits,
  hasInteractiveSnapshotNode,
  limitPageSnapshotQueryMatches,
  reconcileAXCheckedStates,
  resolvePageSnapshotQuery,
  type AXNodeBase,
  type SnapshotNodeBase,
} from '../axSnapshot.js';

const tree: SnapshotNodeBase = {
  role: 'RootWebArea',
  name: 'Search',
  backendDOMNodeId: 1,
  focused: true,
  children: [
    { role: 'StaticText', name: 'Above fold', backendDOMNodeId: 2, ref: '@e1' },
    { role: 'button', name: 'Submit', backendDOMNodeId: 3, ref: '@e2' },
    { role: 'StaticText', name: 'Below fold', backendDOMNodeId: 4, ref: '@e3' },
  ],
};

describe('AX snapshot shaping', () => {
  it('promotes content through anonymous groups without wasting indentation', () => {
    const lines: string[] = [];
    formatSnapshotNode(
      {
        role: 'RootWebArea',
        name: 'Page',
        children: [
          {
            role: 'group',
            name: '',
            children: [
              {
                role: 'group',
                name: '',
                children: [{ role: 'button', name: 'Save', ref: '@e1', disabled: true }],
              },
            ],
          },
        ],
      },
      0,
      lines,
    );
    expect(lines).toEqual(['[RootWebArea "Page"]', '  @e1 [button "Save"] (disabled)']);
  });

  it.each([
    { name: 'Address' },
    { ref: '@e1' },
    { value: '' },
    { description: 'Help' },
    { focused: true },
    { checked: false },
    { disabled: true },
    { required: true },
    { expanded: false },
    { selected: true },
    { level: 1 },
  ])('preserves groups carrying semantics or an actionable ref: %o', properties => {
    const lines: string[] = [];
    formatSnapshotNode({ role: 'group', name: '', ...properties }, 0, lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[group');
  });

  it('supports interactive and viewport branches without changing full mode', () => {
    expect(filterSnapshotTree(tree, 'full')).toBe(tree);
    expect(filterSnapshotTree(tree, 'interactive')).toEqual(
      expect.objectContaining({
        children: [expect.objectContaining({ role: 'button', name: 'Submit' })],
      }),
    );
    expect(filterSnapshotTree(tree, 'viewport', new Set([1, 2]))).toEqual(
      expect.objectContaining({
        children: [expect.objectContaining({ name: 'Above fold' })],
      }),
    );
  });

  it('detects whether a branch has semantic interactive content', () => {
    expect(hasInteractiveSnapshotNode(tree)).toBe(true);
    expect(
      hasInteractiveSnapshotNode({
        role: 'RootWebArea',
        name: 'Role-poor app',
        children: [{ role: 'StaticText', name: 'Tap me', backendDOMNodeId: 2 }],
      }),
    ).toBe(false);
  });

  it('does not treat a focused web area as an interactive control', () => {
    expect(
      hasInteractiveSnapshotNode({
        role: 'RootWebArea',
        name: 'Document',
        focused: true,
        children: [{ role: 'StaticText', name: 'Read only' }],
      }),
    ).toBe(false);
  });

  it('reconciles stale AX checked values with live DOM state', async () => {
    const nodes: AXNodeBase[] = [
      {
        nodeId: 'checkbox',
        ignored: false,
        role: { value: 'checkbox' },
        backendDOMNodeId: 7,
        properties: [{ name: 'checked', value: { value: false } }],
      },
      {
        nodeId: 'button',
        ignored: false,
        role: { value: 'button' },
        backendDOMNodeId: 8,
      },
    ];

    await reconcileAXCheckedStates(nodes, async backendDOMNodeId =>
      backendDOMNodeId === 7 ? true : undefined,
    );

    expect(nodes[0]?.properties).toContainEqual({
      name: 'checked',
      value: { value: true },
    });
  });

  it('preserves both the beginning and end when output is bounded', () => {
    const lines: string[] = [];
    formatSnapshotNode(tree, 0, lines);
    const result = formatSnapshotWithLimits(lines, { maxNodes: 3, maxChars: 0 });

    expect(result.truncated).toBe(true);
    expect(result.snapshot).toContain('RootWebArea');
    expect(result.snapshot).toContain('Below fold');
    expect(result.snapshot).toContain('snapshot nodes omitted');
  });

  it('filters by accessible name and role while retaining ancestor context', () => {
    const result = filterSnapshotTreeByQuery(tree, {
      text: 'Sub',
      role: 'button',
      exact: false,
    });

    expect(result.tree).toEqual(
      expect.objectContaining({
        role: 'RootWebArea',
        children: [expect.objectContaining({ ref: '@e2', name: 'Submit' })],
      }),
    );
    expect(result.matches).toEqual([{ ref: '@e2', role: 'button', name: 'Submit' }]);
  });

  it('validates snapshot queries', () => {
    expect(resolvePageSnapshotQuery({ role: 'button' })).toEqual({ role: 'button' });
    expect(() => resolvePageSnapshotQuery({})).toThrow('must include text or role');
    expect(() => resolvePageSnapshotQuery({ text: '' })).toThrow('query.text');
  });

  it('bounds structured query matches independently from snapshot text limits', () => {
    const result = limitPageSnapshotQueryMatches(
      Array.from({ length: 150 }, (_, index) => ({
        ref: `@e${index + 1}`,
        role: 'button',
        name: `Action ${index} ${'x'.repeat(4_000)}`,
      })),
    );

    expect(result.truncated).toBe(true);
    expect(result.matches).toHaveLength(100);
    expect(result.matches[0]?.name.length).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(JSON.stringify(result.matches), 'utf8')).toBeLessThan(256 * 1024);
  });
});
