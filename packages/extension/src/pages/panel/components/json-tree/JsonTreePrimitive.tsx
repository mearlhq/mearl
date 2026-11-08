import { clsx } from 'clsx';
import { useState, useRef, useEffect, ReactNode, MouseEvent, KeyboardEvent, FC } from 'react';
import { Check, X, Minus } from 'lucide-react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { PrefixBadge } from './PrefixBadge';
import { ImagePreviewModal } from './ImagePreviewModal';
import { t } from '../../utils/i18n';
import { getValueType } from '../../utils/jsonHelpers';
import { useSafeFocus } from '../../../../shared/hooks/useSafeFocus';
import { getStringFormatTooltipText } from '../../utils/helpers';
import type { StringFormat } from '../../utils/helpers';
import { openColorPicker } from './colorPicker';
import { applyPickedColor, parseHexColorValue } from './colorValue';

interface JsonTreePrimitiveProps {
  data: any;
  format?: StringFormat;
  prefix?: string;
  searchQuery: string;
  isMatch: boolean;
  highlightText: (text: string, textStartOffset?: number) => ReactNode;
  nameOccurrenceCount?: number;
  editable: boolean;
  isEditing: boolean;
  editValue: string;
  setEditValue: (value: string) => void;
  handleValueClick: (e: MouseEvent) => void;
  handleSaveEdit: () => void;
  handleBlurEdit: (value: string) => void;
  handleDirectValueChange: (value: string) => void;
  handleCancelEdit: () => void;
  handleKeyDown: (e: KeyboardEvent) => void;
  contextMenu: { x: number; y: number } | null;
  contextMenuItems: ContextMenuItem[];
  setContextMenu: (menu: { x: number; y: number } | null) => void;
  onToggleRaw?: (e: MouseEvent) => void;
  toggled?: boolean;
  onRemove?: () => void;
}

