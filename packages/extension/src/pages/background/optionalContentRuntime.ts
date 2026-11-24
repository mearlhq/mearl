import { getTabFrameIds } from './frameMessaging';

type RuntimeTarget = { tabId: number; frameIds: number[] };
type RuntimeInjectionOptions = { injectImmediately: boolean };

async function runtimeReady(
  target: RuntimeTarget,
  flag: string,
  options?: RuntimeInjectionOptions,
): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      ...options,
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
  options?: RuntimeInjectionOptions,
): Promise<boolean> {
  const target = { tabId, frameIds: [frameId] };
  if (await runtimeReady(target, flag, options)) return true;
  try {
    await chrome.scripting.executeScript({ target, world: 'ISOLATED', files: [file], ...options });
  } catch {
    return false;
  }
  return runtimeReady(target, flag, options);
}

export async function ensureOptionalContentRuntimeForFrames(
  tabId: number,
  frameIds: number[],
  flag: string,
  file: string,
  options?: RuntimeInjectionOptions,
): Promise<number[]> {
  const results = await Promise.all(
    [...new Set(frameIds)].map(async frameId => ({
      frameId,
      ready: await ensureFrameRuntime(tabId, frameId, flag, file, options),
    })),
  );
  return results.filter(result => result.ready).map(result => result.frameId);
}

export async function ensureOptionalContentRuntime(
  tabId: number,
  flag: string,
  file: string,
  options?: RuntimeInjectionOptions,
): Promise<number[]> {
  const frameIds = await getTabFrameIds(tabId);
  return ensureOptionalContentRuntimeForFrames(
    tabId,
    frameIds.length > 0 ? frameIds : [0],
    flag,
    file,
    options,
  );
}
