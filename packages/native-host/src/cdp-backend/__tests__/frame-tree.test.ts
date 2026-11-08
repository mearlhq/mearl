import { describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../cdp-session.js';
import { readCdpFrameEntries } from '../frame-tree.js';
import { cdpPageFrames } from '../snapshot-handlers.js';

function fixture(useParentTarget = true) {
  const targetInfos = [
    {
      type: 'iframe',
      targetId: 'outer',
      parentFrameId: 'main',
      ...(useParentTarget ? { parentId: 'page' } : {}),
    },
    {
      type: 'iframe',
      targetId: 'nested',
      parentFrameId: 'embedded',
      ...(useParentTarget ? { parentId: 'outer' } : {}),
    },
    { type: 'iframe', targetId: 'foreign', parentId: 'other-page', parentFrameId: 'other-main' },
  ];
  const client = {
    sendCommand: vi.fn(async (method: string, params?: any) => {
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', url: '/main' } } };
      if (method === 'Target.getTargets') return { targetInfos };
      if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
      return {};
    }),
    createChildSession: vi.fn((targetId: string) => ({
      sendCommand: vi.fn(async () => ({
        frameTree: {
          frame: { id: targetId, name: targetId, url: `/${targetId}` },
          ...(targetId === 'outer'
            ? { childFrames: [{ frame: { id: 'embedded', url: '/embedded' } }] }
            : {}),
        },
      })),
    })),
  };
  return { session: { client, targetId: 'page' } as unknown as PageSession, client };
}

describe('CDP frame discovery across targets', () => {
  it.each([true, false])(
    'discovers nested page frames without including other tabs (parentId=%s)',
    async useParentTarget => {
      const f = fixture(useParentTarget);
      const result = await cdpPageFrames(f.session, { tabId: 1 });
      expect(result.count).toBe(4);
      expect(result.frames).toEqual([
        { frameId: 'main', url: '/main', name: '', parentFrameId: null, isMainFrame: true },
        {
          frameId: 'outer',
          url: '/outer',
          name: 'outer',
          parentFrameId: 'main',
          isMainFrame: false,
        },
        {
          frameId: 'embedded',
          url: '/embedded',
          name: '',
          parentFrameId: 'outer',
          isMainFrame: false,
        },
        {
          frameId: 'nested',
          url: '/nested',
          name: 'nested',
          parentFrameId: 'embedded',
          isMainFrame: false,
        },
      ]);
      expect(f.client.createChildSession.mock.calls.map(([target]) => target)).toEqual([
        'outer',
        'nested',
      ]);
      expect(
        f.client.sendCommand.mock.calls.filter(([method]) => method === 'Target.detachFromTarget'),
      ).toHaveLength(2);
    },
  );

  it('resolves an in-process frame nested inside an OOPIF to its owning target', async () => {
    const f = fixture();
    const entries = await readCdpFrameEntries(f.session, 'embedded');
    expect(entries.find(entry => entry.frame.frameId === 'embedded')?.targetId).toBe('outer');
    expect(f.client.createChildSession).toHaveBeenCalledExactlyOnceWith('outer');
  });

  it('does not attach a foreign target even if its ID was supplied as a frame', async () => {
    const f = fixture();
    const entries = await readCdpFrameEntries(f.session, 'foreign');
    expect(entries.some(entry => entry.frame.frameId === 'foreign')).toBe(false);
    expect(f.client.createChildSession.mock.calls.some(([target]) => target === 'foreign')).toBe(
      false,
    );
  });

  it('discovers an OOPIF by its frame ID when target metadata has no parent fields', async () => {
    const f = fixture();
    f.client.sendCommand.mockImplementation(async (method: string, params?: any) => {
      if (method === 'Page.getFrameTree')
        return {
          frameTree: {
            frame: { id: 'main', url: '/main' },
            childFrames: [{ frame: { id: 'outer', url: '/outer' } }],
          },
        };
      if (method === 'Target.getTargets')
        return {
          targetInfos: [
            { type: 'iframe', targetId: 'outer' },
            { type: 'iframe', targetId: 'foreign' },
          ],
        };
      if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
      return {};
    });
    const entries = await readCdpFrameEntries(f.session);
    expect(entries.find(entry => entry.frame.frameId === 'outer')?.targetId).toBe('outer');
    expect(entries.some(entry => entry.frame.frameId === 'foreign')).toBe(false);
  });

  it('detaches a temporary discovery session when its frame tree cannot be read', async () => {
    const f = fixture();
    f.client.createChildSession.mockImplementation(() => ({
      sendCommand: vi.fn().mockRejectedValue(new Error('Target disappeared')),
    }));
    await expect(readCdpFrameEntries(f.session)).rejects.toThrow('Target disappeared');
    expect(f.client.sendCommand).toHaveBeenLastCalledWith('Target.detachFromTarget', {
      sessionId: 'outer',
    });
  });
});