export const JsonTreePrimitive: FC<JsonTreePrimitiveProps> = ({
  data,
  format,
  prefix,
  searchQuery,
  isMatch,
  highlightText,
  nameOccurrenceCount = 0,
  editable,
  isEditing,
  editValue,
  setEditValue,
  handleValueClick,
  handleSaveEdit,
  handleBlurEdit,
  handleDirectValueChange,
  handleCancelEdit,
  handleKeyDown,
  contextMenu,
  contextMenuItems,
  setContextMenu,
  onToggleRaw,
  toggled = false,
  onRemove,
}) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useSafeFocus(textareaRef, { enabled: isEditing });

  // 自适应高度
  useEffect(() => {
    if (textareaRef.current && isEditing) {
      const textarea = textareaRef.current;
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    }
  }, [editValue, isEditing]);

  // 检测是否为图片 URL
  const isImageUrl = (val: any): boolean => {
    if (typeof val !== 'string') return false;
    const urlPattern = /^(https?:)?\/\/.+\.(jpg|jpeg|png|gif|bmp|webp|svg)(\?.*)?$/i;
    return urlPattern.test(val);
  };
  const normalizeImageUrl = (url: string): string => {
    if (url.startsWith('//')) return 'https:' + url;
    return url;
  };

  const renderPrimitive = (val: any) => {
    const type = getValueType(val);
    let displayValue = String(val);
    let colorClass = 'text-text-primary';
    const isImage = isImageUrl(val);
    const colorValue = parseHexColorValue(val);

    if (type === 'string') {
      colorClass = 'text-json-string';
      displayValue = `"${val}"`;
    } else if (type === 'number') {
      colorClass = 'text-json-number';
    } else if (type === 'boolean') {
      colorClass = 'text-json-boolean';
    } else if (type === 'null') {
      colorClass = 'text-json-null';
      displayValue = 'null';
    }

    const content =
      searchQuery && isMatch ? highlightText(displayValue, nameOccurrenceCount) : displayValue;

    if (isImage) {
      return (
        <span
          className={clsx(
            `${colorClass} break-all cursor-pointer hover:underline whitespace-break-spaces`,
          )}
          onClick={e => {
            if (editable && !e.metaKey) return;
            e.stopPropagation();
            setImageUrl(normalizeImageUrl(val));
          }}
          title={editable ? t('commandClickToViewImage') : t('clickToViewImage')}
        >
          {content}
        </span>
      );
    }

    if (colorValue) {
      return (
        <span
          className={clsx(colorClass, 'inline-flex items-center align-middle whitespace-nowrap')}
        >
          {editable ? (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                openColorPicker(e.currentTarget, colorValue.pickerValue, pickedColor => {
                  handleDirectValueChange(applyPickedColor(pickedColor, String(val)));
                });
              }}
              aria-label={t('selectColor')}
              title={t('selectColor')}
              data-json-color-preview={colorValue.cssValue}
              className="inline-block size-[1lh] mr-1 shrink-0 rounded-sm border border-border shadow-sm cursor-pointer"
              style={{ backgroundColor: colorValue.cssValue }}
            />
          ) : (
            <span
              aria-hidden="true"
              data-json-color-preview={colorValue.cssValue}
              className="inline-block size-[1lh] mr-1 shrink-0 rounded-sm border border-border shadow-sm"
              style={{ backgroundColor: colorValue.cssValue }}
            />
          )}
          {content}
        </span>
      );
    }

    return (
      <span className={clsx(`${colorClass} break-all whitespace-break-spaces`)}>{content}</span>
    );
  };

  return (
    <>
      {format && (
        <PrefixBadge
          text={
            format.badge.text === 'Query'
              ? t('queryString')
              : format.badge.text === 'Encoded'
                ? t('encoded')
                : format.badge.text
          }
          tooltip={
            onToggleRaw
              ? t('clickToToggleFormat')
              : prefix
                ? `${t('encodedPrefix')}: ${prefix}`
                : getStringFormatTooltipText(format.badge.tooltipKey)
          }
          copyText={onToggleRaw ? undefined : prefix}
          variant={format.badge.variant}
          onClick={onToggleRaw}
          toggled={toggled}
        />
      )}
      {isEditing ? (
        <div
          className="flex items-start gap-1 min-w-0 max-w-full -mt-0.5 translate-y-px"
          onClick={e => e.stopPropagation()}
        >
          <textarea
            ref={textareaRef}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={e => handleBlurEdit(e.currentTarget.value)}
            className="field-sizing-content min-w-5 max-w-full px-1.25 py-0 border border-accent-blue rounded bg-bg-secondary text-text-primary outline-none resize-none overflow-hidden whitespace-break-spaces break-all"
            rows={1}
          />
          <button
            onMouseDown={e => {
              e.preventDefault();
              handleSaveEdit();
            }}
            className="mt-px p-0.5 rounded bg-green-500 text-white cursor-pointer shrink-0"
            title={t('save')}
          >
            <Check size={12} />
          </button>
          <button
            onMouseDown={e => {
              e.preventDefault();
              handleCancelEdit();
            }}
            className="mt-px p-0.5 rounded bg-red-500 text-white cursor-pointer shrink-0"
            title={t('cancel')}
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <span
          onClick={editable ? handleValueClick : undefined}
          className={editable ? 'cursor-pointer hover:underline' : ''}
        >
          {renderPrimitive(data)}
        </span>
      )}
      {onRemove && !isEditing && (
        <button
          className="opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center justify-center w-3.5 h-3.5 rounded text-text-secondary hover:text-red-500 shrink-0 mt-px"
          onClick={e => {
            e.stopPropagation();
            onRemove();
          }}
          title={t('removeField')}
        >
          <Minus size={11} />
        </button>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      <ImagePreviewModal imageUrl={imageUrl} onClose={() => setImageUrl(null)} />
    </>
  );
};
