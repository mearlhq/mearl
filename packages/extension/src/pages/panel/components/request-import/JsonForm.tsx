import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { t } from '../../utils/i18n';
import { SelectOption } from '../SearchableSelect';
import { ApiNameInput } from './ApiNameInput';
import { SearchableJsonTree } from '../json-tree/index';
import { CodeEditor } from '../CodeEditor';
import { formatJsonForEditor, parseJsonTextForEditor } from '../../utils/jsonEditor';
import { setValueByPathInParsedData } from '../../utils/helpers';

type JsonViewMode = 'tree' | 'code';

/**
 * 从解析后的 JSON 中提取顶层 `api` 字段。支持单个对象，或对象数组（取第一个
 * 带 api 的元素）。用于在用户填写 JSON 后自动回填上方的 api 输入框。
 */
const extractTopLevelApi = (data: unknown): string => {
  const pick = (v: unknown): string => {
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return '';
    const api = (v as Record<string, unknown>).api;
    return typeof api === 'string' ? api.trim() : '';
  };
  if (Array.isArray(data)) {
    for (const item of data) {
      const api = pick(item);
      if (api) return api;
    }
    return '';
  }
  return pick(data);
};

export interface JsonFormProps {
  jsonInput: string;
  onJsonInputChange: (v: string) => void;
  apiName: string;
  onApiNameChange: (v: string) => void;
  apiOptions: SelectOption[];
  errorMsg: string;
  onClearError: () => void;
}

export const JsonForm: FC<JsonFormProps> = ({
  jsonInput,
  onJsonInputChange,
  apiName,
  onApiNameChange,
  apiOptions,
  errorMsg,
  onClearError,
}) => {
  // 默认始终是代码模式（不持久化，每次进入 JSON 导入都从代码模式开始）。
  const [viewMode, setViewMode] = useState<JsonViewMode>('code');

  // 树形模式需要解析后的数据；空内容或非法 JSON 时为 null，回退到提示文案。
  const { parsed, parseError } = useMemo(() => {
    if (!jsonInput.trim()) return { parsed: null, parseError: '' };
    const { parsed: data, error } = parseJsonTextForEditor(jsonInput, t('jsonInvalidJson'));
    return { parsed: error ? null : data, parseError: error ?? '' };
  }, [jsonInput]);

  // 仅在 JSON 中的 api 字段「实际发生变化」时回填，避免覆盖用户随后手动修改的输入框。
  const lastDetectedApi = useRef('');
  useEffect(() => {
    const detected = extractTopLevelApi(parsed);
    if (detected && detected !== lastDetectedApi.current) {
      lastDetectedApi.current = detected;
      if (detected !== apiName) onApiNameChange(detected);
    }
  }, [parsed]);

  const handleCodeChange = (value: string) => {
    onJsonInputChange(value);
    if (errorMsg) onClearError();
  };

  const handleFormat = () => {
    if (!jsonInput.trim()) return;
    const { parsed: data, error } = parseJsonTextForEditor(jsonInput, t('jsonInvalidJson'));
    if (error) return;
    onJsonInputChange(formatJsonForEditor(data));
    if (errorMsg) onClearError();
  };

  const handleTreeChange = (path: string[], newValue: any) => {
    const base = parsed ?? {};
    const updated =
      path.length === 0 ? newValue : setValueByPathInParsedData(base, base, path, newValue);
    onJsonInputChange(formatJsonForEditor(updated));
    if (errorMsg) onClearError();
  };

  const modeBtnCls = (active: boolean) =>
    `px-1.5 py-0.5 text-2xs transition-colors cursor-pointer ${
      active
        ? 'bg-blue-500 text-white'
        : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
    }`;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-1">
      <div className="flex items-center gap-2">
        <ApiNameInput
          className="flex-1"
          value={apiName}
          onChange={v => {
            onApiNameChange(v);
            if (errorMsg) onClearError();
          }}
          placeholder={t('jsonApiPlaceholder')}
          options={apiOptions}
        />
        <div className="flex items-center rounded overflow-hidden border border-border bg-bg-secondary shrink-0">
          <button onClick={() => setViewMode('tree')} className={modeBtnCls(viewMode === 'tree')}>
            {t('jsonViewModeTree')}
          </button>
          <button onClick={() => setViewMode('code')} className={modeBtnCls(viewMode === 'code')}>
            {t('jsonViewModeCode')}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {viewMode === 'tree' ? (
          <SearchableJsonTree
            className="h-full border border-border rounded bg-white dark:bg-bg-primary"
            textClassName="text-2xs"
            data={parsed}
            editable
            onValueChange={handleTreeChange}
            empty={
              <div className="text-2xs text-text-secondary opacity-70">
                {jsonInput.trim() ? parseError || t('jsonInvalidJson') : t('jsonInputPlaceholder')}
              </div>
            }
          />
        ) : (
          <CodeEditor
            code={jsonInput}
            language="json"
            onChange={handleCodeChange}
            onFormat={handleFormat}
            placeholder={t('jsonInputPlaceholder')}
            className="h-full"
          />
        )}
      </div>

      {errorMsg && (
        <div className="flex items-center gap-1.5 text-xs text-red-500 px-1">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
};
