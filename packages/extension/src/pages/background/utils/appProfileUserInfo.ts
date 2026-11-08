import type { AppProfileHostCapabilities } from '@mearl/browser-core';
import { prepareAppProfileCapabilities } from '../appProfileHostCapabilities';
import { authorizeBrowserCapabilityUrl } from '../browserCapabilities';
import { runAcceptedBrowserPureCapability } from '../browserPureCapabilities';

export interface AppProfileUserInfo { userId?: string; userName?: string }

/** The accepted App implementation supplies Cookie selection and identity decoding. */
export async function getAppProfileUserInfo(url: string, snapshot?: AppProfileHostCapabilities): Promise<AppProfileUserInfo> {
  const accepted = await prepareAppProfileCapabilities(['app.userInfo.scope', 'app.userInfo.resolve'], snapshot);
  const scope = accepted['app.userInfo.scope'], resolve = accepted['app.userInfo.resolve'];
  if (!scope || !resolve) throw new Error('CAPABILITY_NOT_INSTALLED');
  if (scope.bundleId !== resolve.bundleId || scope.revision !== resolve.revision) throw new Error('App identity handlers must belong to one implementation');
  const selection = await runAcceptedBrowserPureCapability({ ...scope.invocation, input: { url } }) as { cookieNames: string[] };
  if (!Array.isArray(selection?.cookieNames) || selection.cookieNames.length > 16 || selection.cookieNames.some(name => typeof name !== 'string' || !name || name.length > 256)) throw new Error('Invalid App identity Cookie selection');
  if (!selection.cookieNames.length) return {};
  const target = await authorizeBrowserCapabilityUrl(url);
  const cookies = (await Promise.all(selection.cookieNames.map(name => chrome.cookies.getAll({ url: target.href, name })))).flat();
  return await runAcceptedBrowserPureCapability({ ...resolve.invocation, input: { url: target.href, cookies: cookies.map(({ name, value }) => ({ name, value })) } }) as AppProfileUserInfo;
}
