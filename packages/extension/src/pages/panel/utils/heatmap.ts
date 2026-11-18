/**
 * Panel 侧热度地图入口：与 background 之间的薄封装。
 * 数据拉取、缓存、转发到 content-script 都在 background 完成。
 */

import type { HeatmapErrorCode, HeatmapMeasure, HeatmapPage } from '../../../shared/heatmap';
import { sendMessageSafely } from './safeChrome';
export type { HeatmapErrorCode, HeatmapMeasure };

export type HeatmapStatus = 'idle' | 'loading' | 'active' | 'error';

export type HeatmapStartResult =
  | { success: true; cached: boolean }
  | { success: false; errorCode: HeatmapErrorCode; error: string };

/** 计算昨天的日期字符串 yyyyMMdd（与 埋点服务端默认聚合粒度一致） */
export function getYesterdayDs(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** yyyyMMdd → yyyy-MM-dd，用于 UI 展示 / <input type="date"> 的 value */
export function formatDsDisplay(ds: string): string {
  if (!/^\d{8}$/.test(ds)) return ds;
  return `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
}

/** yyyy-MM-dd（HTML date input value） → yyyyMMdd */
export function parseDsInput(value: string): string | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}

export function startHeatmap(
  tabId: number,
  spmAB: string,
  measures: HeatmapMeasure[],
  ds: string,
): Promise<HeatmapStartResult> {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'startHeatmap', tabId, spmAB, ds, measures }, response => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          errorCode: 'network',
          error: chrome.runtime.lastError.message || 'Runtime error',
        });
        return;
      }
      resolve(response as HeatmapStartResult);
    });
  });
}

export function stopHeatmap(tabId: number): Promise<void> {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'stopHeatmap', tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

export function detectHeatmapPage(tabId: number): Promise<HeatmapPage | null> {
  return sendMessageSafely<HeatmapPage>({ action: 'getHeatmapPage', tabId }).catch(() => null);
}
