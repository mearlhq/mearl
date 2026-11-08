import { describe, expect, it } from 'vitest';
import { buildTreesFromDOMSnapshot } from '../domSnapshot';

describe('DOM snapshot tree', () => {
  it('keeps rendered controls, clickable wrappers, text, and live form state', () => {
    const refs: Array<{ backendNodeId: number; role: string; name: string }> = [];
    const trees = buildTreesFromDOMSnapshot(
      {
        strings: [
          '#document',
          '',
          'BODY',
          'DIV',
          '#text',
          'Choose occupation',
          'INPUT',
          'type',
          'checkbox',
          'aria-label',
          'Accept terms',
          'block',
          'visible',
          '1',
        ],
        documents: [
          {
            nodes: {
              parentIndex: [-1, 0, 1, 2, 1],
              nodeType: [9, 1, 1, 3, 1],
              nodeName: [0, 2, 3, 4, 6],
              nodeValue: [1, 1, 1, 5, 1],
              backendNodeId: [1, 2, 3, 4, 5],
              attributes: [[], [], [], [], [7, 8, 9, 10]],
              isClickable: { index: [2] },
              inputChecked: { index: [4] },
            },
            layout: {
              nodeIndex: [0, 1, 2, 3, 4],
              bounds: [
                [0, 0, 400, 800],
                [0, 0, 400, 800],
                [10, 10, 200, 40],
                [10, 10, 200, 40],
                [10, 60, 20, 20],
              ],
              styles: Array.from({ length: 5 }, () => [11, 12, 13]),
            },
          },
        ],
      },
      {
        registerRef: entry => {
          refs.push(entry);
          return `@e${refs.length}`;
        },
      },
    );

    expect(trees).toHaveLength(1);
    expect(trees[0].tree).toMatchObject({
      role: 'document',
      children: [
        { role: 'clickable', name: 'Choose occupation', ref: '@e2' },
        { role: 'checkbox', name: 'Accept terms', checked: true, ref: '@e3' },
      ],
    });
    expect(refs).toEqual([
      { backendNodeId: 4, role: 'StaticText', name: 'Choose occupation' },
      { backendNodeId: 3, role: 'clickable', name: 'Choose occupation' },
      { backendNodeId: 5, role: 'checkbox', name: 'Accept terms' },
    ]);
  });

  it('excludes non-rendered branches and password values', () => {
    const trees = buildTreesFromDOMSnapshot(
      {
        strings: [
          '#document',
          '',
          'BODY',
          'INPUT',
          'type',
          'password',
          'secret',
          'DIV',
          '#text',
          'Hidden template',
          'block',
          'visible',
          '1',
        ],
        documents: [
          {
            nodes: {
              parentIndex: [-1, 0, 1, 1, 3],
              nodeType: [9, 1, 1, 1, 3],
              nodeName: [0, 2, 3, 7, 8],
              nodeValue: [1, 1, 1, 1, 9],
              backendNodeId: [1, 2, 3, 4, 5],
              attributes: [[], [], [4, 5], [], []],
              inputValue: { index: [2], value: [6] },
            },
            layout: {
              nodeIndex: [0, 1, 2],
              bounds: [
                [0, 0, 400, 800],
                [0, 0, 400, 800],
                [10, 10, 200, 40],
              ],
              styles: Array.from({ length: 3 }, () => [10, 11, 12]),
            },
          },
        ],
      },
      { registerRef: ({ backendNodeId }) => `@e${backendNodeId}` },
    );

    expect(trees[0].tree).toMatchObject({
      role: 'document',
      children: [{ role: 'textbox' }],
    });
    expect(trees[0].tree?.children?.[0]).not.toHaveProperty('value');
    expect(JSON.stringify(trees)).not.toContain('secret');
    expect(JSON.stringify(trees)).not.toContain('Hidden template');
  });

  it('scopes the output by backend node and frame', () => {
    const trees = buildTreesFromDOMSnapshot(
      {
        strings: ['main', 'child', '#document', '', 'BUTTON', '#text', 'Save'],
        documents: [
          {
            frameId: 0,
            nodes: {
              parentIndex: [-1],
              nodeType: [9],
              nodeName: [2],
              nodeValue: [3],
              backendNodeId: [1],
              attributes: [[]],
            },
          },
          {
            frameId: 1,
            nodes: {
              parentIndex: [-1, 0, 1],
              nodeType: [9, 1, 3],
              nodeName: [2, 4, 5],
              nodeValue: [3, 3, 6],
              backendNodeId: [10, 11, 12],
              attributes: [[], [], []],
            },
          },
        ],
      },
      {
        frameId: 'child',
        rootBackendNodeId: 11,
        registerRef: ({ backendNodeId }) => `@e${backendNodeId}`,
      },
    );

    expect(trees).toEqual([
      {
        frameId: 'child',
        tree: {
          role: 'button',
          name: 'Save',
          backendDOMNodeId: 11,
          ref: '@e11',
        },
      },
    ]);
  });

  it('does not duplicate structural text or hide nested controls', () => {
    const trees = buildTreesFromDOMSnapshot(
      {
        strings: ['#document', '', 'FORM', 'DIV', '#text', 'Card title', 'BUTTON', 'Save'],
        documents: [
          {
            nodes: {
              parentIndex: [-1, 0, 1, 2, 2, 4],
              nodeType: [9, 1, 1, 3, 1, 3],
              nodeName: [0, 2, 3, 4, 6, 4],
              nodeValue: [1, 1, 1, 5, 1, 7],
              backendNodeId: [1, 2, 3, 4, 5, 6],
              attributes: [[], [], [], [], [], []],
              isClickable: { index: [2] },
            },
          },
        ],
      },
      { registerRef: ({ backendNodeId }) => `@e${backendNodeId}` },
    );

    expect(trees[0].tree).toMatchObject({
      role: 'document',
      children: [
        {
          role: 'form',
          name: '',
          children: [
            {
              role: 'clickable',
              name: 'Card title',
              children: [{ role: 'button', name: 'Save' }],
            },
          ],
        },
      ],
    });
  });
});
