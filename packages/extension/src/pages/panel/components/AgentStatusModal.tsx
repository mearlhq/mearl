import { setupManagementCommand } from '@mearl/preset';
import { getExtensionVersion, setupCommand } from '../../../shared/extensionVersion';
import { FC, useState, useEffect } from 'react';
import { CheckCircle, ExternalLink, Link, Link2Off, Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalContent, ModalFooter } from './modal';
import { t } from '../utils/i18n';
import { CopyButton } from './CopyButton';
import {
  DEFAULT_EXTENSION_ID,
  MEARL_DOC_URL,
  AGENT_INTEGRATION_MODE_STORAGE_KEY,
} from '../../../shared/constants';
import { clsx } from 'clsx';
import { useCloudConnectorStatus } from '../hooks/useCloudConnectorStatus';
import { getConfig, updateConfig } from '../utils/config';
import { showToast } from '../utils/toast';
import { useBrowserUiSettings, useSetupManagement } from '../utils/browserUiSettings';
import { extractCloudConnectorUrl } from '../utils/cloudConnectorInput';

interface AgentStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentConnected: boolean;
  currentRequestSubMode?: 'protocol' | 'requests';
  effectiveRequestSubMode?: 'protocol' | 'requests';
  /** 是否隐藏连接状态指示器 */
  hideConnectionStatus?: boolean;
  /** 弹窗尺寸 */
  size?: 'default' | 'fullscreen';
}

const CapBadge: FC<{ children: string }> = ({ children }) => (
  <span className="inline-block rounded-full bg-bg-secondary px-1.5 py-0 text-text-secondary leading-4">
    {children}
  </span>
);

const AgentCapabilities: FC = () => (
  <div className="space-y-1">
    <p className="font-medium text-text-primary">{t('agentAllCapabilities')}</p>
    <div className="text-2xs">
      <div className="grid grid-cols-[5rem_1fr] gap-x-2 border-b border-border py-1.5">
        <div className="text-text-secondary font-medium whitespace-nowrap leading-4">
          {t('agentCapCategoryData')}
        </div>
        <div className="flex flex-wrap gap-x-1 gap-y-0 leading-4">
          <CapBadge>{t('agentCapGetRequests')}</CapBadge>
          <CapBadge>{t('agentCapGetLogs')}</CapBadge>
          <CapBadge>{t('agentCapGetEvents')}</CapBadge>
          <CapBadge>{t('agentCapGetSelectedElement')}</CapBadge>
          <CapBadge>{t('agentCapGetScreenshot')}</CapBadge>
        </div>
      </div>
      <div className="grid grid-cols-[5rem_1fr] gap-x-2 border-b border-border py-1.5">
        <div className="text-text-secondary font-medium whitespace-nowrap leading-4">
          {t('agentCapCategoryMock')}
        </div>
        <div className="flex flex-wrap gap-x-1 gap-y-0 leading-4">
          <CapBadge>{t('agentCapSetMock')}</CapBadge>
          <CapBadge>{t('agentCapGetMocks')}</CapBadge>
          <CapBadge>{t('agentCapAddRule')}</CapBadge>
          <CapBadge>{t('agentCapProxyRequest')}</CapBadge>
          <CapBadge>{t('agentCapSendCapturedRequest')}</CapBadge>
        </div>
      </div>
      <div className="grid grid-cols-[5rem_1fr] gap-x-2 pt-1.5">
        <div className="text-text-secondary font-medium whitespace-nowrap leading-4">
          {t('agentCapCategoryBrowser')}
        </div>
        <div className="flex flex-wrap gap-x-1 gap-y-0 leading-4">
          <CapBadge>{t('agentCapTabManage')}</CapBadge>
          <CapBadge>{t('agentCapPageNavigate')}</CapBadge>
          <CapBadge>{t('agentCapPageSnapshot')}</CapBadge>
          <CapBadge>{t('agentCapPageClick')}</CapBadge>
          <CapBadge>{t('agentCapPageType')}</CapBadge>
          <CapBadge>{t('agentCapPagePress')}</CapBadge>
          <CapBadge>{t('agentCapPageScroll')}</CapBadge>
          <CapBadge>{t('agentCapPageEval')}</CapBadge>
          <CapBadge>{t('agentCapPageWait')}</CapBadge>
          <CapBadge>{t('agentCapPageUpload')}</CapBadge>
          <CapBadge>{t('agentCapPageFrames')}</CapBadge>
          <CapBadge>{t('agentCapSetDeviceEmulation')}</CapBadge>
        </div>
      </div>
    </div>
  </div>
);

