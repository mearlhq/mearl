import { createRoot } from 'react-dom/client';
import { PermissionRequest } from './PermissionRequest';
import { getConfig } from '../panel/utils/config';
import { initI18n, t } from '../panel/utils/i18n';
import { setExtensionPageTitle } from '../../shared/pageTitle';
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
    setExtensionPageTitle(t('agentPermRequestTitle'));
    root.render(<PermissionRequest />);
  };
  void mount();
}
