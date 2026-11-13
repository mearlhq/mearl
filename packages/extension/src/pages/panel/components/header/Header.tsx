import { FC } from 'react';
import { ArrowLeftRight, Radio, BookText, Book, Webhook, MapPin, Cloud } from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../../utils/i18n';
import { PanelMode } from '../../types';
import { AccountBadge } from './AccountBadge';
import { QuickSettingsMenu } from './QuickSettingsMenu';
import { Banner } from './Banner';
import { SpmOverlayMenu } from './SpmOverlayMenu';
import { HeatmapButton } from './HeatmapButton';
import type { HeatmapErrorCode, HeatmapMeasure, HeatmapStatus } from '../../utils/heatmap';
import { useRemoteConfig } from '../../hooks/useRemoteConfig';

interface HeaderProps {
  inspectedTabId?: number;
  preserveLog: boolean;
  onTogglePreserveLog: () => void;
  modificationEnabled: boolean;
  onToggleModification: () => void;
  mode: PanelMode;
  onSetMode: (mode: PanelMode) => void;
  onShowAgentStatus: () => void;
  agentConnected: boolean;
  cloudConnected?: boolean;
  agentEnabled: boolean;
  onShowSettings: () => void;
  showAllSpm: boolean;
  onToggleShowAllSpm: () => void;
  // 热度数据
  heatmapAvailable: boolean;
  pageSpmAB: string | null;
  heatmapMeasure: HeatmapMeasure;
  heatmapDs: string;
  heatmapStatus: HeatmapStatus;
  heatmapError: string | null;
  heatmapErrorCode: HeatmapErrorCode | null;
  onSelectHeatmapMeasure: (m: HeatmapMeasure) => void;
  onSelectHeatmapDs: (ds: string) => void;
  onToggleHeatmap: () => void;
  accountsEnabled?: boolean;
  onToggleSourceTrace?: () => void;
  sourceTraceActive?: boolean;
}

