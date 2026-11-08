/** Read or write one named cookie in the default browser context or a selected tab's context. */

import {
  filterCookiesForUrl,
  resolveGetCookieTarget,
  resolveSetCookieTarget,
  selectReadableCookie,
  validateRequiredActionTabId,
  type ControlSource,
  type GetCookieParams,
  type SetCookieParams,
} from '@mearl/browser-core';
import type { CdpSession, PageSession } from './cdp-session.js';
import { registerActions } from './action-registry.js';
import { readCdpCurrentUrl } from './cdp-utils.js';
import { ensureControlledIndicator } from './controlled-indicator.js';

function reloadPageAndWait(session: PageSession, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let removeListener = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListener();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Page load timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    removeListener = session.client.on('Page.loadEventFired', () => finish());
    session.client.sendCommand('Page.reload').catch(error => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function cdpSetCookie(session: PageSession, data: SetCookieParams): Promise<any> {
  const url = data.url ?? (await readCdpCurrentUrl(session, 'set_cookie'));
  const target = resolveSetCookieTarget(url, data ?? {});
  const result = await session.client.sendCommand('Network.setCookie', {
    name: target.cookieName,
    value: target.cookieValue,
    url: target.cookieUrl,
    path: target.path,
    secure: target.cookieUrl.startsWith('https:'),
    ...(target.cookieDomain ? { domain: target.cookieDomain } : {}),
  });
  if (result.success === false) {
    throw new Error(`set_cookie: failed to set ${target.cookieName}`);
  }

  if (target.reload) {
    await reloadPageAndWait(session, 30000);
  }

  return {
    ...(typeof data?.tabId === 'number' ? { tabId: data.tabId } : {}),
    url: data.url ? target.cookieUrl : url,
    name: target.cookieName,
    domain: target.domain,
    path: target.path,
    reloaded: target.reload,
  };
}

export async function cdpGetCookie(session: PageSession, data: GetCookieParams): Promise<any> {
  const url = data.url ?? (await readCdpCurrentUrl(session, 'get_cookie'));
  const target = resolveGetCookieTarget(url, data ?? {});
  const result = await session.client.sendCommand('Network.getCookies', {
    urls: [target.cookieUrl],
  });
  const cookie = selectReadableCookie(result.cookies ?? [], target);

  return {
    ...(typeof data?.tabId === 'number' ? { tabId: data.tabId } : {}),
    url: data?.url ? target.cookieUrl : url,
    name: target.cookieName,
    found: Boolean(cookie),
    ...(cookie
      ? {
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
        }
      : {}),
  };
}

export async function cdpGetBrowserCookie(
  session: CdpSession,
  data: GetCookieParams,
): Promise<any> {
  validateRequiredActionTabId('get_cookie', data);
  if (data.tabId !== undefined) {
    const page = await session.getPageSession(data.tabId);
    return cdpGetCookie(page, data);
  }
  const target = resolveGetCookieTarget(undefined, data);
  const browser = await session.getBrowserClient();
  const result = await browser.sendCommand('Storage.getCookies', {});
  const cookie = selectReadableCookie(
    filterCookiesForUrl(result.cookies ?? [], target.cookieUrl),
    target,
  );
  return {
    url: target.cookieUrl,
    name: target.cookieName,
    found: Boolean(cookie),
    ...(cookie ? { value: cookie.value, domain: cookie.domain, path: cookie.path } : {}),
  };
}

export async function cdpSetBrowserCookie(
  session: CdpSession,
  data: SetCookieParams,
  controlSource: ControlSource = 'local',
): Promise<any> {
  validateRequiredActionTabId('set_cookie', data);
  if (data.tabId !== undefined) {
    const page = await session.getPageSession(data.tabId);
    if (data.reload === true) await ensureControlledIndicator(page, controlSource);
    return cdpSetCookie(page, data);
  }
  const target = resolveSetCookieTarget(undefined, data);
  const browser = await session.getBrowserClient();
  await browser.sendCommand('Storage.setCookies', {
    cookies: [
      {
        name: target.cookieName,
        value: target.cookieValue,
        url: target.cookieUrl,
        path: target.path,
        secure: target.cookieUrl.startsWith('https:'),
        ...(target.cookieDomain ? { domain: target.cookieDomain } : {}),
      },
    ],
  });
  return {
    url: target.cookieUrl,
    name: target.cookieName,
    domain: target.domain,
    path: target.path,
    reloaded: false,
  };
}

registerActions([
  { name: 'get_cookie', session: 'browser', handler: cdpGetBrowserCookie },
  { name: 'set_cookie', session: 'browser', handler: cdpSetBrowserCookie },
]);
