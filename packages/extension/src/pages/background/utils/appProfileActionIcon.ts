import type { InjectedAppProfileConfig } from '@mearl/browser-core';

const DEFAULT_ICON = 'icons/icon-32x32.png';

const GENERIC_APP_PROFILE_ICON = 'icons/app-profiles/generic-32.png';

/**
 * action API 的 tab 级写入可能与标签页关闭同时发生。回调执行期间同步读取
 * runtime.lastError，既能把失败交给调用方处理，也能避免 Chrome 记录 unchecked 告警。
 */
function invokeActionApi(call: (callback: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    call(() => {
      const message = chrome.runtime.lastError?.message;
      if (message) {
        reject(new Error(message));
        return;
      }
      resolve();
    });
  });
}

/** 更新指定 tab 的工具栏图标与 badge；Chrome 会随激活 tab 自动展示对应状态。 */
export async function updateAppProfileActionIcon(
  tabId: number,
  config?: InjectedAppProfileConfig,
): Promise<void> {
  if (!chrome.action?.setIcon) return;

  const icon = config?.binding?.definition.actionIcon;
  if (icon) {
    const bitmap = await createImageBitmap(await (await fetch(icon)).blob());
    try {
      const canvas = new OffscreenCanvas(32, 32);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Toolbar icon renderer unavailable');
      context.drawImage(bitmap, 0, 0, 32, 32);
      const imageData = context.getImageData(0, 0, 32, 32);
      await invokeActionApi(callback => chrome.action.setIcon({ tabId, imageData }, callback));
    } finally { bitmap.close(); }
  } else {
    await invokeActionApi(callback => chrome.action.setIcon({ tabId, path: config ? GENERIC_APP_PROFILE_ICON : DEFAULT_ICON }, callback));
  }
  // 状态完全由合成图表达，原生 badge 保持为空。
  if (chrome.action.setBadgeText) {
    await invokeActionApi(callback => chrome.action.setBadgeText({ tabId, text: '' }, callback));
  }
}
