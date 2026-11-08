import { nativeCapabilities } from '../native-capability-services.js';
import { validateBrowserControl, type NetworkRoutePlan } from '@mearl/preset/bundles';
import type { NetworkControlSelection } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { ensureCorsHeaders, registerCdpFetchPauseHandler, unregisterCdpFetchPauseHandler, type CdpFetchHeader, type CdpFetchPauseContext } from './fetch-interceptor.js';

let selections = new WeakMap<PageSession, { selection: NetworkControlSelection; plan: NetworkRoutePlan }>();
async function handleNetworkControl({ session, params, isResponseStage }: CdpFetchPauseContext): Promise<boolean> {
  const accepted = selections.get(session);
  if (!accepted) return false;
  const request = params.request ?? {};
  let url: URL;
  try { url = new URL(request.url); } catch { return false; }
  if (!accepted.plan.routes.some(route => route.fromHost === url.hostname || route.toHost === url.hostname)) return false;
  if (!isResponseStage) {
    const route = accepted.plan.routes.find(route => route.fromHost === url.hostname);
    if (!route) return false;
    url.hostname = route.toHost;
    await session.client.sendCommand('Fetch.continueRequest', { requestId: params.requestId, url: url.href });
    return true;
  }
  if (params.responseStatusCode == null || !Object.keys(request.headers ?? {}).some(name => name.toLowerCase() === 'origin')) return false;
  await session.client.sendCommand('Fetch.continueResponse', {
    requestId: params.requestId, responseCode: params.responseStatusCode,
    ...(typeof params.responseStatusText === 'string' ? { responsePhrase: params.responseStatusText } : {}),
    responseHeaders: ensureCorsHeaders([...(params.responseHeaders ?? []) as CdpFetchHeader[]], request),
  });
  return true;
}
export async function setCdpNetworkControl(session: PageSession, selection: NetworkControlSelection | null): Promise<void> {
  if (selection === null) {
    await unregisterCdpFetchPauseHandler(session, 'network-control');
    selections.delete(session);
    return;
  }
  const definition = validateBrowserControl(nativeCapabilities.require('browser.control')());
  const option = definition.options.find(option => option.value === selection?.value);
  if (definition.id !== selection?.id || !option) throw new Error('Unknown installed browser control selection');
  const previous = selections.get(session);
  selections.set(session, { selection: { ...selection }, plan: option.networkRoutes });
  try {
    if (option.networkRoutes.routes.length) await registerCdpFetchPauseHandler(session, 'network-control', 50, handleNetworkControl);
    else await unregisterCdpFetchPauseHandler(session, 'network-control');
  }
  catch (error) {
    if (previous) selections.set(session, previous); else selections.delete(session);
    throw error;
  }
}
export function getCdpNetworkControl(session: PageSession): NetworkControlSelection | undefined { return selections.get(session)?.selection; }
export function clearCdpNetworkControlState(sessions?: Iterable<PageSession>): void {
  if (!sessions) selections = new WeakMap();
  else for (const session of sessions) selections.delete(session);
}
