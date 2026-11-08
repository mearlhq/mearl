// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOverlay } from '../../design-overlay/scripts/overlay.mjs';
import { createCommands, defaults, waitForImage, pageRuntime } from '../../design-overlay/scripts/commands.mjs';
import { comparePixels } from '../../design-overlay/scripts/compare.mjs';

const fromExtension = createRequire(join(process.cwd(), 'package.json'));
const preact = fromExtension('preact');
const hooks = fromExtension('preact/hooks');
const htm = fromExtension('htm');
const { act } = fromExtension('preact/test-utils');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red" /></svg>';

beforeEach(() => {
  vi.stubGlobal('location', window.location);
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.innerHTML = '<div id="target"></div>';
  document.body.removeAttribute('style');
});
afterEach(() => {
  window.__mearlDesignOverlay?.destroy();
  preact.render(null, document.getElementById('app') || document.createElement('div'));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const runtimeHosts = new WeakMap();
function runtimeCommands(store) {
  if (runtimeHosts.has(store)) return runtimeHosts.get(store);
  let handler;
  let commands;
  const context = { identity: { page: { instanceId: 'page-instance', target: { tabId: 7, browserSessionId: 'test-session', url: location.href } } }, page: { send: message => handler.receive(message) } };
  const page = async (operation, input) => {
    if (operation === 'activation') return {};
    if (operation === 'attach') {
      if (!handler || !window.__mearlDesignOverlay) {
        handler = new Function(`return (${pageRuntime.code})`)()({ emit: async (name, payload) => commands.sync({ event: { name, payload } }, context) });
        await commands.initialize({ input: input.input }, context);
      }
      return { instanceId: 'page-instance', target: context.identity.page.target };
    }
    return handler.receive(input.message);
  };
  commands = createCommands({ invoke: vi.fn(), page }, store);
  runtimeHosts.set(store, commands);
  return commands;
}

describe('design overlay page runtime', () => {
  const install = content => installOverlay({ settings: { ...defaults, visible: true, assetId: 'a'.repeat(64), svgContent: content }, pickHint: 'Pick' });

  it('restores a pasted raster and popup-independent position edits after the document runtime is lost', async () => {
    vi.spyOn(window.HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(window.HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(640);
    const content = 'data:image/png;base64,cG5n';
    let saved;
    const store = {
      read: vi.fn(async () => content),
      pin: vi.fn(),
      loadSettings: vi.fn(async () => saved),
      saveSettings: vi.fn(async (_, settings) => { saved = structuredClone(settings); }),
    };
    const commands = runtimeCommands(store);
    await commands.apply({ tabId: 7, assetId: 'a'.repeat(64), pixelRatio: 2 });
    await commands.update({ tabId: 7, settings: { opacity: 0.4, scale: 0.7, cropLeft: 12 } });
    window.__mearlDesignOverlay.handle({ type: 'UPDATE_LAYER', settings: { offsetX: 45, offsetY: 67 }, forceOffset: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    window.__mearlDesignOverlay.destroy();
    document.body.innerHTML = '<div id="target"></div>';
    const restored = await runtimeCommands(store).state({ tabId: 7 });
    expect(restored.hasContent).toBe(true);
    expect(restored.settings).toMatchObject({ visible: true, pixelRatio: 2, opacity: 0.4, scale: 0.7, cropLeft: 12, offsetX: 45, offsetY: 67 });
    expect(document.querySelector('#mearl-design-overlay-svg-wrapper img').src).toBe(content);
    await commands.clear({ tabId: 7 });
    window.__mearlDesignOverlay.destroy();
    expect((await runtimeCommands(store).state({ tabId: 7 })).hasContent).toBe(false);
  });

  it('lets picking reach the page through the design and restores drag and crop interaction afterward', () => {
    const api = install(svg);
    const wrapper = document.querySelector('#mearl-design-overlay-svg-wrapper');
    const handles = document.querySelector('[data-crop-handle]').parentElement;
    expect(wrapper.style.pointerEvents).toBe('auto'); expect(handles.style.display).toBe('block');
    api.handle({ type: 'START_PICKING' });
    expect(wrapper.style.pointerEvents).toBe('none'); expect(handles.style.display).toBe('none');
    api.handle({ type: 'UPDATE_LAYER', settings: { opacity: 0.7 } });
    expect(wrapper.style.pointerEvents).toBe('none'); expect(handles.style.display).toBe('none');
    api.handle({ type: 'CANCEL_PICKING' });
    expect(wrapper.style.pointerEvents).toBe('auto'); expect(handles.style.display).toBe('block');
    api.handle({ type: 'UPDATE_LAYER', settings: { locked: true } });
    api.handle({ type: 'START_PICKING' }); api.handle({ type: 'CANCEL_PICKING' });
    expect(wrapper.style.pointerEvents).toBe('none'); expect(handles.style.display).toBe('none');
  });

  it('preserves an anchor picked while the popup is closed and synchronizes it on reopen', async () => {
    let saved;
    const store = {
      loadSettings: vi.fn(async () => saved),
      saveSettings: vi.fn(async (_, settings) => { saved = structuredClone(settings); }),
    };
    const commands = runtimeCommands(store);
    await commands.pick({ tabId: 7 });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.querySelector('#target'));
    const click = new MouseEvent('click', { clientX: 20, clientY: 30, bubbles: true, cancelable: true });
    document.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(window.__mearlDesignOverlay.state()).toMatchObject({ picking: false, settings: { selector: '#target' } });
    await new Promise(resolve => setTimeout(resolve, 100));
        expect(await commands.state({ tabId: 7 })).toMatchObject({ settings: { selector: '#target' } });
        window.__mearlDesignOverlay.destroy();
    expect((await commands.state({ tabId: 7 })).settings.selector).toBe('#target');
  });

  it('coalesces state events and stops emitting on destroy', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const api = installOverlay({ emit, settings: { ...defaults, visible: true, svgContent: svg } });
    api.state();
    emit.mockClear();
    api.handle({ type: 'UPDATE_LAYER', settings: { offsetX: 10 }, forceOffset: true });
    api.handle({ type: 'UPDATE_LAYER', settings: { offsetX: 20 }, forceOffset: true });
    await vi.advanceTimersByTimeAsync(80);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ offsetX: 20 }) }));
    api.handle({ type: 'START_PICKING' }); api.destroy();
    const count = emit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(emit).toHaveBeenCalledTimes(count);
  });

  it('filters unsafe SVG content while retaining gradients and safe inline styling', () => {
    const api = install('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>x</script><foreignObject>x</foreignObject><rect fill="url(\'#gradient\')" style="fill:red" /><image href="https://unsafe.test/a" /></svg>');
    const root = document.getElementById('mearl-design-overlay-svg-wrapper');
    expect(root.querySelector('script, foreignObject')).toBeNull();
    expect(root.querySelector('svg').hasAttribute('onload')).toBe(false);
    expect(root.querySelector('image').hasAttribute('href')).toBe(false);
    expect(root.querySelector('rect').getAttribute('fill')).toBe("url('#gradient')");
    expect(root.querySelector('rect').getAttribute('style')).toBe('fill:red');
    expect(api.state().hasContent).toBe(true);
  });

  it('keeps the valid design when an invalid SVG or selector is applied', () => {
    const api = install(svg);
    const original = document.querySelector('#mearl-design-overlay-svg-wrapper svg');
    expect(() => api.handle({ type: 'UPDATE_LAYER', settings: { svgContent: '<svg invalid' } })).toThrow('Invalid SVG');
    expect(() => api.handle({ type: 'UPDATE_LAYER', settings: { selector: '[' } })).toThrow();
    expect(document.querySelector('#mearl-design-overlay-svg-wrapper svg')).toBe(original);
  });

  it('uses intrinsic SVG dimensions independently of anchor width and scales from 100%', () => {
    const api = install(svg);
    const wrapper = document.getElementById('mearl-design-overlay-svg-wrapper');
    api.handle({ type: 'UPDATE_LAYER', settings: { selector: '#target' } });
    expect(wrapper.style.width).toBe('100px');
    expect(wrapper.style.height).toBe('100px');
    api.handle({ type: 'UPDATE_LAYER', settings: { scale: 0.5 } });
    expect(wrapper.style.width).toBe('50px');
    api.handle({ type: 'UPDATE_LAYER', settings: { svgContent: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" />', scale: 1 } });
    expect(wrapper.style.width).toBe('240px');
    expect(wrapper.style.height).toBe('120px');
  });

  it('uses raster natural dimensions after decoding', () => {
    vi.spyOn(window.HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
    const api = install('data:image/png;base64,cG5n');
    const image = document.querySelector('#mearl-design-overlay-svg-wrapper img');
    Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
    image.dispatchEvent(new Event('load'));
    expect(api.state().naturalSize).toEqual({ width: 640, height: 480 });
    const wrapper = document.getElementById('mearl-design-overlay-svg-wrapper');
    expect(wrapper.style.width).toBe('640px');
    expect(wrapper.style.height).toBe('480px');
    api.handle({ type: 'UPDATE_LAYER', settings: { pixelRatio: 2 } });
    expect(wrapper.style.width).toBe('320px');
    expect(wrapper.style.height).toBe('240px');
    expect(api.state().naturalSize).toEqual({ width: 640, height: 480 });
    api.handle({ type: 'UPDATE_LAYER', settings: { scale: 0.5, cropLeft: 10 } });
    expect(wrapper.style.width).toBe('160px');
    expect(wrapper.style.clipPath).toBe('inset(0px 0px 0px 5px)');
  });

  it('persists keyboard nudges without storing image content and restores them after reinjection', () => {
    const api = install(svg);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(api.state().settings.offsetX).toBe(10);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.getItem(window.sessionStorage.key(0))).not.toContain('svgContent');
    api.destroy();
    expect(install(svg).state().settings.offsetX).toBe(10);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(window.__mearlDesignOverlay.state().settings.offsetX).toBe(11);
  });

  it('hides and restores both the design and its crop controls for capture', () => {
    const api = install(svg);
    const wrapper = document.getElementById('mearl-design-overlay-svg-wrapper');
    api.handle({ type: 'HIDE_FOR_CAPTURE' });
    expect(wrapper.style.visibility).toBe('hidden');
    api.handle({ type: 'SHOW_AFTER_CAPTURE' });
    expect(wrapper.style.visibility).toBe('');
  });

  it('restores page scroll styling and aborts document listeners when destroyed', () => {
    document.body.style.setProperty('overflow', 'scroll', 'important');
    const events = vi.spyOn(document, 'addEventListener');
    const api = install(svg);
    const wrapper = document.getElementById('mearl-design-overlay-svg-wrapper');
    const touch = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(touch, 'touches', { value: [{ clientX: 0, clientY: 0 }] });
    wrapper.dispatchEvent(touch);
    expect(document.body.style.overflow).toBe('hidden');
    const releaseListeners = events.mock.calls.filter(([name]) => ['mouseup', 'touchend', 'touchcancel'].includes(name));
    api.destroy();
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.body.style.getPropertyPriority('overflow')).toBe('important');
    expect(releaseListeners.every(([, , options]) => options.signal?.aborted)).toBe(true);
    const restored = install(svg);
    api.destroy();
    expect(window.__mearlDesignOverlay).toBe(restored);
  });

  it('cleans up a failed initialization and ignores crop attributes outside the overlay', () => {
    expect(() => install('<svg invalid')).toThrow('Invalid SVG');
    expect(document.getElementById('mearl-design-overlay-svg-wrapper')).toBeNull();
    const api = install(svg);
    const unrelated = document.createElement('div');
    unrelated.dataset.cropHandle = 'left';
    document.body.appendChild(unrelated);
    unrelated.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20 }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 20 }));
    expect(api.state().settings.cropLeft).toBe(0);
  });

  it('avoids allocating an unbounded raster crop canvas', () => {
    const api = install('data:image/png;base64,cG5n');
    const image = document.querySelector('#mearl-design-overlay-svg-wrapper img');
    Object.defineProperties(image, { naturalWidth: { value: 10_000 }, naturalHeight: { value: 10_000 } });
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10_000, height: 10_000 });
    const create = vi.spyOn(document, 'createElement');
    const result = api.handle({ type: 'GET_VIEWPORT_INFO' });
    expect(result.croppedDesign).toBeNull();
    expect(create.mock.calls.some(([tag]) => tag === 'canvas')).toBe(false);
  });
});

