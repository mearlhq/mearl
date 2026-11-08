// 工具函数模块

// 生成唯一 ID
export function generateId(): string {
  return Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// 向 content script 发送消息
export function sendToContentScript(message: Record<string, unknown>): void {
  try {
    window.postMessage(
      {
        source: 'mearl-injected',
        ...message,
      },
      '*',
    );
  } catch {
    // 忽略错误
  }
}
