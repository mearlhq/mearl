import { createRoot } from 'react-dom/client';
import { initAnalytics } from '../../shared/analytics';
import { AGENT_SIDE_PANEL_PRESENCE_PORT } from '../../shared/agentSidePanelState';
import { SidepanelApp } from './SidepanelApp';
import '../../global.css';
import '../../shared/fontSize';

initAnalytics('sidepanel');

const presencePort = chrome.runtime.connect({ name: AGENT_SIDE_PANEL_PRESENCE_PORT });
const container = document.getElementById('root');

const render = (windowId: number | null) => {
  if (!container) return;
  const root = createRoot(container);
  root.render(<SidepanelApp windowId={windowId} />);
};

chrome.windows
  .getCurrent()
  .then(window => {
    const windowId = typeof window.id === 'number' ? window.id : null;
    if (windowId !== null) presencePort.postMessage({ windowId });
    render(windowId);
  })
  .catch(() => render(null));
