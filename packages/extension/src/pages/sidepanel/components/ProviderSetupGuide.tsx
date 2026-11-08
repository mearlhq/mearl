import type { AgentChatProviderDescriptor } from '@mearl/browser-core';
import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../panel/utils/i18n';
import { QoderLoginActions } from './QoderLoginActions';

interface ProviderSetupGuideProps {
  provider: AgentChatProviderDescriptor;
  installed: boolean;
  onInstall: () => Promise<void>;
  onContinue: () => void;
}

export function ProviderSetupGuide({
  provider,
  installed,
  onInstall,
  onContinue,
}: ProviderSetupGuideProps) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string>();
  const setup = provider.setup;
  if (!setup) return null;
  const handleInstall = async () => {
    setInstalling(true);
    setInstallError(undefined);
    try {
      await onInstall();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  };
  return (
    <section className="min-h-full flex items-center justify-center px-4 py-8 text-xs">
      <div className="w-full max-w-xl">
        <div className="font-medium text-text-primary">
          {installed
            ? t('agentChatSetupInstalled', provider.name)
            : t('agentChatSetupTitle', provider.name)}
        </div>
        {!installed ? (
          <p className="mt-1 text-text-secondary leading-5">
            {setup.canInstall ? t('agentChatSetupManagedDescription') : t('agentChatSetupDescription')}
          </p>
        ) : null}
        {!installed && setup.canInstall && provider.acceptsNewSessions !== false ? (
          <button
            type="button"
            disabled={installing}
            onClick={() => void handleInstall()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {installing
              ? t('agentChatSetupInstalling')
              : t('agentChatSetupInstallProvider', provider.name)}
          </button>
        ) : null}
        {installError ? (
          <p role="alert" className="mt-2 break-words text-red-600 dark:text-red-400">
            {installError}
          </p>
        ) : null}
        {!installed && provider.error ? (
          <div className="mt-2 rounded border border-border bg-bg-primary px-2 py-1.5">
            <div className="text-3xs text-text-secondary">{t('agentChatSetupError')}</div>
            <code className="mt-0.5 block whitespace-pre-wrap break-words text-xxs text-text-primary">
              {provider.error}
            </code>
          </div>
        ) : null}
        <div className="mt-2 space-y-2">
          {!installed && setup.installCommand ? (
            <div>
              <div className="mb-1 text-3xs text-text-secondary">{t('agentChatSetupInstall')}</div>
              <code className="block overflow-x-auto rounded border border-border bg-bg-primary px-2 py-1.5 text-xxs text-text-primary select-all">
                {setup.installCommand}
              </code>
            </div>
          ) : null}
          {installed && provider.id === 'qoder' ? (
            <QoderLoginActions command={setup.loginCommand} />
          ) : setup.loginCommand ? (
            <div>
              <div className="mb-1 text-3xs text-text-secondary">
                {installed ? t('agentChatSetupLoginIfNeeded') : t('agentChatSetupLogin')}
              </div>
              <code className="block overflow-x-auto rounded border border-border bg-bg-primary px-2 py-1.5 text-xxs text-text-primary select-all">
                {setup.loginCommand}
              </code>
            </div>
          ) : null}
        </div>
        {installed ? (
          <button
            type="button"
            onClick={onContinue}
            className="mt-3 rounded-md bg-blue-600 px-2.5 py-1.5 text-white hover:bg-blue-700"
          >
            {t('agentChatSetupContinue')}
          </button>
        ) : setup.docsUrl ? (
          <a
            href={setup.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
          >
            {t('agentChatSetupDocs')}
            <ExternalLink className="w-3 h-3" />
          </a>
        ) : null}
      </div>
    </section>
  );
}
