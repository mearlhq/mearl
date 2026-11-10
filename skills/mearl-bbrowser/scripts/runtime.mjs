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

export async function executeAdapter(adapter, args, { invoke, options = {}, tabId, browserBound = false }) {
  if (adapter.domain) domainMatches(`https://${adapter.domain}/`, adapter.domain);
  if (tabId !== undefined && (!Number.isSafeInteger(Number(tabId)) || Number(tabId) < 0 || String(tabId).trim() === '')) throw new Error('tab 必须是有效的 Mearl tabId');
  // Read both files before browser work so one invocation retains its accepted script contents.
  const script = readAdapter(adapter);
  let session = options.session;
  let browser = options.browser;
  if (!browserBound && !browser && (!session || session === 'new')) {
    const discovered = await invoke('browser_list', {}, { session: undefined });
    browser = discovered?.defaultBrowserId;
    if (!browser) throw new Error('未找到默认浏览器，请用 --browser 指定已连接的浏览器');
  }
  const call = async (action, payload, beforeSession = false) => {
    const result = await invoke(action, payload, { ...(browser ? { browser } : {}), ...(session ? { session: beforeSession ? undefined : session } : {}) });
    if (result?.action?.success === false) throw new Error(result.action.error || `${action} failed`);
    if (result?.session?.sessionId) {
      session = result.session.sessionId;
      browser = result.session.browserId ?? browser;
    }
    return result;
  };
  const listed = await call('tab_list', {}, session === 'new');
  if (!Array.isArray(listed?.tabs)) throw new Error('tab_list 未返回标签页列表');
  let target;
  if (tabId !== undefined || !adapter.domain) {
    target = tabId !== undefined
      ? listed.tabs.find(tab => (tab.tabId ?? tab.id) === Number(tabId))
      : listed.tabs.find(tab => tab.active) ?? listed.tabs[0];
    if (!target) throw new Error('找不到目标标签页，请先打开页面或使用 --tab 指定 Mearl tabId');
    tabId = target.tabId ?? target.id;
    if (adapter.domain && !domainMatches(target.url, adapter.domain)) throw new Error(`指定标签页与适配器域名 ${adapter.domain} 不匹配`);
    if (session === 'new') await call('page_snapshot', { tabId, mode: 'viewport' });
  } else {
    const existing = listed.tabs.find(tab => domainMatches(tab.url, adapter.domain));
    target = await call('tab_open', {
      url: existing?.url ?? `https://${adapter.domain}/`, active: false, reuse: 'prefer',
      match: { ...(existing ? {} : { urlPattern: `*://${adapter.domain}/*` }), onMultiple: 'first' },
    });
    tabId = target?.tabId;
    if (!Number.isSafeInteger(tabId)) throw new Error('tab_open 未返回有效的 tabId');
    if (!domainMatches(target.url, adapter.domain)) throw new Error(`页面跳转到其他域名，请先登录 ${adapter.domain} 后重试`);
  }
  const evaluated = await call('page_eval', { tabId, ...script, args: [args], awaitPromise: true, executionWorld: 'main', observe: false });
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
