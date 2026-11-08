import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserBundleStore, buildPageRuntimeCallSource, buildPageRuntimeRegistrationSource, bundleDigest, installPageRuntimeHost, prepareBundle } from '../bundles.js';

const digest = 'a'.repeat(64);
const stores: BrowserBundleStore[] = [];
beforeEach(() => { vi.stubGlobal('window', {}); vi.stubGlobal('crypto', webcrypto); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); vi.unstubAllGlobals(); });

describe('document page runtime dispatch', () => {
  it.each([true, false])('keeps registration order independent of the static document_start entry (%s)', registerFirst => {
    const host = installPageRuntimeHost();
    const install = vi.fn();
    const fallback = vi.fn();
    const config = { pageRuntime: { id: 'sample/main', sha256: digest } };
    if (registerFirst) host.register(digest, install);
    host.install(config, fallback);
    if (!registerFirst) { expect(install).not.toHaveBeenCalled(); host.register(digest, install); }
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(config);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('keeps pinned versions separate and only uses the fallback for profiles without a runtime', () => {
    const host = installPageRuntimeHost();
    const install = vi.fn();
    const fallback = vi.fn();
    host.register(digest, install);
    host.install({ pageRuntime: { id: 'sample/main', sha256: 'b'.repeat(64) } }, fallback);
    expect(install).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    host.install({}, fallback);
    expect(fallback).toHaveBeenCalledOnce();
  });
  it('prepares code as text and executes the CommonJS installer only in the page context', () => {
    const binding = { id: 'sample/main', sha256: digest };
    const moduleSource = 'window.moduleLoaded=true; module.exports.install=config=>{window.installed=config;};';
    const registration = buildPageRuntimeRegistrationSource(binding, moduleSource, '__install');
    expect((window as unknown as { moduleLoaded?: boolean }).moduleLoaded).toBeUndefined();
    const config = { pageRuntime: binding };
    const page = {};
    runInNewContext(buildPageRuntimeCallSource('config') + registration, { window: page, config });
    expect(page).toMatchObject({ moduleLoaded: true, installed: config });
  });
});

async function runtimeBundle(source: string, version: string) {
  const bytes = new TextEncoder().encode(source);
  const sha256 = await bundleDigest(bytes);
  const manifest = { schemaVersion: 1, id: 'sample', version,
    resources: { 'main.cjs': { sha256, byteLength: bytes.byteLength } }, contributions: { appProfiles: [], pageRuntimes: { main: 'main.cjs' } } };
  const bundle = await prepareBundle('https://example.com/bundle.json', { expectedId: 'sample', mearlApiVersion: '1.0.0',
    load: async url => url.endsWith('bundle.json') ? new TextEncoder().encode(JSON.stringify(manifest)) : bytes });
  return { bundle, sha256 };
}

describe('retained page runtime resources', () => {
  it('keeps previous exact code after an update, removal, and offline store restart', async () => {
    const factory = new IDBFactory();
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory }); stores.push(store);
    const first = await runtimeBundle('module.exports.install=()=>1;', '1.0.0');
    const second = await runtimeBundle('module.exports.install=()=>2;', '1.1.0');
    await store.install(first.bundle, null);
    await store.pinPageRuntimes({ 'tab:1': first.sha256 });
    await store.install(second.bundle, first.bundle.revision);
    expect(await store.pageRuntimeSource(first.sha256)).toBe('module.exports.install=()=>1;');
    await store.remove('sample', second.bundle.revision);
    await store.close();
    const reopened = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: factory }); stores.push(reopened);
    expect(await reopened.pageRuntimeSource(first.sha256)).toBe('module.exports.install=()=>1;');
    await expect(reopened.pageRuntimeSource(second.sha256)).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await reopened.pinPageRuntimes({ 'tab:1': null });
    await expect(reopened.pageRuntimeSource(first.sha256)).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await expect(reopened.pageRuntimeSource('c'.repeat(64))).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
  });
  it('reclaims unreferenced code during repeated install/remove cycles and rebuilds session pins', async () => {
    const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0', indexedDB: new IDBFactory() }); stores.push(store);
    const first = await runtimeBundle('module.exports.install=()=>1;', '1.0.0');
    await store.install(first.bundle, null);
    await store.pinPageRuntimes({ 'tab:1': first.sha256 });
    const second = await runtimeBundle('module.exports.install=()=>2;', '1.1.0');
    await store.install(second.bundle, first.bundle.revision);
    await store.synchronizePageRuntimePins({});
    await expect(store.pageRuntimeSource(first.sha256)).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await store.remove('sample', second.bundle.revision);
    await expect(store.pageRuntimeSource(second.sha256)).rejects.toMatchObject({ code: 'BUNDLE_INTEGRITY' });
    await store.install(first.bundle, null);
    expect(await store.pageRuntimeSource(first.sha256)).toContain('install');
  });
});
