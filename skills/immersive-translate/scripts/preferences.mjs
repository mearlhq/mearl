import { validateOptions, preferencesSchemaVersion } from './translation.mjs';

const migratePreferences = value => ({ ...value, ...(['off', 'left', 'right'].includes(value?.floating) ? { floating: value.floating !== 'off' } : {}) });
export const readPreferences = async state => validateOptions(migratePreferences((await state('preferences', 'get', { key: 'settings' })).value));

export async function savePreferences(state, input) {
  const patch = Object.fromEntries(['engine', 'targetLang', 'maxParagraphs', 'model', 'reasoningEffort', 'floating', 'floatingPosition'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await state('preferences', 'get', { key: 'settings' });
    const options = validateOptions({ ...migratePreferences(previous.value), ...patch });
    if (JSON.stringify(previous.value) === JSON.stringify(options)) return options;
    try {
      await state('preferences', 'transact', { transaction: { ...(previous.schemaVersion !== undefined && previous.schemaVersion !== preferencesSchemaVersion ? { migrateFromVersion: previous.schemaVersion, expectedRevision: previous.revision } : {}), operations: [{ type: 'put', key: 'settings', expectedVersion: previous.version, value: options }] } });
      return options;
    } catch (error) { if (error.code !== 'PLUGIN_STATE_CONFLICT' || attempt === 3) throw error; }
  }
}

export function siteIdentity(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Translation requires an HTTP(S) webpage');
  return { site: url.host, pattern: `*://${url.host}/*` };
}

export async function siteTarget(app, input) {
  if (input.instanceId) return (await app.page('get', { instanceId: input.instanceId })).target;
  if (!Number.isSafeInteger(input.tabId) || input.tabId < 0) throw new Error('An explicit tabId is required');
  const { tabs } = await app.invoke('tab_list', {});
  const tab = tabs.find(tab => (tab.tabId ?? tab.id) === input.tabId);
  if (!tab) throw new Error('Target tab is no longer available');
  return { tabId: input.tabId, url: tab.url };
}

export async function siteState(app, target, snapshot) {
  const { site, pattern } = siteIdentity(target.url);
  const { activation } = snapshot ?? await app.page('activation');
  return { site, siteEnabled: Boolean(activation?.enabled && activation.matches.includes(pattern)) };
}

export async function setSite(app, target, enabled) {
  const { site, pattern } = siteIdentity(target.url);
  await app.page('activation', { enabled: true, matchPatch: enabled ? { add: [pattern] } : { remove: [pattern] }, persistence: 'persistent', frame: 'business', input: {} });
  if (!enabled) {
    const preferences = await readPreferences((...args) => app.state(...args));
    const { instances } = await app.page('list');
    for (const instance of instances) {
      if (instance.state !== 'active') continue;
      let sameSite = false;
      try { sameSite = siteIdentity(instance.target.url).site === site; } catch { /* Non-web targets have no translation preference. */ }
      if (sameSite) {
        await app.page('detach', { instanceId: instance.instanceId });
        if (preferences.floating) await app.page('attach', { tabId: instance.target.tabId, frame: 'business', input: { manual: true } });
      }
    }
  }
  return { site, siteEnabled: enabled };
}

export async function setFloating(app, options, tabId) {
  const matches = ['http://*/*', 'https://*/*'];
  const { instances } = await app.page('list');
  for (const instance of instances) {
    if (instance.state !== 'active') continue;
    try {
      const result = await app.page('send', { instanceId: instance.instanceId, message: { type: 'FLOATING', enabled: options.floating, position: options.floatingPosition } });
      if (!options.floating) {
        if (result.enabled) await app.page('attach', { tabId: instance.target.tabId, frame: 'business', input: { manual: true } });
        else await app.page('detach', { instanceId: instance.instanceId });
      }
    } catch (error) { if (!/PLUGIN_PAGE_(INVALIDATED|NOT_FOUND|TARGET_CHANGED)/.test(String(error.code || error.message))) throw error; }
  }
  await app.page('activation', { enabled: true, matchPatch: !options.floating ? { remove: matches } : { add: matches }, persistence: 'persistent', frame: 'business', input: {} });
  if (options.floating && Number.isSafeInteger(tabId) && !instances.some(instance => instance.state === 'active' && instance.target.tabId === tabId)) {
    await app.page('attach', { tabId, frame: 'business', input: { manual: true } });
  }
}
