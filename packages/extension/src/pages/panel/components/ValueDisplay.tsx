import { FC } from 'react';

interface ValueDisplayProps {
  value: any;
  colored?: boolean;
}

/**
 * 显示值的组件，支持各种数据类型的格式化显示
 */
export const ValueDisplay: FC<ValueDisplayProps> = ({ value, colored = false }) => {
  const getDisplayText = (val: any): string => {
    if (val === null || val === undefined) {
      return 'null';
    }

    if (Array.isArray(val)) {
      return `[${val.length} items]`;
    }

    if (typeof val === 'object') {
      const keys = Object.keys(val);
      return `{${keys.length} keys}`;
    }

    if (typeof val === 'string') {
      const displayValue = val.length > 100 ? `${val.substring(0, 100)}...` : val;
      return `"${displayValue}"`;
    }

    if (typeof val === 'number' || typeof val === 'boolean') {
      return String(val);
    }

    return String(val);
  };

  const displayText = getDisplayText(value);

  if (!colored) {
    return <span className="text-text-secondary whitespace-nowrap">{displayText}</span>;
  }

  // 根据类型添加颜色
  if (value === null || value === undefined || typeof value === 'object') {
    return <span className="text-text-secondary whitespace-nowrap">{displayText}</span>;
  }

  if (typeof value === 'string') {
    return <span className="text-green-500 whitespace-nowrap">{displayText}</span>;
  }

  if (typeof value === 'number') {
    return <span className="text-blue-500 whitespace-nowrap">{displayText}</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="text-purple-500 whitespace-nowrap">{displayText}</span>;
  }

  return <span className="whitespace-nowrap">{displayText}</span>;
};
