import { FC, Ref } from 'react';
import { ListFilter } from 'lucide-react';
import { clsx } from 'clsx';
import { SearchableSelect, SelectOption } from '../SearchableSelect';
import { t } from '../../utils/i18n';

export interface ApiNameInputProps {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder: string;
  options: SelectOption[];
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}

export const ApiNameInput: FC<ApiNameInputProps> = ({
  value,
  onChange,
  onEnter,
  placeholder,
  options,
  className,
  inputRef,
}) => {
  const hasPicker = options.length > 0;
  return (
    <div className={clsx('relative', className)}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onEnter?.();
        }}
        placeholder={placeholder}
        className={clsx(
          'w-full px-2 py-1.5 text-xs rounded border border-border bg-bg-primary text-text-primary focus:outline-none focus:border-blue-500 font-mono',
          hasPicker && 'pr-8',
        )}
      />
      {hasPicker && (
        <div className="absolute inset-y-0 right-1 flex items-center">
          <SearchableSelect
            options={options}
            value=""
            onChange={onChange}
            searchPlaceholder={t('pickApiFromRequestsSearch')}
            noDataText={t('pickApiFromRequestsEmpty')}
            align="right"
            panelClassName="w-80"
            triggerClassName="flex items-center justify-center w-6 h-6 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            triggerTitle={t('pickApiFromRequestsTitle')}
            triggerContent={<ListFilter size={14} />}
          />
        </div>
      )}
    </div>
  );
};
