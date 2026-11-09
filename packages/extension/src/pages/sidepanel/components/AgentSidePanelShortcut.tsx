import { agentSidePanelShortcutLabel } from '../../../shared/agentSidePanelState';
import { t } from '../../panel/utils/i18n';

interface AgentSidePanelShortcutProps {
  disabled?: boolean;
  onClick: () => void;
}

export function AgentSidePanelShortcut({ disabled, onClick }: AgentSidePanelShortcutProps) {
  const label = t('openAgentSidePanelFromPage');
  const shortcut = agentSidePanelShortcutLabel(navigator.platform);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={`${label} (${shortcut})`}
      className="min-w-0 break-words rounded border border-border bg-bg-primary px-1 py-0.5 text-left text-text-secondary/80 transition-colors cursor-pointer hover:bg-bg-hover hover:text-text-primary focus-visible:ring-1 focus-visible:ring-accent-blue disabled:cursor-not-allowed disabled:opacity-40"
    >
      {shortcut} {t('agentChatSidePanelLabel')}
    </button>
  );
}
