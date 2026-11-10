import { watch, type FSWatcher } from 'node:fs';
import { keyedDir, ensureDir } from '@mearl/daemon-core';
import { listInstalledProviders, INSTALLED_PROVIDERS_SUBDIR } from '@mearl/provider/host';
import type { ExtensionAgentPolicy } from '@mearl/browser-core';
import type { InstalledProviderManifest } from '@mearl/provider/host';

export function providerIdsForBrowser(
  bundleId: string | undefined,
  providers?: InstalledProviderManifest[],
): string[] {
  if (!bundleId) return [];
  return (providers ?? listInstalledProviders())
    .filter(provider => provider.extensionAgentDefault?.macBundleIds?.includes(bundleId))
    .map(provider => provider.providerId)
    .sort();
}

/** One directory watcher per native connection; no process scans or polling. */
export function watchExtensionAgentPolicy(
  bundleId: string | undefined,
  changed: (policy: ExtensionAgentPolicy) => void,
) {
  let policy: ExtensionAgentPolicy = { revision: 0, providerIds: providerIdsForBrowser(bundleId) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const refresh = () => {
    if (closed || policy.available === false) return;
    const providerIds = providerIdsForBrowser(bundleId);
    if (JSON.stringify(providerIds) === JSON.stringify(policy.providerIds)) return;
    policy = { revision: policy.revision + 1, providerIds };
    changed(policy);
  };
  const directory = keyedDir(INSTALLED_PROVIDERS_SUBDIR);
  let watcher: FSWatcher | undefined;
  if (bundleId)
    try {
      ensureDir(directory);
      watcher = watch(directory, () => {
        if (closed) return;
        clearTimeout(timer);
        timer = setTimeout(refresh, 50);
        timer.unref();
      });
    } catch {
      policy = { ...policy, available: false };
    }
  watcher?.unref();
  policy = { ...policy, providerIds: providerIdsForBrowser(bundleId) };
  // A watcher failure must not revoke an already accepted provider assignment.
  watcher?.on('error', () => {
    if (closed) return;
    clearTimeout(timer);
    watcher?.close();
    policy = { ...policy, revision: policy.revision + 1, available: false };
    changed(policy);
  });
  return {
    current: () => policy,
    close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
