import { createRoot } from 'react-dom/client';
import { getConfig } from '../panel/utils/config';
import { initI18n, t } from '../panel/utils/i18n';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import { Installation } from './Installation';
import '../../global.css';

const root = document.getElementById('root');
if (root) void (async () => {
  try { await initI18n((await getConfig()).language); } catch { await initI18n(); }
  setExtensionPageTitle(t('presetInstallTitle'));
  createRoot(root).render(<Installation />);
})();
