import { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { getCurrentLanguage, initI18n, t } from '../panel/utils/i18n';
import { onConfigChange } from '../panel/utils/config';
import { requestToolbox } from '../popup/toolboxRequest';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import type { ToolboxToolOpenResult } from '@mearl/browser-core';
import { localizeToolboxMetadata } from '../../shared/toolboxLocale';
import { SandboxToolPage } from './SandboxToolPage';

const LOADING_INDICATOR_DELAY_MS = 300;

export function ToolHost() {
  const plugin = window.location.hash.slice(1);
  const toolId = /^[a-z][a-z0-9-]*$/.test(plugin) ? `plugin:${plugin}` : null;
  const [tool, setTool] = useState<ToolboxToolOpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [locale, setLocale] = useState(getCurrentLanguage);

  useEffect(() => {
    let revision = 0;
    const unsubscribe = onConfigChange(changes => {
      const language = changes.language;
      if (!language) return;
      const currentRevision = ++revision;
      void initI18n(language).then(() => {
        if (revision === currentRevision) setLocale(language);
      });
    });
    return () => {
      revision += 1;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (tool) setExtensionPageTitle(localizeToolboxMetadata(tool).title);
  }, [tool, locale]);

  useEffect(() => {
    if (!toolId) {
      setError(t('toolboxToolMissing'));
      setExtensionPageTitle(t('toolboxToolOpenFailed'));
      return;
    }
    let active = true;
    const loadingTimer = window.setTimeout(() => setShowLoading(true), LOADING_INDICATOR_DELAY_MS);
    const openTool = async () => {
      try {
        const result = await requestToolbox('toolbox_tool_open', { id: toolId });
        if (!active) return;
        if (result.displayMode === 'popup') throw new Error(t('toolboxPopupOnly'));
        const localizedResult = localizeToolboxMetadata(result);
        setExtensionPageTitle(localizedResult.title);
        setTool(result);
      } catch (openError) {
        if (!active) return;
        setExtensionPageTitle(t('toolboxToolOpenFailed'));
        setError(openError instanceof Error ? openError.message : String(openError));
      } finally {
        window.clearTimeout(loadingTimer);
        if (active) setShowLoading(false);
      }
    };
    void openTool();
    return () => {
      active = false;
      window.clearTimeout(loadingTimer);
    };
  }, [toolId]);

  if (error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary p-8 text-text-primary">
        <div className="max-w-lg rounded-lg border border-red-500/30 bg-red-500/5 p-5 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-red-500" />
          <h1 className="mt-2 text-sm font-medium">{t('toolboxToolOpenFailed')}</h1>
          <p className="mt-1 break-words text-xs text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!tool) {
    return (
      <div
        role={showLoading ? 'status' : undefined}
        className="flex h-screen w-screen items-center justify-center gap-2 bg-bg-primary text-xs text-text-secondary"
      >
        {showLoading && (
          <>
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t('toolboxToolOpening')}
          </>
        )}
      </div>
    );
  }

  return (
    <SandboxToolPage
      agent={tool.agent}
      page={tool.page}
      skillUpdate={tool.skillUpdate}
      title={localizeToolboxMetadata(tool).title}
      toolId={toolId!}
    />
  );
}
