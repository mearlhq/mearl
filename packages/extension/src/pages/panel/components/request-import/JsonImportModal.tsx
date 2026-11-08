import { useMemo, useRef, useState } from 'react';
import { FileSliders, Loader2 } from 'lucide-react';
import { Modal, ModalContent, ModalFooter, ModalHeader } from '../modal/Modal';
import { ConditionsEditor, type ConditionsViewMode } from '../ConditionsEditor';
import { JsonForm } from './JsonForm';
import { normalizeInstalledImportItem } from './jsonImportNormalizer';
import { formatJsonForEditor, parseJsonTextForEditor } from '../../utils/jsonEditor';
import { setValueByPathInParsedData } from '../../utils/helpers';
import { t } from '../../utils/i18n';
import { showToast } from '../../utils/toast';
import type { RequestImportModalProps } from './requestImportTypes';

export function JsonImportModal({ isOpen, onClose, onImportMock, requestApiNames = [] }: RequestImportModalProps) {
  const [jsonInput, setJsonInput] = useState('');
  const [apiName, setApiName] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [conditionsExpanded, setConditionsExpanded] = useState(false);
  const [conditionsText, setConditionsText] = useState('');
  const [conditionsViewMode, setConditionsViewMode] = useState<ConditionsViewMode>('code');
  const conditions = useMemo(() => {
    if (!conditionsText.trim()) return { parsed: null, error: '' };
    const result = parseJsonTextForEditor(conditionsText, t('invalidJsonFormat'));
    if (result.error) return result;
    return result.parsed && typeof result.parsed === 'object' && !Array.isArray(result.parsed)
      ? result : { parsed: null, error: t('invalidJsonFormat') };
  }, [conditionsText]);
  const options = useMemo(() => [...new Set(requestApiNames.filter(Boolean))].map(value => ({ value, label: value })), [requestApiNames]);

  const handleImport = async () => {
    if (importingRef.current) return;
    setError('');
    let parsed: unknown;
    try { parsed = JSON.parse(jsonInput); } catch { setError(t('jsonInvalidJson')); return; }
    if (conditions.error) { setConditionsExpanded(true); return; }
    importingRef.current = true;
    setImporting(true);
    try {
    const entries = [];
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const normalized = await normalizeInstalledImportItem(item, apiName);
      if (!normalized.ok) {
        if (normalized.reason === 'notObject') continue;
        setError(t('jsonApiRequired')); return;
      }
      entries.push(normalized.entry);
    }
    if (!entries.length) { setError(t('jsonNoEntries')); return; }
      for (const [index, entry] of entries.entries()) {
        try {
          const result = await onImportMock({ ...entry, ...(conditions.parsed ? { conditions: conditions.parsed } : {}) });
          if (result?.success === false) throw new Error(result.error || t('requestImportFailed'));
        } catch {
          // Retain only unprocessed entries so retrying does not reapply completed imports.
          setJsonInput(formatJsonForEditor(entries.slice(index).map(item => item.responseData)));
          setError(t('requestImportFailed'));
          return;
        }
      }
      setJsonInput('');
      setApiName('');
      showToast(t('requestImportSuccess', String(entries.length)), 'success');
    } catch { setError(t('requestImportFailed')); } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalHeader title={t('importData')} onClose={onClose} />
      <ModalContent>
        <div className="mb-2 text-xs font-medium text-text-primary">{t('dataSourceJson')}</div>
        <div className={`flex flex-col flex-1 min-h-0 ${importing ? 'pointer-events-none opacity-60' : ''}`} aria-busy={importing}>
          <JsonForm jsonInput={jsonInput} onJsonInputChange={setJsonInput} apiName={apiName} onApiNameChange={setApiName} apiOptions={options} errorMsg={error} onClearError={() => setError('')} />
        </div>
      </ModalContent>
      <ModalFooter>
        <div className="flex flex-col w-full gap-1.5 px-2">
          {conditionsExpanded && <ConditionsEditor viewMode={conditionsViewMode} onViewModeChange={setConditionsViewMode} text={conditionsText} data={conditions.parsed} error={conditions.error ?? ''} onCodeChange={setConditionsText} onTreeChange={(path, value) => setConditionsText(formatJsonForEditor(setValueByPathInParsedData(conditions.parsed ?? {}, conditions.parsed ?? {}, path, value)))} />}
          <div className="flex items-center justify-between">
            <button type="button" aria-pressed={conditionsExpanded} onClick={() => setConditionsExpanded(value => !value)} title={t('mockConditions')} className="p-1 rounded text-text-secondary hover:bg-bg-hover hover:text-text-primary"><FileSliders className="w-3.5 h-3.5" /></button>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="px-2 py-1 text-xs rounded bg-bg-secondary hover:bg-bg-hover text-text-primary">{t('close')}</button>
              <button onClick={handleImport} disabled={importing || !jsonInput.trim()} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed">
                {importing && <Loader2 className="w-3 h-3 animate-spin" />}{t('importData')}
              </button>
            </div>
          </div>
        </div>
      </ModalFooter>
    </Modal>
  );
}
