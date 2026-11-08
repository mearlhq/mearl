import { FC } from 'react';
import { EyeOff, Edit3, ChevronUp, TestTube2, Ghost } from 'lucide-react';
import { t } from '../utils/i18n';

interface BottomStatusBarProps {
  /** 当前列表条数，展示在状态栏最左侧 */
  count: number;
  hiddenCount: number;
  modifiedCount: number;
  onExpand: () => void;
  onRequestCasesClick?: () => void;
  showRequestCases?: boolean;
  onImportClick?: () => void;
}

export const BottomStatusBar: FC<BottomStatusBarProps> = ({
  count,
  hiddenCount,
  modifiedCount,
  onExpand,
  onRequestCasesClick,
  showRequestCases = false,
  onImportClick,
}) => {
  return (
    <div className="border-t border-toolbar-border bg-toolbar text-text-secondary px-2 py-1 flex items-center justify-between transition-colors">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* 请求条数 —— 状态栏最左侧，不参与展开点击 */}
        <span className="text-xs tabular-nums whitespace-nowrap">
          {count} {t('requests')}
        </span>
        <div
          className="flex items-center gap-3 text-xs flex-1 cursor-pointer min-h-4.75"
          onClick={onExpand}
        >
          {/* 修改的 API 数量 */}
          {modifiedCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Edit3 size={14} />
              <span>
                {modifiedCount} {t('modified_count')}
              </span>
            </div>
          )}

          {/* 隐藏的 API 数量 */}
          {hiddenCount > 0 && (
            <div className="flex items-center gap-1.5">
              <EyeOff size={14} />
              <span>
                {hiddenCount} {t('blocked')}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* 数据导入按钮 */}
        {onImportClick && (
          <button
            onClick={e => {
              e.stopPropagation();
              onImportClick();
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 text-2xs cursor-pointer rounded transition-colors text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            title={t('requestImportAction')}
          >
            <Ghost size={12} />
            <span>{t('requestImportAction')}</span>
          </button>
        )}

        {/* 请求用例按钮 */}
        {showRequestCases && onRequestCasesClick && (
          <button
            onClick={e => {
              e.stopPropagation();
              onRequestCasesClick();
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 text-2xs cursor-pointer rounded transition-colors bg-blue-600 hover:bg-blue-700 text-white"
            title={t('requestCasesTitle')}
          >
            <TestTube2 size={12} />
            <span>{t('requestCasesButton')}</span>
          </button>
        )}

        <div className="cursor-pointer hover:opacity-70" onClick={onExpand}>
          <ChevronUp size={14} />
        </div>
      </div>
    </div>
  );
};
