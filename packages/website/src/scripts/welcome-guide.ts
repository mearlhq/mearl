import { loadInstallationConfig, readJsonResponse } from '../lib/installation.mjs';
import { installedCopy } from '../lib/installed-copy';

export interface Guide { url: string; registry: string }
export type ProbeResult = 'ready' | 'unavailable' | 'denied' | 'cancelled';

/** Unknown permission support requires an explicit click, rather than an unsolicited prompt. */
export async function localNetworkPermission(): Promise<PermissionStatus | undefined> {
  const major = Number(/(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1]);
  // The combined permission query is unsafe in old Chromium renderers.
  const names = major >= 141 ? ['local-network', 'local-network-access'] : ['local-network'];
  for (const name of names) {
    try {
      return await navigator.permissions.query({ name: name as PermissionName });
    } catch { /* Chromium permission names vary by version. */ }
  }
  return undefined;
}

export function mayAutoProbe(permission: PermissionStatus | undefined, userAgent: string): boolean {
  if (permission) return permission.state === 'granted';
  const major = Number(/(?:Chrome|Chromium)\/(\d+)/.exec(userAgent)?.[1]);
  return major >= 110 && major < 142;
}

/** Restrict automatic requests to public IP space when local access is not granted. */
export function supportsPublicProbe(registry: string): boolean {
  try {
    const init: RequestInit & { targetAddressSpace: 'public' } = { targetAddressSpace: 'public' };
    return (new Request(registry, init) as Request & { targetAddressSpace?: string }).targetAddressSpace === 'public';
  } catch { return false; }
}

/** Uses the registry's standard npm ping endpoint; no account cookies or host process are needed. */
export function probeGuide(guide: Guide, options: { permission?: PermissionStatus; manual: boolean; publicOnly?: boolean; signal: AbortSignal }): Promise<ProbeResult> {
  return new Promise(resolve => {
    const permission = options.publicOnly ? undefined : options.permission;
    if (options.signal.aborted) { resolve('cancelled'); return; }
    if (permission?.state === 'denied') { resolve('denied'); return; }
    const controller = new AbortController();
    const url = new URL('-/ping', guide.registry);
    url.searchParams.set('mearl_probe', crypto.randomUUID());
    let settled = false;
    let networkTimer: number | undefined;
    // A permission decision can take longer than the registry's network deadline.
    const permissionPending = !options.publicOnly && options.manual && permission?.state !== 'granted';
    const overallTimer = window.setTimeout(() => finish('unavailable'), permissionPending ? 120_000 : 5_000);
    function shortDeadline() {
      if (!settled && !networkTimer) networkTimer = window.setTimeout(() => finish('unavailable'), 5_000);
    }
    function finish(result: ProbeResult) {
      if (settled) return;
      settled = true;
      window.clearTimeout(overallTimer);
      window.clearTimeout(networkTimer);
      options.signal.removeEventListener('abort', onAbort);
      permission?.removeEventListener('change', onPermission);
      controller.abort();
      resolve(result);
    }
    function onPermission() {
      if (permission?.state === 'denied') finish('denied');
      else if (permission?.state === 'granted') shortDeadline();
    }
    function onAbort() { finish('cancelled'); }
    options.signal.addEventListener('abort', onAbort, { once: true });
    permission?.addEventListener('change', onPermission);
    const request: RequestInit & { targetAddressSpace?: 'public' } = {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      ...(options.publicOnly ? { targetAddressSpace: 'public' as const } : {}),
    };
    fetch(url, request)
      .then(async response => {
        if (settled) { void response.body?.cancel().catch(() => {}); return; }
        shortDeadline();
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return finish('unavailable');
        const data = await readJsonResponse(response, 4096);
        finish(data && typeof data === 'object' && 'pong' in data && data.pong === true ? 'ready' : 'unavailable');
      })
      .catch(() => finish(permission?.state === 'denied' ? 'denied' : 'unavailable'));
  });
}

export async function initGuide(): Promise<void> {
  const region = document.querySelector<HTMLElement>('[data-guide]');
  const status = document.querySelector<HTMLElement>('[data-guide-status]');
  const detect = document.querySelector<HTMLButtonElement>('[data-guide-detect]');
  const cancel = document.querySelector<HTMLButtonElement>('[data-guide-cancel]');
  const link = document.querySelector<HTMLAnchorElement>('[data-guide-link]');
  if (!region || !status || !detect || !cancel || !link) return;
  const t = installedCopy[document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en'];
  let guide: Guide | undefined;
  let permission: PermissionStatus | undefined;
  let active: AbortController | undefined;
  let disposed = false;
  const lifetime = new AbortController();
  window.addEventListener('pagehide', () => { disposed = true; active?.abort(); lifetime.abort(); }, { once: true });
  const run = async (manual: boolean, publicOnly = false) => {
    if (!guide || active) return;
    active = new AbortController();
    status.textContent = t.checking;
    detect.disabled = true;
    cancel.hidden = false;
    region.setAttribute('aria-busy', 'true');
    const result = await probeGuide(guide, { permission, manual, publicOnly, signal: active.signal });
    active = undefined;
    detect.disabled = false;
    cancel.hidden = true;
    region.removeAttribute('aria-busy');
    if (disposed) return;
    if (result === 'ready') { window.location.replace(guide.url); return; }
    status.textContent = result === 'denied'
      ? t.denied
      : result === 'unavailable' && permission?.state === 'denied'
      ? t.unreachable
      : result === 'cancelled' ? t.cancelled
      : t.unavailable;
    detect.textContent = t.retry;
  };
  const configure = async () => {
    detect.disabled = true;
    try {
      const config = await loadInstallationConfig(new URL(region.dataset.configUrl ?? 'installation.json', window.location.href), window.location.origin,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]));
      if (disposed) return;
      if (!config.guide) {
        guide = undefined;
        permission = undefined;
        region.hidden = true;
        link.hidden = true;
        link.removeAttribute('href');
        status.textContent = '';
        return;
      }
      guide = config.guide;
      link.href = guide.url;
      link.hidden = false;
      region.hidden = false;
      status.textContent = t.ready;
      // A stalled Permissions API must not prevent the explicit detection button from working.
      let timer: number | undefined;
      permission = await Promise.race([localNetworkPermission(), new Promise<undefined>(resolve => { timer = window.setTimeout(resolve, 1_000); })]);
      window.clearTimeout(timer);
      if (!disposed) {
        if (mayAutoProbe(permission, navigator.userAgent)) await run(false);
        else if (supportsPublicProbe(guide.registry)) await run(false, true);
      }
    } catch {
      if (disposed) return;
      region.hidden = false;
      link.hidden = true;
      status.textContent = t.configError;
    } finally { detect.disabled = false; }
  };
  cancel.addEventListener('click', () => active?.abort(), { signal: lifetime.signal });
  detect.addEventListener('click', () => { if (guide) void run(true, permission?.state === 'denied' && supportsPublicProbe(guide.registry)); else void configure(); }, { signal: lifetime.signal });
  await configure();
}
