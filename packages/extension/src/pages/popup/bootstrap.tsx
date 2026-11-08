import { createRoot } from 'react-dom/client';
import { initAnalytics } from '../../shared/analytics';
import '../../global.css';
import '../../shared/fontSize';
import { Popup } from './Popup';
import { getConfig } from '../panel/utils/config';
import { loadJsonInput } from './hooks/useJsonInput';
import { initI18n } from '../panel/utils/i18n';

export async function mountPopup(): Promise<void> {
  initAnalytics('popup');
  const container = document.getElementById('root');
  if (!container) return;
  const root = createRoot(container);
  const [config, input] = await Promise.all([
    getConfig().catch(error => {
      console.warn('[Popup] Failed to load bootstrap config:', error);
      return undefined;
    }),
    loadJsonInput().catch(error => {
      console.warn('[Popup] Failed to load initial input:', error);
      return { isStandalonePage: false };
    }),
  ]);
  await initI18n(config?.language).catch(error => {
    console.warn('[Popup] Failed to load translations:', error);
  });
  root.render(<Popup bootstrapConfig={config} bootstrapInput={input} />);
}