describe('raster loading', () => {
  it('waits for load events without scheduling a rendering-dependent decode', async () => {
    const image = document.createElement('img');
    Object.defineProperties(image, { complete: { value: false }, naturalWidth: { value: 32 } });
    image.decode = vi.fn(() => new Promise(() => {}));
    const remove = vi.spyOn(image, 'removeEventListener');
    const ready = waitForImage(image);
    image.dispatchEvent(new Event('load'));
    await ready;
    expect(image.decode).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('rejects a completed invalid image', async () => {
    const image = document.createElement('img');
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 0 } });
    await expect(waitForImage(image)).rejects.toThrow('Could not load design image');
  });
});

describe('shared pixel comparison', () => {
  it('clips offscreen content and normalizes design pixels to the screenshot scale', async () => {
    vi.stubGlobal('Image', class {
      set src(value) {
        this.naturalWidth = value === 'screen' ? 200 : 100;
        this.naturalHeight = this.naturalWidth;
        queueMicrotask(() => this.onload());
      }
    });
    const ctx = {
      drawImage: vi.fn(), clearRect: vi.fn(), putImageData: vi.fn(),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    };
    vi.spyOn(document, 'createElement').mockReturnValue({ width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,cG5n' });
    vi.stubGlobal('ImageData', class { constructor(data) { this.data = data; } });
    const imageDiff = vi.fn(() => 36);
    const result = await comparePixels('screen', null, svg, defaults, {
      overlayRect: { x: -10, y: 0, w: 100, h: 100 }, innerWidth: 100, innerHeight: 100, devicePixelRatio: 2,
    }, imageDiff);
    expect(result).toMatchObject({ width: 180, height: 200, count: 36, percentage: 0.1 });
    expect(ctx.drawImage.mock.calls[1].slice(1)).toEqual([10, 0, 90, 100, 0, 0, 180, 200]);
    expect(imageDiff).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), expect.any(Uint8ClampedArray), expect.any(Uint8ClampedArray), 180, 200);
  });
});

