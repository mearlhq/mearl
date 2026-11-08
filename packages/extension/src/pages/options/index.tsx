import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initAnalytics } from '../../shared/analytics';
import '../../global.css';
import '../../shared/fontSize';
import Options from './Options';
import { ToastContainer } from '../panel/components/ToastContainer';

initAnalytics('options');

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Options />
      <ToastContainer />
    </StrictMode>,
  );
}
