import { loadInstallationConfig, type InstallationConfig } from '@mearl/preset/installation';
import site from '@mearl/preset/installation-site.json';
import { installationBridgeCopy as t } from '../lib/installation-bridge-copy';

interface WebRuntime {
  lastError?: { message?: string };
  sendMessage(id: string, message: unknown, callback: (value: unknown) => void): void;
}
interface BridgeStatus {
  browserReady?: boolean;
}
function runtime(): WebRuntime | undefined {
  return (globalThis as typeof globalThis & { chrome?: { runtime?: WebRuntime } }).chrome?.runtime;
}

export function requestInstallation(
  operation: 'status' | 'open',
  presetId: string,
): Promise<BridgeStatus> {
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
        { action: 'mearlInstallation', operation, presetId },
        value => {
          window.clearTimeout(timer);
          const lastError = api.lastError;
          const result = value as
            { success?: boolean; error?: string; data?: BridgeStatus } | undefined;
          if (lastError || !result?.success)
            reject(new Error(result?.error || 'EXTENSION_UNAVAILABLE'));
          else resolve(result.data ?? {});
        },
      );
    } catch (error) {
      window.clearTimeout(timer);
      reject(error);
    }
  });
}

export async function initInstallationBridge(): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-installation-bridge]');
  const label = document.querySelector<HTMLElement>('[data-bridge-label]');
  const status = document.querySelector<HTMLElement>('[data-bridge-status]');
  const install = document.querySelector<HTMLButtonElement>('[data-bridge-install]');
  if (!root || !label || !status || !install) return;
  install.disabled = true;
  label.hidden = false;
  status.textContent = '';
  if (window.parent === window) {
    label.textContent = t.chooseFromGuide;
    return;
  }
  const lifetime = new AbortController();
  let disposed = false;
  let selected = '';
  let config: InstallationConfig;
  let generation = 0;
  let busy = false;
  let queued: string | undefined;
  label.textContent = t.loading;
  window.addEventListener(
    'pagehide',
    () => {
      disposed = true;
      lifetime.abort();
    },
    { once: true },
  );
  try {
    config = await loadInstallationConfig(
      new URL('installation.json', site.url),
      new URL(site.url).origin,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
    );
  } catch {
    label.textContent = t.unavailable;
    status.textContent = t.refresh;
    return;
  }
  if (disposed) return;
  const presets = config.presets ?? {};
  if (!config.guide || !Object.keys(presets).length) {
    label.textContent = t.chooseFromGuide;
    return;
  }
  const parentOrigin = new URL(config.guide.url).origin;

  const choose = async (id: string) => {
    if (!Object.hasOwn(presets, id)) return;
    if (busy) {
      queued = id;
      return;
    }
    const turn = ++generation;
    selected = id;
    label.hidden = true;
    status.textContent = t.connecting;
    install.disabled = true;
    try {
      const result = await requestInstallation('status', id);
      if (disposed || turn !== generation) return;
      status.textContent = result.browserReady ? t.ready : t.connected;
      install.textContent = result.browserReady ? t.update : t.enable;
      install.disabled = false;
    } catch {
      if (disposed || turn !== generation) return;
      status.textContent = '';
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
        !Object.hasOwn(presets, event.data.presetId)
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
  const observer = new ResizeObserver(() =>
    window.parent.postMessage(
      { type: 'mearl-installation-height', schemaVersion: 1, height: document.body.scrollHeight },
      parentOrigin,
    ),
  );
  observer.observe(root);
  lifetime.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  window.parent.postMessage({ type: 'mearl-installation-ready', schemaVersion: 1 }, parentOrigin);
  install.addEventListener(
    'click',
    async event => {
      if (!event.isTrusted || !selected || busy) return;
      busy = true;
      install.disabled = true;
      status.textContent = t.opening;
      try {
        await requestInstallation('open', selected);
        if (!disposed) {
          status.textContent = t.opened;
          install.textContent = t.progress;
        }
      } catch (error) {
        if (!disposed) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'EXTENSION_UNAVAILABLE' || code === 'EXTENSION_TIMEOUT')
            status.textContent = t.disconnected;
          else if (
            [
              'INSTALLATION_SOURCE_DENIED',
              'INSTALLATION_PARENT_DENIED',
              'INSTALLATION_PRESET_UNAVAILABLE',
            ].includes(code)
          )
            status.textContent = t.configurationUnavailable;
          else status.textContent = t.openFailed;
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

void initInstallationBridge();
window.addEventListener('pageshow', event => {
  if (event.persisted) void initInstallationBridge();
});