describe('design overlay toolbox UI', () => {
  async function mount(content = svg, options = {}) {
    document.body.innerHTML = '<div id="app"></div>';
    const settings = { ...defaults, visible: true, assetId: 'a'.repeat(64) };
    const toast = vi.fn(), readClipboard = vi.fn();
    const invoke = vi.fn(async (command, input) => {
      if (command === 'host.tab.active') return { tabId: 42, url: 'https://current.test/' };
      if (command === 'host.toast') return toast(input.message, { type: input.type });
      if (command === 'host.clipboard.read') return readClipboard();
      if (command === 'state' && options.stateError) throw options.stateError;
      if (command === 'state' && options.stateResult) return options.stateResult;
      if (command === 'state' && options.liveState) return { instanceId: 'page-instance', ...options.liveState };
      if (command === 'tabs') return { tabs: [{ id: 41, title: 'Other window', url: 'https://other.test', active: true }, { id: 42, title: 'Current page', url: 'https://current.test', active: true }] };
      if (command === 'resource-chunk') return options.resourceChunk ? options.resourceChunk(input) : { data: Buffer.from(content).toString('base64'), encoding: 'base64', bytes: Buffer.byteLength(content), chunks: 1 };
      if (command === 'begin-import') return { uploadId: 'upload' };
      if (command === 'import-chunk') return { resource: { id: 'b'.repeat(64) } };
      if (command === 'apply') Object.assign(settings, { assetId: input.assetId, pixelRatio: input.pixelRatio });
      if (command === 'update') Object.assign(settings, input.settings);
      return { instanceId: 'page-instance', settings: { ...settings }, picking: false, devicePixelRatio: 2 };
    });
    let receive;
    let notifyContext;
    const unsubscribe = vi.fn();
    window.mearl = {
      ready: async () => ({ locale: 'zh_CN' }), invoke,
      onContextChange: listener => { notifyContext = listener; return () => {}; },
      ui: { ...preact, ...hooks, html: htm.bind(preact.h) },
      subscribe: vi.fn(async (_, target, listener) => { receive = listener; return unsubscribe; }),
    };
    const icons = await readFile(join(process.cwd(), 'skills/design-overlay/assets/toolbox/icons.js'), 'utf8');
    new Function(icons)();
    const source = await readFile(join(process.cwd(), 'skills/design-overlay/assets/toolbox/app.js'), 'utf8');
    await act(async () => { await new Function(`return ${source}`)(); });
    if (options.waitForReady !== false) await vi.waitFor(() => expect(document.querySelector('#opacity')).not.toBeNull());
    return { invoke, toast, readClipboard, settings, unsubscribe, receive: (...args) => receive?.(...args), changeContext: next => notifyContext(next) };
  }

  it('updates language without reloading the overlay or resetting its settings', async () => {
    const { invoke, settings, changeContext } = await mount();
    const opacity = document.querySelector('#opacity');
    const stateReads = invoke.mock.calls.filter(([command]) => command === 'state').length;
    await act(async () => changeContext({ locale: 'en' }));
    expect(document.body.textContent).toContain('Design content');
    expect(document.querySelector('#opacity')).toBe(opacity);
    expect(invoke.mock.calls.filter(([command]) => command === 'state')).toHaveLength(stateReads);
    expect(settings.opacity).toBe(defaults.opacity);
    expect(document.documentElement.lang).toBe('en');
  });

  it('binds the active page in the popup window and matches the original control order', async () => {
    const { invoke, toast, readClipboard } = await mount();
    expect(invoke).toHaveBeenCalledWith('state', { tabId: 42, locale: 'zh_CN' });
    await vi.waitFor(() => expect(window.mearl.subscribe).toHaveBeenCalledWith('page', { instanceId: 'page-instance' }, expect.any(Function)));
    const text = document.querySelector('fieldset').textContent;
    const labels = ['设计内容', '锚定元素', '跟随滚动', '可见', '透明度', '缩放比例', '位置偏移', '裁切'];
    expect(labels.map(label => text.indexOf(label))).toEqual([...labels.map(label => text.indexOf(label))].sort((a, b) => a - b));
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(6);
    const difference = [...document.querySelectorAll('button')].find(button => button.textContent === '差值模式');
    await act(async () => difference.click());
    expect(invoke).toHaveBeenCalledWith('update', { tabId: 42, settings: { blendMode: 'difference' } });
  });

  it('restores a picked anchor from the live page when reopening a saved overlay', async () => {
    const saved = { ...defaults, assetId: 'a'.repeat(64), visible: true, selector: 'body' };
    const liveState = { settings: { ...saved, selector: '#picked-card', offsetX: 37 }, picking: false, devicePixelRatio: 2 };
    const { invoke } = await mount(svg, { liveState });
    expect(invoke).toHaveBeenCalledWith('state', { tabId: 42, locale: 'zh_CN' });
    expect(document.querySelector('#anchor').value).toBe('#picked-card');
    expect(document.querySelector('[aria-label="X"]').value).toBe('37');
    await vi.waitFor(() => expect(window.mearl.subscribe).toHaveBeenCalledWith('page', { instanceId: 'page-instance' }, expect.any(Function)));
  });

  it('leaves errors already presented by the host to the host UI', async () => {
    const { toast } = await mount(svg, { stateError: Object.assign(new Error('host capability missing'), { handledByHost: true }), waitForReady: false });
    expect(toast).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('shows an initialization failure with a retry instead of leaving an empty tool', async () => {
    const options = { stateError: new Error('Request timeout after 15000ms'), waitForReady: false };
    const { invoke } = await mount(svg, options);
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('覆盖层读取失败'));
    expect(document.querySelector('[role="alert"]').textContent).toContain('Request timeout');
    expect(document.querySelector('[role="status"]')).toBeNull();
    options.stateError = null;
    await act(async () => document.querySelector('[role="alert"] button').click());
    await vi.waitFor(() => expect(document.querySelector('#opacity')).not.toBeNull());
    expect(invoke).toHaveBeenCalledWith('resource-chunk', expect.anything());
    expect(invoke.mock.calls.filter(([command]) => command === 'state').every(([, input]) => input.tabId === 42)).toBe(true);
  });

  it('starts importing only after pasted design content is valid', async () => {
    const { invoke, readClipboard } = await mount();
    readClipboard.mockResolvedValue({ data: 'not a design' });
    const paste = [...document.querySelectorAll('button')].find(button => button.textContent.includes('替换设计稿'));
    await act(async () => paste.click());
    expect(invoke.mock.calls.some(([command]) => command === 'begin-import')).toBe(false);
    readClipboard.mockResolvedValue({ data: svg });
    await act(async () => paste.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('apply', expect.objectContaining({ tabId: 42 })));
    expect(invoke.mock.calls.findIndex(([command]) => command === 'state')).toBeLessThan(invoke.mock.calls.findIndex(([command]) => command === 'begin-import'));
    expect(window.mearl.subscribe).toHaveBeenCalled();
  });

  it('uploads pasted raster data in larger chunks within the host input limit', async () => {
    const { invoke, readClipboard } = await mount();
    const data = 'data:image/png;base64,' + 'a'.repeat(512 * 1024);
    readClipboard.mockResolvedValue({ data });
    const paste = [...document.querySelectorAll('button')].find(button => button.textContent.includes('替换设计稿'));
    await act(async () => paste.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('apply', expect.objectContaining({ pixelRatio: 2 })));
    const uploads = invoke.mock.calls.filter(([command]) => command === 'import-chunk').map(([, input]) => input);
    expect(invoke).toHaveBeenCalledWith('begin-import', { tabId: 42, locale: 'zh_CN', chunks: 3 });
    expect(uploads.map(input => input.data).join('')).toBe(data);
    expect(uploads[0].data).toHaveLength(192 * 1024);
    for (const input of uploads) expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(256 * 1024);
  });

  it('temporarily hides the design on long press and restores it on release', async () => {
    const { invoke, toast, readClipboard } = await mount();
    const visible = [...document.querySelectorAll('button')].find(button => button.textContent.includes('可见'));
    visible.setPointerCapture = vi.fn();
    await act(async () => visible.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true })));
    await new Promise(resolve => setTimeout(resolve, 310));
    await act(async () => visible.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true })));
    expect(invoke).toHaveBeenCalledWith('update', { tabId: 42, settings: { visible: false } });
    expect(invoke).toHaveBeenCalledWith('update', { tabId: 42, settings: { visible: true } });
  });

  it('shows import errors without discarding the current design', async () => {
    const { toast, readClipboard } = await mount();
    readClipboard.mockRejectedValue(new Error('permission denied'));
    const paste = [...document.querySelectorAll('button')].find(button => button.textContent.includes('替换设计稿'));
    await act(async () => paste.click());
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('permission denied'), { type: 'error' }));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('#opacity')).not.toBeNull();
  });

  it('synchronizes page events without idle polling and unsubscribes on unmount', async () => {
    vi.useFakeTimers();
    const { invoke, settings, receive, unsubscribe } = await mount();
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '差值模式').click());
    await vi.waitFor(() => expect(window.mearl.subscribe).toHaveBeenCalledWith('page', { instanceId: 'page-instance' }, expect.any(Function)));
    const reads = invoke.mock.calls.filter(([command]) => command === 'state').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(invoke.mock.calls.filter(([command]) => command === 'state')).toHaveLength(reads);
    await act(async () => receive({ type: 'received', name: 'state', payload: { settings: { ...settings, offsetX: 147, cropTop: 12 }, picking: true } }, { url: 'https://current.test/' }));
    expect(document.querySelector('[aria-label="X"]').value).toBe('147');
    expect(document.querySelector('[aria-label="裁切 ↑"]').value).toBe('12');
    expect(invoke.mock.calls.some(([command]) => command === 'sync')).toBe(false);
    preact.render(null, document.getElementById('app'));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('loads a changed design asset from page events before comparing it', async () => {
    const { invoke, settings, receive } = await mount();
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '差值模式').click());
    const updated = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>';
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => {
      if (command === 'resource-chunk' && input.id === 'b'.repeat(64)) return { data: Buffer.from(updated).toString('base64'), encoding: 'base64', bytes: Buffer.byteLength(updated), chunks: 1 };
      if (command === 'capture') return { screenshot: { id: 'screen' }, viewport: {} };
      return original(command, input);
    });
    settings.assetId = 'b'.repeat(64);
    await act(async () => receive({ type: 'received', name: 'state', payload: { settings: { ...settings } } }, { url: 'https://current.test/' }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('resource-chunk', { tabId: 42, id: 'b'.repeat(64), index: 0 }));
    window.designOverlayCompare = vi.fn().mockResolvedValue({ image: 'data:image/png;base64,cG5n', percentage: 0, count: 0 });
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '像素对比').click());
    await vi.waitFor(() => expect(window.designOverlayCompare).toHaveBeenCalledWith(expect.anything(), expect.anything(), updated, expect.anything(), expect.anything(), window.designOverlayDiff));
  });

  it('refreshes settings on focus without reloading an unchanged design resource', async () => {
    const saved = { ...defaults, visible: true, assetId: 'a'.repeat(64) };
    const liveState = { settings: saved, picking: false };
    const { invoke } = await mount(svg, { liveState });
    await vi.waitFor(() => expect(window.mearl.subscribe).toHaveBeenCalled());
    const resources = invoke.mock.calls.filter(([command]) => command === 'resource-chunk').length;
    const states = invoke.mock.calls.filter(([command]) => command === 'state').length;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'state').length).toBeGreaterThan(states));
    expect(invoke.mock.calls.filter(([command]) => command === 'resource-chunk')).toHaveLength(resources);
  });

  it('reconstructs multibyte design content across binary resource chunks', async () => {
    const content = '<svg>' + ' '.repeat(144 * 1024 - 6) + '😀设计</svg>';
    const bytes = Buffer.from(content);
    const settings = { ...defaults, visible: true, assetId: 'a'.repeat(64) };
    const liveState = { settings, picking: false };
    const { invoke } = await mount(content, {
      liveState,
      resourceChunk: ({ index }) => ({ data: bytes.subarray(index * 144 * 1024, (index + 1) * 144 * 1024).toString('base64'), encoding: 'base64', bytes: bytes.length, chunks: 2 }),
    });
    expect(invoke).toHaveBeenCalledWith('resource-chunk', { tabId: 42, id: 'a'.repeat(64), index: 1 });
    window.designOverlayCompare = vi.fn().mockResolvedValue({ image: 'data:image/png;base64,cG5n', percentage: 0, count: 0 });
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '像素对比').click());
    await vi.waitFor(() => expect(window.designOverlayCompare).toHaveBeenCalled());
    expect(window.designOverlayCompare.mock.calls[0][2]).toBe(content);
  });

  it('delays the centered initial loading indicator and clears it when loading completes', async () => {
    vi.useFakeTimers();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const { settings } = await mount(svg, { stateResult: pending, waitForReady: false });
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('main').className).toContain('is-loading');
    await act(async () => finish({ instanceId: 'page-instance', settings, devicePixelRatio: 1 }));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());
    expect(document.querySelector('#opacity')).not.toBeNull();
  });

  it('shows comparison loading in the button and separates results with whitespace', async () => {
    const { invoke, toast, readClipboard } = await mount();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const original = invoke.getMockImplementation();
    invoke.mockImplementation((command, input) => command === 'capture' ? pending : original(command, input));
    window.designOverlayCompare = vi.fn().mockResolvedValue({ image: 'data:image/png;base64,cG5n', percentage: 17.3, count: 50, width: 10, height: 10 });
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '像素对比');
    await act(async () => button.click());
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.loading-spinner')).not.toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => finish({ screenshot: { id: 'screen', chunks: 1 }, croppedDesign: null, viewport: {} }));
    await vi.waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(document.querySelector('img[alt="差异像素"]').parentElement.className).not.toContain('border-t');
  });

  it('uses page pixel density for pasted screenshots and allows original pixel sizing', async () => {
    const { invoke, readClipboard } = await mount();
    readClipboard.mockResolvedValue({ type: 'image', data: 'data:image/png;base64,cG5n' });
    const paste = [...document.querySelectorAll('button')].find(button => button.textContent.includes('替换设计稿'));
    await act(async () => paste.click());
    await act(async () => { await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('apply', expect.objectContaining({ tabId: 42, pixelRatio: 2 }))); });
    const density = document.querySelector('[aria-label="像素密度"]');
    expect(density.value).toBe('2');
    await act(async () => { density.value = '1'; density.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(invoke).toHaveBeenCalledWith('update', { tabId: 42, settings: { pixelRatio: 1 } });
  });

  it('keeps imported file dimensions independent of screen density', async () => {
    const { invoke, toast, readClipboard } = await mount();
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File(['png'], 'design.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('apply', expect.objectContaining({ pixelRatio: 1 })));
  });
});
