import { browserUiText } from '@mearl/preset/bundles';
import { useBrowserUiSettings } from '../../utils/browserUiSettings';
import { getCurrentLanguage } from '../../utils/i18n';
import { FC, useRef } from 'react';
import { useDelayedHover } from '../../../../shared/hooks/useDelayedHover';
import { Flame, LogIn, AlertCircle, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../../utils/i18n';
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
  heatmapMeasure: HeatmapMeasure;
  heatmapDs: string;
  heatmapStatus: HeatmapStatus;
  heatmapError: string | null;
  heatmapErrorCode: HeatmapErrorCode | null;
  onSelectMeasure: (m: HeatmapMeasure) => void;
  onSelectDs: (ds: string) => void;
  onToggleHeatmap: () => void;
}

const SHOW_DELAY = 180;
const HIDE_DELAY = 220;

export const HeatmapButton: FC<HeatmapButtonProps> = ({
  pageSpmAB,
  heatmapMeasure,
  heatmapDs,
  heatmapStatus,
  heatmapError,
  heatmapErrorCode,
  onSelectMeasure,
  onSelectDs,
  onToggleHeatmap,
}) => {
  const settings = useBrowserUiSettings();
  const {
    open: isOpen,
    scheduleOpen: scheduleShow,
    scheduleClose,
    cancelOpen,
    cancelClose: cancelHide,
  } = useDelayedHover({ openDelay: SHOW_DELAY, closeDelay: HIDE_DELAY });
  // 原生 date picker 位于 body 上，输入框聚焦时保持菜单展开供日期选择。
  const dateInputFocusedRef = useRef(false);

  const scheduleHide = () => {
    if (dateInputFocusedRef.current) {
      cancelOpen();
      cancelHide();
      return;
    }
    scheduleClose();
  };

  const heatmapActive = heatmapStatus === 'active';
  const heatmapLoading = heatmapStatus === 'loading';
  const heatmapToggleDisabled = !pageSpmAB || heatmapLoading;
  const heatmapOn = heatmapActive || heatmapLoading;

  return (
    <div className="relative" onMouseEnter={scheduleShow} onMouseLeave={scheduleHide}>
      <button
        onClick={onToggleHeatmap}
        disabled={heatmapToggleDisabled}
        className={clsx(
          'p-0.75 rounded transition-colors flex items-center',
          heatmapOn
            ? 'bg-orange-500/20 text-orange-600 hover:bg-orange-500/30 dark:text-orange-400'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          heatmapToggleDisabled
            ? heatmapLoading
              ? 'cursor-wait'
              : 'cursor-not-allowed opacity-60'
            : 'cursor-pointer',
        )}
        title={!pageSpmAB ? t('heatmapNoSpmAB') : t('heatmap')}
      >
        {heatmapLoading ? <Loader2 size={14} className="animate-spin" /> : <Flame size={14} />}
      </button>

      {isOpen && (
        <div
          className="absolute left-0 top-full mt-1 z-50 w-80 rounded-md border border-border bg-bg-primary shadow-lg text-text-primary"
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          {/* 指标 chips：3 列 × 2 行 */}
          <div className="px-2 pt-2 pb-1.5 grid grid-cols-3 gap-1.5">
            {(settings.heatmap?.measures ?? []).map(definition => {
              const m = definition.id;
              const selected = m === heatmapMeasure;
              return (
                <button
                  key={m}
                  onClick={() => onSelectMeasure(m)}
                  className={clsx(
                    'px-1.5 py-1 rounded text-xxs text-center cursor-pointer transition-colors border truncate',
                    selected
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/40 font-medium'
                      : 'bg-bg-secondary text-text-secondary border-transparent hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {browserUiText(definition.label, getCurrentLanguage())}
                </button>
              );
            })}
          </div>

          {/* 错误信息 */}
          {heatmapStatus === 'error' && heatmapError && (
            <div className="px-2 pb-2.5 -mt-1">
              <div className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div>
                    {heatmapErrorCode === 'login'
                      ? t('heatmapLoginRequired', settings.links?.heatmap ? new URL(settings.links.heatmap).hostname : t('dataService'))
                      : heatmapErrorCode === 'measure_expired'
                        ? t('heatmapMeasureExpired')
                        : heatmapError}
                  </div>
                  {heatmapErrorCode === 'login' && settings.links?.heatmap && (
                    <button
                      onClick={() => window.open(settings.links!.heatmap, '_blank')}
                      className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline cursor-pointer"
                    >
                      <LogIn size={11} />
                      {t('heatmapOpenLogin')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-border" />

          {/* 底部一行：左 = AB 点（缺失则提示），右 = 日期输入框 */}
          <div className="px-2 py-1.5 bg-bg-secondary/50 flex items-center justify-between gap-2">
            <span
              className="text-2xs text-text-secondary font-mono truncate"
              title={!pageSpmAB ? t('heatmapNoSpmAB') : undefined}
            >
              {pageSpmAB ? (
                <>
                  {t('heatmapCurrentSpmAB')}: <span className="text-text-primary">{pageSpmAB}</span>
                </>
              ) : (
                <span className="opacity-70">{t('heatmapNoSpmAB')}</span>
              )}
            </span>
            <input
              type="date"
              value={formatDsDisplay(heatmapDs)}
              max={formatDsDisplay(getYesterdayDs())}
              onChange={e => {
                const parsed = parseDsInput(e.target.value);
                if (parsed) onSelectDs(parsed);
              }}
              onFocus={() => {
                // 原生 date picker 浮在 body 上、不属于本菜单的 mouseenter 区域；
                // input 取得焦点期间锁住菜单，避免鼠标移到 picker 时被 scheduleHide 关掉
                dateInputFocusedRef.current = true;
                cancelHide();
              }}
              onBlur={() => {
                dateInputFocusedRef.current = false;
                scheduleHide();
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
