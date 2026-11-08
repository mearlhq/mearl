import type { CdpChildSession } from './client.js';
import type { PageSession } from './cdp-session.js';
import { deferCdpDialogCleanup, getCdpPageDialogs } from './page-dialogs.js';

interface FrameTree {
  frame: { id: string; parentId?: string; url: string; name?: string };
  childFrames?: FrameTree[];
}

interface FrameTarget {
  type: string;
  targetId: string;
  parentId?: string;
  parentFrameId?: string;
}

interface FrameEntry {
  targetId: string;
  frame: {
    frameId: string;
    parentFrameId: string | null;
    url: string;
    name: string;
    isMainFrame: boolean;
  };
}

export async function withCdpFrameTarget<T>(
  session: PageSession,
  targetId: string,
  callback: (client: CdpChildSession) => Promise<T>,
): Promise<T> {
  const { sessionId } = await session.client.sendCommand('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  try {
    return await callback(session.client.createChildSession(sessionId));
  } finally {
    const detach = () => session.client.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => {});
    if (getCdpPageDialogs(session).pending) deferCdpDialogCleanup(session, () => { void detach(); });
    else await detach();
  }
}

/** OOPIF trees belong to separate targets; parent relationships keep discovery within this page. */
export async function readCdpFrameEntries(
  session: PageSession,
  requestedFrameId?: string,
): Promise<FrameEntry[]> {
  const { frameTree } = await session.client.sendCommand('Page.getFrameTree', {});
  const mainFrameId = frameTree?.frame?.id;
  const entries = new Map<string, FrameEntry>();
  const append = (tree: FrameTree | undefined, targetId: string, parentFrameId?: string): void => {
    if (!tree) return;
    const { frame, childFrames = [] } = tree;
    entries.set(frame.id, {
      targetId,
      frame: {
        frameId: frame.id,
        parentFrameId: frame.parentId ?? parentFrameId ?? null,
        url: frame.url,
        name: frame.name ?? '',
        isMainFrame: frame.id === mainFrameId,
      },
    });
    for (const child of childFrames) append(child, targetId, frame.id);
  };
  append(frameTree, session.targetId);
  if (requestedFrameId && entries.has(requestedFrameId)) return [...entries.values()];

  const { targetInfos = [] } = await session.client.sendCommand('Target.getTargets');
  const pending: FrameTarget[] = targetInfos.filter(
    (target: FrameTarget) => target.type === 'iframe',
  );
  const pageTargets = new Set([session.targetId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const target = pending[index]!;
      if (
        !entries.has(target.targetId) &&
        !(target.parentId && pageTargets.has(target.parentId)) &&
        !(target.parentFrameId && entries.has(target.parentFrameId))
      )
        continue;
      pending.splice(index, 1);
      const tree = await withCdpFrameTarget(session, target.targetId, child =>
        child.sendCommand('Page.getFrameTree', {}),
      );
      append(tree.frameTree, target.targetId, target.parentFrameId);
      pageTargets.add(target.targetId);
      expanded = true;
      if (requestedFrameId && entries.has(requestedFrameId)) return [...entries.values()];
    }
  }
  return [...entries.values()];
}
