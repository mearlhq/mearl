import { readAdapter } from './catalog.mjs';

export function domainMatches(url, domain) {
  const expected = new URL(`https://${domain}`);
  if (expected.host !== domain || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash) {
    throw new Error(`无效的适配器域名: ${domain}`);
  }
  try {
    const actual = new URL(url);
    return ['https:', 'http:'].includes(actual.protocol) && actual.port === expected.port &&
      (actual.hostname === expected.hostname || actual.hostname.endsWith(`.${expected.hostname}`));
  } catch { return false; }
}

export function resolveArguments(adapter, positional = [], named = {}) {
  if (!Array.isArray(positional) || positional.some(value => typeof value !== 'string')) throw new Error('位置参数必须是字符串数组');
  if (!named || typeof named !== 'object' || Array.isArray(named)) throw new Error('args 必须是参数对象');
  const args = Object.create(null);
  for (const [key, value] of Object.entries(named)) {
    if (!Object.hasOwn(adapter.args, key)) throw new Error(`未知适配器参数: ${key}`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`适配器参数 ${key} 必须是字符串、数字或布尔值`);
    args[key] = String(value);
  }
  const remaining = Object.keys(adapter.args).filter(key => !Object.hasOwn(args, key));
  if (positional.length > remaining.length) throw new Error(`适配器 ${adapter.name} 的位置参数过多`);
  positional.forEach((value, index) => { args[remaining[index]] = value; });
  for (const [key, definition] of Object.entries(adapter.args)) {
    if (definition.required && (!Object.hasOwn(args, key) || args[key] === '')) throw new Error(`缺少必填参数: ${key}`);
  }
  return args;
}

function selectBrowser(listing, selector) {
  if (!selector) return listing?.defaultBrowserId;
  const query = selector.trim().toLowerCase();
  const connected = query ? (listing?.browsers ?? []).filter(browser => browser.status === 'connected') : [];
  const equals = value => value?.toLowerCase() === query;
  const byId = connected.filter(browser => equals(browser.browserId) || equals(browser.originalBrowserId));
  const byName = connected.filter(browser => equals(browser.name) || equals(browser.originalName));
  const matches = byId.length ? byId : byName.length ? byName : connected.filter(browser =>
    [browser.browserId, browser.originalBrowserId, browser.name, browser.originalName]
      .some(value => value?.toLowerCase().includes(query)));
  if (matches.length !== 1)
    throw new Error(`无法唯一匹配已连接的浏览器 ${selector}，请用 browser_list 查找完整 browserId`);
  return matches[0].browserId;
}

const targetChanged = '授权后目标标签页已关闭或切换站点，请重新运行适配器';

function guardAdapterOrigin(expression, origin) {
  return `async (args) => {
    const { ancestorOrigins, origin: frameOrigin } = window.location;
    const topOrigin = ancestorOrigins?.[ancestorOrigins.length - 1] ?? frameOrigin;
    if (topOrigin !== ${JSON.stringify(origin)}) throw new Error(${JSON.stringify(targetChanged)});
    return (${expression})(args);
  }`;
}

