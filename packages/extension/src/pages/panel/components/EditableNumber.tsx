import { useState, useEffect, useRef, FC, ChangeEvent, KeyboardEvent } from 'react';
import { useSafeFocus } from '../../../shared/hooks/useSafeFocus';
import { clsx } from 'clsx';

interface EditableNumberProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  title?: string;
  min?: number;
  step?: number;
  suffix?: string;
  className?: string;
}

export const EditableNumber: FC<EditableNumberProps> = ({
  value,
  onChange,
  placeholder = '',
  title = '',
  min = 0,
  step = 100,
  suffix = '',
  className = '',
}) => {
  const [inputValue, setInputValue] = useState<string>(value?.toString() || '');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useSafeFocus(inputRef, { enabled: isEditing });

  useEffect(() => {
    setInputValue(value?.toString() || '');
    setIsEditing(false);
  }, [value]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleBlur = () => {
    setIsEditing(false);
    const trimmedValue = inputValue.trim();

    if (trimmedValue === '') {
      onChange(undefined);
    } else {
      const numValue = parseInt(trimmedValue, 10);
      if (!isNaN(numValue) && numValue >= min) {
        onChange(numValue);
      } else {
        // 恢复原值
        setInputValue(value?.toString() || '');
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      // 恢复原值并退出编辑
      setInputValue(value?.toString() || '');
      setIsEditing(false);
    }
  };

  const displayValue = inputValue || '0';

  if (isEditing) {
    return (
      <div className={clsx(`flex items-center gap-0.5 leading-4 text-2xs ${className}`)}>
        <input
          ref={inputRef}
          type="number"
          min={min}
          step={step}
          value={inputValue}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-12 px-1 py-px rounded border border-blue-500 bg-bg-primary text-text-primary focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          title={title}
        />
        {suffix && <span className="text-text-secondary">{suffix}</span>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setIsEditing(true)}
      className={clsx(
        `px-1.5 py-px leading-4 text-2xs rounded border border-border bg-bg-secondary text-text-primary hover:border-blue-500 transition-colors cursor-pointer ${className}`,
      )}
      title={title}
    >
      {displayValue}
      {suffix}
    </button>
  );
};
