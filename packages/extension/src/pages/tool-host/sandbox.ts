import { TOOLBOX_SANDBOX_PERMISSIONS } from './toolboxSandboxPermissions';

let pluginFrame: HTMLIFrameElement | null = null;
let loadedHtml: string | null = null;
const hostOrigin = `${location.protocol}//${location.host}`;

const handleMessage = (event: MessageEvent) => {
  const message = event.data as { type?: unknown; html?: unknown } | undefined;
  if (message?.type === 'mearl-plugin-load' && typeof message.html === 'string') {
    if (event.source !== window.parent || event.origin !== hostOrigin) return;
    if (pluginFrame && loadedHtml === message.html) return;
    pluginFrame?.remove();
    pluginFrame = document.createElement('iframe');
    pluginFrame.title = 'Plugin content';
    pluginFrame.setAttribute('sandbox', TOOLBOX_SANDBOX_PERMISSIONS);
    pluginFrame.referrerPolicy = 'no-referrer';
    pluginFrame.srcdoc = message.html;
    loadedHtml = message.html;
    document.body.replaceChildren(pluginFrame);
    return;
  }

  if (message?.type === 'mearl-plugin-ready') {
    if (event.source && event.source !== pluginFrame?.contentWindow) return;
    window.parent.postMessage({ type: 'mearl-plugin-ready' }, '*');
    return;
  }

  if (
    message?.type === 'mearl-chat-visualization-size' &&
    pluginFrame &&
    event.source === pluginFrame.contentWindow
  ) {
    const { height } = event.data;
    if (typeof height === 'number' && Number.isFinite(height)) {
      window.parent.postMessage({ type: message.type, height }, '*');
    }
    return;
  }

  if (message?.type === 'mearl-plugin-connect' && event.ports[0] && pluginFrame?.contentWindow) {
    if (event.source !== window.parent || event.origin !== hostOrigin) return;
    pluginFrame.contentWindow.postMessage(message, '*', [event.ports[0]]);
  }
};

window.addEventListener('message', handleMessage);
window.parent.postMessage(
  { type: 'mearl-plugin-host-ready', context: new URLSearchParams(location.search).get('context') },
  '*',
);

export {};
