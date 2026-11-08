import { useEffect, useRef, useState } from 'react';
import { sendMessageSafely } from '../utils/safeChrome';

interface UseAgentBridgeStatusOptions {
  tabId: number | null;
  configReady: boolean;
  agentEnabled: boolean;
}

// Agent Bridge 是单例、与集成模式无关：连接状态反映「是否连上了 native-host」，
// 无论外部 agent 用 MCP 还是 Skills 接入，都共用这一条通路。
export const useAgentBridgeStatus = ({
  tabId,
  configReady,
  agentEnabled,
}: UseAgentBridgeStatusOptions) => {
  const [agentConnected, setAgentConnected] = useState<boolean>(false);
  const hasAutoResetRef = useRef<boolean>(false);

  // Panel 打开时幂等确认 Agent Bridge 已就绪。
  // 启停由 background 的 storage.onChanged 自动处理，这里仅做兜底重试。
  useEffect(() => {
    if (!tabId || !configReady || !agentEnabled) return;

    sendMessageSafely({
      action: 'initAgentBridge',
    }).catch(error => {
      console.warn('[Panel] Failed to ensure Agent Bridge ready:', error);
    });
  }, [tabId, agentEnabled, configReady]);

  // 监听 Agent 连接状态变化（不再轮询，而是监听通知）
  useEffect(() => {
    if (!configReady || !agentEnabled) {
      setAgentConnected(false);
      hasAutoResetRef.current = false;
      return;
    }

    const checkAgentStatus = () => {
      sendMessageSafely({
        action: 'getAgentStatus',
      })
        .then(response => {
          if (response?.success && response.status) {
            setAgentConnected(response.status.connected);

            const attempts = response.status.attempts ?? 0;
            const maxAttempts = response.status.maxAttempts ?? 5;

            // 重连次数耗尽时自动触发一次 reset，恢复后再允许下一次自动触发
            if (!response.status.connected && attempts >= maxAttempts && !hasAutoResetRef.current) {
              hasAutoResetRef.current = true;
              sendMessageSafely({
                action: 'resetAgentBridge',
              }).catch(() => {
                // 忽略失败，避免影响 UI 状态展示
              });
            } else if (response.status.connected || attempts < maxAttempts) {
              hasAutoResetRef.current = false;
            }
          }
        })
        .catch(() => {
          setAgentConnected(false);
        });
    };

    // 立即检查一次
    checkAgentStatus();

    // 监听状态变化通知
    const messageListener = (message: any) => {
      if (message.action === 'agentStatusChanged' && message.status) {
        setAgentConnected(message.status.connected);
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [agentEnabled, configReady]);

  return { agentConnected };
};
