export interface PageCallToolParams {
  tabId: number;
  toolRef: string;
  arguments?: Record<string, unknown>;
}

export interface PageWebMcpTool {
  ref?: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  origin: string;
}

export interface PageWebMcpCatalog {
  url: string;
  status: 'ready' | 'unsupported' | 'discovery-only';
  tools: PageWebMcpTool[];
  truncated: boolean;
}

export type PageWebMcpRequest =
  | { operation: 'discover' }
  | { operation: 'call'; toolRef: string; input: Record<string, unknown> };

export type PageWebMcpResult =
  { catalog: PageWebMcpCatalog } | { result: unknown } | { error: string };

export function pageWebMcpCallRequest(params: PageCallToolParams): PageWebMcpRequest {
  const { toolRef, arguments: input = {} } = params;
  if (typeof toolRef !== 'string' || !/^webmcp:[0-9a-f-]{36}$/.test(toolRef))
    throw new Error('page_call_tool requires a toolRef from the page WebMCP catalog');
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('page_call_tool arguments must be a JSON object');
  return { operation: 'call', toolRef, input };
}

/** Runs in an isolated world. Native tool objects stay in their original document. */
export async function executePageWebMcp(request: PageWebMcpRequest): Promise<PageWebMcpResult> {
  type NativeTool = Omit<PageWebMcpTool, 'ref'> & { window: Window | null };
  const world = globalThis as typeof globalThis & {
    Tool?: { prototype: object };
    __mearlWebMcpRefs?: Map<string, NativeTool>;
  };
  const context = (
    document as Document & {
      modelContext?: {
        getTools(): Promise<NativeTool[]>;
        executeTool(
          tool: NativeTool,
          input: Record<string, unknown>,
          options: { signal: AbortSignal },
        ): Promise<unknown>;
      };
    }
  ).modelContext;
  if (request.operation === 'call') {
    const tool = world.__mearlWebMcpRefs?.get(request.toolRef);
    if (!context || !tool || tool.window !== window)
      return {
        error: 'WEBMCP_STALE_TOOL: Refresh the page WebMCP catalog before calling this tool',
      };
    try {
      const result = await context.executeTool(tool, request.input, {
        signal: AbortSignal.timeout(10_000),
      });
      return { result: result ?? null };
    } catch (error) {
      return { error: `WEBMCP_CALL_FAILED: ${String(error)}. Check page state before retrying.` };
    }
  }

  const catalog: PageWebMcpCatalog = {
    url: location.href,
    status: 'unsupported',
    tools: [],
    truncated: false,
  };
  if (typeof context?.getTools !== 'function' || typeof context.executeTool !== 'function')
    return { catalog };

  // Older Chrome returns dictionaries and dispatches by name, even with an old tool object.
  const toolPrototype = world.Tool?.prototype;
  catalog.status = toolPrototype ? 'ready' : 'discovery-only';
  const refs = (world.__mearlWebMcpRefs ??= new Map());
  let remaining = 64_000;
  for (const tool of await context.getTools()) {
    if (tool.window !== window) continue;
    const { name, description, inputSchema, annotations, origin } = tool;
    const metadata: PageWebMcpTool = { name, description, inputSchema, annotations, origin };
    const length = JSON.stringify(metadata).length;
    if (catalog.tools.length >= 64 || length > remaining) {
      catalog.truncated = true;
      continue;
    }
    if (toolPrototype && Object.getPrototypeOf(tool) === toolPrototype) {
      metadata.ref = `webmcp:${crypto.randomUUID()}`;
      refs.set(metadata.ref, tool);
    }
    catalog.tools.push(metadata);
    remaining -= length;
  }
  while (refs.size > 256) refs.delete(refs.keys().next().value!);
  return { catalog };
}

/** Passive discovery never delays the browser action that triggered it. */
export class PageWebMcpObservation {
  private catalog?: PageWebMcpCatalog;
  private pending?: Promise<void>;
  private refs = new Set<string>();

  protected get hasCatalog(): boolean {
    return this.catalog !== undefined;
  }

  reset(): void {
    this.catalog = undefined;
    this.pending = undefined;
    this.refs.clear();
  }

  assertRef(toolRef: string): void {
    if (!this.refs.has(toolRef))
      throw new Error(
        'WEBMCP_STALE_TOOL: Refresh the page WebMCP catalog before calling this tool',
      );
  }

  refresh(probe: () => Promise<PageWebMcpResult>): Promise<void> {
    if (this.pending) return this.pending;
    let cancelTimeout = () => {};
    const timeout = new Promise<undefined>(resolve => {
      const timer = setTimeout(resolve, 500);
      cancelTimeout = () => clearTimeout(timer);
    });
    const pending = Promise.race([Promise.resolve().then(probe), timeout])
      .catch(() => undefined)
      .then(result => {
        if (this.pending !== pending) return;
        this.catalog =
          result && typeof result === 'object' && 'catalog' in result ? result.catalog : undefined;
        for (const tool of this.catalog?.tools ?? []) {
          if (tool.ref) this.refs.add(tool.ref);
        }
        while (this.refs.size > 256) this.refs.delete(this.refs.values().next().value!);
      })
      .finally(() => {
        cancelTimeout();
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  fields(url: string | undefined, full = false) {
    const catalog = this.catalog;
    if (!catalog || (url && catalog.url !== url))
      return full ? { webmcp: [], webmcpStatus: 'unavailable' } : {};
    if (!full && !catalog.tools.length && !catalog.truncated) return {};
    const tools = full ? catalog.tools : catalog.tools.slice(0, 8);
    return {
      webmcp: tools,
      ...(full || catalog.status !== 'ready' ? { webmcpStatus: catalog.status } : {}),
      ...(catalog.truncated || tools.length < catalog.tools.length
        ? { webmcpTruncated: true }
        : {}),
    };
  }
}
