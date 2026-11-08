/**
 * Panel 侧热度地图入口：与 background 之间的薄封装。
 * 数据拉取、缓存、转发到 content-script 都在 background 完成。
 */

import type { HeatmapErrorCode, HeatmapMeasure } from '../../../shared/heatmap';
import { ensureBrowserUiSettings } from './browserUiSettings';
export type { HeatmapErrorCode, HeatmapMeasure };

export type HeatmapStatus = 'idle' | 'loading' | 'active' | 'error';

export type HeatmapStartResult =
  | { success: true; cached: boolean }
  | { success: false; errorCode: HeatmapErrorCode; error: string };

function getTabId(): number | undefined {
  return chrome.devtools.inspectedWindow.tabId;
}

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
  spmAB: string,
  measure: HeatmapMeasure,
  ds: string,
): Promise<HeatmapStartResult> {
  return new Promise(resolve => {
    const tabId = getTabId();
    if (!tabId) {
      resolve({ success: false, errorCode: 'unknown', error: 'No active tab' });
      return;
    }
    chrome.runtime.sendMessage({ action: 'startHeatmap', tabId, spmAB, ds, measure }, response => {
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

export function stopHeatmap(): Promise<void> {
  return new Promise(resolve => {
    const tabId = getTabId();
    if (!tabId) {
      resolve();
      return;
    }
    chrome.runtime.sendMessage({ action: 'stopHeatmap', tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/** 通过 inspectedWindow.eval 读取当前页 location.pathname；失败返 null */
export function detectPagePath(): Promise<string | null> {
  return new Promise(resolve => {
    chrome.devtools.inspectedWindow.eval<string>('location.pathname', (result, exception) => {
      if (exception) {
        resolve(null);
        return;
      }
      resolve(typeof result === 'string' ? result : null);
    });
  });
}

/**
 * 通过 devtools.inspectedWindow.eval 在页面里读取当前页的 spmAB。
 * 按 preset 的前缀读取 body、meta 或 data-spm-abcd。
 */
export function detectPageSpmAB(): Promise<string | null> {
  return ensureBrowserUiSettings().then(settings => new Promise<string | null>(resolve => {
    const prefix = settings.heatmap?.bodySpmPrefix;
    if (!prefix) { resolve(null); return; }
    chrome.devtools.inspectedWindow.eval<string | null>(
      `(function(){
        try {
          var spmAB = '';
          var spmB = document.body && document.body.getAttribute('data-spm');
          var meta = document.querySelector('meta[name="data-spm"]');
          var metaSpm = meta ? meta.getAttribute('content') : '';
          var abcdEl = document.querySelector('[data-spm-abcd]');
          var abcd = abcdEl ? abcdEl.getAttribute('data-spm-abcd') : '';
          if (spmB) {
            spmAB = ${JSON.stringify(prefix + '.')} + spmB;
          } else if (metaSpm && /^\\d+\\./.test(metaSpm)) {
            var parts = metaSpm.split('.');
            spmAB = parts[0] + '.' + (parts[1] || '');
          } else if (abcd) {
            var p = abcd.split('.');
            spmAB = p[0] + '.' + (p[1] || '');
          }
          if (!spmAB || spmAB.indexOf('0.0') === 0 || spmAB.endsWith('.')) return null;
          return spmAB;
        } catch (e) { return null; }
      })()`,
      (result, exception) => {
        if (exception) {
          resolve(null);
          return;
        }
        resolve(typeof result === 'string' && result ? result : null);
      },
    );
  }));
}
