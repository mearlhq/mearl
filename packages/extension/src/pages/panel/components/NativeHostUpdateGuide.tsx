import { setupCommand } from '../../../shared/extensionVersion';
import { PackageOpen } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { t } from '../utils/i18n';

export interface NativeHostUpdateInfo {
  extensionVersion: string;
  nativeHostVersion: string | null;
  reason: 'not-connected' | 'unsupported-capability';
}

interface NativeHostUpdateGuideProps {
  context: 'sidepanel' | 'browser-manager' | 'toolbox';
  update: NativeHostUpdateInfo;
  retry: () => Promise<void>;
}

export function NativeHostUpdateGuide({ context, update, retry }: NativeHostUpdateGuideProps) {
  const isInstall = update.reason === 'not-connected';
  const command = setupCommand(update.extensionVersion) + (isInstall ? '' : ' update --local');
  const description =
    context === 'toolbox'
      ? isInstall
        ? t('toolboxNativeHostInstallDescription')
        : t('toolboxNativeHostUpdateDescription')
      : isInstall
        ? context === 'browser-manager'
          ? t('browserManagerNativeHostInstallDescription')
          : t('agentChatNativeHostInstallDescription')
        : context === 'browser-manager'
          ? t('browserManagerNativeHostUpdateDescription')
          : t('agentChatNativeHostUpdateDescription');
  return (
    <section className="flex min-h-full items-center justify-center px-4 py-8 text-xs">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <PackageOpen className="h-5 w-5" />
        </div>
        <h2 className="mt-3 text-sm font-medium text-text-primary">
          {isInstall ? t('agentChatNativeHostInstallTitle') : t('agentChatNativeHostUpdateTitle')}
        </h2>
        <p className="mx-auto mt-1 max-w-sm leading-5 text-text-secondary">{description}</p>

        <div className="mt-4 rounded-lg border border-border/50 bg-bg-secondary/40 p-3 text-left">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-3xs text-text-secondary">{t('agentChatExtensionVersion')}</dt>
              <dd className="mt-0.5 font-mono text-xxs text-text-primary">
                {update.extensionVersion}
              </dd>
            </div>
            <div>
              <dt className="text-3xs text-text-secondary">{t('agentChatNativeHostVersion')}</dt>
              <dd className="mt-0.5 font-mono text-xxs text-text-primary">
                {update.nativeHostVersion || t('agentChatNativeHostVersionUnknown')}
              </dd>
            </div>
          </dl>

          <div className="mt-3">
            <div className="mb-1 text-3xs text-text-secondary">
              {t('agentChatNativeHostUpdateCommand')}
            </div>
            <div className="flex items-center gap-1 rounded-md border border-border/50 bg-bg-primary px-2 py-1.5">
              <code className="min-w-0 flex-1 break-all whitespace-normal text-xxs text-text-primary select-all">
                {command}
              </code>
              <CopyButton text={command} iconOnly size="sm" />
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void retry()}
          className="mt-3 inline-flex h-7 cursor-pointer items-center justify-center rounded-md bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700"
        >
          {isInstall ? t('agentChatNativeHostInstallReconnect') : t('agentChatNativeHostReconnect')}
        </button>
        <p className="mt-1.5 text-3xs text-text-secondary">
          {isInstall
            ? t('agentChatNativeHostInstallReconnectHint')
            : t('agentChatNativeHostReconnectHint')}
        </p>
      </div>
    </section>
  );
}
