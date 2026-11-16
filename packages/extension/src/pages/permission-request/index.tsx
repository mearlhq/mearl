import { createRoot } from 'react-dom/client';
import { PermissionRequest } from './PermissionRequest';
import { getConfig } from '../panel/utils/config';
import { initI18n, t } from '../panel/utils/i18n';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import { SIMULATION_PERMISSION_PARAM } from '../../shared/permissionRequest';
import '../../global.css';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  const mount = async () => {
    try {
      const config = await getConfig();
      await initI18n(config.language);
    } catch {
      await initI18n();
    }
    setExtensionPageTitle(
      new URLSearchParams(window.location.search).has(SIMULATION_PERMISSION_PARAM)
        ? t('simulationSitePermissionTitle')
        : t('agentPermRequestTitle'),
    );
    root.render(<PermissionRequest />);
  };
  void mount();
}
