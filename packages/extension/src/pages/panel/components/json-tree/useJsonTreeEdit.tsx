import { useState, MouseEvent, KeyboardEvent } from 'react';
import { getValueType } from '../../utils/jsonHelpers';
import { isImeComposing } from './keyboard';
import { useBlurCommitGuard } from './useBlurCommitGuard';

interface UseJsonTreeEditProps {
  data: any;
  rawData?: any; // raw 模式下的原始字符串（如 URL 字符串）
  showRaw?: boolean;
  path: string[];
  name?: string;
  onValueChange?: (path: string[], newValue: any) => void;
  active?: boolean;
  onEditStart?: () => void;
  onEditEnd?: () => void;
}

export const useJsonTreeEdit = ({
  data,
  rawData,
  showRaw = false,
  path,
  name,
  onValueChange,
  active = true,
  onEditStart,
  onEditEnd,
}: UseJsonTreeEditProps) => {
  const [locallyEditing, setLocallyEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const blurCommitGuard = useBlurCommitGuard();
  const isEditing = locallyEditing && active;

  // 处理点击值开始编辑
  const handleValueClick = (e: MouseEvent) => {
    e.stopPropagation();
    onEditStart?.();
    blurCommitGuard.beginEdit();
    // raw 模式：直接显示原始字符串；否则按值类型处理
    if (showRaw && rawData !== undefined) {
      setEditValue(String(rawData));
    } else {
      setEditValue(String(data));
    }
    setLocallyEditing(true);
  };

  // 校验并写入编辑值
  const commitEdit = (value: string): boolean => {
    if (!onValueChange) return false;

    const currentPath = name ? [...path, name] : path;
    let newValue: any;

    try {
      if (showRaw) {
        // raw 模式：直接以字符串形式保存，不做类型转换
        newValue = value;
      } else {
        const type = getValueType(data);
        if (type === 'number') {
          newValue = Number(value);
          if (isNaN(newValue)) return false;
        } else if (type === 'boolean') {
          if (value === 'true') newValue = true;
          else if (value === 'false') newValue = false;
          else return false;
        } else if (type === 'null') {
          if (value !== 'null') return false;
          newValue = null;
        } else {
          newValue = value;
        }
      }

      const currentValue = showRaw && rawData !== undefined ? String(rawData) : data;
      if (Object.is(newValue, currentValue)) return true;

      onValueChange(currentPath, newValue);
      return true;
    } catch (error) {
      console.warn('保存失败: ' + error);
      return false;
    }
  };

  const handleSaveEdit = () => {
    blurCommitGuard.finishEdit();
    if (!commitEdit(editValue)) {
      blurCommitGuard.beginEdit();
      return false;
    }
    setLocallyEditing(false);
    onEditEnd?.();
    return true;
  };

  // 取消编辑
  const handleCancelEdit = () => {
    blurCommitGuard.finishEdit();
    setLocallyEditing(false);
    onEditEnd?.();
  };

  const handleBlurEdit = (value: string) => {
    if (blurCommitGuard.consumeBlur()) return;
    commitEdit(value);
    setLocallyEditing(false);
    onEditEnd?.();
  };

  const handleDirectValueChange = (value: string) => {
    commitEdit(value);
  };

  // 处理键盘事件
  const handleKeyDown = (e: KeyboardEvent) => {
    if (isImeComposing(e)) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancelEdit();
    }
  };

  return {
    isEditing,
    editValue,
    setEditValue,
    handleValueClick,
    handleSaveEdit,
    handleBlurEdit,
    handleDirectValueChange,
    handleCancelEdit,
    handleKeyDown,
  };
};
