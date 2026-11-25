import { useState, useEffect, useRef } from 'react';
import { preprocessData } from '../../../shared/dataPreprocessor';
import { tryParseJsonString } from '../../panel/utils/helpers';
import { t } from '../../panel/utils/i18n';
import { parseJsonContainer, type ParseResult } from '../../panel/utils/stringFormats';
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
  /** The transferred or active-tab input before any automatic paste. */
  inputText?: string;
  clipboard?: { text: string; parsed: ParseResult };
  isStandalonePage: boolean;
  expandedPaths?: Record<string, boolean>;
}

/** Resolve the default input and any clipboard override before rendering. */
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
  const snapshot: JsonInputSnapshot = { isStandalonePage: false };
  const url = tabs[0]?.url;
  if (url) {
    const inputText = normalizeForDisplay(url);
    if (canParse(inputText)) snapshot.inputText = inputText;
  }
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) return snapshot;
    // Chrome can finish loading a toolbar popup before giving it focus.
    if (!document.hasFocus()) {
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timeout);
          window.removeEventListener('focus', finish);
          resolve();
        };
        const timeout = setTimeout(finish, 150);
        window.addEventListener('focus', finish, { once: true });
      });
    }
    const text = (await clipboard.readText()).trim();
    const parsed = parseJsonContainer(text);
    if (parsed) snapshot.clipboard = { text, parsed };
  } catch {
    /* Clipboard access can fail when the document is unfocused. */
  }
  return snapshot;
}

const resolveDefaultInput = (snapshot?: JsonInputSnapshot) => ({
  ...snapshot,
  inputText: snapshot?.inputText ?? createWelcomeJson(),
});

interface UseJsonInputOptions {
  enableAutoLoad?: boolean;
  initialInput?: JsonInputSnapshot;
  onExpandedPathsRestore?: (paths: Record<string, boolean>) => void;
}

export const useJsonInput = (options: UseJsonInputOptions = {}) => {
  const { enableAutoLoad = true, initialInput, onExpandedPathsRestore } = options;

  const [initialSources, setInitialSources] = useState(() => resolveDefaultInput(initialInput));
  const [editedInput, setInputText] = useState<string>();
  const [parseError, setParseError] = useState<string>('');
  const loadRef = useRef<Promise<JsonInputSnapshot> | null>(null);
  const loadedRef = useRef(initialInput !== undefined);
  const { clipboard, inputText: defaultInput, isStandalonePage } = initialSources;
  const inputText = editedInput ?? clipboard?.text ?? defaultInput;

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
      setInitialSources(resolveDefaultInput(snapshot));
      if (snapshot.expandedPaths) onExpandedPathsRestore?.(snapshot.expandedPaths);
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
    isStandalonePage: isStandalonePage ?? false,
    isInitialized: isStandalonePage !== undefined,
    autoPasteUndoInput: clipboard && editedInput === undefined ? defaultInput : undefined,
    parsedClipboardInput: clipboard?.text === inputText ? clipboard.parsed : undefined,
    processInputText,
  };
};
