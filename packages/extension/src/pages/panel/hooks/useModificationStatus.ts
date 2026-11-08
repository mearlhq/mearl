import { useState, useEffect, useCallback } from 'react';
import { sendMessageSafely } from '../utils/safeChrome';
import { t } from '../utils/i18n';
import { showToast } from '../utils/toast';

function showEnableModificationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  showToast(
    /another debugger|already attached/i.test(message)
      ? t('responseModificationDebuggerBusy')
      : t('enableResponseModificationFailed'),
    'error',
    6000,
  );
}

interface UseModificationStatusProps {
  tabId: number | null;
}

/**
 * 管理响应修改功能的状态，确保 Panel 显示状态与 Background 实际状态保持同步
 * 注意：每个 tab 独立管理状态，不跨 tab 共享
 *
 * 通信机制：Background 通过 port 定向发送状态变化给 Panel，
 * usePanelPortBridge 收到后触发 'mearl-debugger-status-changed' 事件，
 * 本 hook 监听该事件更新状态。
 */
export const useModificationStatus = ({ tabId }: UseModificationStatusProps) => {
  // 使用普通 state，每个 tab 的 panel 独立管理，不跨 tab 共享
  const [modificationEnabled, setModificationEnabled] = useState<boolean>(false);

  // 同步 debugger 状态的辅助函数
  const syncDebuggerStatus = useCallback(async () => {
    if (!tabId) return;

    try {
      const response = await sendMessageSafely<any>({
        action: 'getDebuggerStatus',
        tabId,
      });

      if (response && typeof response.debuggerAttached === 'boolean') {
        setModificationEnabled(response.debuggerAttached);
      }
    } catch {
      // 忽略错误，可能是 background 还未准备好
      // console.debug('Sync debugger status:');
    }
  }, [tabId, setModificationEnabled]);

  // 初始化时同步状态
  useEffect(() => {
    if (!tabId) return;

    // 延迟执行，确保 background 已经准备好
    const timer = setTimeout(() => {
      syncDebuggerStatus();
    }, 100);

    return () => clearTimeout(timer);
  }, [tabId, syncDebuggerStatus]);

  // 监听 debugger 状态变化事件（由 usePanelPortBridge 触发）
  useEffect(() => {
    const handleStatusChange = (event: Event) => {
      const { attached } = (event as CustomEvent<{ attached: boolean }>).detail;
      setModificationEnabled(attached);
    };

    window.addEventListener('mearl-debugger-status-changed', handleStatusChange);
    return () => {
      window.removeEventListener('mearl-debugger-status-changed', handleStatusChange);
    };
  }, []);

  // 切换响应修改功能
  const toggleModification = useCallback(async () => {
    if (!tabId) {
      console.error('Tab ID not available');
      return;
    }

    try {
      if (!modificationEnabled) {
        // 启用修改
        const response = await sendMessageSafely<any>({
          action: 'enableModification',
          tabId,
        });
        if (!response?.success) {
          console.error('Failed to enable modification:', response?.error);
          showEnableModificationError(response?.error);
        }
        // 状态更新由消息监听处理
      } else {
        // 禁用修改
        const response = await sendMessageSafely<any>({
          action: 'disableModification',
          tabId,
        });
        if (!response?.success) {
          console.error('Failed to disable modification:', response?.error);
        }
        // 状态更新由消息监听处理
      }
      await syncDebuggerStatus();
    } catch (error) {
      console.error('Error toggling modification:', error);
      if (!modificationEnabled) showEnableModificationError(error);
    }
  }, [tabId, modificationEnabled, syncDebuggerStatus]);

  return {
    modificationEnabled,
    toggleModification,
    syncDebuggerStatus,
  };
};
