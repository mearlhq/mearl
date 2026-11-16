import { watch, type FSWatcher } from 'node:fs';
import { keyedDir, ensureDir } from '@mearl/daemon-core';
import { listInstalledProviders, INSTALLED_PROVIDERS_SUBDIR } from '@mearl/provider/host';

export function canDiscoverExtension(bundleId: string | undefined): boolean {
  return (
    !bundleId ||
    !listInstalledProviders().some(provider => {
      const ids = provider.extensionAgentDefault?.macBundleIds;
      return Array.isArray(ids) && ids.includes(bundleId);
    })
  );
}

/** One directory watcher per native connection; no process scans or polling. */
export function watchExtensionDiscovery(bundleId: string | undefined, changed: () => void) {
  let allowed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const update = (next: boolean) => {
    if (closed || allowed === next) return;
    allowed = next;
    changed();
  };
  let watcher: FSWatcher | undefined;
  if (bundleId) {
    try {
      const directory = keyedDir(INSTALLED_PROVIDERS_SUBDIR);
      ensureDir(directory);
      watcher = watch(directory, () => {
        if (closed) return;
        clearTimeout(timer);
        timer = setTimeout(() => update(canDiscoverExtension(bundleId)), 50);
        timer.unref();
      });
      allowed = canDiscoverExtension(bundleId);
    } catch {
      allowed = false;
    }
  }
  watcher?.unref();
  watcher?.on('error', () => {
    if (closed) return;
    clearTimeout(timer);
    watcher?.close();
    watcher = undefined;
    update(false);
  });
  return {
    allowed: () => allowed,
    close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
