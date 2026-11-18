import { browserUiText } from '@mearl/preset/bundles';
import { useBrowserUiSettings } from '../../utils/browserUiSettings';
import { getCurrentLanguage } from '../../utils/i18n';
import { FC, useEffect, useId, useRef, useState } from 'react';
import { Flame, Copy, AlertCircle, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../../utils/i18n';
import { copyToClipboard } from '../../utils/clipboard';
import { showToast } from '../../utils/toast';
import {
  formatDsDisplay,
  getYesterdayDs,
  parseDsInput,
  type HeatmapErrorCode,
  type HeatmapMeasure,
  type HeatmapStatus,
} from '../../utils/heatmap';

export interface HeatmapButtonProps {
  pageSpmAB: string | null;
  heatmapMeasures: HeatmapMeasure[];
  heatmapDs: string;
  heatmapStatus: HeatmapStatus;
  heatmapError: string | null;
  heatmapErrorCode: HeatmapErrorCode | null;
  onSelectMeasure: (m: HeatmapMeasure) => void;
  onSelectDs: (ds: string) => void;
}

export const HeatmapButton: FC<HeatmapButtonProps> = ({
  pageSpmAB,
  heatmapMeasures,
  heatmapDs,
  heatmapStatus,
  heatmapError,
  heatmapErrorCode,
  onSelectMeasure,
  onSelectDs,
}) => {
  const settings = useBrowserUiSettings();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setIsOpen(false);
      if (containerRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const heatmapLoading = heatmapStatus === 'loading';
  const heatmapOn = heatmapStatus === 'active' || heatmapLoading;
  const loginRequired = heatmapErrorCode === 'login';
  const loginUrl = settings.links?.heatmap;
  const errorMessage = loginRequired
    ? t('heatmapLoginRequired', loginUrl ? new URL(loginUrl).hostname : t('dataService'))
    : heatmapErrorCode === 'measure_expired'
      ? t('heatmapMeasureExpired')
      : heatmapError;

  return (
    <div ref={containerRef} className="@[640px]:relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(open => !open)}
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        aria-label={t('heatmap')}
        className={clsx(
          'p-0.75 rounded transition-colors flex items-center cursor-pointer',
          heatmapOn
            ? 'bg-orange-500/20 text-orange-600 hover:bg-orange-500/30 dark:text-orange-400'
            : isOpen
              ? 'bg-bg-hover text-text-primary'
              : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
        )}
        title={t('heatmap')}
      >
        {heatmapLoading ? <Loader2 size={14} className="animate-spin" /> : <Flame size={14} />}
      </button>

      {isOpen && (
        <div
          id={popoverId}
          className="absolute right-2 top-full z-50 mt-1 w-80 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-bg-primary text-text-primary shadow-lg @[640px]:right-auto @[640px]:left-0"
        >
          {/* 指标 chips：3 列 × 2 行 */}
          <div className="px-2 pt-2 pb-1.5 grid grid-cols-3 gap-1.5">
            {(settings.heatmap?.measures ?? []).map(definition => {
              const m = definition.id;
              const selected = heatmapMeasures.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => onSelectMeasure(m)}
                  aria-pressed={selected}
                  disabled={!pageSpmAB}
                  className={clsx(
                    'px-1.5 py-1 rounded text-xxs text-center cursor-pointer transition-colors border truncate disabled:cursor-default',
                    selected
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/40 font-medium'
                      : 'bg-bg-secondary text-text-secondary border-transparent enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:opacity-60',
                  )}
                >
                  {browserUiText(definition.label, getCurrentLanguage())}
                </button>
              );
            })}
          </div>

          {/* 错误信息 */}
          {heatmapStatus === 'error' && errorMessage && (
            <div
              className={clsx(
                'flex gap-1.5 px-2 pb-2 text-xs text-red-600 dark:text-red-400',
                loginRequired ? 'items-center' : 'items-start',
              )}
            >
              <AlertCircle size={12} className={clsx('shrink-0', !loginRequired && 'mt-0.5')} />
              {loginRequired ? (
                <span className="truncate" title={errorMessage}>
                  {errorMessage}
                </span>
              ) : (
                <span className="min-w-0 wrap-break-word">{errorMessage}</span>
              )}
              {loginRequired && loginUrl && (
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
                >
                  {t('heatmapOpenLogin')}
                </a>
              )}
            </div>
          )}

          <div className="border-t border-border" />

          {/* 底部一行：左 = AB 点（缺失则提示），右 = 日期输入框 */}
          <div className="px-2 py-1.5 bg-bg-secondary/50 flex items-center justify-between gap-2">
            {pageSpmAB ? (
              <div className="flex min-w-0 items-center gap-1 whitespace-nowrap font-mono text-2xs text-text-secondary">
                <span>{t('heatmapCurrentSpmAB')}:</span>
                <button
                  type="button"
                  className="flex min-w-0 cursor-pointer items-center gap-1 rounded text-text-primary hover:text-blue-600 dark:hover:text-blue-400"
                  title={`${t('copy')} ${pageSpmAB}`}
                  aria-label={`${t('copy')} ${pageSpmAB}`}
                  onClick={async () => {
                    const copied = await copyToClipboard(pageSpmAB);
                    if (copied) showToast(t('heatmapSpmABCopied'), 'success');
                    else showToast(t('copyFailed'), 'error');
                  }}
                >
                  <span className="truncate">{pageSpmAB}</span>
                  <Copy size={11} className="shrink-0" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <span className="truncate text-2xs text-text-secondary" title={t('heatmapNoSpmAB')}>
                {t('heatmapNoSpmAB')}
              </span>
            )}
            <input
              type="date"
              value={formatDsDisplay(heatmapDs)}
              max={formatDsDisplay(getYesterdayDs())}
              disabled={heatmapLoading}
              onChange={e => {
                const parsed = parseDsInput(e.target.value);
                if (parsed) onSelectDs(parsed);
              }}
              title={t('heatmapDataDateTooltip')}
              className="shrink-0 bg-bg-primary border border-border rounded px-1.5 py-0.5 text-2xs text-text-primary font-mono"
            />
          </div>
        </div>
      )}
    </div>
  );
};
