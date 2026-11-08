import { safeSendMessage } from './chromeSafe';

/** Page requests are limited to discovery and the host-validated installation operations. */
export function installWebsiteInstallationBridge() {
  if (window !== window.top || location.protocol !== 'https:') return;
  let opening = false;
  const listener = async (event: MessageEvent) => {
    const input = event.data;
    if (event.source !== window || event.origin !== location.origin || !input || input.type !== 'mearl-website-request' || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || !['version', 'status', 'open'].includes(input.operation)) return;
    const reply = (value: object) => window.postMessage({ type: 'mearl-website-response', id: input.id, ...value }, location.origin);
    if (input.operation === 'version') {
      const manifest = chrome.runtime.getManifest();
      reply({ success: true, data: { version: manifest.version_name ?? manifest.version } });
      return;
    }
    if (typeof input.presetId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId)) return;
    if (input.operation === 'open' && (opening || !navigator.userActivation?.isActive)) {
      reply({ success: false, error: opening ? 'INSTALLATION_BUSY' : 'USER_ACTIVATION_REQUIRED' });
      return;
    }
    if (input.operation === 'open') opening = true;
    try {
      const result = await safeSendMessage({ action: 'mearlWebsiteInstallation', operation: input.operation, presetId: input.presetId, ...(typeof input.catalogUrl === 'string' ? { catalogUrl: input.catalogUrl } : {}) });
      reply(result ?? { success: false, error: 'EXTENSION_UNAVAILABLE' });
    } finally { if (input.operation === 'open') opening = false; }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
