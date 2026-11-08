import { useState, useEffect, useCallback, useRef } from 'react';
import type { TranslateProgress } from '../utils/translate';

export type TranslateErrorType = 'not-supported' | 'downloading' | 'failed';

interface UseTranslateOptions {
  onSuccess?: (translatedData: any) => void;
}

interface UseTranslateReturn {
  // 状态
  isTranslating: boolean;
  translateProgress: TranslateProgress | null;
  translateSuccess: boolean;
  showErrorModal: boolean;
  errorType: TranslateErrorType;
  errorMessage?: string;

  // 操作
  handleTranslate: (data: any, targetLang: 'en' | 'zh-TW') => Promise<void>;
  closeErrorModal: () => void;
}

/**
 * 翻译功能的自定义 Hook
 * 封装了翻译状态管理、进度跟踪、错误处理等逻辑
 */
export function useTranslate(options: UseTranslateOptions = {}): UseTranslateReturn {
  const { onSuccess } = options;

  // 翻译状态
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateProgress, setTranslateProgress] = useState<TranslateProgress | null>(null);
  // 用 ref 存 requestId，避免 useEffect 依赖 state 导致消息监听注册过晚
  const translateRequestIdRef = useRef<string | null>(null);
  const [translateSuccess, setTranslateSuccess] = useState(false);

  // 错误弹窗状态
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorType, setErrorType] = useState<TranslateErrorType>('failed');
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  // 监听来自 background worker 的进度更新（始终注册，通过 ref 过滤 requestId）
  useEffect(() => {
    const handleMessage = (message: any) => {
      if (
        message.action === 'translateProgress' &&
        message.requestId === translateRequestIdRef.current
      ) {
        setTranslateProgress(message.progress);
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []); // 空依赖，只注册一次，通过 ref 过滤

  // 翻译处理函数
  const handleTranslate = useCallback(
    async (data: any, targetLang: 'en' | 'zh-TW') => {
      setIsTranslating(true);
      setTranslateProgress(null);
      setTranslateSuccess(false);

      const requestId = `translate-${Date.now()}`;
      // 先设置 ref，确保消息监听器在 sendMessage 之前就能识别该 requestId
      translateRequestIdRef.current = requestId;

      try {
        // 发送翻译请求到 background worker
        const result = await chrome.runtime.sendMessage({
          action: 'translateJson',
          data,
          targetLang,
          requestId,
        });

        if (result.success && result.translatedData) {
          // 翻译成功
          onSuccess?.(result.translatedData);

          // 短暂延迟后清理状态
          setTimeout(() => {
            setIsTranslating(false);
            setTranslateProgress(null);
            translateRequestIdRef.current = null;
          }, 500);
        } else if (result.error === 'noChineseFields') {
          // 未找到可翻译字段，显示成功标识
          setTranslateSuccess(true);
          setTimeout(() => {
            setTranslateSuccess(false);
            setIsTranslating(false);
            setTranslateProgress(null);
            translateRequestIdRef.current = null;
          }, 2000);
        } else if (result.error === 'browserAiNotSupported') {
          // 浏览器不支持翻译 API
          setErrorType('not-supported');
          setErrorMessage(undefined);
          setShowErrorModal(true);
          setIsTranslating(false);
          setTranslateProgress(null);
          translateRequestIdRef.current = null;
        } else {
          // 其他错误
          setErrorType('failed');
          setErrorMessage(result.error);
          setShowErrorModal(true);
          setIsTranslating(false);
          setTranslateProgress(null);
          translateRequestIdRef.current = null;
        }
      } catch (error) {
        console.error('翻译出错:', error);
        setErrorType('failed');
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setShowErrorModal(true);
        setIsTranslating(false);
        setTranslateProgress(null);
        translateRequestIdRef.current = null;
      }
    },
    [onSuccess],
  );

  const closeErrorModal = useCallback(() => {
    setShowErrorModal(false);
  }, []);

  return {
    // 状态
    isTranslating,
    translateProgress,
    translateSuccess,
    showErrorModal,
    errorType,
    errorMessage,

    // 操作
    handleTranslate,
    closeErrorModal,
  };
}
