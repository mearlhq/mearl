import { FC } from 'react';
import {
  calculateByteSize,
  formatBytes,
  getContentEncoding,
  parseContentLength,
} from '../../utils/helpers';
import { t } from '../../utils/i18n';

interface BodySizeDisplayProps {
  headers?: Array<{ name: string; value: string }>;
  size?: number;
  data?: any;
  label?: string;
}

export const BodySizeDisplay: FC<BodySizeDisplayProps> = ({ headers, size, data, label }) => {
  const contentLength = parseContentLength(headers);
  const hasNetworkSize = size !== undefined || contentLength !== undefined;
  const displaySize = size ?? contentLength ?? calculateByteSize(data);
  const contentEncoding = getContentEncoding(headers);
  const encodingLabel = hasNetworkSize
    ? contentEncoding === 'gzip'
      ? t('gzipSize')
      : contentEncoding
    : undefined;

  if (
    displaySize === 0 &&
    size === undefined &&
    data === undefined &&
    (!headers || headers.length === 0)
  ) {
    return null;
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 rounded text-2xs leading-4.5 bg-bg-secondary text-text-secondary border border-border"
      title={label || t('headersSize')}
    >
      <span className="text-text-primary font-medium">{formatBytes(displaySize)}</span>
      {encodingLabel && <span className="text-3xs">({encodingLabel})</span>}
    </span>
  );
};

interface SizeDisplayProps {
  size?: number;
  data?: any;
  label?: string;
}

export const SizeDisplay: FC<SizeDisplayProps> = ({ size, data, label }) => {
  const displaySize = size !== undefined ? size : calculateByteSize(data);

  return (
    <span
      className="inline-flex items-center px-1.5 rounded text-2xs leading-4.5 bg-bg-secondary text-text-secondary border border-border"
      title={label || t('headersSize')}
    >
      <span className="text-text-primary font-medium">{formatBytes(displaySize)}</span>
    </span>
  );
};
