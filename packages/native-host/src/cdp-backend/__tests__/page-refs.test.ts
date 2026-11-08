import { describe, expect, it, vi } from 'vitest';
import type { PageChangeSet } from '@mearl/browser-core';
import { cdpPageClick } from '../interaction-handlers';
import { enrichCdpPageChangeSetWithRefs, getPageRefRegistry } from '../page-refs';

const delta: PageChangeSet = {
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
    ],
  },
  mutationCount: 1,
  overflow: false,
  fullSnapshotRecommended: false,
  snapshotReasons: [],
};

describe('native page effect refs', () => {
  it('uses an enriched delta ref in the next page action', async () => {
    const listeners = new Map<string, (params: any) => void>();
    const sendCommand = vi.fn(async (method: string, params?: any) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'effects-array' } };
      if (method === 'Runtime.getProperties') {
        return { result: [{ name: '0', value: { objectId: 'continue-node' } }] };
      }
      if (method === 'DOM.describeNode') {
        expect(params).toEqual({ objectId: 'continue-node' });
        return { node: { backendNodeId: 42 } };
      }
      if (method === 'Runtime.releaseObjectGroup') return {};
      if (method === 'DOM.resolveNode') {
        expect(params).toEqual({ backendNodeId: 42 });
        return { object: { objectId: 'continue-node' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { tag: 'button', text: 'Continue' } } };
      }
      throw new Error(`Unexpected command: ${method}`);
    });
    const session = {
      client: {
        sendCommand,
        on: vi.fn((method: string, listener: (params: any) => void) => {
          listeners.set(method, listener);
          return () => listeners.delete(method);
        }),
      },
    } as any;

    const enriched = await enrichCdpPageChangeSetWithRefs(session, delta);
    const ref = enriched.effects.interactives[0].node.ref;
    expect(ref).toBe('@e1');
    await expect(cdpPageClick(session, { selector: ref, clickMode: 'dom' })).resolves.toMatchObject(
      {
        clicked: true,
        requestedTarget: {
          kind: 'ref',
          selector: '@e1',
          role: 'button',
          name: 'Continue',
        },
      },
    );
  });

  it('clears refs when the main frame navigates', () => {
    const listeners = new Map<string, (params: any) => void>();
    const session = {
      client: {
        on: vi.fn((method: string, listener: (params: any) => void) => {
          listeners.set(method, listener);
          return () => listeners.delete(method);
        }),
      },
    } as any;
    const registry = getPageRefRegistry(session);
    const ref = registry.registerDelta({
      backendNodeId: 42,
      role: 'button',
      name: 'Continue',
    });

    listeners.get('Page.frameNavigated')?.({
      frame: { id: 'child-frame', parentId: 'main-frame' },
    });
    expect(registry.resolve(ref)).toBeDefined();

    listeners.get('Page.frameNavigated')?.({ frame: { id: 'main-frame' } });
    expect(registry.resolve(ref)).toBeUndefined();
  });
});
