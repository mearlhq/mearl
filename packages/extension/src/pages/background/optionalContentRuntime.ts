import { getTabFrameIds } from './frameMessaging';

type RuntimeTarget = { tabId: number; frameIds: number[] };

async function runtimeReady(target: RuntimeTarget, flag: string): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      func: runtimeFlag => Boolean((window as unknown as Record<string, unknown>)[runtimeFlag]),
      args: [flag],
    });
    return results.length > 0 && results.every(result => result.result === true);
  } catch {
    return false;
  }
}

async function ensureFrameRuntime(
  tabId: number,
  frameId: number,
  flag: string,
  file: string,
): Promise<boolean> {
  const target = { tabId, frameIds: [frameId] };
  if (await runtimeReady(target, flag)) return true;
  try {
    await chrome.scripting.executeScript({ target, world: 'ISOLATED', files: [file] });
  } catch {
    return false;
  }
  return runtimeReady(target, flag);
}

export async function ensureOptionalContentRuntimeForFrames(
  tabId: number,
  frameIds: number[],
  flag: string,
  file: string,
): Promise<number[]> {
  const results = await Promise.all(
    [...new Set(frameIds)].map(async frameId => ({
      frameId,
      ready: await ensureFrameRuntime(tabId, frameId, flag, file),
    })),
  );
  return results.filter(result => result.ready).map(result => result.frameId);
}

export async function ensureOptionalContentRuntime(
  tabId: number,
  flag: string,
  file: string,
): Promise<number[]> {
  const frameIds = await getTabFrameIds(tabId);
  return ensureOptionalContentRuntimeForFrames(
    tabId,
    frameIds.length > 0 ? frameIds : [0],
    flag,
    file,
  );
}
