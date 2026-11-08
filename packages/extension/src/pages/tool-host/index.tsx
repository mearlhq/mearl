import { createRoot } from 'react-dom/client';
import { initAnalytics } from '../../shared/analytics';
import { getConfig } from '../panel/utils/config';
import { initI18n, t } from '../panel/utils/i18n';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import '../../global.css';
import '../../shared/fontSize';
import { ToastContainer } from '../panel/components/ToastContainer';
import { ToolHost } from './ToolHost';

initAnalytics('tool_host');

const container = document.getElementById('app-container');
const root = createRoot(container!);

const mount = async () => {
  try {
    const config = await getConfig();
    await initI18n(config.language);
  } catch {
    await initI18n();
  }
  setExtensionPageTitle(t('toolboxToolFrame'));
  root.render(
    <>
      <ToolHost />
      <ToastContainer />
    </>,
  );
};

void mount();
