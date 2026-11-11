import { useState, useEffect, useRef } from 'react';
import { preprocessData } from '../../../shared/dataPreprocessor';
import { tryParseJsonString } from '../../panel/utils/helpers';
import { t } from '../../panel/utils/i18n';
import packageJson from '../../../../package.json';

const createWelcomeJson = () =>
  JSON.stringify(
    {
      name: 'mearl.welcome',
      data: {
        title: 'Mearl',
        description: t('welcomeDescription'),
        tips: {
          popup: t('welcomeTipPopup'),
          panel: t('welcomeTipPanel'),
          sidepanel: t('welcomeTipSidepanel'),
          'device-capture': t('welcomeTipDeviceCapture'),
        },
      },
      success: true,
      version: packageJson.version,
    },
    null,
    2,
  );

// 去掉可能的 JSON 引号包裹
const unwrapJsonString = (text: string): string => {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // ignore
  }
  return text;
};

// 将原始文本规范化为 JsonTree 可直接解析的格式：
// tryParseJsonString 识别不到时，用 preprocessData 转换，结果为对象则序列化为 JSON 字符串
const normalizeForDisplay = (text: string): string => {
  const { format } = tryParseJsonString(text);
  if (format) return text;
  const preprocessed = preprocessData(text);
  if (typeof preprocessed === 'object' && preprocessed !== null) {
    return JSON.stringify(preprocessed);
  }
  return text;
};

// 判断文本是否可解析（用于显示错误提示）
const canParse = (text: string): boolean => {
  if (!text.trim()) return false;
  const { format } = tryParseJsonString(normalizeForDisplay(text));
  return !!format;
};

export interface JsonInputSnapshot {
  inputText?: string;
  isStandalonePage: boolean;
  expandedPaths?: Record<string, boolean>;
}

/** Resolve one input source before rendering; transferred data takes precedence over the active tab. */
export async function loadJsonInput(): Promise<JsonInputSnapshot> {
  const [stored, tabs] = await Promise.all([
    new Promise<Record<string, any>>(resolve => {
      chrome.storage.local.get(['jsonFormatterData', 'jsonFormatterExpandedPaths'], resolve);
    }),
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
  ]);
  if (stored.jsonFormatterData) {
    const snapshot = {
      inputText: normalizeForDisplay(unwrapJsonString(stored.jsonFormatterData)),
      isStandalonePage: true,
      expandedPaths: stored.jsonFormatterExpandedPaths,
    };
    void chrome.storage.local.remove(['jsonFormatterData', 'jsonFormatterExpandedPaths']);
    return snapshot;
  }
  const url = tabs[0]?.url;
  if (url) {
    const inputText = normalizeForDisplay(unwrapJsonString(url));
    if (canParse(inputText)) return { inputText, isStandalonePage: false };
  }
  try {
    const text = (await navigator.clipboard.readText())?.trim();
    if (text) {
      const inputText = normalizeForDisplay(unwrapJsonString(text));
      if (canParse(inputText)) return { inputText, isStandalonePage: false };
    }
  } catch {
    /* The welcome input is available when clipboard access is denied. */
  }
  return { isStandalonePage: false };
}

interface UseJsonInputOptions {
  enableAutoLoad?: boolean;
  initialInput?: JsonInputSnapshot;
  onExpandedPathsRestore?: (paths: Record<string, boolean>) => void;
}

export const useJsonInput = (options: UseJsonInputOptions = {}) => {
  const { enableAutoLoad = true, initialInput, onExpandedPathsRestore } = options;

  const [inputText, setInputText] = useState<string>(
    () => initialInput?.inputText ?? createWelcomeJson(),
  );
  const [parseError, setParseError] = useState<string>('');
  const [isStandalonePage, setIsStandalonePage] = useState<boolean>(
    initialInput?.isStandalonePage ?? false,
  );
  const [isInitialized, setIsInitialized] = useState<boolean>(initialInput !== undefined);
  const loadRef = useRef<Promise<JsonInputSnapshot> | null>(null);
  const loadedRef = useRef(initialInput !== undefined);

  const processInputText = (text: string) => {
    if (!text?.trim()) return;
    const actualText = normalizeForDisplay(unwrapJsonString(text));
    setInputText(actualText);
    if (!canParse(actualText)) {
      setParseError(t('jsonParseError'));
      setTimeout(() => setParseError(''), 3000);
    } else {
      setParseError('');
    }
  };

  useEffect(() => {
    if (!enableAutoLoad || initialInput || loadedRef.current) return;
    let disposed = false;
    // Reuse an in-flight read when switching views so transferred data is consumed once.
    loadRef.current ??= loadJsonInput();
    void loadRef.current.then(snapshot => {
      if (disposed) return;
      loadedRef.current = true;
      setInputText(snapshot.inputText ?? createWelcomeJson());
      setIsStandalonePage(snapshot.isStandalonePage);
      if (snapshot.expandedPaths) onExpandedPathsRestore?.(snapshot.expandedPaths);
      setIsInitialized(true);
    });
    return () => {
      disposed = true;
    };
  }, [enableAutoLoad, initialInput, onExpandedPathsRestore]);

  return {
    inputText,
    setInputText,
    parseError,
    setParseError,
    isStandalonePage,
    isInitialized,
    processInputText,
  };
};
