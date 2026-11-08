import { createRoot } from 'react-dom/client';
import { Panel } from '../panel/Panel';
import { ErrorBoundary } from '../panel/components/ErrorBoundary';
import '../../global.css';
import '../../shared/fontSize';

createRoot(document.getElementById('app-container')!).render(
  <ErrorBoundary>
    <Panel previewToken={window.location.hash.slice(1)} />
  </ErrorBoundary>,
);
