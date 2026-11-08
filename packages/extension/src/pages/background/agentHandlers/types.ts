/**
 * AgentBridge handler context — passed to each handler function so they can
 * query the DevTools panel and inspect current state without direct class coupling.
 */
export interface AgentHandlerContext {
  queryPanel(tabId: number, query: Record<string, any>, timeoutMs?: number): Promise<any>;
  getActiveTabId(): number | null;
  signal?: AbortSignal;
}
