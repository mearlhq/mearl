import { PageActionPreconditionError } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import type { CdpChildSession } from './client.js';
import { readCdpFrameEntries, withCdpFrameTarget } from './frame-tree.js';
import { monitorCdpPageDialogs, sendCdpPageCommand, getCdpPageDialogs, deferCdpDialogCleanup } from './page-dialogs.js';

/** A temporary session enumerates main-world contexts without resetting ongoing page capture. */
export async function evaluateCdpFrame(
  session: PageSession,
  frameId: string,
  params: Record<string, unknown>,
): Promise<any> {
  if (typeof frameId !== 'string' || !frameId.trim()) {
    throw new PageActionPreconditionError('page_eval: frameId must be a non-empty string');
  }
  const entries = await readCdpFrameEntries(session, frameId);
  const entry = entries.find(candidate => candidate.frame.frameId === frameId);
  if (!entry) {
    throw new PageActionPreconditionError(
      `page_eval: frameId "${frameId}" is not present in the current page. Run page_frames to get current frame IDs.`,
    );
  }
  return withCdpFrameTarget(session, entry.targetId, child =>
    evaluateFrameContext(session, child, frameId, params),
  );
}

async function evaluateFrameContext(
  session: PageSession,
  child: CdpChildSession,
  frameId: string,
  params: Record<string, unknown>,
): Promise<any> {
  let contextId: number | undefined;
  let notifyContext = () => {};
  const stopMonitor = monitorCdpPageDialogs(session, child);
  const disposers = [
    child.on('Runtime.executionContextCreated', ({ context }) => {
      if (
        context?.auxData?.frameId === frameId &&
        context.auxData.isDefault === true &&
        typeof context.id === 'number'
      ) {
        contextId = context.id;
        notifyContext();
      }
    }),
    child.on('Runtime.executionContextsCleared', () => {
      contextId = undefined;
    }),
    child.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      if (executionContextId === contextId) contextId = undefined;
    }),
  ];
  try {
    await child.sendCommand('Page.enable');
    await child.sendCommand('Runtime.enable');
    if (contextId === undefined) {
      await getCdpPageDialogs(session).command(() => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 3000);
        notifyContext = () => {
          clearTimeout(timer);
          resolve();
        };
      }));
    }
    if (contextId === undefined) {
      throw new PageActionPreconditionError(
        `page_eval: main-world execution context for frame "${frameId}" is unavailable. Run page_frames to verify the frame is still present.`,
      );
    }
    return await sendCdpPageCommand(session, child, 'Runtime.evaluate', { ...params, contextId });
  } finally {
    for (const dispose of disposers) dispose();
    deferCdpDialogCleanup(session, stopMonitor);
  }
}
