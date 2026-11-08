import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { Panel } from './Panel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { setupGlobalErrorHandler } from './utils/safeChrome';
import { initAnalytics } from '../../shared/analytics';
import '../../global.css';
import '../../shared/fontSize';

setupGlobalErrorHandler();
initAnalytics('panel');

ReactDOM.createRoot(document.getElementById('app-container')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Panel />
    </ErrorBoundary>
  </StrictMode>,
);
