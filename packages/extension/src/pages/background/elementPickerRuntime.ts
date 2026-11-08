import type {
  ElementCommentLabels,
  ElementPickerPage,
} from '../content-script/elementCommentTypes';
import { getTabFrameIds } from './frameMessaging';

const ELEMENT_PICKER_MAIN_RUNTIME_PATH = 'src/pages/content-script/element-picker-main-runtime.js';
const MAIN_RUNTIME_OPERATION_TIMEOUT_MS = 1500;

type ElementPickerInjectionTarget =
  | { tabId: number; allFrames: true }
  | { tabId: number; frameIds: number[] };

export interface ActiveElementPickerSession {
  traceMode: boolean;
  commentMode: boolean;
  continuousCommentMode?: boolean;
  commentLabels?: ElementCommentLabels;
  topPage?: ElementPickerPage;
  previewRootFrameId?: number;
}

const activeElementPickerSessions = new Map<number, ActiveElementPickerSession>();

export async function getElementPickerPreviewFrameIds(tabId: number, rootFrameId: number): Promise<number[]> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const parents = new Map((frames ?? []).map(frame => [frame.frameId, frame.parentFrameId]));
  const isInRoot = (frameId: number): boolean => {
    for (let current = frameId; current > 0; current = parents.get(current) ?? -1) {
      if (current === rootFrameId) return true;
    }
    return false;
  };
  return [rootFrameId, ...Array.from(parents.keys()).filter(id => id !== rootFrameId && isInRoot(id))];
}

function everyInjectedFrameIsReady(
  executions: chrome.scripting.InjectionResult<boolean>[],
): boolean {
  return executions.length > 0 && executions.every(execution => execution.result === true);
}

async function settleMainRuntimeOperation<T>(operation: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), MAIN_RUNTIME_OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function mainRuntimeIsReady(target: ElementPickerInjectionTarget): Promise<boolean> {
  try {
    const executions = await settleMainRuntimeOperation(
      chrome.scripting.executeScript({
        target,
        world: 'MAIN',
        func: () => window.__mearlElementPickerMainRuntime === true,
      }),
    );
    if (!executions) return false;
    return everyInjectedFrameIsReady(executions);
  } catch {
    return false;
  }
}

export async function ensureElementPickerMainRuntime(tabId: number): Promise<boolean> {
  const frameIds = await getTabFrameIds(tabId);
  if (frameIds.length > 0) {
    return (await ensureElementPickerMainRuntimeForFrames(tabId, frameIds)).length > 0;
  }
  return ensureElementPickerMainRuntimeForTarget({ tabId, allFrames: true });
}

async function ensureElementPickerMainRuntimeForTarget(
  target: ElementPickerInjectionTarget,
): Promise<boolean> {
  if (await mainRuntimeIsReady(target)) return true;
  try {
    const injected = await settleMainRuntimeOperation(
      chrome.scripting.executeScript({
        target,
        files: [ELEMENT_PICKER_MAIN_RUNTIME_PATH],
        world: 'MAIN',
      }),
    );
    if (!injected) return false;
  } catch {
    return false;
  }
  return mainRuntimeIsReady(target);
}

async function ensureElementPickerMainRuntimeForFrame(
  tabId: number,
  frameId: number,
): Promise<boolean> {
  return ensureElementPickerMainRuntimeForTarget({ tabId, frameIds: [frameId] });
}

export async function ensureElementPickerMainRuntimeForFrames(
  tabId: number,
  frameIds: number[],
): Promise<number[]> {
  const results = await Promise.all(
    [...new Set(frameIds)].map(async frameId => ({
      frameId,
      ready: await ensureElementPickerMainRuntimeForFrame(tabId, frameId),
    })),
  );
  return results.filter(result => result.ready).map(result => result.frameId);
}

export function setActiveElementPickerSession(
  tabId: number,
  session: ActiveElementPickerSession,
): void {
  activeElementPickerSessions.set(tabId, session);
}

export function clearActiveElementPickerSession(tabId: number): void {
  activeElementPickerSessions.delete(tabId);
}

export function getActiveElementPickerSession(
  tabId: number,
): ActiveElementPickerSession | undefined {
  return activeElementPickerSessions.get(tabId);
}

export function selectInitialElementPickerFrame(
  frameIds: number[],
  preferChildFrame: boolean,
): number | undefined {
  if (preferChildFrame) {
    return [...frameIds].reverse().find(frameId => frameId !== 0) ?? frameIds[0];
  }
  return frameIds.includes(0) ? 0 : frameIds[0];
}

export function selectElementPickerStartupFrames(
  frameIds: number[],
  traceMode: boolean,
  appProfileActive: boolean,
): number[] {
  if (!traceMode || !appProfileActive) return frameIds;
  const activeFrameId = selectInitialElementPickerFrame(frameIds, true);
  return activeFrameId === undefined ? [] : [activeFrameId];
}

/** 新 frame 的常驻 content script 就绪后，恢复当前选择会话。 */
export async function restoreElementPickerSessionForFrame(
  tabId: number,
  frameId: number,
): Promise<boolean> {
  const session = activeElementPickerSessions.get(tabId);
  if (!session) return false;
  if (session.previewRootFrameId !== undefined && frameId !== session.previewRootFrameId) {
    const frameIds = await getElementPickerPreviewFrameIds(tabId, session.previewRootFrameId).catch((): number[] => []);
    if (!frameIds.includes(frameId)) return false;
  }
  if (session.traceMode && !(await ensureElementPickerMainRuntimeForFrame(tabId, frameId))) {
    return false;
  }
  if (activeElementPickerSessions.get(tabId) !== session) return false;

  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      {
        action: 'startElementPicker',
        traceMode: session.traceMode,
        commentMode: session.commentMode,
        ...(session.continuousCommentMode !== undefined
          ? { continuousCommentMode: session.continuousCommentMode }
          : {}),
        commentLabels: session.commentLabels,
        topPage: session.topPage,
      },
      { frameId },
    );
    return response?.success === true;
  } catch {
    return false;
  }
}
