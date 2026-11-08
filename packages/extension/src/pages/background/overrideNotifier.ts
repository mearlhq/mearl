/**
 * Override Notifier - 独立模块，避免循环依赖
 * 负责通知 Panel Override 状态变化
 */

import { getOverrides } from './debuggerManager';
import { notifyDevicePreviewPanel } from './devicePreviewPanel';

// 存储 devtools panel 的连接端口（从 background/index.ts 注入）
let devtoolsPorts: Map<number, chrome.runtime.Port> | null = null;

/**
 * 初始化 - 从 background/index.ts 注入 ports
 */
export function initOverrideNotifier(ports: Map<number, chrome.runtime.Port>): void {
  devtoolsPorts = ports;
}

/**
 * 通知 Panel Override 状态已改变
 */
export function notifyPanelOverrideChanged(tabId: number): void {
  const message = { action: 'overridesChanged', overrides: getOverrides(tabId) };
  notifyDevicePreviewPanel(tabId, message);
  if (!devtoolsPorts) {
    console.warn('[OverrideNotifier] Not initialized - devtoolsPorts is null');
    return;
  }

  const port = devtoolsPorts.get(tabId);
  if (port) {
    try {
      port.postMessage(message);
    } catch (e) {
      console.warn('[OverrideNotifier] Failed to notify panel:', e);
    }
  }
}
