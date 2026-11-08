import { FC } from 'react';
import { EyeOff, Edit3, ChevronDown, Ban, TestTube2, Ghost, Filter } from 'lucide-react';
import { t } from '../utils/i18n';

interface ModifiedApi {
  id: string;
  apiName: string;
  sceneComment?: string;
  hasConditions?: boolean;
}

interface StatusPanelProps {
  /** 当前列表条数，展示在状态栏最左侧 */
  count: number;
  hiddenApis: string[];
  modifiedApis: ModifiedApi[];
  onShow: (apiName: string) => void;
  onRemoveOverride: (apiName: string, id: string) => void;
  onRemoveAllOverrides: () => void;
  onEdit: (id: string) => void;
  onCollapse: () => void;
  onRequestCasesClick?: () => void;
  showRequestCases?: boolean;
  onImportClick?: () => void;
  /** 是否展示每条 mock 的编辑按钮；真机抓包场景仅做清理管理，不提供编辑 */
  showEdit?: boolean;
}

export const StatusPanel: FC<StatusPanelProps> = ({
  count,
  hiddenApis,
  modifiedApis,
  onShow,
  onRemoveOverride,
  onRemoveAllOverrides,
  onEdit,
  onCollapse,
  onRequestCasesClick,
  showRequestCases = false,
  onImportClick,
  showEdit = true,
}) => {
  return (
    <div className="border-t border-toolbar-border shadow-lg bg-bg-primary">
      {/* 使用与收起状态相同的样式 */}
      <div className="px-2 py-1 flex items-center justify-between transition-colors bg-toolbar border-toolbar-border text-text-secondary">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* 请求条数 —— 状态栏最左侧，不参与收起点击 */}
          <span className="text-xs tabular-nums whitespace-nowrap">
            {count} {t('requests')}
          </span>
          <div
            className="flex items-center gap-3 text-xs cursor-pointer flex-1 min-h-4.75"
            onClick={onCollapse}
          >
            {/* 修改的 API 数量 */}
            {modifiedApis.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Edit3 size={14} />
                <span>
                  {modifiedApis.length} {t('modified_count')}
                </span>
              </div>
            )}

            {/* 隐藏的 API 数量 */}
            {hiddenApis.length > 0 && (
              <div className="flex items-center gap-1.5">
                <EyeOff size={14} />
                <span>
                  {hiddenApis.length} {t('blocked')}
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

          {/* 收起箭头 */}
          <div className="cursor-pointer hover:opacity-70" onClick={onCollapse}>
            <ChevronDown size={14} />
          </div>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="px-2 py-2 max-h-48 overflow-y-auto">
        {/* 已修改的 API 列表 */}
        {modifiedApis.length > 0 && (
          <div className={hiddenApis.length > 0 ? 'mb-3' : ''}>
            <div className="flex items-center justify-between mb-1.5 px-1">
              <span className="text-xs font-medium text-text-secondary">{t('modified_count')}</span>
              <button
                onClick={onRemoveAllOverrides}
                className="px-1.5 py-0.5 rounded transition-colors text-2xs text-red-500 hover:bg-red-600 hover:text-white"
                title={t('removeAllOverrides')}
              >
                {t('removeAllOverrides')}
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {modifiedApis.map(api => (
                <div
                  key={api.id}
                  className="flex items-center justify-between px-2 py-1 rounded text-xs bg-bg-secondary text-text-primary"
                >
                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="font-mono truncate text-xxs">{api.apiName}</span>
                      {api.hasConditions && <Filter size={10} className="shrink-0 text-blue-500" />}
                    </div>
                    {api.sceneComment && (
                      <span className="truncate text-2xs text-text-secondary mt-0.5">
                        {api.sceneComment}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1 ml-2 shrink-0">
                    {showEdit && (
                      <button
                        onClick={() => onEdit(api.id)}
                        className="px-1.5 py-0.5 rounded transition-colors bg-blue-600 hover:bg-blue-700 text-white text-2xs"
                        title={t('edit')}
                      >
                        {t('edit')}
                      </button>
                    )}
                    <button
                      onClick={() => onRemoveOverride(api.apiName, api.id)}
                      className="px-1.5 py-0.5 rounded transition-colors bg-red-600 hover:bg-red-700 text-white text-2xs"
                    >
                      {t('remove')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 隐藏的 API 列表 */}
        {hiddenApis.length > 0 && (
          <div>
            <div className="text-xs font-medium mb-1.5 px-1 text-text-secondary">
              {t('blockedApis')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {hiddenApis.map(api => (
                <div
                  key={api}
                  className="flex items-center justify-between px-2 py-1 rounded text-xs bg-bg-secondary text-text-primary"
                >
                  <span className="font-mono truncate flex-1 text-xxs">{api}</span>
                  <button
                    onClick={() => onShow(api)}
                    className="ml-2 px-1.5 py-0.5 rounded transition-colors shrink-0 bg-red-600 hover:bg-red-700 text-white text-2xs"
                  >
                    {t('unblockApi')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 空状态 */}
        {hiddenApis.length === 0 && modifiedApis.length === 0 && (
          <div className="text-center py-8 px-4 text-text-secondary">
            <Ban size={48} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium mb-1">{t('emptyListGuide')}</p>
            <p className="text-xs opacity-75">{t('emptyListGuideDescription')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
