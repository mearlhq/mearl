import { useEffect, useRef, useState } from 'react';
import { SIMULATION_PERMISSION_ACTION } from '../../shared/permissionRequest';
import { ALL_URLS_ORIGIN } from '../../shared/proxyPermissions';
import { t } from '../panel/utils/i18n';
import { PermissionModal, PermissionPrompt, PermissionSite } from './PermissionPrompt';

interface SiteRequest {
  host: string;
  pattern: string;
}

export function SimulationSitePermissionPrompt() {
  const [site, setSite] = useState<SiteRequest | null | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => {
    let current = true;
    void chrome.runtime.sendMessage({ action: SIMULATION_PERMISSION_ACTION }).then(
      (response: Partial<SiteRequest> | undefined) => {
        if (!current) return;
        setSite(
          response?.host && response.pattern
            ? { host: response.host, pattern: response.pattern }
            : null,
        );
      },
      () => {
        if (current) setSite(null);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (site === undefined) return null;
  if (site === null) {
    return (
      <p role="alert" className="p-4 text-center text-sm text-text-secondary">
        {t('simulationSitePermissionExpired')}
      </p>
    );
  }

  return (
    <PermissionModal
      isOpen
      onClose={() => {
        if (!busy.current) window.history.back();
      }}
      ariaLabel={t('simulationSitePermissionTitle')}
    >
      <PermissionPrompt
        title={t('simulationSitePermissionTitle')}
        description={t('simulationSitePermissionDescription')}
        allowLabel={t('simulationSitePermissionAllow')}
        dismissLabel={t('simulationSitePermissionSkip')}
        decisionErrorMessage={t('simulationSitePermissionContinueFailed')}
        onBusyChange={value => {
          busy.current = value;
        }}
        requestPermission={() => chrome.permissions.request({ origins: [site.pattern] })}
        requestAllSites={() => chrome.permissions.request({ origins: [ALL_URLS_ORIGIN] })}
        onDecision={async granted => {
          const response = (await chrome.runtime.sendMessage({
            action: SIMULATION_PERMISSION_ACTION,
            decision: granted ? 'allow' : 'skip',
          })) as { destination?: string } | undefined;
          if (!response?.destination) {
            throw new Error('Simulation permission request is no longer available');
          }
          window.location.replace(response.destination);
        }}
      >
        <PermissionSite domain={site.host} />
      </PermissionPrompt>
    </PermissionModal>
  );
}