export async function executeAdapter(adapter, args, { invoke, options = {}, tabId, browserBound = false }) {
  if (adapter.domain) domainMatches(`https://${adapter.domain}/`, adapter.domain);
  if (tabId !== undefined && (!Number.isSafeInteger(Number(tabId)) || Number(tabId) < 0 || String(tabId).trim() === '')) throw new Error('tab 必须是有效的 Mearl tabId');
  // Read both files before browser work so one invocation retains its accepted script contents.
  const script = readAdapter(adapter);
  let session = options.session;
  let browser = options.browser;
  if (!browserBound && (!session || session === 'new') && !/^mearl:(local|remote):/.test(browser ?? '')) {
    const discovered = await invoke('browser_list', {}, { session: undefined });
    browser = selectBrowser(discovered, browser);
    if (!browser) throw new Error('未找到默认浏览器，请用 --browser 指定已连接的浏览器');
  }
  let permissionGranted = false;
  const dispatch = async (action, payload, routing) => {
    const result = await invoke(action, payload, routing);
    if (result?.action?.success === false) throw new Error(result.action.error || `${action} failed`);
    return result;
  };
  const call = async (action, payload, { beforeSession = false, targetUrl } = {}) => {
    const routing = { ...(browser ? { browser } : {}), ...(session ? { session: beforeSession ? undefined : session } : {}) };
    const run = () => {
      const request = permissionGranted && action === 'page_eval'
        ? { ...payload, expression: guardAdapterOrigin(payload.expression, new URL(targetUrl).origin) }
        : payload;
      return dispatch(action, request, routing);
    };
    let result;
    try {
      result = await run();
    } catch (error) {
      if (
        browserBound || error?.code !== 'DOMAIN_PERMISSION_REQUIRED' ||
        error.requestDispatched !== false || error.action !== action ||
        !targetUrl || !URL.canParse(targetUrl)
      ) throw error;
      const expected = new URL(targetUrl);
      if (!['http:', 'https:'].includes(expected.protocol) || expected.hostname !== error.domain) throw error;

      const permissionRouting = session === 'new' ? { ...routing, session: undefined } : routing;
      const decision = await dispatch('request_permission', { domain: error.domain }, permissionRouting);
      if (decision?.granted !== true) throw new Error(`未获得 ${error.domain} 的访问权限，已停止运行适配器`);
      permissionGranted = true;
      if (payload.tabId !== undefined) {
        // The user may have navigated the target tab while the request was pending.
        const { tabs } = await dispatch('tab_list', {}, permissionRouting);
        const current = Array.isArray(tabs) && tabs.find(tab => (tab.tabId ?? tab.id) === payload.tabId);
        if (!current?.url || !URL.canParse(current.url) || new URL(current.url).origin !== expected.origin)
          throw new Error(targetChanged);
      }
      result = await run();
    }
    if (result?.session?.sessionId) {
      session = result.session.sessionId;
      browser = result.session.browserId ?? browser;
    }
    return result;
  };
  const listed = await call('tab_list', {}, { beforeSession: session === 'new' });
  if (!Array.isArray(listed?.tabs)) throw new Error('tab_list 未返回标签页列表');
  let target;
  if (tabId !== undefined || !adapter.domain) {
    target = tabId !== undefined
      ? listed.tabs.find(tab => (tab.tabId ?? tab.id) === Number(tabId))
      : listed.tabs.find(tab => tab.active) ?? listed.tabs[0];
    if (!target) throw new Error('找不到目标标签页，请先打开页面或使用 --tab 指定 Mearl tabId');
    tabId = target.tabId ?? target.id;
    if (adapter.domain && !domainMatches(target.url, adapter.domain)) throw new Error(`指定标签页与适配器域名 ${adapter.domain} 不匹配`);
    if (session === 'new') await call('page_snapshot', { tabId, mode: 'viewport' }, { targetUrl: target.url });
  } else {
    const existing = listed.tabs.find(tab => domainMatches(tab.url, adapter.domain));
    const url = existing?.url ?? `https://${adapter.domain}/`;
    target = await call('tab_open', {
      url, active: false, reuse: 'prefer',
      match: { ...(existing ? {} : { urlPattern: `*://${adapter.domain}/*` }), onMultiple: 'first' },
    }, { targetUrl: url });
    tabId = target?.tabId;
    if (!Number.isSafeInteger(tabId)) throw new Error('tab_open 未返回有效的 tabId');
    if (!domainMatches(target.url, adapter.domain)) throw new Error(`页面跳转到其他域名，请先登录 ${adapter.domain} 后重试`);
  }
  const evaluated = await call('page_eval', { tabId, ...script, args: [args], awaitPromise: true, executionWorld: 'main', observe: false }, { targetUrl: target.url });
  const data = evaluated?.result;
  let result = data ?? null;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { /* Adapters may return plain text. */ }
  }
  const sessionInfo = evaluated?.session;
  if (result && typeof result === 'object' && Object.hasOwn(result, 'error')) {
    return {
      success: false, error: { message: typeof result.error === 'string' ? result.error : JSON.stringify(result.error) },
      ...(result.hint ? { hint: result.hint } : {}), result,
      ...(sessionInfo ? { session: sessionInfo } : {}),
    };
  }
  return { result, ...(sessionInfo ? { session: sessionInfo } : {}) };
}
