import { FC, useEffect, useState } from 'react';
import { AlertCircle, FileSliders } from 'lucide-react';
import { Modal, ModalHeader, ModalContent, ModalFooter } from './Modal';
import { SearchableJsonTree } from '../json-tree';
import { CodeEditor } from '../CodeEditor';
import { ConditionsEditor } from '../ConditionsEditor';
import { t } from '../../utils/i18n';
import { formatJsonForEditor, parseJsonTextForEditor } from '../../utils/jsonEditor';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { setValueByPathInParsedData } from '../../utils/helpers';

interface MockEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiName: string;
  responseData: any;
  conditions: Record<string, any> | undefined;
  onSave: (conditions: Record<string, any> | undefined, responseData: any) => void;
}

type ViewMode = 'tree' | 'code';

export const MockEditModal: FC<MockEditModalProps> = ({
  isOpen,
  onClose,
  apiName,
  responseData,
  conditions,
  onSave,
}) => {
  const [conditionsExpanded, setConditionsExpanded] = useLocalStorage<boolean>(
    'mock-edit-conditions-expanded',
    true,
  );
  const [conditionsViewMode, setConditionsViewMode] = useLocalStorage<ViewMode>(
    'mock-edit-conditions-view-mode',
    'code',
  );
  const [responseViewMode, setResponseViewMode] = useLocalStorage<ViewMode>(
    'mock-edit-response-view-mode',
    'tree',
  );

  const [conditionsText, setConditionsText] = useState('');
  const [conditionsError, setConditionsError] = useState('');
  const [conditionsData, setConditionsData] = useState<any>(null);

  const [responseText, setResponseText] = useState('');
  const [responseError, setResponseError] = useState('');
  const [responseDataState, setResponseDataState] = useState<any>(null);

  useEffect(() => {
    if (isOpen) {
      const hasConditions = conditions && Object.keys(conditions).length > 0;
      const text = hasConditions ? formatJsonForEditor(conditions) : '';
      setConditionsText(text);
      setConditionsData(hasConditions ? conditions : null);
      setConditionsError('');

      setResponseDataState(responseData);
      setResponseText(formatJsonForEditor(responseData));
      setResponseError('');
    }
  }, [isOpen, conditions, responseData]);

  const handleConditionsCodeChange = (value: string) => {
    setConditionsText(value);
    if (!value.trim()) {
      setConditionsError('');
      setConditionsData(null);
      return;
    }
    const { parsed, error } = parseJsonTextForEditor(value, t('invalidJsonFormat'), {
      includeErrorPrefix: true,
    });
    if (error) {
      setConditionsError(error);
    } else {
      setConditionsError('');
      setConditionsData(parsed);
    }
  };

  const handleConditionsTreeChange = (path: string[], newValue: any) => {
    const updated =
      path.length === 0
        ? newValue
        : setValueByPathInParsedData(conditionsData ?? {}, conditionsData ?? {}, path, newValue);
    setConditionsData(updated);
    setConditionsText(formatJsonForEditor(updated));
    setConditionsError('');
  };

  const handleResponseCodeChange = (value: string) => {
    setResponseText(value);
    if (!value.trim()) {
      setResponseError('');
      setResponseDataState(null);
      return;
    }
    const { parsed, error } = parseJsonTextForEditor(value, t('invalidJsonFormat'), {
      includeErrorPrefix: true,
    });
    if (error) {
      setResponseError(error);
    } else {
      setResponseError('');
      setResponseDataState(parsed);
    }
  };

  const handleResponseTreeChange = (path: string[], newValue: any) => {
    const updated =
      path.length === 0
        ? newValue
        : setValueByPathInParsedData(responseDataState, responseDataState, path, newValue);
    setResponseDataState(updated);
    setResponseText(formatJsonForEditor(updated));
    setResponseError('');
  };

  const formatConditions = () => {
    if (!conditionsText.trim()) return;
    const { parsed, error } = parseJsonTextForEditor(conditionsText, t('invalidJsonFormat'), {
      includeErrorPrefix: true,
    });
    if (error) {
      setConditionsError(error);
    } else {
      setConditionsText(formatJsonForEditor(parsed));
      setConditionsData(parsed);
      setConditionsError('');
    }
  };

  const formatResponse = () => {
    if (!responseText.trim()) return;
    const { parsed, error } = parseJsonTextForEditor(responseText, t('invalidJsonFormat'), {
      includeErrorPrefix: true,
    });
    if (error) {
      setResponseError(error);
    } else {
      setResponseText(formatJsonForEditor(parsed));
      setResponseDataState(parsed);
      setResponseError('');
    }
  };

  const handleSave = () => {
    let finalConditions: Record<string, any> | undefined;
    if (conditionsText.trim()) {
      const { parsed, error } = parseJsonTextForEditor(conditionsText, t('invalidJsonFormat'), {
        includeErrorPrefix: true,
      });
      if (error) {
        setConditionsError(error);
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setConditionsError(t('invalidJsonFormat'));
        return;
      }
      finalConditions = Object.keys(parsed).length > 0 ? parsed : undefined;
    }

    if (responseText.trim()) {
      const { parsed, error } = parseJsonTextForEditor(responseText, t('invalidJsonFormat'), {
        includeErrorPrefix: true,
      });
      if (error) {
        setResponseError(error);
        return;
      }
      onSave(finalConditions, parsed);
    } else {
      onSave(finalConditions, responseDataState);
    }
  };

  const modeButtonClass = (active: boolean) =>
    `px-1.5 py-0.5 text-2xs transition-colors cursor-pointer ${
      active
        ? 'bg-blue-500 text-white'
        : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
    }`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="fullscreen">
      <ModalHeader title={apiName} onClose={onClose} />
      <ModalContent>
        <div className="flex flex-col h-full min-h-0">
          {/* 响应数据 */}
          <div className="flex items-center justify-between pb-1.5 shrink-0">
            <span className="text-xs font-medium text-text-primary">{t('responsePreview')}</span>
            <div className="flex items-center rounded overflow-hidden border border-border bg-bg-secondary">
              <button
                onClick={() => setResponseViewMode('tree')}
                className={modeButtonClass(responseViewMode === 'tree')}
              >
                {t('jsonViewModeTree')}
              </button>
              <button
                onClick={() => setResponseViewMode('code')}
                className={modeButtonClass(responseViewMode === 'code')}
              >
                {t('jsonViewModeCode')}
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {responseViewMode === 'tree' ? (
              <SearchableJsonTree
                className="h-full border border-border rounded bg-white dark:bg-bg-primary"
                data={responseDataState}
                editable
                onValueChange={handleResponseTreeChange}
              />
            ) : (
              <CodeEditor
                code={responseText}
                language="json"
                onChange={handleResponseCodeChange}
                onFormat={formatResponse}
                className="bg-white! dark:bg-bg-primary!"
              />
            )}
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <div className="flex flex-col w-full gap-1.5 px-2">
          {conditionsExpanded && (
            <ConditionsEditor
              viewMode={conditionsViewMode}
              onViewModeChange={setConditionsViewMode}
              text={conditionsText}
              data={conditionsData}
              error={conditionsError}
              onCodeChange={handleConditionsCodeChange}
              onTreeChange={handleConditionsTreeChange}
              onFormat={formatConditions}
            />
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                aria-pressed={conditionsExpanded}
                onClick={() => setConditionsExpanded(prev => !prev)}
                title={t('mockConditions')}
                className={`p-1 rounded transition-colors cursor-pointer text-text-secondary hover:text-text-primary shrink-0 ${
                  conditionsExpanded ? 'bg-bg-secondary' : 'hover:bg-bg-hover'
                }`}
              >
                <FileSliders size={14} />
              </button>
              {responseError && (
                <div className="flex items-center gap-1.5 text-xs text-red-500 min-w-0">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{responseError}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={onClose}
                className="px-3 py-1 rounded cursor-pointer text-xs transition-colors bg-bg-secondary text-text-primary hover:bg-bg-hover"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={!!conditionsError || !!responseError}
                className="px-3 py-1 rounded text-xs text-white transition-colors bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      </ModalFooter>
    </Modal>
  );
};
