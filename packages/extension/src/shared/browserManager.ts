import type {
  BrowserManagementActionMap,
  BrowserLaunchParams,
  BrowserCloseParams,
  ManagedBrowserInfo,
  BrowserInstanceOperations,
  BrowserProviderOperations,
  BrowserSessionOperations,
  OperationRequest,
  OperationResponse,
  BrowserProviderDefinition,
} from '@mearl/browser-core';
import { requestExtensionService } from './extensionServiceRequest';

export type BrowserProviderSummary = BrowserProviderDefinition;
interface BrowserManagerRequestMap {
  list: BrowserManagementActionMap['browser_list'];
  launch: {
    request: BrowserLaunchParams & {
      operation: 'launch' | 'attach';
    };
    response: ManagedBrowserInfo;
  };
  close: { request: BrowserCloseParams; response: unknown };
  access: BrowserManagementActionMap['get_browser_access_url'];
  providers: BrowserProviderOperations['list'];
  configure: BrowserProviderOperations['configure'];
  launchForm: BrowserProviderOperations['launch_form'];
  start: BrowserInstanceOperations['start'];
  detach: BrowserInstanceOperations['detach'];
  syncCookies: BrowserInstanceOperations['sync_cookies'];
}
export type BrowserManagerOperation = keyof BrowserManagerRequestMap;

/** UI conveniences share the wire protocol's input/output definitions. */
const requests = {
  list: (data: BrowserManagerRequestMap['list']['request']) =>
    requestExtensionService('browser_list', data),
  launch: async (data: BrowserManagerRequestMap['launch']['request']) =>
    (await requestExtensionService(
      'browser_manage',
      data.operation === 'attach'
        ? {
            operation: 'attach',
            provider: data.provider ?? '',
            providerOptions: data.providerOptions,
          }
        : { ...data, operation: 'launch' },
    )) as ManagedBrowserInfo,
  close: (data: BrowserManagerRequestMap['close']['request']) =>
    requestExtensionService('browser_manage', { ...data, operation: 'close' }),
  access: (data: BrowserManagerRequestMap['access']['request']) =>
    requestExtensionService('get_browser_access_url', data),
  providers: (_data: BrowserManagerRequestMap['providers']['request']) =>
    requestExtensionService('browser_providers', { operation: 'list' }),
  configure: (data: BrowserManagerRequestMap['configure']['request']) =>
    requestExtensionService('browser_providers', { ...data, operation: 'configure' }),
  launchForm: (data: BrowserManagerRequestMap['launchForm']['request']) =>
    requestExtensionService('browser_providers', { ...data, operation: 'launch_form' }),
  start: (data: BrowserManagerRequestMap['start']['request']) =>
    requestExtensionService('browser_instances', { ...data, operation: 'start' }),
  detach: (data: BrowserManagerRequestMap['detach']['request']) =>
    requestExtensionService('browser_manage', { ...data, operation: 'detach' }),
  syncCookies: (data: BrowserManagerRequestMap['syncCookies']['request']) =>
    requestExtensionService('browser_instances', { ...data, operation: 'sync_cookies' }),
} satisfies {
  [O in BrowserManagerOperation]: (
    data: BrowserManagerRequestMap[O]['request'],
  ) => Promise<BrowserManagerRequestMap[O]['response']>;
};

export function requestBrowserManager<O extends BrowserManagerOperation>(
  operation: O,
  data: BrowserManagerRequestMap[O]['request'],
): Promise<BrowserManagerRequestMap[O]['response']> {
  const request = requests[operation] as (
    data: BrowserManagerRequestMap[O]['request'],
  ) => Promise<BrowserManagerRequestMap[O]['response']>;
  return request(data);
}
export function requestBrowserSessions<R extends OperationRequest<BrowserSessionOperations>>(
  data: R,
): Promise<OperationResponse<BrowserSessionOperations, R>> {
  return requestExtensionService('browser_sessions', data);
}
