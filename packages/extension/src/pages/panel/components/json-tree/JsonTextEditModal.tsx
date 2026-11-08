import { useState, useEffect, FC } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal, ModalHeader, ModalContent, ModalFooter } from '../modal';
import { t } from '../../utils/i18n';
import { formatJsonForEditor, parseJsonTextForEditor } from '../../utils/jsonEditor';
import { CodeEditor } from '../CodeEditor';

interface JsonTextEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 节点名称，显示在标题中 */
  name?: string;
  /** 待编辑的原始数据，组件内部负责格式化 */
  data: any;
  /** 用户保存后回调，传入已解析的值 */
  onSave: (value: any) => void;
}

export const JsonTextEditModal: FC<JsonTextEditModalProps> = ({
  isOpen,
  onClose,
  name,
  data,
  onSave,
}) => {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  // 每次弹窗打开时重置内容
  useEffect(() => {
    if (isOpen) {
      setText(formatJsonForEditor(data));
      setError('');
    }
  }, [isOpen, data]);

  const handleFormat = () => {
    const { parsed, error } = parseJsonTextForEditor(text, t('invalidJsonFormat'));
    if (error) {
      setError(error);
      return;
    }
    setText(formatJsonForEditor(parsed));
    setError('');
  };

  const handleSave = () => {
    const { parsed, error } = parseJsonTextForEditor(text, t('invalidJsonFormat'));
    if (error) {
      setError(error);
      return;
    }

    onSave(parsed);
    onClose();
  };

  const title = t('editInModalTitle') + (name ? `: ${name}` : '');

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="fullscreen">
      <ModalHeader
        title={title}
        onClose={onClose}
        actions={
          <button
            onClick={handleFormat}
            className="px-1.5 py-0.5 text-2xs rounded transition-colors cursor-pointer bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            {t('formatJson')}
          </button>
        }
      />
      <ModalContent>
        <CodeEditor
          code={text}
          language="json"
          onChange={v => {
            setText(v);
            setError('');
          }}
          minHeightClass="min-h-75"
          autoFocus={isOpen}
        />
        {error && (
          <div className="flex items-center gap-1.5 text-xs text-red-500 mt-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </ModalContent>
      <ModalFooter>
        <div />
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 rounded cursor-pointer text-xs transition-colors bg-bg-secondary text-text-primary hover:bg-bg-hover"
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1 rounded text-xs text-white transition-colors bg-blue-500 hover:bg-blue-600 cursor-pointer"
          >
            {t('save')}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
};
