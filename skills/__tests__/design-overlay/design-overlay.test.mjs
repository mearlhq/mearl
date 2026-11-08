import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetStore, CHUNK_CHARACTERS, IMPORT_CHUNK_CHARACTERS, RESOURCE_CHUNK_BYTES } from '../../design-overlay/scripts/assets.mjs';
import { createCommands as createPluginCommands, defaults, validatePatch, overlayRuntimeVersion } from '../../design-overlay/scripts/commands.mjs';
import { memoryState } from './memory-state.mjs';
import register, { toolbox } from '../../design-overlay/scripts/main.mjs';


const createCommands = (invoke, store, page = vi.fn()) => createPluginCommands({ invoke, page }, store);

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), 'mearl-overlay-'));
  directories.push(directory);
  return createAssetStore(memoryState(directory), () => 'test-tab');
}

describe('design overlay plugin', () => {
  it('registers a popup-only tool without browser or file activity during help', () => {
    const invoke = vi.fn(), command = vi.fn(), toolboxCommand = vi.fn(), runtimeCommand = vi.fn();
    register({ invoke, command, toolboxCommand, runtimeCommand });
    expect(runtimeCommand.mock.calls.map(([name]) => name)).toEqual(['initialize', 'sync']);
    expect(toolbox.displayMode).toBe('popup');
    expect(invoke).not.toHaveBeenCalled();
    expect(command.mock.calls.map(([name]) => name)).toEqual(['tabs', 'state', 'update', 'apply', 'clear', 'compare', 'import']);
    expect(toolboxCommand.mock.calls.map(([name]) => name)).toEqual(['pick', 'cancel-pick', 'capture', 'begin-import', 'import-chunk', 'resource-chunk']);
    expect(toolbox.page.commands).not.toContain('import');
    expect(toolbox.page.commands).not.toContain('compare');
  });

  it('reassembles large SVG resources and preserves split Unicode surrogate pairs', async () => {
    const store = await makeStore();
    const first = '<svg xmlns="http://www.w3.org/2000/svg"><text>';
    const content = first + 'a'.repeat(CHUNK_CHARACTERS - first.length - 1) + '😀' + '</text></svg>';
    const { uploadId } = await store.begin({ chunks: 2 });
    await expect(store.append({ uploadId, index: 1, data: 'wrong' })).rejects.toThrow('chunk index');
    expect(await store.append({ uploadId, index: 0, data: content.slice(0, CHUNK_CHARACTERS) })).toEqual({ next: 1 });
    const { resource } = await store.append({ uploadId, index: 1, data: content.slice(CHUNK_CHARACTERS) });
    expect(await store.read(resource.id)).toBe(content);
    const parts = [];
    for (let index = 0; index < resource.chunks; index += 1) parts.push(Buffer.from((await store.chunk({ id: resource.id, index })).data, 'base64'));
    expect(Buffer.concat(parts).toString('utf8')).toBe(content);
    await expect(store.append({ uploadId, index: 0, data: 'old' })).rejects.toThrow();
  });

  it('rejects malformed resources, oversized chunks and path traversal', async () => {
    const store = await makeStore();
    const { uploadId } = await store.begin({ chunks: 1 });
    await expect(store.append({ uploadId, index: 0, data: 'x'.repeat(IMPORT_CHUNK_CHARACTERS + 1) })).rejects.toThrow('chunk data');
    await expect(store.append({ uploadId, index: 0, data: '<script>alert(1)</script>' })).rejects.toThrow('Expected SVG');
    await expect(store.read('../settings')).rejects.toThrow('resource id');
    await expect(store.append({ uploadId: '../settings', index: 0, data: 'x' })).rejects.toThrow('upload id');
  });

  it('accepts larger raster upload chunks while keeping resource reads bounded', async () => {
    const store = await makeStore();
    const content = 'data:image/png;base64,' + 'a'.repeat(IMPORT_CHUNK_CHARACTERS * 2);
    const count = Math.ceil(content.length / IMPORT_CHUNK_CHARACTERS);
    const { uploadId } = await store.begin({ chunks: count });
    let resource;
    for (let index = 0; index < count; index++) {
      ({ resource } = await store.append({ uploadId, index, data: content.slice(index * IMPORT_CHUNK_CHARACTERS, (index + 1) * IMPORT_CHUNK_CHARACTERS) }));
    }
    expect(await store.read(resource.id)).toBe(content);
    expect(Buffer.from((await store.chunk({ id: resource.id, index: 0 })).data, 'base64')).toHaveLength(RESOURCE_CHUNK_BYTES);
  });

  it('isolates page settings within the browser session', async () => {
    const store = await makeStore();
    await store.saveSettings('https://example.test/a', { ...defaults, offsetX: 42 }, { pageInstanceId: 'page-instance', settingsRevision: 0 });
    expect((await store.loadSettings('https://example.test/a')).offsetX).toBe(42);
    expect(await store.loadSettings('https://example.test/b')).toBeNull();
  });

  it('saves event state without executing another page script and rejects mismatched pages', async () => {
    const invoke = vi.fn();
    const saveSettings = vi.fn();
    const commands = createCommands(invoke, { saveSettings });
    const state = { settingsRevision: 0, runtimeVersion: overlayRuntimeVersion, url: 'https://example.test/a', settings: { ...defaults, offsetX: 147 } };
    await commands.sync({ event: { payload: state } }, { identity: { page: { instanceId: 'page-instance', target: { tabId: 42, url: 'https://example.test/a' } } } });
    expect(saveSettings).toHaveBeenCalledWith('https://example.test/a', expect.objectContaining({ offsetX: 147 }), { pageInstanceId: 'page-instance', settingsRevision: 0 });
    expect(invoke).not.toHaveBeenCalled();
    await expect(commands.sync({ event: { payload: { ...state, settingsRevision: undefined } } }, { identity: { page: { instanceId: 'page-instance', target: { tabId: 42, url: state.url } } } })).rejects.toThrow('Invalid overlay state');
    await expect(commands.sync({ event: { payload: state } }, { identity: { page: { instanceId: 'page-instance', target: { tabId: 42, url: 'https://other.test/a' } } } })).rejects.toThrow('event state');
  });

  it.each([{ opacity: 2 }, { scale: 0 }, { pixelRatio: 0 }, { pixelRatio: 5 }, { cropTop: -1 }, { visible: 1 }, { offsetX: Infinity }, { unknown: 1 }, { assetId: '../x' }])('rejects invalid setting patches %j', patch => {
    expect(() => validatePatch(patch)).toThrow();
  });

  function pageFixture(state, handle = () => state) {
    return vi.fn(async (operation, input) => {
      if (operation === 'attach') return { instanceId: 'page-instance', target: { tabId: 42 } };
      if (operation === 'activation') return { activation: input };
      return input.message.type === 'STATE' ? state : handle(input.message);
    });
  }

  it('uses a document instance and explicit activation through the generic host', async () => {
    const state = { settingsRevision: 0, runtimeVersion: overlayRuntimeVersion, url: 'https://example.test/a', settings: defaults };
    const page = pageFixture(state), invoke = vi.fn();
    const result = await createCommands(invoke, { saveSettings: vi.fn() }, page).state({ tabId: 42 });
    expect(result.instanceId).toBe('page-instance');
    expect(page).toHaveBeenCalledWith('attach', { tabId: 42, frame: 'business', input: { locale: 'zh_CN' } });
    expect(page).toHaveBeenCalledWith('activation', expect.objectContaining({ matches: ['https://example.test/a', 'https://example.test/a?*'], persistence: 'session' }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('restores the overlay when screenshot capture fails', async () => {
    const state = { settingsRevision: 0, runtimeVersion: overlayRuntimeVersion, url: 'https://example.test/a', settings: defaults, hasContent: true };
    const messages = [];
    const page = pageFixture(state, message => {
      messages.push(message.type);
      return message.type === 'GET_VIEWPORT_INFO' ? { overlayRect: { x: 0, y: 0, w: 10, h: 10 } } : state;
    });
    const invoke = vi.fn(async () => { throw new Error('capture failed'); });
    await expect(createCommands(invoke, { saveSettings: vi.fn(), releaseComparisons: vi.fn() }, page).capture({ tabId: 42 })).rejects.toThrow('capture failed');
    expect(messages).toEqual(['WAIT_IMAGE', 'GET_VIEWPORT_INFO', 'HIDE_FOR_CAPTURE', 'SHOW_AFTER_CAPTURE']);
  });

  it('keeps image resources out of toolbox command results', async () => {
    const state = { settingsRevision: 0, runtimeVersion: overlayRuntimeVersion, url: 'https://example.test/a', settings: defaults };
    const page = pageFixture(state, message => message.type === 'GET_VIEWPORT_INFO' ? {
      overlayRect: { x: 0, y: 0, w: 10, h: 10 }, croppedDesign: 'large design', innerWidth: 100,
    } : state);
    const store = { saveSettings: vi.fn(), releaseComparisons: vi.fn(), save: vi.fn(async () => ({ id: 'a'.repeat(64), chunks: 8 })) };
    const result = await createCommands(vi.fn(async () => ({ data: 'large screenshot' })), store, page).capture({ tabId: 42 });
    expect(result.screenshot.chunks).toBe(8);
    expect(result.viewport).not.toHaveProperty('croppedDesign');
    expect(JSON.stringify(result)).not.toContain('large');
  });

  it('passes large Unicode designs losslessly through the host message API', async () => {
    const state = { settingsRevision: 0, runtimeVersion: overlayRuntimeVersion, url: 'https://example.test/a', settings: defaults };
    const content = '<svg>' + '设计😀'.repeat(100_000) + '</svg>';
    const page = pageFixture(state);
    await createCommands(vi.fn(), { read: async () => content, saveSettings: vi.fn(), pin: vi.fn() }, page).apply({ tabId: 42, assetId: 'a'.repeat(64) });
    expect(page).toHaveBeenCalledWith('send', { instanceId: 'page-instance', message: { type: 'APPLY', content, assetId: 'a'.repeat(64), pixelRatio: 1 } });
  });
});

it('keeps resources and settings isolated across browser session memory stores', async () => {
  const first = createAssetStore(memoryState(), () => 'test-tab'), second = createAssetStore(memoryState(), () => 'test-tab');
  const resource = await first.save('<svg/>');
  await first.pin(resource.id);
  await first.saveSettings('https://example.test/a', { ...defaults, assetId: resource.id }, { pageInstanceId: 'first', settingsRevision: 0 });
  expect((await first.loadSettings('https://example.test/a')).assetId).toBe(resource.id);
  expect(await second.loadSettings('https://example.test/a')).toBeNull();
  await expect(second.read(resource.id)).rejects.toThrow('no longer available');
  const comparison = await first.save('data:image/png;base64,YQ==');
  await first.releaseComparisons();
  await expect(first.read(comparison.id)).rejects.toThrow('no longer available');
  expect(await first.read(resource.id)).toBe('<svg/>');
  await first.saveSettings('https://example.test/a', defaults, { pageInstanceId: 'first', settingsRevision: 1 });
  await expect(first.read(resource.id)).rejects.toThrow('no longer available');
});

it('keeps same-URL designs and comparison resources owned by their tab and frame', async () => {
  const state = memoryState();
  const first = createAssetStore(state, () => 'tab-1-frame-0'), second = createAssetStore(state, () => 'tab-2-frame-0');
  const a = await first.save('<svg>A</svg>'), b = await second.save('<svg>B</svg>');
  await first.pin(a.id); await second.pin(b.id);
  await first.saveSettings('https://example.test/a', { ...defaults, assetId: a.id }, { pageInstanceId: 'first', settingsRevision: 0 });
  await second.saveSettings('https://example.test/a', { ...defaults, assetId: b.id }, { pageInstanceId: 'second', settingsRevision: 0 });
  const comparison = await first.save('data:image/png;base64,YQ==');
  await second.releaseComparisons();
  expect(await first.read(comparison.id)).toBe('data:image/png;base64,YQ==');
  expect(await first.read(a.id)).toBe('<svg>A</svg>');
  expect((await first.loadSettings('https://example.test/a')).assetId).toBe(a.id);
  await expect(second.read(a.id)).rejects.toThrow('no longer available');
});

it('ignores late state events before they can reclaim a newly applied design', async () => {
  const store = createAssetStore(memoryState(), () => 'test-tab'), url = 'https://example.test/a';
  const stamp = settingsRevision => ({ pageInstanceId: 'pi_document-one', settingsRevision });
  await store.saveSettings(url, defaults, stamp(0));
  const resource = await store.save('<svg>new</svg>'); await store.pin(resource.id);
  await store.saveSettings(url, { ...defaults, visible: true, assetId: resource.id }, stamp(2));
  await store.saveSettings(url, defaults, stamp(1));
  expect((await store.loadSettings(url)).assetId).toBe(resource.id);
  expect(await store.read(resource.id)).toBe('<svg>new</svg>');
  await store.saveSettings(url, { ...defaults, visible: true, assetId: resource.id, opacity: 0.3 }, { pageInstanceId: 'pi_document-two', settingsRevision: 0 });
  expect((await store.loadSettings(url)).opacity).toBe(0.3);
});