const version = getExtensionVersion();
const MCP_SETUP_BASE_COMMAND = `npx @mearl/mcp-server${version.includes('-beta.') ? '@beta' : ''} configure`;

export const AgentStatusModal: FC<AgentStatusModalProps> = ({
  isOpen,
  onClose,
  agentConnected,
  hideConnectionStatus,
  size = 'default',
}) => {
  const settings = useBrowserUiSettings();
  const setup = useSetupManagement();
  const skillCliCommand = setup ? setupManagementCommand(setup) : setupCommand();
  const skillAgentPrompt = t('skillSetupAgentPrompt', settings.links?.skillSetup ?? MEARL_DOC_URL);
  const [extensionId, setExtensionId] = useState<string>(DEFAULT_EXTENSION_ID);
  const shouldShowExtensionId = extensionId !== DEFAULT_EXTENSION_ID;
  const mcpSetupCommand = shouldShowExtensionId
    ? `${MCP_SETUP_BASE_COMMAND} --id=${extensionId}`
    : MCP_SETUP_BASE_COMMAND;
  const [skillSetupMode, setSkillSetupMode] = useState<'cli' | 'agent' | 'cloud'>('cli');
  const [integrationMode, setIntegrationMode] = useState<'mcp' | 'skills'>(() => {
    try {
      const saved = localStorage.getItem(AGENT_INTEGRATION_MODE_STORAGE_KEY);
      return (saved === 'mcp' ? 'mcp' : 'skills') as 'mcp' | 'skills';
    } catch {
      return 'skills';
    }
  });

  const [cloudServerUrl, setCloudServerUrl] = useState<string>('');
  const {
    state: cloudState,
    loading: cloudLoading,
    startConnector,
    stopConnector,
  } = useCloudConnectorStatus(isOpen);

  useEffect(() => {
    // 获取当前扩展 ID
    try {
      const id = chrome.runtime.id;
      setExtensionId(id);
    } catch {}

    // 加载 cloud server 配置
    getConfig().then(config => {
      if (config.cloudServerUrl) {
        setCloudServerUrl(config.cloudServerUrl);
      }
    });
  }, []);

  useEffect(() => {
    if (!cloudState.connected || !cloudState.serverUrl || cloudState.serverUrl === cloudServerUrl) {
      return;
    }

    setCloudServerUrl(cloudState.serverUrl);
    updateConfig({ cloudServerUrl: cloudState.serverUrl }).catch(() => {});
  }, [cloudState.connected, cloudState.serverUrl, cloudServerUrl]);

  useEffect(() => {
    // 持久化保存 WebSocket 地址（连接态由连接逻辑负责保存，初始空值不覆盖已存配置）
    if (cloudState.connected) {
      return;
    }
    const trimmed = cloudServerUrl.trim();
    if (!trimmed) {
      return;
    }
    const timer = setTimeout(() => {
      updateConfig({ cloudServerUrl: trimmed }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [cloudServerUrl, cloudState.connected]);

  const handleModeChange = (mode: 'mcp' | 'skills') => {
    setIntegrationMode(mode);
    try {
      localStorage.setItem(AGENT_INTEGRATION_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  };

  const handleCloudConnectToggle = async () => {
    if (cloudState.connected && cloudState.serverUrl) {
      const result = await stopConnector(cloudState.serverUrl);
      if (result.success) {
        showToast(t('cloudConnectorDisconnectSuccess'), 'success');
      } else {
        showToast(t('cloudConnectorDisconnectFailed', result.error || ''), 'error');
      }
    } else if (cloudServerUrl.trim()) {
      const result = await startConnector(cloudServerUrl.trim());
      if (result.success) {
        await updateConfig({ cloudServerUrl: cloudServerUrl.trim() });
        showToast(t('cloudConnectorConnectSuccess'), 'success');
      } else {
        showToast(t('cloudConnectorConnectFailed', result.error || ''), 'error');
      }
    }
  };

  const displayedCloudServerUrl =
    cloudState.connected && cloudState.serverUrl ? cloudState.serverUrl : cloudServerUrl;
  const cloudProcessLabel = [cloudState.name, cloudState.pid ? `PID: ${cloudState.pid}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Modal
        size={size}
        isOpen={isOpen}
        onClose={onClose}
        contentStyle={size === 'default' ? { maxHeight: '90vh' } : undefined}
      >
        <ModalHeader
          title={
            <div className="flex items-center gap-2">
              <span>{t('mcpIntegration')}</span>
              {!hideConnectionStatus && (
                <div className="flex items-center gap-1.5">
                  <div
                    className={clsx(
                      `w-1.5 h-1.5 rounded-full transition-colors ${agentConnected ? 'bg-green-500' : 'bg-gray-400'}`,
                    )}
                  />
                  <span
                    className={clsx(
                      `text-2xs transition-colors ${agentConnected ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`,
                    )}
                  >
                    {agentConnected ? t('mcpConnected') : t('mcpDisconnected')}
                  </span>
                </div>
              )}
            </div>
          }
          onClose={onClose}
        />

        {/* 集成方式切换标签页 */}
        <div className="flex items-center border-b border-border bg-bg-secondary px-2">
          <button
            onClick={() => handleModeChange('skills')}
            className={clsx(
              `px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                integrationMode === 'skills'
                  ? 'border-blue-500 text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`,
            )}
          >
            Skills
          </button>
          <button
            onClick={() => handleModeChange('mcp')}
            className={clsx(
              `px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                integrationMode === 'mcp'
                  ? 'border-blue-500 text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`,
            )}
          >
            MCP
          </button>
        </div>

        <ModalContent>
          <div className="space-y-2.5 text-xs">
            <p className="text-text-secondary">
              {integrationMode === 'skills' && skillSetupMode === 'cloud'
                ? t('cloudModeDescription')
                : t('agentDescription')}
            </p>
            {/* Tab 切换部分：配置入口 */}
            <div>
              {integrationMode === 'mcp' ? (
                <div className="space-y-2">
                  <div className="flex items-center min-h-5">
                    <p className="font-medium text-text-primary">{t('mcpQuickSetup')}</p>
                    <p className="text-text-secondary text-xxs leading-none ml-1">
                      ({t('mcpSetupHint')})
                    </p>
                  </div>
                  <div className="bg-bg-primary rounded border border-border p-2.5 font-mono text-xs flex items-center justify-between">
                    <code className="text-text-primary break-all">{mcpSetupCommand}</code>
                    <CopyButton text={mcpSetupCommand} iconOnly size="sm" />
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 min-h-5">
                    <p className="font-medium text-text-primary">{t('skillQuickSetup')}</p>
                    <div className="flex items-center rounded border border-border overflow-hidden text-2xs leading-none">
                      <button
                        type="button"
                        onClick={() => setSkillSetupMode('cli')}
                        className={clsx(
                          'px-2 py-1 transition-colors cursor-pointer',
                          skillSetupMode === 'cli'
                            ? 'bg-accent-bg text-text-primary font-medium'
                            : 'text-text-secondary hover:text-text-primary',
                        )}
                      >
                        {t('skillSetupCli')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSkillSetupMode('agent')}
                        className={clsx(
                          'px-2 py-1 border-l border-border transition-colors cursor-pointer',
                          skillSetupMode === 'agent'
                            ? 'bg-accent-bg text-text-primary font-medium'
                            : 'text-text-secondary hover:text-text-primary',
                        )}
                      >
                        {t('skillSetupAgent')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSkillSetupMode('cloud')}
                        className={clsx(
                          'flex items-center gap-1 px-2 py-1 border-l border-border transition-colors cursor-pointer',
                          skillSetupMode === 'cloud'
                            ? 'bg-accent-bg text-text-primary font-medium'
                            : 'text-text-secondary hover:text-text-primary',
                        )}
                      >
                        {t('cloudConnections')}
                        {cloudState.connected && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-green-500"
                            title={t('connected')}
                          />
                        )}
                      </button>
                    </div>
                    {skillSetupMode === 'cloud' && cloudProcessLabel && (
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-2xs text-text-secondary leading-none"
                        title={cloudProcessLabel}
                      >
                        {cloudProcessLabel}
                      </span>
                    )}
                  </div>
                  {skillSetupMode === 'cloud' ? (
                    <div className="bg-bg-primary rounded border border-border p-2.5 font-mono text-xs flex items-center justify-between gap-2">
                      <input
                        type="text"
                        value={displayedCloudServerUrl}
                        readOnly={cloudState.connected}
                        onChange={e => setCloudServerUrl(extractCloudConnectorUrl(e.target.value))}
                        placeholder={t('cloudServerPlaceholder')}
                        className={clsx(
                          'min-w-0 flex-1 bg-transparent text-text-primary placeholder:text-text-secondary focus:outline-none',
                          cloudState.connected && 'cursor-default',
                        )}
                      />
                      <button
                        type="button"
                        onClick={handleCloudConnectToggle}
                        disabled={cloudLoading || (cloudState.connected && !cloudState.serverUrl)}
                        className="p-1 hover:bg-bg-secondary rounded transition-colors shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
                        title={cloudState.connected ? t('disconnect') : t('connect')}
                      >
                        {cloudLoading ? (
                          <Loader2 className="w-3 h-3 text-text-secondary animate-spin" />
                        ) : cloudState.connected ? (
                          <Link2Off className="w-3 h-3 text-red-500" />
                        ) : (
                          <Link className="w-3 h-3 text-blue-500" />
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="bg-bg-primary rounded border border-border p-2.5 font-mono text-xs flex items-center justify-between gap-2">
                      <code
                        className={clsx(
                          'min-w-0 flex-1 text-text-primary',
                          skillSetupMode === 'cli' ? 'whitespace-normal break-all' : 'truncate',
                        )}
                      >
                        {skillSetupMode === 'cli' ? skillCliCommand : skillAgentPrompt}
                      </code>
                      <CopyButton
                        text={skillSetupMode === 'cli' ? skillCliCommand : skillAgentPrompt}
                        iconOnly
                        size="sm"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 对话示例 */}
            <div className="flex gap-3">
              <div className="flex-1 space-y-2">
                <p className="font-medium text-text-primary">{t('agentCapabilities')}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="flex items-center gap-1.5 text-text-secondary">
                    <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{t('agentExample1')}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-text-secondary">
                    <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{t('agentExample2')}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-text-secondary">
                    <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{t('agentExample3')}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-text-secondary">
                    <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{t('agentExample4')}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-text-secondary col-span-2">
                    <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{t('agentExample5')}</span>
                  </div>
                </div>
              </div>
            </div>

            <AgentCapabilities />
          </div>
        </ModalContent>
        <ModalFooter>
          <a
            href={settings.links?.agentDocs ?? MEARL_DOC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-1 text-xs text-blue-500 transition-colors hover:text-blue-600"
          >
            <ExternalLink className="w-3 h-3" />
            {t('agentFullDocs')}
          </a>
        </ModalFooter>
      </Modal>
    </>
  );
};
