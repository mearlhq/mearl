import { notifyContentScriptUnreachable, sendTabMessageSafe } from './utils';

export interface FrameMessageResult<T> {
  frameId: number;
  response: T;
}

export function getTabFrameIds(tabId: number): Promise<number[]> {
  return new Promise(resolve => {
    if (!chrome.webNavigation?.getAllFrames) {
      resolve([]);
      return;
    }
    chrome.webNavigation.getAllFrames({ tabId }, frames => {
      if (chrome.runtime.lastError || !frames) {
        resolve([]);
        return;
      }
      resolve([...new Set(frames.map(frame => frame.frameId))]);
    });
  });
}

export async function sendTabMessageToFrameIdsSafe<T>(
  tabId: number,
  frameIds: number[],
  message: unknown,
  options?: { notifyOnUnreachable?: boolean },
): Promise<FrameMessageResult<T>[]> {
  const responses = await Promise.all(
    [...new Set(frameIds)].map(async frameId => ({
      frameId,
      response: await sendTabMessageSafe<T>(tabId, message, { frameId }),
    })),
  );
  const reachable: FrameMessageResult<T>[] = [];
  for (const result of responses) {
    if (result.response !== undefined) {
      reachable.push({ frameId: result.frameId, response: result.response as T });
    }
  }
  if (reachable.length === 0 && options?.notifyOnUnreachable) {
    notifyContentScriptUnreachable(tabId);
  }
  return reachable;
}

/** 逐 frame 投递消息，使调用方可以汇总响应且不依赖 tabs.sendMessage 的首个响应。 */
export async function sendTabMessageToFramesSafe<T>(
  tabId: number,
  message: unknown,
  options?: { notifyOnUnreachable?: boolean },
): Promise<FrameMessageResult<T>[]> {
  const frameIds = await getTabFrameIds(tabId);
  if (frameIds.length === 0) {
    const response = await sendTabMessageSafe<T>(tabId, message, {
      notifyOnUnreachable: options?.notifyOnUnreachable,
    });
    return response === undefined ? [] : [{ frameId: 0, response }];
  }

  return sendTabMessageToFrameIdsSafe<T>(tabId, frameIds, message, options);
}
