export interface WebViewNavigationClient {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface WebViewNavigationRequest {
  requestId: string;
  frameId?: string;
  resourceType?: string;
  responseStatusCode?: number;
  responseErrorReason?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
  request: {
    url: string;
    urlFragment?: string;
    method: string;
    headers?: Record<string, string>;
  };
}

export interface WebViewDocumentResponse {
  responseCode: number;
  responseHeaders?: Array<{ name: string; value: string }>;
  /** CDP Fetch.fulfillRequest 格式的 base64 响应体。 */
  body: string;
}

export interface RootWebViewNavigationOptions {
  client: WebViewNavigationClient;
  shellHeaders(forDocument: boolean): Promise<Array<{ name: string; value: string }> | undefined>;
  /** The host supports loading same-origin documents directly in the root frame. */
  keepSameOriginNavigation?: boolean;
  /** 开发代理把业务路径保存在外层 origin 中，不迁移该 origin。 */
  preserveOrigin?(current: URL, destination: URL): Promise<boolean> | boolean;
}

export interface WebViewFrameTree {
  frame: {
    id: string;
    url: string;
    urlFragment?: string;
    name?: string;
    parentId?: string;
    mimeType?: string;
  };
  childFrames?: WebViewFrameTree[];
}

export interface WebViewFrameEvent {
  frame?: WebViewFrameTree['frame'];
  frameId?: string;
  parentFrameId?: string;
  reason?: string;
}

const SHELL_BODY = btoa(
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body></body></html>',
);

const DOCUMENT_PREFIX = '/.mearl-document/';
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const DOCUMENT_TTL_MS = 30_000;
const DOCUMENT_READ_TIMEOUT_MS = 30_000;

type Header = { name: string; value: string };

function documentHeaders(headers: Header[], replay: boolean): Header[] {
  return headers.flatMap(header => {
    const name = header.name.toLowerCase();
    if (/^(content-encoding|content-length|transfer-encoding|x-frame-options)$/.test(name))
      return [];
    if (replay && /^(set-cookie|clear-site-data)$/.test(name)) return [];
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only') {
      if (!replay) return [];
      const value = header.value
        .split(';')
        .filter(directive => !/^\s*frame-ancestors\b/i.test(directive))
        .join(';');
      return value.trim() ? [{ ...header, value }] : [];
    }
    return [header];
  });
}

