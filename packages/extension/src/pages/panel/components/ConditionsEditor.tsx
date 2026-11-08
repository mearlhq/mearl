import { FC } from 'react';
import { AlertCircle } from 'lucide-react';
import { JsonTree } from './json-tree';
import { CodeEditor } from './CodeEditor';
import { t } from '../utils/i18n';

export type ConditionsViewMode = 'tree' | 'code';

export interface ConditionsEditorProps {
  viewMode: ConditionsViewMode;
  onViewModeChange: (mode: ConditionsViewMode) => void;
  text: string;
  data: any;
  error: string;
  onCodeChange: (value: string) => void;
  onTreeChange: (path: string[], newValue: any) => void;
  titleClassName?: string;
  /** 提供则在代码模式右上角显示「格式化」按钮 */
  onFormat?: () => void;
}

export const ConditionsEditor: FC<ConditionsEditorProps> = ({
  viewMode,
  onViewModeChange,
  text,
  data,
  error,
  onCodeChange,
  onTreeChange,
  titleClassName = 'text-xs font-medium text-text-primary',
  onFormat,
}) => {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className={`shrink-0 ${titleClassName}`}>{t('mockConditions')}</span>
        <span className="flex-1 text-2xs text-text-secondary truncate opacity-60">
          {t('noConditionsHint')}
        </span>
        <div className="flex items-center rounded overflow-hidden border border-border bg-bg-secondary shrink-0">
          <button
            onClick={() => onViewModeChange('tree')}
            className={`px-1.5 py-0.5 text-2xs transition-colors cursor-pointer ${
              viewMode === 'tree'
                ? 'bg-blue-500 text-white'
                : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`}
          >
            {t('jsonViewModeTree')}
          </button>
          <button
            onClick={() => onViewModeChange('code')}
            className={`px-1.5 py-0.5 text-2xs transition-colors cursor-pointer ${
              viewMode === 'code'
                ? 'bg-blue-500 text-white'
                : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`}
          >
            {t('jsonViewModeCode')}
          </button>
        </div>
      </div>
      <div className="mt-1.5">
        <div className="h-24">
          {viewMode === 'tree' ? (
            <div className="h-full overflow-y-auto p-2 border border-border rounded bg-white dark:bg-bg-primary">
              <pre className="font-mono text-xxs">
                <JsonTree data={data ?? {}} editable onValueChange={onTreeChange} />
              </pre>
            </div>
          ) : (
            <CodeEditor
              code={text}
              language="json"
              onChange={onCodeChange}
              showToolbar={false}
              onFormat={onFormat}
              placeholder={t('conditionsPlaceholder')}
              className="bg-white! dark:bg-bg-primary!"
            />
          )}
        </div>
        {error ? (
          <div className="flex items-center gap-1 mt-1 text-2xs text-red-500">
            <AlertCircle size={12} />
            <span>{error}</span>
          </div>
        ) : (
          <p className="text-2xs text-blue-500 mt-1 opacity-85">{t('conditionsMultiMockHint')}</p>
        )}
      </div>
    </div>
  );
};
