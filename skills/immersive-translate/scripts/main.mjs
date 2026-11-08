import { createLinkMarkup } from './links.mjs';
import { installTranslation } from './runtime.mjs';
import { createBrowserTranslation } from './browser.mjs';
import { createFloatingSwitch } from './floating.mjs';
import { stateStorage, translateBatch, translateBrowser, restoreCache } from './translation.mjs';
import { readPreferences, savePreferences, siteIdentity, siteTarget, siteState, setSite, setFloating } from './preferences.mjs';
export { stateStorage };
export const name = 'translate';
export const description = '使用本机 Codex 或浏览器内置模型提供网页双语阅读';
export const pageRuntime = { version: 1, matches: ['http://*/*', 'https://*/*'], code: `(host) => (${installTranslation.toString()})(host, ${createBrowserTranslation.toString()}, ${createFloatingSwitch.toString()}, (${createLinkMarkup.toString()})())`, initialize: 'initialize-translation', events: {
  move: { command: 'move-floating', policy: 'latest', schema: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'], additionalProperties: false } },
  toggle: { command: 'toggle-translation', policy: 'latest', schema: { type: 'object', properties: {}, additionalProperties: false } },
  cache: { command: 'restore-cache', policy: 'latest', schema: { type: 'object', properties: { generation: { type: 'integer', minimum: 1 } }, required: ['generation'], additionalProperties: false } },
  quick: { command: 'translate-browser', policy: 'latest', schema: { type: 'object', properties: { generation: { type: 'integer', minimum: 1 }, auto: { type: 'boolean' } }, required: ['generation', 'auto'], additionalProperties: false } },
  work: { command: 'translate-batch', policy: 'latest', schema: { type: 'object', properties: { generation: { type: 'integer', minimum: 1 }, auto: { type: 'boolean' } }, required: ['generation'], additionalProperties: false } },
} };
export const toolbox = { version: 1, title: '沉浸式翻译', description: '使用 Codex 或浏览器内置模型翻译网页', icon: 'languages', displayMode: 'popup',
  locales: { en: { title: 'Immersive translation', description: 'Read webpages with Codex or browser built-in translation' } },
  page: { type: 'sandbox', runtime: 'preact', entry: 'assets/toolbox/index.html', commands: ['bootstrap', 'preferences', 'settings', 'start-page', 'start', 'state', 'stop-page', 'stop', 'display', 'retry'] }, order: 85 };

export default function register(app) {
  const find = async input => {
    if (input.instanceId) return input.instanceId;
    if (!Number.isSafeInteger(input.tabId) || input.tabId < 0) throw new Error('An explicit tabId is required');
    const { instances } = await app.page('list');
    return instances.find(instance => instance.state === 'active' && instance.target.tabId === input.tabId)?.instanceId;
  };
  const state = async input => {
    const [target, { instances }, activation] = await Promise.all([siteTarget(app, input), app.page('list'), app.page('activation')]);
    const site = await siteState(app, target, activation);
    const instance = instances.find(instance => instance.state === 'active' && (input.instanceId ? instance.instanceId === input.instanceId : instance.target.tabId === input.tabId));
    if (!instance) return { enabled: false, status: 'idle', instanceId: null, ...site };
    const instanceId = instance.instanceId;
    return { ...await app.page('send', { instanceId, message: { type: 'STATE' } }), instanceId, ...site };
  };
  const storage = (...args) => app.state(...args);
  app.toolboxCommand('bootstrap', async input => {
    const [preferences, progress] = await Promise.all([readPreferences(storage), state(input)]);
    return { preferences, state: progress };
  });
  app.toolboxCommand('preferences', () => readPreferences(storage));
  app.toolboxCommand('settings', async input => {
    const options = await savePreferences(storage, input);
    if (Object.hasOwn(input, 'floating')) await setFloating(app, options, input.tabId);
    return options;
  });
  const start = async (input, persist) => {
    const target = await siteTarget(app, input); siteIdentity(target.url);
    const options = await savePreferences(storage, input);
    const instance = await app.page('attach', { tabId: target.tabId, frame: 'business', replace: true, input: { manual: true } });
    try {
      const result = await app.page('send', { instanceId: instance.instanceId, message: { type: 'START', ...options } });
      return { ...result, instanceId: instance.instanceId, ...await (persist ? setSite(app, target, true) : siteState(app, target)) };
    } catch (error) { await app.page('detach', { instanceId: instance.instanceId }).catch(() => {}); throw error; }
  };
  app.toolboxCommand('start-page', input => start(input, false), '仅翻译当前文档，不开启本站自动翻译');
  app.toolboxCommand('start', input => start(input, true), '开启本站自动翻译，刷新和再次访问时恢复');
  app.toolboxCommand('state', state, '读取翻译进度');
  app.toolboxCommand('stop-page', async input => {
    const target = await siteTarget(app, input), instanceId = await find(input);
    if (instanceId) await app.page('detach', { instanceId });
    const preferences = await readPreferences(storage);
    if (preferences.floating) {
      await app.page('attach', { tabId: target.tabId, frame: 'business', input: { manual: true } });
      return state({ tabId: target.tabId });
    }
    return { enabled: false, status: 'idle', instanceId: null, ...await siteState(app, target) };
  }, '停止当前页面翻译并恢复原文');
  app.toolboxCommand('stop', async input => {
    const target = await siteTarget(app, input);
    await setSite(app, target, false);
    return state({ tabId: target.tabId });
  }, '关闭本站自动翻译并恢复本站页面原文');
  for (const [command, type] of [['display', 'DISPLAY'], ['retry', 'RETRY']]) app.toolboxCommand(command, async input => {
    const instanceId = await find(input);
    if (!instanceId) throw new Error('Start translation on this page first');
    return { ...await app.page('send', { instanceId, message: { type, mode: input.mode } }), instanceId };
  }, command === 'display' ? '切换原文、双语或译文' : '重试失败的翻译');
  app.runtimeCommand('translate-batch', translateBatch);
  app.runtimeCommand('translate-browser', translateBrowser);
  app.runtimeCommand('restore-cache', restoreCache);
  app.runtimeCommand('initialize-translation', async ({ input }, context) => {
    const options = await readPreferences(context.state);
    if (options.floating) await context.page.send({ type: 'FLOATING', enabled: true, position: options.floatingPosition });
    if (input.manual) return;
    const instance = await context.page.get();
    if (!(await siteState(app, instance.target)).siteEnabled) return;
    return context.page.send({ type: 'START', ...options });
  });
  app.runtimeCommand('move-floating', (input, context) => savePreferences(context.state, { floatingPosition: input.event.payload }));
  app.runtimeCommand('toggle-translation', async (_input, context) => {
    try {
      const current = await context.page.send({ type: 'STATE' });
      if (current.enabled) return await context.page.send({ type: 'DISPLAY', mode: current.mode === 'original' ? 'bilingual' : 'original' });
      return await context.page.send({ type: 'START', ...await readPreferences(context.state) });
    } catch (error) {
      await context.page.send({ type: 'FLOATING_ERROR', error: String(error.message || error).slice(0, 500) }).catch(() => {});
      throw error;
    }
  });
}
