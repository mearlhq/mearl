import { requestExtensionService } from '../../shared/extensionServiceRequest';
import type {
  AgentChatEventsResult,
  AgentChatRefreshResult,
  AgentServiceAction,
  AgentServiceDataAction,
  AgentServiceEmptyAction,
  AgentServiceRequest,
  AgentServiceResponse,
} from '@mearl/browser-core';

export function requestNativeHost<A extends AgentServiceEmptyAction>(
  action: A,
): Promise<AgentServiceResponse<A>>;
export function requestNativeHost<A extends AgentServiceDataAction>(
  action: A,
  data: AgentServiceRequest<A>,
): Promise<AgentServiceResponse<A>>;
export async function requestNativeHost(
  action: AgentServiceAction,
  data: unknown = {},
): Promise<AgentServiceResponse<AgentServiceAction>> {
  return requestExtensionService(action, data as AgentServiceRequest<typeof action>) as Promise<
    AgentServiceResponse<AgentServiceAction>
  >;
}

async function collectAgentChatEventPages<T extends AgentChatEventsResult>(
  sessionId: string,
  firstPage: T,
): Promise<T> {
  let events = [...firstPage.events];
  let retention = firstPage.retention;
  let cursor = firstPage.nextCursor;
  const seenCursors = new Set<number>();

  while (cursor !== undefined) {
    if (seenCursors.has(cursor)) throw new Error('Agent event pagination did not advance');
    seenCursors.add(cursor);
    const page = await requestNativeHost('agent_chat_events', {
      sessionId,
      cursor,
    });
    events = [...page.events, ...events];
    retention = page.retention ?? retention;
    cursor = page.nextCursor;
  }

  const { nextCursor: _nextCursor, ...firstPageWithoutCursor } = firstPage;
  return {
    ...firstPageWithoutCursor,
    events,
    ...(retention ? { retention } : {}),
  } as T;
}

export async function requestAgentChatEvents(sessionId: string): Promise<AgentChatEventsResult> {
  const firstPage = await requestNativeHost('agent_chat_events', {
    sessionId,
  });
  return collectAgentChatEventPages(sessionId, firstPage);
}

export async function requestAgentChatRefresh(sessionId: string): Promise<AgentChatRefreshResult> {
  const firstPage = await requestNativeHost('agent_chat_refresh', {
    sessionId,
  });
  return collectAgentChatEventPages(sessionId, firstPage);
}
