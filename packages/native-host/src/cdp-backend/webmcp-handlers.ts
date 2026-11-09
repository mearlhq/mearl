import {
  executePageWebMcp,
  PageWebMcpObservation,
  pageWebMcpCallRequest,
  resolvePageEvalExpression,
  type PageCallToolParams,
  type PageWebMcpRequest,
  type PageWebMcpResult,
} from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { sendCdpPageCommand } from './page-dialogs.js';

const observations = new WeakMap<PageSession, CdpWebMcpObservation>();

async function execute(
  session: PageSession,
  request: PageWebMcpRequest,
): Promise<PageWebMcpResult> {
  const { client } = session;
  const discovery = request.operation === 'discover';
  const { frameTree } = await sendCdpPageCommand(session, client, 'Page.getFrameTree', {}, 450);
  const { executionContextId } = await sendCdpPageCommand(
    session,
    client,
    'Page.createIsolatedWorld',
    {
      frameId: frameTree.frame.id,
      worldName: 'mearl-webmcp',
    },
    450,
  );
  const reply = await sendCdpPageCommand(
    session,
    client,
    'Runtime.evaluate',
    {
      expression: resolvePageEvalExpression({
        expression: executePageWebMcp.toString(),
        args: [request],
      }),
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    },
    discovery ? 450 : 12_000,
  );
  if (reply.exceptionDetails || !reply.result?.value)
    throw new Error('WEBMCP_EXECUTION_UNAVAILABLE: Check page state before retrying');
  return reply.result.value;
}

class CdpWebMcpObservation extends PageWebMcpObservation {
  private observedToolEvents = false;
  private mainFrameId?: string;
  private refreshing?: Promise<void>;
  private queued?: Promise<void>;
  private retryProbe = false;
  private committedUrl?: string;

  constructor(private readonly session: PageSession) {
    super();
    const { client } = session;
    client.on?.('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      this.mainFrameId = frame.id;
      this.reset();
      this.committedUrl = frame.url + (frame.urlFragment ?? '');
      if (!this.observedToolEvents && /^https?:/.test(frame.url)) this.catalogChanged();
    });
    client.on?.('Page.navigatedWithinDocument', ({ frameId, url }) => {
      if (!this.isMainFrame(frameId)) return;
      this.committedUrl = url;
      this.catalogChanged();
    });
    client.on?.('Page.domContentEventFired', () => {
      void this.refreshCatalog();
    });
    const onToolsChanged = ({ tools }: { tools: { frameId: string }[] }) => {
      if (!tools.some(tool => this.isMainFrame(tool.frameId))) return;
      this.observedToolEvents = true;
      this.catalogChanged();
    };
    const removeAdded = client.on?.('WebMCP.toolsAdded', onToolsChanged);
    const removeRemoved = client.on?.('WebMCP.toolsRemoved', onToolsChanged);
    void client.sendCommand('WebMCP.enable', {}, 500).catch(() => {
      removeAdded?.();
      removeRemoved?.();
    });
  }

  override reset(): void {
    super.reset();
    this.committedUrl = undefined;
  }

  navigationFields(requestedUrl: string | undefined) {
    return this.fields(this.committedUrl ?? requestedUrl);
  }

  refreshCatalog(full = false): Promise<void> | undefined {
    // Some Chrome configurations acknowledge enable without delivering events.
    if (full || !this.observedToolEvents || this.retryProbe) return this.queued ?? this.probe();
    return this.queued ?? this.refreshing;
  }

  private isMainFrame(frameId: string): boolean {
    return this.mainFrameId === undefined || frameId === this.mainFrameId;
  }

  private probe(): Promise<void> {
    this.refreshing ??= this.refresh(() =>
      execute(this.session, { operation: 'discover' }),
    ).finally(() => {
      this.retryProbe = !this.hasCatalog;
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private catalogChanged(): void {
    if (!this.refreshing) {
      void this.probe();
      return;
    }
    // A change that arrives during a probe may postdate the browser's snapshot.
    this.queued ??= this.refreshing.then(() => {
      this.queued = undefined;
      return this.probe();
    });
  }
}

export function watchCdpWebMcp(session: PageSession): CdpWebMcpObservation {
  let observation = observations.get(session);
  if (!observation) {
    observation = new CdpWebMcpObservation(session);
    observations.set(session, observation);
  }
  return observation;
}

export async function callCdpWebMcp(session: PageSession, params: PageCallToolParams) {
  const request = pageWebMcpCallRequest(params);
  watchCdpWebMcp(session).assertRef(params.toolRef);
  const reply = await execute(session, request);
  if ('result' in reply) return reply;
  throw new Error('error' in reply ? reply.error : 'WEBMCP_CALL_FAILED: Unexpected browser reply');
}
