import { isExternalServiceEnabled } from '../externalServices';
import { prepareBrowserCapability } from '../browserCapabilities';
import type { HeatmapDataPoint, HeatmapFetchResult } from '../../../shared/heatmap';
export type {
  HeatmapMeasure,
  HeatmapDataPoint,
  HeatmapFetchResult,
  HeatmapErrorCode,
} from '../../../shared/heatmap';
const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { points: HeatmapDataPoint[]; expiresAt: number; provider: string };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<HeatmapFetchResult>>();
const getCacheKey = (spmAB: string, ds: string) => `${spmAB}|${ds}`;

export async function fetchHeatmapData(spmAB: string, ds: string): Promise<HeatmapFetchResult> {
  if (!(await isExternalServiceEnabled('trackingMetadataEnabled'))) {
    return { success: false, errorCode: 'unknown', error: 'TRACKING_METADATA_DISABLED' };
  }
  try {
    const accepted = await prepareBrowserCapability('tracking.heatmap');
    if (!accepted)
      return { success: false, errorCode: 'unknown', error: 'CAPABILITY_NOT_INSTALLED' };
    const provider = `${accepted.bundleId}@${accepted.revision}`;
    const key = getCacheKey(spmAB, ds);
    const cached = cache.get(key);
    if (cached && cached.provider === provider && cached.expiresAt > Date.now()) {
      return { success: true, points: cached.points, cached: true };
    }
    const pendingKey = JSON.stringify([provider, key]);
    const inFlight = pending.get(pendingKey);
    if (inFlight) return await inFlight;

    const request = (async () => {
      const result = (await accepted.invoke({ spmAB, ds })) as HeatmapFetchResult;
      if (result.success)
        cache.set(key, { points: result.points, expiresAt: Date.now() + CACHE_TTL_MS, provider });
      return result;
    })();
    pending.set(pendingKey, request);
    try {
      return await request;
    } finally {
      pending.delete(pendingKey);
    }
  } catch (error) {
    return {
      success: false,
      errorCode: 'network',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
