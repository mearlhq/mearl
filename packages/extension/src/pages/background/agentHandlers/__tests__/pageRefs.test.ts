import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageChangeSet } from '@mearl/browser-core';

const releaseDebuggerLease = vi.hoisted(() => vi.fn());

vi.mock('../../debuggerSessionManager', () => ({
  acquireDebuggerLease: vi.fn().mockResolvedValue({ release: releaseDebuggerLease }),
}));

import { acquireDebuggerLease } from '../../debuggerSessionManager';
import {
  clearPageRefsForNavigation,
  disposePageRefs,
  enrichExtensionPageChangeSetWithRefs,
  resolveRef,
} from '../pageRefs';

function delta(selector: string): PageChangeSet {
  return {
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
          node: { selector, tag: 'button', role: 'button', name: 'Continue' },
        },
      ],
    },
    mutationCount: 1,
    overflow: false,
    fullSnapshotRecommended: false,
    snapshotReasons: [],
  };
}

describe('extension page effect refs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disposePageRefs(1);
    chrome.debugger.sendCommand = vi.fn(async (_target, method, params?: any) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'effects-array' } };
      if (method === 'Runtime.getProperties') {
        return { result: [{ name: '0', value: { objectId: 'continue-node' } }] };
      }
      if (method === 'DOM.describeNode') {
        expect(params).toEqual({ objectId: 'continue-node' });
        return { node: { backendNodeId: 42 } };
      }
      if (method === 'Runtime.releaseObjectGroup') return {};
      throw new Error(`Unexpected command: ${method}`);
    }) as any;
  });

  it('registers an actionable backend ref and keeps numbering monotonic across navigation', async () => {
    const first = await enrichExtensionPageChangeSetWithRefs(1, delta('#continue'));
    expect(first.effects.interactives[0].node.ref).toBe('@e1');
    expect(resolveRef(1, '@e1')).toEqual({
      backendNodeId: 42,
      role: 'button',
      name: 'Continue',
    });

    clearPageRefsForNavigation(1);
    expect(resolveRef(1, '@e1')).toBeUndefined();

    const next = await enrichExtensionPageChangeSetWithRefs(1, delta('#continue'));
    expect(next.effects.interactives[0].node.ref).toBe('@e2');
    expect(releaseDebuggerLease).toHaveBeenCalledTimes(2);
  });

  it('does not acquire a debugger lease when there are no actionable candidates', async () => {
    const unchanged = delta('#continue');
    unchanged.effects.interactives = [];

    await expect(enrichExtensionPageChangeSetWithRefs(1, unchanged)).resolves.toBe(unchanged);
    expect(acquireDebuggerLease).not.toHaveBeenCalled();
  });
});