export const Header: FC<HeaderProps> = ({
  inspectedTabId,
  preserveLog,
  onTogglePreserveLog,
  modificationEnabled,
  onToggleModification,
  mode,
  onSetMode,
  onShowAgentStatus,
  agentConnected,
  cloudConnected = false,
  agentEnabled,
  onShowSettings,
  showAllSpm,
  onToggleShowAllSpm,
  heatmapAvailable,
  pageSpmAB,
  heatmapMeasure,
  heatmapDs,
  heatmapStatus,
  heatmapError,
  heatmapErrorCode,
  onSelectHeatmapMeasure,
  onSelectHeatmapDs,
  onToggleHeatmap,
  accountsEnabled = false,
  onToggleSourceTrace,
  sourceTraceActive = false,
}) => {
  const remoteConfig = useRemoteConfig();
  const integrationTitle = agentConnected
    ? t('mcpIntegrationConnected')
    : t('mcpIntegrationDisconnected');

  return (
    <div className="@container min-w-0 px-2 py-1.5 flex justify-between items-center border-b border-toolbar-border bg-toolbar text-text-primary">
      <div className="flex shrink-0 items-center gap-2">
        <span className="inline-flex items-center text-sm font-medium select-none">Mearl</span>
        {agentEnabled && (
          <button
            onClick={onShowAgentStatus}
            className={clsx(
              'px-1 rounded text-3xs font-semibold -mt-1 -ml-1 cursor-pointer inline-flex items-center gap-0.5',
              agentConnected
                ? 'bg-green-500/20 text-green-600 hover:bg-green-500/30 dark:bg-green-500/30 dark:text-green-400 dark:hover:bg-green-500/40'
                : 'bg-gray-500/20 text-gray-600 hover:bg-gray-500/30 dark:bg-gray-500/30 dark:text-gray-400 dark:hover:bg-gray-500/40',
            )}
            title={integrationTitle}
          >
            {cloudConnected && <Cloud className="w-2.5 h-2.5" />}
            <span>agent</span>
          </button>
        )}
      </div>

      <Banner config={remoteConfig} />

      <div className="flex shrink-0 gap-1.5 items-center text-xs">
        {/* 源码追溯 - picker 找元素对应的接口字段 + 源码 */}
        {onToggleSourceTrace && (
          <button
            onClick={onToggleSourceTrace}
            aria-pressed={sourceTraceActive ?? false}
            className={clsx(
              'p-0.75 rounded transition-colors cursor-pointer',
              sourceTraceActive
                ? 'bg-blue-500/20 text-blue-600 hover:bg-blue-500/30 dark:text-blue-400'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
            )}
            title={t('sourceTraceTip')}
          >
            <MapPin size={14} />
          </button>
        )}

        {/* 热度数据 - icon 按钮，点击切换、悬停展开配置面板（仅 /app/trip 路径下可用） */}
        {mode === 'rum' && heatmapAvailable && (
          <HeatmapButton
            pageSpmAB={pageSpmAB}
            heatmapMeasure={heatmapMeasure}
            heatmapDs={heatmapDs}
            heatmapStatus={heatmapStatus}
            heatmapError={heatmapError}
            heatmapErrorCode={heatmapErrorCode}
            onSelectMeasure={onSelectHeatmapMeasure}
            onSelectDs={onSelectHeatmapDs}
            onToggleHeatmap={onToggleHeatmap}
          />
        )}

        {/* 保留日志 */}
        <button
          onClick={onTogglePreserveLog}
          className={clsx(
            'px-1.5 py-0.5 rounded transition-colors cursor-pointer flex items-center justify-center gap-1 @[640px]:min-w-21',
            preserveLog
              ? 'bg-blue-500/20 text-blue-600 hover:bg-blue-500/30 dark:text-blue-400'
              : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
          title={t('preserveLog')}
        >
          {preserveLog ? <BookText size={14} /> : <Book size={14} />}
          <span className="hidden @[640px]:inline">{t('preserveLog')}</span>
        </button>

        {/* 修改响应 */}
        {mode === 'protocol' && (
          <button
            onClick={onToggleModification}
            className={clsx(
              'px-1.5 py-0.5 rounded transition-colors cursor-pointer flex items-center justify-center gap-1 @[640px]:min-w-21',
              modificationEnabled
                ? 'bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30 dark:text-yellow-400'
                : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
            title={t('enableResponseModification')}
          >
            <Webhook size={14} />
            <span className="hidden @[640px]:inline">{t('modify')}</span>
          </button>
        )}

        {/* 高亮 SPM */}
        {mode === 'rum' && (
          <SpmOverlayMenu showAllSpm={showAllSpm} onToggleShowAllSpm={onToggleShowAllSpm} />
        )}

        {/* 埋点验证/接口调试 模式切换 */}
        <button
          onClick={() => onSetMode(mode === 'protocol' ? 'rum' : 'protocol')}
          className="px-1.5 py-0.5 rounded transition-colors flex items-center justify-center gap-1 cursor-pointer text-text-secondary hover:text-text-primary hover:bg-bg-hover @[640px]:min-w-21"
          title={t('switchMode')}
        >
          {mode === 'protocol' ? <Radio size={14} /> : <ArrowLeftRight size={14} />}
          <span className="hidden @[640px]:inline">
            {mode === 'protocol' ? t('modeRumVerify') : t('modeApiDebug')}
          </span>
        </button>
        {/* 账号切换徽章，放在最右侧、设置按钮左边；紧贴右侧边缘，故下拉面板右对齐徽章、向左展开 */}
        {accountsEnabled && <AccountBadge showRequestCountToggle={false} dropdownAlign="default" />}
        <QuickSettingsMenu
          inspectedTabId={inspectedTabId}
          onShowSettings={onShowSettings}
          remoteConfig={remoteConfig}
        />
      </div>
    </div>
  );
};
