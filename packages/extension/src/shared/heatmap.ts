export type HeatmapMeasure = string;
export type HeatmapDataPoint = { spm: string; spmName: string | null; measures: Record<string, number> };
export type HeatmapErrorCode = 'login' | 'measure_expired' | 'network' | 'unknown';
export type HeatmapFetchResult = { success: true; points: HeatmapDataPoint[]; cached: boolean } | { success: false; errorCode: HeatmapErrorCode; error: string };
