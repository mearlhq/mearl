import { useState, useRef, FC, ClipboardEvent, KeyboardEvent } from 'react';
import { Check, X } from 'lucide-react';
import { t } from '../../utils/i18n';
import { useSafeFocus } from '../../../../shared/hooks/useSafeFocus';
import type { StringFormat } from '../../utils/helpers';
import { serializeWithFormat } from '../../utils/helpers';
import { isImeComposing } from './keyboard';

interface AddItemFormProps {
  data: any;
  format?: StringFormat;
  prefix?: string;
  currentPath: string[];
  onValueChange: (path: string[], newValue: any) => void;
  onCancel: () => void;
}

export const AddItemForm: FC<AddItemFormProps> = ({
  data,
  format,
  prefix,
  currentPath,
  onValueChange,
  onCancel,
}) => {
  const [newItemKey, setNewItemKey] = useState('');
  const [newItemValue, setNewItemValue] = useState('');
  const [newItemType, setNewItemType] = useState<
    'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  >('string');
  const firstInputRef = useRef<HTMLInputElement>(null);

  useSafeFocus(firstInputRef);

  const isArray = Array.isArray(data);
  const arrayLength = isArray ? data.length : 0;
  const [insertIndex, setInsertIndex] = useState<string>(arrayLength.toString()); // 数组插入位置索引，默认为末尾

  const handleAddItem = () => {
    // 对于对象，需要检查 key 是否为空
    if (!isArray && !newItemKey.trim()) {
      return;
    }

    let newValue: any;
    try {
      switch (newItemType) {
        case 'string':
          newValue = newItemValue;
          break;
        case 'number':
          newValue = Number(newItemValue);
          if (isNaN(newValue)) {
            return;
          }
          break;
        case 'boolean':
          newValue = newItemValue === 'true';
          break;
        case 'null':
          newValue = null;
          break;
        case 'object':
          // 尝试解析输入的值为对象
          try {
            const parsed = JSON.parse(newItemValue);
            newValue =
              typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null ? parsed : {};
          } catch {
            newValue = {};
          }
          break;
        case 'array':
          // 尝试解析输入的值为数组
          try {
            const parsed = JSON.parse(newItemValue);
            newValue = Array.isArray(parsed) ? parsed : [];
          } catch {
            newValue = [];
          }
          break;
      }

      let updatedData: any;
      if (isArray) {
        // 数组：根据索引位置插入
        const targetIndex = insertIndex.trim() === '' ? arrayLength : parseInt(insertIndex, 10);

        // 验证索引是否有效
        if (isNaN(targetIndex) || targetIndex < 0) {
          return;
        }

        // 使用 splice 在指定位置插入
        const newArray = [...data];
        const safeIndex = Math.min(targetIndex, arrayLength); // 确保索引不超过数组长度
        newArray.splice(safeIndex, 0, newValue);
        // 如果数组本身是从格式化字符串解析出来的，需要序列化回字符串
        updatedData = format ? serializeWithFormat(newArray, format, prefix) : newArray;
      } else {
        // 对象：通过深路径添加新属性，让 setValueByPathInParsedData 负责中间格式的序列化
        onValueChange([...currentPath, newItemKey], newValue);
        onCancel();
        return;
      }

      onValueChange(currentPath, updatedData);
      onCancel();
    } catch (error) {
      console.error(error);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (isImeComposing(e)) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddItem();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  // 仅 query string 场景才把 key 输入框中粘贴的 `key=value` 拆到 key/value 两格：
  // query 参数天然是 key=value 形态，而普通 JSON 对象的 key 可能合法包含 `=`，不应拆分。
  const handleKeyPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (format?.id !== 'queryString') return;
    const pastedText = e.clipboardData.getData('text');
    const separatorIndex = pastedText.indexOf('=');
    if (separatorIndex <= 0) return;

    const target = e.currentTarget;
    const replacesWholeKey =
      newItemKey === '' ||
      (target.selectionStart === 0 && target.selectionEnd === newItemKey.length);
    if (!replacesWholeKey) return;

    const key = pastedText.slice(0, separatorIndex).trim();
    if (!key) return;

    e.preventDefault();
    setNewItemKey(key);
    setNewItemValue(pastedText.slice(separatorIndex + 1));
  };

  return (
    <div className="py-0.5 flex items-center gap-1 text-xxs">
      {isArray ? (
        <input
          ref={firstInputRef}
          type="number"
          value={insertIndex}
          onChange={e => setInsertIndex(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('insertIndex')}
          title={t('insertIndexHint')}
          className="w-16 h-5 px-1.5 py-0 border border-border rounded bg-bg-primary text-text-primary focus:outline-none"
          min="0"
        />
      ) : (
        <input
          ref={firstInputRef}
          type="text"
          value={newItemKey}
          onChange={e => setNewItemKey(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handleKeyPaste}
          placeholder="key"
          className="w-20 h-5 px-1.5 py-0 border border-border rounded bg-bg-primary text-text-primary focus:outline-none"
        />
      )}
      <select
        value={newItemType}
        onChange={e => setNewItemType(e.target.value as any)}
        className="h-5 px-1.5 py-0 border border-border rounded bg-bg-primary text-text-primary text-2xs focus:outline-none"
      >
        <option value="string">String</option>
        <option value="number">Number</option>
        <option value="boolean">Boolean</option>
        <option value="null">Null</option>
        <option value="object">Object</option>
        <option value="array">Array</option>
      </select>
      {newItemType !== 'null' && (
        <input
          type={newItemType === 'number' ? 'number' : 'text'}
          value={newItemValue}
          onChange={e => setNewItemValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            newItemType === 'object'
              ? '{"key": "value"}'
              : newItemType === 'array'
                ? '[1, 2, 3]'
                : 'value'
          }
          className="flex-1 h-5 px-1.5 py-0 border border-border rounded bg-bg-primary text-text-primary focus:outline-none"
        />
      )}
      <button
        onClick={handleAddItem}
        className="p-0.5 rounded bg-green-500 text-white hover:bg-green-600 cursor-pointer"
        title={t('confirm')}
      >
        <Check size={12} />
      </button>
      <button
        onClick={onCancel}
        className="p-0.5 rounded bg-red-500 text-white hover:bg-red-600 cursor-pointer"
        title={t('cancel')}
      >
        <X size={12} />
      </button>
    </div>
  );
};
