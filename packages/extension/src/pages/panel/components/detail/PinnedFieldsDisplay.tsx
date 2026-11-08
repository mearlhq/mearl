import { FC } from 'react';
import { PinnedField } from '../../types';
import { PinnedFieldItem } from './PinnedFieldItem';
import { t } from '../../utils/i18n';
import { useDragToReorder } from '../../hooks/useDragToReorder';

interface PinnedFieldsDisplayProps {
  fields: PinnedField[];
  onUnpin: (path: string) => void;
  onValueChangeForField?: (fieldPath: string) => (path: string[], newValue: any) => void;
  editable?: boolean;
  onPinField?: (path: string[], value: any) => void;
  expandedPaths?: Record<string, boolean>;
  onToggleExpand?: (paths: Record<string, boolean>) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

export const PinnedFieldsDisplay: FC<PinnedFieldsDisplayProps> = ({
  fields,
  onUnpin,
  onValueChangeForField,
  editable = false,
  onPinField,
  expandedPaths,
  onToggleExpand,
  onReorder,
}) => {
  const { getDragHandlers, isDragging, isDragOver } = useDragToReorder(onReorder);

  return (
    <div className="mb-3">
      <div className="mb-1.5 text-xxs font-medium px-1 text-text-primary">{t('pinnedFields')}</div>
      <div className="space-y-1.5">
        {fields.map((field, idx) => (
          <PinnedFieldItem
            key={`${field.path}-${field.apiName}-${field.type}-${idx}`}
            field={field}
            index={idx}
            onUnpin={onUnpin}
            onValueChange={
              onValueChangeForField && editable ? onValueChangeForField(field.path) : undefined
            }
            editable={editable}
            onPinField={onPinField}
            expandedPaths={expandedPaths}
            onToggleExpand={onToggleExpand}
            dragHandlers={getDragHandlers(idx)}
            isDragging={isDragging(idx)}
            isDragOver={isDragOver(idx)}
          />
        ))}
      </div>
    </div>
  );
};
