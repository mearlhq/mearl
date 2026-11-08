import { installOverlay } from './overlay.mjs';
import { createAssetStore } from './assets.mjs';
import { comparePixels } from './compare.mjs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { resolve, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';

export const overlayRuntimeVersion = createHash('sha256').update(installOverlay.toString()).digest('hex');
export const runtimeId = 'design-overlay';

export const defaults = {
  visible: false, opacity: 0.5, scale: 1, pixelRatio: 1, selector: 'body', offsetX: 0, offsetY: 0,
  blendMode: 'normal', locked: false, followScroll: true,
  cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, assetId: null,
};
const blendModes = ['normal', 'difference', 'multiply', 'screen', 'overlay', 'darken', 'lighten'];

export function waitForImage(image) {
  if (image.complete) return image.naturalWidth > 0 ? Promise.resolve() : Promise.reject(new Error('Could not load design image'));
  return new Promise((resolve, reject) => {
    const cleanup = () => { image.removeEventListener('load', loaded); image.removeEventListener('error', failed); };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Could not load design image')); };
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
  });
}

export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected settings');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(defaults, key) || key === 'assetId') throw new Error(`Unsupported setting: ${key}`);
    if (['visible', 'locked', 'followScroll'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`Expected boolean: ${key}`);
    } else if (key === 'selector') {
      if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('Invalid selector');
    } else if (key === 'blendMode') {
      if (!blendModes.includes(value)) throw new Error('Invalid blend mode');
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid number: ${key}`);
      const [min, max] = key === 'opacity' ? [0, 1] : key === 'scale' ? [0.1, 3] : key === 'pixelRatio' ? [1, 4] : key.startsWith('crop') ? [0, 100_000] : [-100_000, 100_000];
      if (value < min || value > max) throw new Error(`Out of range: ${key}`);
    }
  }
  return patch;
}

function pageKey(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Select an HTTP(S) web page');
  return parsed.origin + parsed.pathname;
}

export function createCommands({ invoke, page, state }, store) {
  let instanceId, owner;
  const setOwner = target => { owner = createHash('sha256').update(JSON.stringify([target.tabId, 'business'])).digest('hex'); };
  store ??= createAssetStore((collection, operation, input) => state(collection, operation, { ...input, instanceId }), () => owner);
  const persist = async state => {
    if (!state?.settings || !Number.isSafeInteger(state.settingsRevision) || state.settingsRevision < 0)
      throw new Error('Invalid overlay state');
    await store.saveSettings(pageKey(state.url), state.settings, { pageInstanceId: instanceId, settingsRevision: state.settingsRevision });
    return state;
  };
  const ensure = async ({ tabId, locale = 'zh_CN' }) => {
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('Invalid target tab');
    const instance = await page('attach', { tabId, frame: 'business', input: { locale } });
    instanceId = instance.instanceId;
    setOwner(instance.target);
    const state = await page('send', { instanceId: instance.instanceId, message: { type: 'STATE' } });
    const url = new URL(state.url);
    await page('activation', { enabled: true, matches: [url.origin + url.pathname, url.origin + url.pathname + '?*'], persistence: 'session', frame: 'business', input: { locale } });
    return persist({ ...state, instanceId: instance.instanceId });
  };
  const send = async (input, message) => {
    const state = await ensure(input);
    const result = await page('send', { instanceId: state.instanceId, message });
    return result && typeof result === 'object' ? { ...result, instanceId: state.instanceId } : result;
  };
  const commands = {
    async tabs() {
      const { tabs } = await invoke('tab_list', {});
      return { tabs: tabs.filter(tab => /^https?:\/\//.test(tab.url)).map(({ id, title, url, active }) => ({ id, title, url, active })) };
    },
    async state(input) { return ensure(input); },
    async initialize(input, context) {
      instanceId = context.identity.page.instanceId;
      setOwner(context.identity.page.target);
      const url = context.identity.page.target.url;
      const settings = { ...defaults, ...await store.loadSettings(pageKey(url)) };
      const content = settings.assetId ? await store.read(settings.assetId) : '';
      return context.page.send({ type: 'INITIALIZE', config: { runtimeVersion: overlayRuntimeVersion, browserSessionId: context.identity.page.target.browserSessionId, settings: { ...settings, svgContent: content }, pickHint: String(input.input?.locale ?? 'zh_CN').startsWith('zh') ? '按住拖动高亮元素，松开完成锚定' : 'Drag to highlight an element; release to select' } });
    },
    async sync(input, context) {
      instanceId = context.identity.page.instanceId;
      setOwner(context.identity.page.target);
      const state = input.event?.payload;
      const url = context.identity.page.target.url;
      if (!state || state.runtimeVersion !== overlayRuntimeVersion || pageKey(state.url) !== pageKey(url)) {
        throw new Error('Invalid overlay event state');
      }
      const { assetId, ...patch } = state.settings ?? {};
      if (assetId !== null && (typeof assetId !== 'string' || !/^[a-f0-9]{64}$/.test(assetId))) {
        throw new Error('Invalid design asset');
      }
      validatePatch(patch);
      await persist({ ...state, settings: { ...defaults, ...patch, assetId } });
      return { ok: true };
    },
    async update(input) {
      const patch = validatePatch(input.settings);
      return persist(await send(input, { type: 'UPDATE_LAYER', settings: patch, forceOffset: Object.hasOwn(patch, 'offsetX') || Object.hasOwn(patch, 'offsetY') }));
    },
    async apply(input) {
      const { pixelRatio } = validatePatch({ pixelRatio: input.pixelRatio ?? 1 });
      await ensure(input);
      const content = await store.read(input.assetId);
      const result = await send(input, { type: 'APPLY', content, assetId: input.assetId, pixelRatio });
      await store.pin(input.assetId);
      return persist(result);
    },
    async clear(input) {
      return persist(await send(input, { type: 'UPDATE_LAYER', settings: { visible: false, assetId: null, svgContent: '' } }));
    },
    async pick(input) { return send(input, { type: 'START_PICKING' }); },
    async cancelPick(input) { return send(input, { type: 'CANCEL_PICKING' }); },
    async capture(input) {
      await ensure(input);
      await store.releaseComparisons();
      await send(input, { type: 'WAIT_IMAGE' });
      const info = await send(input, { type: 'GET_VIEWPORT_INFO' });
      if (!info.overlayRect || info.overlayRect.w <= 0 || info.overlayRect.h <= 0) throw new Error('Import a visible design before comparing');
      let screenshot;
      await send(input, { type: 'HIDE_FOR_CAPTURE' });
      try { screenshot = await invoke('page_screenshot', { tabId: input.tabId, format: 'png', captureMode: 'visible', observe: false }); }
      finally { await send(input, { type: 'SHOW_AFTER_CAPTURE' }); }
      const { croppedDesign, ...viewport } = info;
      return {
        screenshot: await store.save(`data:image/png;base64,${screenshot.data}`),
        croppedDesign: croppedDesign ? await store.save(croppedDesign) : null,
        viewport,
      };
    },
    async beginImport(input) { await ensure(input); await store.releaseComparisons(); return store.begin(input); },
    async importChunk(input) { await ensure(input); return store.append(input); },
    async resourceChunk(input) { await ensure(input); return store.chunk(input); },
  };
  commands.importFile = async input => {
    if (typeof input.filePath !== 'string' || !input.filePath.trim()) throw new Error('Expected design filePath');
    const path = resolve(input.filePath), extension = extname(path).toLowerCase();
    if (!['.svg', '.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('Expected SVG, PNG or JPEG file');
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new Error('Design file exceeds 16 MiB');
    const file = await readFile(path);
    const content = extension === '.svg' ? file.toString('utf8') : `data:image/${extension === '.png' ? 'png' : 'jpeg'};base64,${file.toString('base64')}`;
    await ensure(input);
    await store.releaseComparisons();
    const resource = await store.save(content);
    return commands.apply({ ...input, assetId: resource.id });
  };
  commands.compare = async input => {
    if (input.diffPath !== undefined && (typeof input.diffPath !== 'string' || !input.diffPath.trim())) throw new Error('Invalid diff image path');
    const state = await ensure(input);
    if (!state.settings.assetId || !state.hasContent) throw new Error('Import a design before comparing');
    const capture = await commands.capture(input);
    const screenshot = await store.read(capture.screenshot.id);
    const cropped = capture.croppedDesign ? await store.read(capture.croppedDesign.id) : null;
    const content = await store.read(state.settings.assetId);
    const result = await send(input, { type: 'COMPARE', data: [screenshot, cropped, content, state.settings, capture.viewport] });
    const image = await store.save(result.image);
    let path;
    if (input.diffPath !== undefined) {
      path = resolve(input.diffPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(result.image.replace(/^data:image\/png;base64,/, ''), 'base64'), { mode: 0o600 });
    }
    return {
      diffPixels: result.count, totalPixels: result.width * result.height,
      percentage: result.percentage, width: result.width, height: result.height,
      image, ...(path ? { path } : {}),
    };
  };
  return commands;
}

const diffSource = readFileSync(new NodeURL('../assets/toolbox/blazediff.js', import.meta.url), 'utf8').replace('window.designOverlayDiff =', 'const imageDiff =');
export const pageRuntime = {
  version: 1,
  matches: ['http://*/*', 'https://*/*'],
  initialize: 'initialize',
  events: { state: { command: 'sync', policy: 'latest', schema: { type: 'object', required: ['settings', 'url', 'runtimeVersion'], properties: { settings: { type: 'object' }, url: { type: 'string', maxLength: 8192 }, runtimeVersion: { type: 'string', maxLength: 64 } }, additionalProperties: true } } },
  code: `host => {
    const installOverlay = ${installOverlay.toString()};
    const waitForImage = ${waitForImage.toString()};
    const comparePixels = ${comparePixels.toString()};
    ${diffSource}
    let overlay;
    return {
      async receive(message, request) {
        if (message.type === 'INITIALIZE') {
          overlay?.destroy();
          overlay = installOverlay({ ...message.config, emit: state => host.emit('state', state).catch(() => {}) });
          return overlay.state();
        }
        if (!overlay) throw new Error('Overlay is not initialized');
        if (message.type === 'STATE' || message.type === 'host:navigation') return overlay.state();
        if (message.type === 'APPLY') {
          if (message.content.startsWith('data:image/')) { const image = new Image(); image.src = message.content; await waitForImage(image); }
          request?.signal.throwIfAborted();
          overlay.handle({ type: 'UPDATE_LAYER', settings: { visible: true, assetId: message.assetId, svgContent: message.content, pixelRatio: message.pixelRatio } });
          const image = document.querySelector('#mearl-design-overlay-svg-wrapper img');
          if (image) await waitForImage(image);
          return overlay.state();
        }
        if (message.type === 'WAIT_IMAGE') {
          const image = document.querySelector('#mearl-design-overlay-svg-wrapper img'); if (image) await waitForImage(image);
          request?.signal.throwIfAborted();
          overlay.handle({ type: 'UPDATE_LAYER', settings: {} }); return null;
        }
        if (message.type === 'COMPARE') return comparePixels(...message.data, imageDiff);
        return overlay.handle(message);
      },
      dispose() { overlay?.destroy(); },
    };
  }`,
};
