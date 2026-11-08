import { describe, expect, it, vi } from 'vitest';
import { BackendNodeRefRegistry } from '../backendNodeRefs.js';
import {
  enrichPageChangeSetWithRefs,
  resolveUniqueBackendNodeIds,
  type PageEffectRefEntry,
} from '../pageEffectRefs.js';
import type { PageChangeSet } from '../pageObserver.js';

const observation: PageChangeSet = {
  mode: 'delta',
  scope: 'main-document',
  checkpoint: 1,
  version: 2,
  elapsed: 10,
  settledBy: 'quiet',
  url: 'https://example.test',
  title: 'Example',
  changed: true,
  effects: {
    notifications: [],
    interactives: [
      {
        change: 'appeared',
        node: { selector: '#continue', tag: 'button', role: 'button', name: 'Continue' },
      },
      {
        change: 'appeared',
        node: { selector: '.ambiguous', tag: 'button', role: 'button', name: 'Ambiguous' },
      },
    ],
    focus: { selector: '#continue', tag: 'button', role: 'button', name: 'Continue' },
  },
  mutationCount: 1,
  overflow: false,
  fullSnapshotRecommended: false,
  snapshotReasons: [],
};

describe('page effect refs', () => {
  it('resolves unique nodes in one batch and tolerates per-node failures', async () => {
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'array-1' } };
      if (method === 'Runtime.getProperties') {
        return {
          result: [
            { name: '0', value: { objectId: 'node-1' } },
            { name: '1', value: { objectId: 'node-2' } },
            { name: 'length', value: { value: 2 } },
          ],
        };
      }
      if (method === 'DOM.describeNode' && params.objectId === 'node-1') {
        return { node: { backendNodeId: 41 } };
      }
      if (method === 'DOM.describeNode') throw new Error('detached');
      if (method === 'Runtime.releaseObjectGroup') return {};
      throw new Error(`Unexpected command: ${method}`);
    });

    const result = await resolveUniqueBackendNodeIds(sendCommand, ['#continue', '.ambiguous']);

    expect(result).toEqual(new Map([['#continue', 41]]));
    expect(sendCommand).toHaveBeenCalledWith(
      'Runtime.getProperties',
      expect.objectContaining({ objectId: 'array-1' }),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      'Runtime.releaseObjectGroup',
      expect.objectContaining({ objectGroup: expect.stringContaining('page-effect-refs') }),
    );
  });

  it('adds one reusable ref to matching interactive and focus nodes', async () => {
    const registry = new BackendNodeRefRegistry<PageEffectRefEntry>();
    const enriched = await enrichPageChangeSetWithRefs(
      observation,
      registry,
      async selectors => {
        expect(selectors).toEqual(['#continue', '.ambiguous']);
        return new Map([['#continue', 41]]);
      },
      (node, backendNodeId) => ({
        backendNodeId,
        role: node.role ?? '',
        name: node.name ?? '',
      }),
    );

    expect(enriched.effects.interactives[0].node.ref).toBe('@e1');
    expect(enriched.effects.focus?.ref).toBe('@e1');
    expect(enriched.effects.interactives[1].node).not.toHaveProperty('ref');
    expect(observation.effects.interactives[0].node).not.toHaveProperty('ref');
  });

  it('does not register resolved nodes after the document changes', async () => {
    const registry = new BackendNodeRefRegistry<PageEffectRefEntry>();

    await expect(
      enrichPageChangeSetWithRefs(
        observation,
        registry,
        async () => {
          registry.clearDocument();
          return new Map([['#continue', 41]]);
        },
        (node, backendNodeId) => ({
          backendNodeId,
          role: node.role ?? '',
          name: node.name ?? '',
        }),
      ),
    ).rejects.toThrow('page document changed while refs were being collected');
    expect(registry.size).toBe(0);
  });
});
