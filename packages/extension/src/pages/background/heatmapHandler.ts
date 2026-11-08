import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import {
  fetchHeatmapData,
  type HeatmapDataPoint,
  type HeatmapFetchResult,
  type HeatmapMeasure,
} from './api/heatmap';
import { sendTabMessageToFramesSafe } from './frameMessaging';
import { isExternalServiceEnabled } from './externalServices';

interface HeatmapState {
  revision: number;
  visible: boolean;
  delivery: Promise<void>;
}

const heatmapTabs = new Map<number, HeatmapState>();

export type HeatmapRenderPayload = {
  measure: HeatmapMeasure;
  format: 'number' | 'percent';
  points: HeatmapDataPoint[];
};

type HeatmapStartResult =
  | { success: true; cached: boolean }
  | (HeatmapFetchResult & { success: false });
const cancelled = (): HeatmapStartResult => ({
  success: false,
  errorCode: 'unknown',
  error: 'HEATMAP_CANCELLED',
});

/** 同一 tab 的绘制和清理按投递顺序完成，清理不会被较早的异步 frame 枚举越过。 */
function enqueueDelivery<T>(state: HeatmapState, task: () => Promise<T>): Promise<T> {
  const result = state.delivery.then(task);
  state.delivery = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function clearHeatmap(tabId: number, state?: HeatmapState): Promise<{ success: boolean }> {
  try {
    const delivered = await sendTabMessageToFramesSafe(tabId, { action: 'stopHeatmap' });
    const success = delivered.length > 0;
    if (success && state) state.visible = false;
    return { success };
  } catch {
    return { success: false };
  }
}

/** 拉取热度数据后直接投递至各 frame，Panel 仅接收成功标识和错误信息。 */
export async function handleStartHeatmap(
  tabId: number,
  spmAB: string,
  ds: string,
  measure: HeatmapMeasure,
): Promise<HeatmapStartResult> {
  const state = heatmapTabs.get(tabId) ?? {
    revision: 0,
    visible: false,
    delivery: Promise.resolve(),
  };
  heatmapTabs.set(tabId, state);
  const revision = ++state.revision;
  const definition = (await browserCapabilityRegistry().settings()).extension?.heatmap?.measures.find(value => value.id === measure);
  if (revision !== state.revision) return cancelled();
  if (!definition) {
    if (!state.visible) heatmapTabs.delete(tabId);
    return { success: false, errorCode: 'unknown', error: `Unknown measure: ${measure}` };
  }
  const result = await fetchHeatmapData(spmAB, ds);
  if (revision !== state.revision) return cancelled();
  if (!result.success) {
    return enqueueDelivery(state, async () => {
      if (revision !== state.revision) return cancelled();
      if (!state.visible) heatmapTabs.delete(tabId);
      return result;
    });
  }

  return enqueueDelivery(state, async () => {
    if (revision !== state.revision) return cancelled();
    if (!(await isExternalServiceEnabled('trackingMetadataEnabled'))) {
      return { success: false, errorCode: 'unknown', error: 'TRACKING_METADATA_DISABLED' };
    }
    if (revision !== state.revision) return cancelled();
    try {
      const delivered = await sendTabMessageToFramesSafe(tabId, {
        action: 'renderHeatmap',
        payload: { measure, format: definition.format, points: result.points } satisfies HeatmapRenderPayload,
      });
      if (delivered.length === 0) throw new Error('No reachable content-script frame');
      state.visible = true;
      if (revision !== state.revision || !(await isExternalServiceEnabled('trackingMetadataEnabled'))) {
        await clearHeatmap(tabId, state);
        return cancelled();
      }
      return { success: true, cached: result.cached };
    } catch (error) {
      return {
        success: false,
        errorCode: 'network',
        error: `Failed to deliver to content-script: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}

export async function handleStopHeatmap(tabId: number): Promise<{ success: boolean }> {
  // worker 重启后仍可能残留图层，未知状态的清理也与后续绘制共享投递队列。
  const state = heatmapTabs.get(tabId) ?? {
    revision: 0,
    visible: true,
    delivery: Promise.resolve(),
  };
  heatmapTabs.set(tabId, state);
  const revision = ++state.revision;
  return enqueueDelivery(state, async () => {
    if (revision !== state.revision) return { success: true };
    const result = state.visible ? await clearHeatmap(tabId, state) : { success: true };
    if (result.success && revision === state.revision) heatmapTabs.delete(tabId);
    return result;
  });
}

export async function reconcileHeatmapService(): Promise<void> {
  if (!heatmapTabs.size || (await isExternalServiceEnabled('trackingMetadataEnabled'))) return;
  await Promise.all([...heatmapTabs.keys()].map(tabId => handleStopHeatmap(tabId)));
}
