import type { InstallationGuide } from '@mearl/preset/installation';
import { loadInstallationConfig } from '../lib/installation.mjs';
import { siteBase } from '../lib/site';

/** Permission names vary across Chromium versions. */
export async function localNetworkPermission(): Promise<PermissionStatus | undefined> {
  const major = Number(/(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1]);
  // The combined permission query is unsafe in old Chromium renderers.
  const names = major >= 141 ? ['local-network', 'local-network-access'] : ['local-network'];
  for (const name of names) {
    try {
      return await navigator.permissions.query({ name: name as PermissionName });
    } catch {
      /* Chromium permission names vary by version. */
    }
  }
  return undefined;
}

export function mayAutoProbe(permission: PermissionStatus | undefined, userAgent: string): boolean {
  if (permission) return permission.state === 'granted';
  const major = Number(/(?:Chrome|Chromium)\/(\d+)/.exec(userAgent)?.[1]);
  return major >= 110 && major < 142;
}

/** Restrict automatic requests to public IP space when local access is not granted. */
export function supportsPublicProbe(url: string): boolean {
  try {
    const init: RequestInit & { targetAddressSpace: 'public' } = { targetAddressSpace: 'public' };
    return (
      (new Request(url, init) as Request & { targetAddressSpace?: string }).targetAddressSpace ===
      'public'
    );
  } catch {
    return false;
  }
}

/** A cross-origin HEAD response shows reachability without exposing its HTTP status. */
export function probeGuide(
  guide: InstallationGuide,
  options: {
    publicOnly?: boolean;
    request?: typeof fetch;
    signal: AbortSignal;
  },
): Promise<boolean> {
  return new Promise(resolve => {
    if (options.signal.aborted) {
      resolve(false);
      return;
    }
    const controller = new AbortController();
    const url = new URL(guide.url);
    url.searchParams.set('mearl_probe', crypto.randomUUID());
    const timer = window.setTimeout(onAbort, 5_000);
    function finish(reachable: boolean) {
      if (controller.signal.aborted) return;
      window.clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      controller.abort();
      resolve(reachable);
    }
    function onAbort() {
      finish(false);
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
    const request: RequestInit & { targetAddressSpace?: 'public' } = {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
      ...(options.publicOnly ? { targetAddressSpace: 'public' as const } : {}),
    };
    (options.request ?? fetch)(url, request).then(
      () => finish(true),
      () => finish(false),
    );
  });
}

const networkFeatures = ['local-network', 'loopback-network', 'local-network-access'];
interface NetworkPolicy {
  features(): string[];
  allowsFeature(name: string): boolean;
}
function networkPolicy(doc: Document | null): NetworkPolicy | undefined {
  return (doc as (Document & { featurePolicy?: NetworkPolicy }) | null)?.featurePolicy;
}
function controlsLocalNetwork(policy: NetworkPolicy | undefined): policy is NetworkPolicy {
  const features = policy?.features();
  return Boolean(
    features?.includes('local-network-access') ||
    (features?.includes('local-network') && features.includes('loopback-network')),
  );
}

export async function probeWithoutLocalNetwork(
  guide: InstallationGuide,
  signal: AbortSignal,
): Promise<boolean> {
  if (controlsLocalNetwork(networkPolicy(document))) {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.allow = networkFeatures.map(feature => feature + " 'none'").join('; ');
    document.body.append(frame);
    try {
      const policy = networkPolicy(frame.contentDocument);
      const realm = frame.contentWindow;
      if (
        realm &&
        controlsLocalNetwork(policy) &&
        policy
          .features()
          .filter(feature => networkFeatures.includes(feature))
          .every(feature => !policy.allowsFeature(feature))
      ) {
        // Chromium can classify proxied HTTPS as unknown. The frame blocks local access without requiring a public IP classification.
        return await probeGuide(guide, { request: realm.fetch.bind(realm), signal });
      }
    } finally {
      frame.remove();
    }
  }
  return supportsPublicProbe(guide.url) ? probeGuide(guide, { publicOnly: true, signal }) : false;
}

const dismissedKey = 'mearl-intranet-banner-dismissed';

function isDismissed(scope: 'localStorage' | 'sessionStorage'): boolean {
  try {
    return window[scope].getItem(dismissedKey) === '1';
  } catch {
    return false;
  }
}

export async function initGuide(): Promise<void> {
  const banner = document.querySelector<HTMLElement>('[data-custom-website-banner]');
  const link = banner?.querySelector<HTMLAnchorElement>('[data-custom-website-link]');
  const close = banner?.querySelector<HTMLButtonElement>('[data-custom-website-close]');
  const never = banner?.querySelector<HTMLButtonElement>('[data-custom-website-never]');
  if (!banner || !link || !close || !never) return;
  banner.hidden = true;
  if (banner.dataset.dismissed || isDismissed('localStorage') || isDismissed('sessionStorage'))
    return;
  const lifetime = new AbortController();
  const { signal } = lifetime;
  window.addEventListener('pagehide', () => lifetime.abort(), { once: true, signal });
  try {
    const { guide } = await loadInstallationConfig(
      new URL(`${siteBase}installation.json`, window.location.origin),
      window.location.origin,
      AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    );
    if (!guide || signal.aborted) return;
    let timer: number | undefined;
    const permission = await Promise.race([
      localNetworkPermission(),
      new Promise<undefined>(resolve => {
        timer = window.setTimeout(resolve, 1_000);
      }),
    ]);
    window.clearTimeout(timer);
    if (signal.aborted) return;
    const reachable = mayAutoProbe(permission, navigator.userAgent)
      ? await probeGuide(guide, { signal })
      : await probeWithoutLocalNetwork(guide, signal);
    if (!reachable || signal.aborted) return;
    link.href = guide.url;
    const dismiss = (scope: 'localStorage' | 'sessionStorage') => {
      banner.hidden = true;
      banner.dataset.dismissed = 'true';
      try {
        window[scope].setItem(dismissedKey, '1');
      } catch {
        /* The banner can still be dismissed on this page. */
      }
    };
    close.onclick = () => dismiss('sessionStorage');
    never.onclick = () => dismiss('localStorage');
    banner.hidden = false;
  } catch {
    // Guide discovery is optional for the public site.
  } finally {
    lifetime.abort();
  }
}