function encodeBody(body: string): string {
  if (body.length > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds delivery limit');
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds delivery limit');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function readDocumentBody(client: WebViewNavigationClient, requestId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.sendCommand('Fetch.getResponseBody', { requestId }) as Promise<{
        body: string;
        base64Encoded: boolean;
      }>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Document read timed out')),
          DOCUMENT_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 根 WebView 在现有外壳内完成同源导航。顶层导航的 HTML 响应通过内部地址
 * 一次性交付给根 WebView，避免重放登录回调；非 HTML 和下载保持浏览器语义。
 */
export function createRootWebViewNavigation(options: RootWebViewNavigationOptions) {
  let handoff: { url: string; headers?: Record<string, string> } | undefined;
  let localReload: { frameId: string; url: string } | undefined;
  let shellReload:
    { url: string; expiresAt: number; stage: 'request' | 'commit' | 'webview' } | undefined;
  let mainFrame: WebViewFrameTree['frame'] | undefined;
  let rootFrameId: string | undefined;
  let committedRoot: { id: string; origin: string } | undefined;
  const directChildFrames = new Set<string>();
  let navigationHops = 0;
  let document:
    { token: string; origin: string; body: string; headers: Header[]; status: number } | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let deliveryGeneration = 0;
  const clearDocument = () => {
    document = undefined;
    clearTimeout(expiry);
    expiry = undefined;
  };

  const isSameOriginRootNavigation = (params: WebViewNavigationRequest): boolean => {
    if (
      !options.keepSameOriginNavigation ||
      !mainFrame ||
      !committedRoot ||
      params.frameId !== committedRoot.id ||
      params.resourceType !== 'Document' ||
      params.request.method !== 'GET' ||
      params.responseStatusCode != null ||
      params.responseErrorReason != null ||
      !/^https?:/.test(params.request.url) ||
      !/^https?:/.test(mainFrame.url)
    )
      return false;
    const destination = new URL(params.request.url);
    return (
      !destination.pathname.startsWith(DOCUMENT_PREFIX) &&
      !(
        localReload &&
        localReload.frameId === params.frameId &&
        localReload.url === destination.href
      ) &&
      destination.origin === committedRoot.origin &&
      destination.origin === new URL(mainFrame.url).origin
    );
  };

  const preserveNavigationSource = ({ request }: WebViewNavigationRequest): (() => void) => {
    const source = {
      url: new URL(request.url).href,
      headers: Object.fromEntries(
        Object.entries(request.headers ?? {}).filter(([name]) => /^(referer|origin)$/i.test(name)),
      ),
    };
    handoff = source;
    return () => {
      if (handoff === source) handoff = undefined;
    };
  };

  const deliverDocument = async (
    params: WebViewNavigationRequest,
    requestClient: WebViewNavigationClient,
    headers: Header[],
    readBody: () => Promise<{ body: string; base64Encoded: boolean }>,
  ): Promise<boolean> => {
    const destination = new URL(params.request.url);
    const originalHeaders = params.responseHeaders ?? [];
    const contentType =
      originalHeaders.find(header => header.name.toLowerCase() === 'content-type')?.value ?? '';
    const attachment = originalHeaders.some(
      header =>
        header.name.toLowerCase() === 'content-disposition' &&
        /^\s*attachment\b/i.test(header.value),
    );
    const status = params.responseStatusCode ?? 0;
    if (
      params.responseErrorReason ||
      status < 200 ||
      (status >= 300 && status < 400) ||
      status === 204 ||
      status === 205 ||
      attachment ||
      !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)
    )
      return false;
    clearDocument();
    const generation = ++deliveryGeneration;
    try {
      const result = await readBody();
      const body = result.base64Encoded ? result.body : encodeBody(result.body);
      if (
        disposed ||
        generation !== deliveryGeneration ||
        body.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4
      )
        throw new Error('Document delivery unavailable');
      const token = crypto.randomUUID();
      const replayHeaders = [
        ...documentHeaders(originalHeaders, true).filter(
          header => !/^(cache-control|expires)$/i.test(header.name),
        ),
        { name: 'Cache-Control', value: 'no-store' },
      ];
      if (!result.base64Encoded) {
        const type = replayHeaders.find(header => header.name.toLowerCase() === 'content-type');
        if (type) type.value = contentType.split(';')[0] + '; charset=utf-8';
      }
      document = { token, origin: destination.origin, body, headers: replayHeaders, status };
      expiry = setTimeout(clearDocument, DOCUMENT_TTL_MS);
      await requestClient.sendCommand('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: status,
        responseHeaders: [
          ...documentHeaders(originalHeaders, false).filter(
            header =>
              !/^(content-type|cache-control|server-timing|content-disposition)$/i.test(
                header.name,
              ),
          ),
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
          ...headers,
          { name: 'Server-Timing', value: `mearl-document;desc="${token}"` },
        ],
        body: SHELL_BODY,
      });
    } catch {
      if (generation === deliveryGeneration) clearDocument();
      // 已读取的回调响应不能回退为再次 GET；终止本次导航，避免重复消费凭证。
      await requestClient
        .sendCommand('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' })
        .catch(() => {});
    }
    return true;
  };

  return {
    isSameOriginRootNavigation,
    preserveNavigationSource,
    prepareShellReload(): (() => void) | undefined {
      if (
        disposed ||
        !options.keepSameOriginNavigation ||
        rootFrameId ||
        !mainFrame ||
        !/^https?:/.test(mainFrame.url) ||
        !/^(text\/html|application\/xhtml\+xml)$/.test(mainFrame.mimeType ?? '')
      )
        return;
      const url = new URL(mainFrame.url);
      // Reload URLs with parameters or fragments through the normal top navigation, including login callbacks.
      if (url.search || url.hash || mainFrame.urlFragment) return;
      const reload = {
        url: url.href,
        expiresAt: Date.now() + DOCUMENT_TTL_MS,
        stage: 'request' as const,
      };
      shellReload = reload;
      return () => {
        if (shellReload === reload) shellReload = undefined;
      };
    },
    allowLocalReload(frameId: string, url: string): () => void {
      const destination = new URL(url);
      destination.hash = '';
      const reload = { frameId, url: destination.href };
      localReload = reload;
      return () => {
        if (localReload === reload) localReload = undefined;
      };
    },
    dispose(): void {
      disposed = true;
      deliveryGeneration += 1;
      clearDocument();
      handoff = undefined;
      localReload = undefined;
      shellReload = undefined;
      directChildFrames.clear();
    },
    initialize(tree: WebViewFrameTree): void {
      mainFrame = tree.frame;
      const root = tree.childFrames?.find(child => child.frame.name === '__mearl_root__')?.frame;
      rootFrameId = root?.id;
      committedRoot =
        root && /^https?:/.test(root.url)
          ? { id: root.id, origin: new URL(root.url).origin }
          : undefined;
      directChildFrames.clear();
      for (const child of tree.childFrames ?? []) directChildFrames.add(child.frame.id);
    },
    /** Returns the committed business URL when the root navigates within the current shell. */
    handleFrameEvent(method: string, params: WebViewFrameEvent): string | undefined {
      if (method === 'Page.frameNavigated' && params.frame) {
        const frame = params.frame;
        if (!frame.parentId) {
          if (shellReload?.stage === 'commit' && shellReload.url === frame.url) {
            shellReload.stage = 'webview';
          } else {
            shellReload = undefined;
          }
          mainFrame = frame;
          rootFrameId = undefined;
          committedRoot = undefined;
          directChildFrames.clear();
        } else if (mainFrame && frame.parentId === mainFrame.id) {
          directChildFrames.add(frame.id);
          if (frame.id === rootFrameId || frame.name === '__mearl_root__') {
            rootFrameId = frame.id;
            if (/^https?:/.test(frame.url)) {
              navigationHops = 0;
              const hasPreviousDocument = committedRoot?.id === frame.id;
              const destination = new URL(frame.url);
              committedRoot = { id: frame.id, origin: destination.origin };
              if (
                hasPreviousDocument &&
                !destination.pathname.startsWith(DOCUMENT_PREFIX) &&
                /^https?:/.test(mainFrame.url) &&
                destination.origin === new URL(mainFrame.url).origin
              ) {
                if (frame.urlFragment !== undefined) destination.hash = frame.urlFragment;
                return destination.href;
              }
            }
          }
        }
      } else if (
        method === 'Page.frameAttached' &&
        params.parentFrameId === mainFrame?.id &&
        params.frameId
      ) {
        directChildFrames.add(params.frameId);
      } else if (method === 'Page.frameDetached' && params.frameId) {
        if (params.frameId === committedRoot?.id) committedRoot = undefined;
        if (params.reason !== 'swap') {
          directChildFrames.delete(params.frameId);
          if (params.frameId === rootFrameId) rootFrameId = undefined;
        }
      }
    },
    /** Mock 与真实响应共用交付入口，保持浏览器 URL 和一次性文档语义一致。 */
    async fulfillResponse(
      params: WebViewNavigationRequest,
      response: WebViewDocumentResponse,
      requestClient: WebViewNavigationClient = options.client,
    ): Promise<boolean> {
      if (
        disposed ||
        !mainFrame ||
        params.resourceType !== 'Document' ||
        params.frameId !== mainFrame.id ||
        !/^https?:/.test(params.request.url)
      )
        return false;
      const headers = await options.shellHeaders(true);
      if (!headers || disposed) return false;
      return deliverDocument(
        {
          ...params,
          responseStatusCode: response.responseCode,
          responseHeaders: response.responseHeaders,
        },
        requestClient,
        headers,
        async () => ({ body: response.body, base64Encoded: true }),
      );
    },
    async handle(
      params: WebViewNavigationRequest,
      requestClient: WebViewNavigationClient = options.client,
    ): Promise<boolean> {
      if (disposed || params.resourceType !== 'Document' || !params.frameId) return false;
      let destination: URL;
      try {
        destination = new URL(params.request.url);
      } catch {
        return false;
      }
      if (!/^https?:$/.test(destination.protocol)) return false;
      const responseStage = params.responseStatusCode != null || params.responseErrorReason != null;
      const internal = destination.pathname.startsWith(DOCUMENT_PREFIX);
      if (internal && !responseStage) {
        const cached = document;
        if (
          cached &&
          directChildFrames.has(params.frameId) &&
          params.request.method === 'GET' &&
          destination.origin === cached.origin &&
          destination.pathname === DOCUMENT_PREFIX + cached.token
        ) {
          // 根文档由一次性交付 token 识别，不能把最先附加的广告 iframe 当成根页。
          rootFrameId = params.frameId;
          clearDocument();
          await requestClient.sendCommand('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: cached.status,
            responseHeaders: cached.headers,
            body: cached.body,
          });
        } else {
          await requestClient.sendCommand('Fetch.failRequest', {
            requestId: params.requestId,
            errorReason: 'Aborted',
          });
        }
        return true;
      }
      if (shellReload && Date.now() >= shellReload.expiresAt) shellReload = undefined;
      if (shellReload?.stage === 'request' && !responseStage && params.frameId === mainFrame?.id) {
        const reload = shellReload;
        shellReload = undefined;
        if (
          params.request.method === 'GET' &&
          !params.request.urlFragment &&
          destination.href === reload.url
        ) {
          const headers = await options.shellHeaders(true);
          if (
            !headers ||
            disposed ||
            params.frameId !== mainFrame?.id ||
            mainFrame.url !== reload.url
          )
            return false;
          reload.stage = 'commit';
          shellReload = reload;
          try {
            await requestClient.sendCommand('Fetch.fulfillRequest', {
              requestId: params.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                { name: 'Cache-Control', value: 'no-store' },
                ...headers,
                { name: 'Server-Timing', value: 'mearl-device-shell-start' },
              ],
              body: SHELL_BODY,
            });
          } catch (error) {
            if (shellReload === reload) shellReload = undefined;
            throw error;
          }
          return true;
        }
      }
      if (
        shellReload?.stage === 'webview' &&
        !responseStage &&
        params.request.method === 'GET' &&
        destination.href === shellReload.url &&
        directChildFrames.has(params.frameId)
      ) {
        // The shell contains a single initial WebView. Register it before its request can redirect.
        rootFrameId = params.frameId;
        committedRoot = { id: params.frameId, origin: destination.origin };
        shellReload = undefined;
        return false;
      }
      if (
        !responseStage &&
        params.request.method === 'GET' &&
        params.frameId === localReload?.frameId &&
        destination.href === localReload.url
      ) {
        localReload = undefined;
        return false;
      }
      if (!mainFrame) return false;
      const headers = await options.shellHeaders(responseStage && params.frameId === mainFrame.id);
      if (!headers || disposed) return false;
      if (params.frameId === mainFrame.id) {
        if (!responseStage) {
          if (handoff?.url === destination.href) {
            const transferred = handoff;
            handoff = undefined;
            const entries = new Map(
              Object.entries(params.request.headers ?? {}).map(([name, value]) => [
                name.toLowerCase(),
                { name, value },
              ]),
            );
            for (const [name, value] of Object.entries(transferred.headers ?? {}))
              entries.set(name.toLowerCase(), { name, value });
            params.request.headers = Object.fromEntries(
              [...entries.values()].map(({ name, value }) => [name, value]),
            );
          } else handoff = undefined;
          return false;
        }
        return deliverDocument(params, requestClient, headers, () =>
          readDocumentBody(requestClient, params.requestId),
        );
      }
      // Fetch 暂停时查询 renderer 可能与导航互等，frame 身份只使用提前登记的 Page 事件。
      if (responseStage || params.frameId !== rootFrameId || params.request.method !== 'GET')
        return false;
      const current = new URL(mainFrame.url);
      if (
        !/^https?:$/.test(current.protocol) ||
        isSameOriginRootNavigation(params) ||
        (await options.preserveOrigin?.(current, destination))
      )
        return false;
      if (navigationHops >= 20) return false;
      await requestClient.sendCommand('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 204,
        responseHeaders: [{ name: 'Cache-Control', value: 'no-store' }],
      });
      navigationHops += 1;
      const clearSource = preserveNavigationSource(params);
      try {
        await options.client.sendCommand('Page.navigate', {
          url: destination.href + (params.request.urlFragment ?? ''),
        });
      } catch {
        clearSource();
      }
      return true;
    },
  };
}
