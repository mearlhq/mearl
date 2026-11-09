import {
  DomainPermissionError,
  executePageWebMcp,
  PageWebMcpObservation,
  pageWebMcpCallRequest,
  type PageCallToolParams,
  type PageWebMcpRequest,
} from '@mearl/browser-core';
import { isAgentDomainAuthorized } from '../../../shared/proxyPermissions';

const observedTabs = new Map<number, PageWebMcpObservation>();
let watching = false;

export function listWebMcpTabIds(): number[] {
  return [...observedTabs.keys()];
}

export function disposeExtensionWebMcp(tabId: number): void {
  observedTabs.get(tabId)?.reset();
  observedTabs.delete(tabId);
}

async function execute(tabId: number, request: PageWebMcpRequest) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (!frame?.documentId || frame.documentLifecycle !== 'active')
    throw new Error('WEBMCP_DOCUMENT_UNAVAILABLE: No active document');
  const url = new URL(frame.url);
  if (!['http:', 'https:'].includes(url.protocol) || !(await isAgentDomainAuthorized(url.hostname)))
    throw new DomainPermissionError('page_call_tool', url.hostname);
  const [reply] = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [frame.documentId] },
    world: 'ISOLATED',
    injectImmediately: true,
    func: executePageWebMcp,
    args: [request],
  });
  if (!reply?.result || reply.documentId !== frame.documentId)
    throw new Error('WEBMCP_DOCUMENT_CHANGED: Check page state before retrying');
  return reply.result;
}

export function watchExtensionWebMcp(tabId: number): PageWebMcpObservation {
  if (!watching && chrome.webNavigation?.onCommitted) {
    watching = true;
    const changed = ({ tabId, frameId }: { tabId: number; frameId: number }) => {
      const observation = observedTabs.get(tabId);
      if (frameId !== 0 || !observation) return;
      observation.reset();
      void refreshExtensionWebMcp(tabId, observation);
    };
    chrome.webNavigation.onCommitted.addListener(changed);
    chrome.webNavigation.onHistoryStateUpdated?.addListener(changed);
    chrome.webNavigation.onCompleted?.addListener(({ tabId, frameId }) => {
      const observation = observedTabs.get(tabId);
      if (frameId === 0 && observation) void refreshExtensionWebMcp(tabId, observation);
    });
    chrome.tabs.onRemoved?.addListener(disposeExtensionWebMcp);
  }
  let observation = observedTabs.get(tabId);
  if (!observation) {
    observation = new PageWebMcpObservation();
    observedTabs.set(tabId, observation);
  }
  return observation;
}

export function refreshExtensionWebMcp(tabId: number, observation = watchExtensionWebMcp(tabId)) {
  return observation.refresh(() => execute(tabId, { operation: 'discover' }));
}

export async function callExtensionWebMcp(params: PageCallToolParams) {
  const request = pageWebMcpCallRequest(params);
  watchExtensionWebMcp(params.tabId).assertRef(params.toolRef);
  const reply = await execute(params.tabId, request);
  if ('result' in reply) return reply;
  throw new Error('error' in reply ? reply.error : 'WEBMCP_CALL_FAILED: Unexpected browser reply');
}
