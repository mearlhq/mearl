export type HeatmapMeasure = string;
export type HeatmapPage = { spmA: string | null; spmAB: string | null };
export type HeatmapDataPoint = {
  spm: string;
  spmName: string | null;
  measures: Record<string, number>;
};
export type HeatmapDisplayMeasure = { id: HeatmapMeasure; format: 'number' | 'percent' };
export type HeatmapRenderPayload = {
  measures: HeatmapDisplayMeasure[];
  points: HeatmapDataPoint[];
};
export type HeatmapErrorCode = 'login' | 'measure_expired' | 'network' | 'unknown';
export type HeatmapFetchResult =
  | { success: true; points: HeatmapDataPoint[]; cached: boolean }
  | { success: false; errorCode: HeatmapErrorCode; error: string };
