import {
  FRAME_VISUAL_RUNTIME_FLAG,
  FRAME_VISUAL_RUNTIME_PATH,
} from '../../shared/contentScriptRuntimes';
import {
  ensureOptionalContentRuntime,
  ensureOptionalContentRuntimeForFrames,
} from './optionalContentRuntime';

// The device shell stops the outer document before its normal injection point.
const injectionOptions = { injectImmediately: true };

export function ensureFrameVisualRuntime(tabId: number): Promise<number[]> {
  return ensureOptionalContentRuntime(
    tabId,
    FRAME_VISUAL_RUNTIME_FLAG,
    FRAME_VISUAL_RUNTIME_PATH,
    injectionOptions,
  );
}

export function ensureFrameVisualRuntimeForFrames(
  tabId: number,
  frameIds: number[],
): Promise<number[]> {
  return ensureOptionalContentRuntimeForFrames(
    tabId,
    frameIds,
    FRAME_VISUAL_RUNTIME_FLAG,
    FRAME_VISUAL_RUNTIME_PATH,
    injectionOptions,
  );
}
