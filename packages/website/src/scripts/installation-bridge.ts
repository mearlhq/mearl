import site from '@mearl/preset/installation-site.json';
import { installationBridgeCopy as t } from '../lib/installation-bridge-copy';

interface WebRuntime {
  lastError?: { message?: string };
  sendMessage(id: string, message: unknown, callback: (value: unknown) => void): void;
}
function runtime(): WebRuntime | undefined {
  return (globalThis as typeof globalThis & { chrome?: { runtime?: WebRuntime } }).chrome?.runtime;
}

function requestInstallation(
  operation: 'status' | 'open',
  presetId: string,
  catalogUrl: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const api = runtime();
    if (!api?.sendMessage) {
      reject(new Error('EXTENSION_UNAVAILABLE'));
      return;
    }
    const timer = window.setTimeout(() => reject(new Error('EXTENSION_TIMEOUT')), 10_000);
    try {
      api.sendMessage(
        site.extensionId,
        { action: 'mearlInstallation', operation, presetId, catalogUrl },
        value => {
          window.clearTimeout(timer);
          const lastError = api.lastError;
          const result = value as { success?: boolean; error?: string } | undefined;
          if (lastError || !result?.success)
            reject(new Error(result?.error || 'EXTENSION_UNAVAILABLE'));
          else resolve();
        },
      );
    } catch (error) {
      window.clearTimeout(timer);
      reject(error);
    }
  });
}

export function initInstallationBridge(): void {
  const root = document.querySelector<HTMLElement>('[data-installation-bridge]');
  const label = document.querySelector<HTMLElement>('[data-bridge-label]');
  const status = document.querySelector<HTMLElement>('[data-bridge-status]');
  const install = document.querySelector<HTMLButtonElement>('[data-bridge-install]');
  if (!root || !label || !status || !install) return;
  install.disabled = true;
  label.hidden = false;
  status.textContent = '';
  const catalog = new URLSearchParams(location.hash.slice(1)).get('catalog');
  if (window.parent === window || !catalog) {
    label.textContent = t.chooseFromGuide;
    return;
  }
  let catalogUrl: URL;
  try {
    catalogUrl = new URL(catalog);
    if (
      catalog.length > 4096 ||
      catalogUrl.protocol !== 'https:' ||
      catalogUrl.username ||
      catalogUrl.password ||
      catalogUrl.search ||
      catalogUrl.hash ||
      catalogUrl.origin === new URL(site.url).origin
    )
      throw new Error('Invalid catalog URL');
  } catch {
    label.textContent = t.unavailable;
    return;
  }
  const parentOrigin = catalogUrl.origin;
  const lifetime = new AbortController();
  let disposed = false;
  let selected = '';
  let generation = 0;
  let busy = false;
  let queued: string | undefined;
  label.textContent = t.connectingGuide;
  window.addEventListener(
    'pagehide',
    () => {
      disposed = true;
      lifetime.abort();
    },
    { once: true },
  );
  const showStatus = (text: string) => {
    status.textContent = text;
    window.parent.postMessage(
      { type: 'mearl-installation-status', schemaVersion: 1, presetId: selected, text },
      parentOrigin,
    );
  };

  const choose = async (id: string) => {
    if (busy) {
      queued = id;
      return;
    }
    const turn = ++generation;
    selected = id;
    label.hidden = true;
    showStatus(t.connecting);
    install.disabled = true;
    try {
      await requestInstallation('status', id, catalogUrl.href);
      if (disposed || turn !== generation) return;
      showStatus(t.connected);
      install.textContent = t.enable;
      install.disabled = false;
    } catch {
      if (disposed || turn !== generation) return;
      showStatus('');
      install.textContent = t.enable;
      install.disabled = false;
    }
  };
  window.addEventListener(
    'message',
    event => {
      if (
        event.source !== window.parent ||
        event.origin !== parentOrigin ||
        !event.data ||
        typeof event.data !== 'object'
      )
        return;
      if (
        event.data.type !== 'mearl-installation-select' ||
        event.data.schemaVersion !== 1 ||
        typeof event.data.presetId !== 'string' ||
        !/^[a-z][a-z0-9-]{0,79}$/.test(event.data.presetId)
      )
        return;
      if (event.data.theme === 'light' || event.data.theme === 'dark') {
        document.documentElement.dataset.theme = event.data.theme;
        document.documentElement.style.colorScheme = event.data.theme;
      }
      if (busy || selected !== event.data.presetId) void choose(event.data.presetId);
    },
    { signal: lifetime.signal },
  );
  window.parent.postMessage({ type: 'mearl-installation-ready', schemaVersion: 1 }, parentOrigin);
  install.addEventListener(
    'click',
    async event => {
      if (!event.isTrusted || !selected || busy) return;
      busy = true;
      install.disabled = true;
      showStatus(t.opening);
      try {
        await requestInstallation('open', selected, catalogUrl.href);
        if (!disposed) {
          showStatus(t.opened);
          install.textContent = t.progress;
        }
      } catch (error) {
        if (!disposed) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'EXTENSION_UNAVAILABLE' || code === 'EXTENSION_TIMEOUT')
            showStatus(t.disconnected);
          else if (
            [
              'INSTALLATION_SOURCE_DENIED',
              'INSTALLATION_PARENT_DENIED',
              'INSTALLATION_PRESET_UNAVAILABLE',
            ].includes(code)
          )
            showStatus(t.configurationUnavailable);
          else showStatus(t.openFailed);
        }
      } finally {
        busy = false;
        if (!disposed) {
          install.disabled = false;
          const next = queued;
          queued = undefined;
          if (next !== undefined && next !== selected) void choose(next);
        }
      }
    },
    { signal: lifetime.signal },
  );
}

initInstallationBridge();
window.addEventListener('pageshow', event => {
  if (event.persisted) initInstallationBridge();
});
